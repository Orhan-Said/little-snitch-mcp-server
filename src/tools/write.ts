import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyModelChange, failAfterWrite, NOT_LOGGED, recoveryDetails, requireLock, restoreText, undo, type RecoveryRequest } from '../apply.js';
import { assertFitsPrompt, describeChanges, prompts, ruleText, shown } from '../approval.js';
import type { ChangeResult } from '../cli/littlesnitch.js';
import type { Context } from '../context.js';
import { LittleSnitchError } from '../errors.js';
import { addRule, buildRule, removeRule, SPECIAL_REMOTES, updateRule, validateNewRule, type NewRuleSpec, type RulePatch } from '../model/edit.js';
import { groupDisplayNames, resolveGroup, summarizeGroups } from '../model/groups.js';
import { asNumber, isObject, parseModelText, rulesOf, type JsonObject } from '../model/json.js';
import { assertAllowedByLittleSnitch } from '../model/permissions.js';
import { activeProfile, resolveProfile, withoutActiveProfile } from '../model/profiles.js';
import { ruleRef, semanticKey, summarizeRule, tolerantKey, type RuleSummary } from '../model/rules.js';
import { compareModels, comparisonDetails, describeComparison } from '../model/verify.js';
import { safely } from './shared.js';

const REF = z.string().regex(/^r[0-9a-f]{12}$/, 'A rule reference looks like r1a2b3c4d5e6f, as list_rules shows it.');
const DRY_RUN = z.boolean().optional().describe('When true, nothing is changed: the result shows what would happen.');
const APPROVAL =
  'The person at the Mac approves each change in the macOS administrator dialog, which states the change, unless they switched that off. ' +
  'Afterwards the configuration is read back and every rule, rule group, profile and preference is compared; if anything differs from what was intended, the change is undone. ' +
  'In the result, rewrittenByLittleSnitch names bookkeeping sections Little Snitch changed by itself, which are not compared, and warnings lists anything the person should know.';

const one = (warning: string | undefined): readonly string[] => (warning === undefined ? [] : [warning]);

/**
 * What every result of a change says besides its own fields: the bookkeeping
 * parts Little Snitch rewrote by itself, which are not compared, and anything
 * that went wrong on the side.
 */
const sideNotes = (outcome: { readonly warnings: readonly string[]; readonly rewrittenByLittleSnitch: readonly string[] }): Record<string, unknown> => ({
  ...(outcome.rewrittenByLittleSnitch.length === 0 ? {} : { rewrittenByLittleSnitch: outcome.rewrittenByLittleSnitch }),
  ...(outcome.warnings.length === 0 ? {} : { warnings: outcome.warnings }),
});

function summarize(rule: JsonObject, model: JsonObject): RuleSummary {
  return summarizeRule(rule, groupDisplayNames(model));
}

/** Finds, in the configuration read back, the rule that was written. */
function readBack(after: JsonObject, written: JsonObject): RuleSummary | null {
  const key = tolerantKey(written);
  const found = rulesOf(after).findLast((rule) => tolerantKey(rule) === key);
  return found === undefined ? null : summarize(found, after);
}

interface SwitchPlan {
  readonly summary: string;
  readonly run: () => Promise<ChangeResult>;
  /** The whole configuration as it must be afterwards, when the switch's effect can be written down exactly. */
  readonly expected?: JsonObject;
  /**
   * For a switch whose place in the configuration is not known for certain:
   * takes that place out of a configuration, so that everything else can be
   * compared with how it was before.
   */
  readonly apartFrom?: (model: JsonObject) => JsonObject;
  /** With `apartFrom`: true or false when the configuration tells whether the switch took effect, null when it does not. */
  readonly confirm?: (after: JsonObject) => boolean | null;
  readonly warnings?: readonly string[];
}

interface SwitchResult {
  readonly method: string;
  /** True when the read-back proves the switch, false when the configuration does not say. */
  readonly confirmed: boolean;
  /** Parts of the configuration other than the rule list that differ from before. */
  readonly partsThatChanged: readonly string[];
  readonly rewrittenByLittleSnitch: readonly string[];
  readonly warnings: readonly string[];
}

const SWITCH_APPROVAL =
  'The person at the Mac approves the switch in the macOS administrator dialog, unless they switched that off. ' +
  'A backup is saved first; if anything other than the switch itself differs afterwards, the earlier configuration is restored.';

/**
 * Runs a profile or rule group switch the way a rule change runs: one at a
 * time, from a configuration read at that moment, with a backup, a check of
 * the result, and an undo when the result is wrong. The check is strict: a
 * switch changes its own place in the configuration and nothing else, so a
 * rule, another group, a preference or a profile that differs afterwards
 * means the earlier configuration is put back.
 */
function switchVerified(ctx: Context, tool: string, plan: (before: JsonObject) => SwitchPlan | 'already'): Promise<SwitchResult | 'already'> {
  return ctx.changes.run(async () => {
    const { model: before, text: beforeText } = await ctx.models.fresh();
    const planned = plan(before);
    if (planned === 'already') {
      return 'already';
    }
    const backup = await ctx.store.writeBackup(beforeText, `before-${tool}`);
    const request: RecoveryRequest = { tool, summary: planned.summary, before, beforeText, backup };
    await requireLock(ctx, request);
    let result: ChangeResult;
    let after: JsonObject;
    try {
      ctx.models.clear();
      result = await planned.run();
      after = parseModelText(result.modelText);
    } catch (error) {
      return failAfterWrite(ctx, request, error);
    }

    const sinceBefore = compareModels(before, after);
    const apart = planned.apartFrom ?? ((model: JsonObject): JsonObject => model);
    const check = planned.expected === undefined ? compareModels(apart(before), apart(after)) : compareModels(planned.expected, after);
    const confirmed = planned.expected === undefined ? (planned.confirm?.(after) ?? null) : check.ok;
    if (check.ok && confirmed !== false) {
      ctx.models.put(after);
      // "accepted" is for a switch the configuration does not show: Little Snitch took it, and nothing else changed.
      const logged = await ctx.store.audit({ tool, summary: planned.summary, outcome: confirmed === true ? 'applied' : 'accepted', method: result.method, backup: backup.name });
      return {
        method: result.method,
        confirmed: confirmed === true,
        partsThatChanged: sinceBefore.changedSections,
        rewrittenByLittleSnitch: sinceBefore.rewrittenByLittleSnitch,
        warnings: [...(planned.warnings ?? []), ...(logged ? [] : [NOT_LOGGED])],
      };
    }
    const difference = check.ok ? sinceBefore : check;
    const problem = comparisonDetails(difference);
    if (sinceBefore.ok) {
      await ctx.store.audit({ tool, summary: planned.summary, outcome: 'failed', method: result.method, backup: backup.name, detail: 'accepted, nothing changed' });
      throw new LittleSnitchError('verification-failed', 'Little Snitch accepted the request, but the configuration is the same as before. Nothing needs to be undone.', {
        details: { ...problem, backup: backup.name, rolledBack: false, configurationAsBefore: true },
      });
    }
    const recovery = await undo(ctx, request);
    throw new LittleSnitchError(
      'verification-failed',
      `Little Snitch accepted the request, but the configuration afterwards is not what the switch should produce (${describeComparison(difference)}). ${recovery.sentence}`,
      { details: recoveryDetails(request, recovery, problem) },
    );
  });
}

function registerSwitchTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'set_active_profile',
    {
      title: 'Switch profile',
      description:
        'Activate a Little Snitch profile by its exact name, or deactivate all profiles. A profile changes which rules apply, so it can loosen or tighten the firewall; ' +
        `say which profile you are switching to and why before calling. ${SWITCH_APPROVAL} ` +
        'Where Little Snitch keeps the active profile is not documented: when the configuration does not show it and nothing else changed, the answer says "accepted" and not "applied".',
      inputSchema: {
        profile: z.string().max(200).nullable().describe('Exact profile name as list_profiles shows it, or null to deactivate all profiles.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Switch profile' },
    },
    safely(async ({ profile }) => {
      const result = await switchVerified(ctx, 'set_active_profile', (before) => {
        const warning = assertAllowedByLittleSnitch(before, ctx.uid, 'switch-profile');
        if (profile !== null) {
          resolveProfile(before, profile);
        }
        return {
          summary: profile === null ? 'deactivate all profiles' : `activate profile "${shown(profile, 80)}"`,
          run: () => (profile === null ? ctx.cli.deactivateAllProfiles() : ctx.cli.activateProfile(profile)),
          // Only the key that names the active profile may differ afterwards.
          apartFrom: withoutActiveProfile,
          confirm: (after) => {
            const active = activeProfile(after, ctx.uid);
            return active.known ? active.name === profile : null;
          },
          warnings: one(warning),
        };
      });
      if (result === 'already') {
        throw new Error('unreachable: a profile switch is always run');
      }
      const common = {
        activeProfile: profile,
        confirmedByReadBack: result.confirmed,
        partsThatChanged: result.partsThatChanged,
        approvedThrough: result.method,
        ...sideNotes(result),
      };
      return result.confirmed
        ? { applied: true, ...common }
        : {
            accepted: true,
            ...common,
            note: 'Little Snitch accepted the request, and no rule, rule group, profile or preference changed. The configuration does not say which profile is active in a form this server recognises, so the switch itself is not confirmed. Check the profile in Little Snitch.',
          };
    }),
  );

  server.registerTool(
    'set_rule_group_enabled',
    {
      title: 'Switch a rule group or blocklist on or off',
      description:
        'Switch a Little Snitch rule group or blocklist on or off, by the exact id or name list_rule_groups shows. Switching a group off stops its rules from applying, ' +
        `which can loosen the firewall; say what you are switching and why before calling. ${SWITCH_APPROVAL}`,
      inputSchema: {
        group: z.string().min(1).max(200).describe('The group\'s id or its exact name, as list_rule_groups shows it.'),
        enabled: z.boolean().describe('true switches the group on, false switches it off.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Switch a rule group or blocklist' },
    },
    safely(async ({ group, enabled }) => {
      let target: { id: string; name: string } | undefined;
      const result = await switchVerified(ctx, 'set_rule_group_enabled', (before) => {
        const warning = assertAllowedByLittleSnitch(before, ctx.uid, 'edit-rules');
        // The group is looked up in the configuration as it is now, so the name sent to Little Snitch and the id checked afterwards belong together.
        const found = resolveGroup(before, group);
        if (found.name === null) {
          throw new LittleSnitchError(
            'not-found',
            `The built-in group with kind "${found.kind ?? 'unknown'}" has no name in the configuration, and Little Snitch only accepts a name. Switch it in Little Snitch itself.`,
            { remedy: 'Please report this group kind and the name Little Snitch shows for it, so it can be added.' },
          );
        }
        const sameName = summarizeGroups(before).filter((entry) => entry.name === found.name);
        if (sameName.length > 1) {
          throw new LittleSnitchError('ambiguous', `${sameName.length} rule groups are called "${found.name}", and Little Snitch takes a name only. Switch the group in Little Snitch itself.`);
        }
        const name = found.name;
        target = { id: found.id, name };
        if (found.active === enabled) {
          return 'already';
        }
        const groups = before['groups'];
        const entry = isObject(groups) ? groups[found.id] : undefined;
        if (!isObject(groups) || !isObject(entry)) {
          throw new LittleSnitchError('unexpected-output', 'The rule groups in the configuration are not in a form this server can check a switch against. Switch the group in Little Snitch itself.');
        }
        return {
          summary: `switch rule group "${shown(name, 80)}" ${enabled ? 'on' : 'off'}`,
          run: () => ctx.cli.setRuleGroupEnabled(name, enabled),
          expected: { ...before, groups: { ...groups, [found.id]: { ...entry, isActive: enabled } } },
          warnings: one(warning),
        };
      });
      if (result === 'already') {
        return { applied: false, alreadyInState: true, group: target ?? null, enabled, note: `The group is already ${enabled ? 'on' : 'off'}. Nothing was run.` };
      }
      return {
        applied: true,
        group: target ?? null,
        enabled,
        confirmedByReadBack: result.confirmed,
        approvedThrough: result.method,
        ...sideNotes(result),
      };
    }),
  );
}

function registerRuleTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'add_rule',
    {
      title: 'Add a firewall rule',
      description:
        'Add one Little Snitch rule that allows or denies connections of a process to a remote. Give exactly one of remote_domains, remote_hosts, remote_addresses or remote. ' +
        'The rule applies in all profiles and is marked in its notes as added through MCP. A rule for any process and any remote is refused; addresses that leave out at most 1/256 of the IPv4 or IPv6 addresses (0.0.0.0/0, ::/0, ::ffff:0:0/96, or halves of them) count as any remote. A remote list too long to show in the approval prompt is refused too. ' +
        `An allow rule opens the firewall: state the exact rule to the person before calling, or call with dry_run first. A backup is saved first. ${APPROVAL}`,
      inputSchema: {
        action: z.enum(['allow', 'deny']),
        process: z.string().min(1).max(1024).describe('Absolute path of the executable (inside the app: /Applications/Safari.app/Contents/MacOS/Safari), or "any" for every process.'),
        via: z.string().max(1024).optional().describe('Optional absolute path of a helper: the rule then applies only when the process connects through it.'),
        remote_domains: z.array(z.string().max(253)).max(200).optional().describe('Domains, each covering its subdomains too. Example: ["example.com"].'),
        remote_hosts: z.array(z.string().max(253)).max(200).optional().describe('Exact host names. Example: ["api.example.com"].'),
        remote_addresses: z.array(z.string().max(100)).max(200).optional().describe('IP addresses, ranges (a-b) or networks (a/prefix).'),
        remote: z.enum(SPECIAL_REMOTES).optional().describe('A keyword instead of names: "any", "local-net", "multicast", "broadcast", "bonjour", "dns-servers" or "bpf".'),
        direction: z.enum(['outgoing', 'incoming']).optional().describe('Default "outgoing".'),
        ports: z.string().max(11).optional().describe('"any" (default), one port such as "443", or a range such as "8000-8100".'),
        protocol: z.enum(['tcp', 'udp', 'icmp']).optional().describe('Default: any protocol.'),
        priority: z.enum(['regular', 'high']).optional().describe('Default "regular". A high-priority rule wins over regular ones.'),
        notes: z.string().max(400).optional().describe('Why the rule exists, for the person reading it later. One line.'),
        dry_run: DRY_RUN,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Add a firewall rule' },
    },
    safely(async (args) => {
      const stamp = `Added through MCP on ${ctx.now().toISOString().slice(0, 10)}.`;
      const spec: NewRuleSpec = {
        action: args.action,
        process: args.process,
        ...(args.via === undefined ? {} : { via: args.via }),
        ...(args.remote_domains === undefined ? {} : { remoteDomains: args.remote_domains }),
        ...(args.remote_hosts === undefined ? {} : { remoteHosts: args.remote_hosts }),
        ...(args.remote_addresses === undefined ? {} : { remoteAddresses: args.remote_addresses }),
        ...(args.remote === undefined ? {} : { remote: args.remote }),
        ...(args.direction === undefined ? {} : { direction: args.direction }),
        ...(args.ports === undefined ? {} : { ports: args.ports }),
        ...(args.protocol === undefined ? {} : { protocol: args.protocol }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        notes: args.notes === undefined || args.notes.trim() === '' ? stamp : `${args.notes.trim()} ${stamp}`,
      };
      // Both checks need nothing from Little Snitch, so a bad request never causes an approval prompt.
      validateNewRule(spec);
      assertFitsPrompt(buildRule(spec, { uid: ctx.uid, now: ctx.now(), model: {} }));

      let built: JsonObject | undefined;
      const outcome = await applyModelChange(
        ctx,
        (before) => {
          const warning = assertAllowedByLittleSnitch(before, ctx.uid, 'edit-rules');
          const rule = buildRule(spec, { uid: ctx.uid, now: ctx.now(), model: before });
          // A rule of another macOS user with the same meaning is not a duplicate of this user's rule.
          const twin = rulesOf(before).find(
            (existing) => semanticKey(existing) === semanticKey(rule) && (asNumber(existing['uid']) ?? ctx.uid) === ctx.uid,
          );
          if (twin !== undefined) {
            throw new LittleSnitchError('invalid-input', `A rule with the same meaning exists already (ref ${ruleRef(twin)}). Change that rule instead of adding a second one.`);
          }
          built = rule;
          return {
            tool: 'add_rule',
            summary: `add rule: ${ruleText(rule, ctx.uid)}`,
            prompt: prompts.add(rule, ctx.uid),
            next: addRule(before, rule),
            written: [rule],
            removedRefs: [],
            preview: { wouldAdd: summarize(rule, before), approvalPrompt: prompts.add(rule, ctx.uid) },
            warnings: one(warning),
          };
        },
        args.dry_run === true,
      );
      if (!outcome.applied) {
        return outcome;
      }
      return { applied: true, rule: built === undefined ? null : readBack(outcome.after, built), backup: outcome.backup, approvedThrough: outcome.method, ...sideNotes(outcome) };
    }),
  );

  server.registerTool(
    'update_rule',
    {
      title: 'Change a firewall rule',
      description:
        'Change the action, priority or notes of one rule, found by the ref list_rules shows. Refused: protected and factory rules, a rule the approval prompt could not show exactly (a remote list that is too long, or data it would have to leave out or cut), ' +
        'a change that would make the rule a copy of another rule, and a change to the action or priority of a rule for any process and any remote. ' +
        `Changing deny to allow opens the firewall: state the change to the person before calling, or call with dry_run first. A backup is saved first. ${APPROVAL}`,
      inputSchema: {
        ref: REF,
        action: z.enum(['allow', 'deny']).optional(),
        priority: z.enum(['regular', 'high']).optional(),
        notes: z.string().max(500).optional().describe('New notes, one line. An empty text removes the notes.'),
        dry_run: DRY_RUN,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: 'Change a firewall rule' },
    },
    safely(async (args) => {
      const patch: RulePatch = {
        ...(args.action === undefined ? {} : { action: args.action }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      };
      if (Object.keys(patch).length === 0) {
        throw new LittleSnitchError('invalid-input', 'Give at least one of action, priority or notes.');
      }
      let written: JsonObject | undefined;
      const outcome = await applyModelChange(
        ctx,
        (before) => {
          const warning = assertAllowedByLittleSnitch(before, ctx.uid, 'edit-rules');
          const updated = updateRule(before, args.ref, patch, ctx.now());
          // The prompt says what changes and shows the rule as it will be. If either cannot be shown exactly, nobody could approve it knowingly.
          assertFitsPrompt(updated.before, true);
          assertFitsPrompt(updated.after, true);
          const owner = asNumber(updated.after['uid']) ?? ctx.uid;
          const twin =
            semanticKey(updated.before) === semanticKey(updated.after)
              ? undefined
              : rulesOf(before).find(
                  (existing) => existing !== updated.before && semanticKey(existing) === semanticKey(updated.after) && (asNumber(existing['uid']) ?? ctx.uid) === owner,
                );
          if (twin !== undefined) {
            throw new LittleSnitchError('invalid-input', `After this change the rule would mean the same as another rule (ref ${ruleRef(twin)}). Remove one of the two instead.`);
          }
          written = updated.after;
          const prompt = prompts.update(updated.before, updated.after, ctx.uid);
          return {
            tool: 'update_rule',
            summary: `change rule (${describeChanges(updated.before, updated.after).join('; ')}): ${ruleText(updated.before, ctx.uid)}`,
            prompt,
            next: updated.model,
            written: [updated.after],
            removedRefs: [args.ref],
            preview: { before: summarize(updated.before, before), after: summarize(updated.after, before), approvalPrompt: prompt },
            warnings: one(warning),
          };
        },
        args.dry_run === true,
      );
      if (!outcome.applied) {
        return outcome;
      }
      return { applied: true, rule: written === undefined ? null : readBack(outcome.after, written), backup: outcome.backup, approvedThrough: outcome.method, ...sideNotes(outcome) };
    }),
  );

  server.registerTool(
    'remove_rule',
    {
      title: 'Remove a firewall rule',
      description:
        'Remove one rule, found by the ref list_rules shows. Protected and factory rules are refused, and so is a rule the approval prompt could not show exactly (a remote list that is too long, or data it would have to leave out or cut). Removing a deny rule opens the firewall, and removing an allow rule ' +
        `can break an app: state the rule to the person before calling, or call with dry_run first. A backup is saved first, so restore_backup can bring the rule back. ${APPROVAL}`,
      inputSchema: { ref: REF, dry_run: DRY_RUN },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: 'Remove a firewall rule' },
    },
    safely(async (args) => {
      let removedSummary: RuleSummary | undefined;
      const outcome = await applyModelChange(
        ctx,
        (before) => {
          const warning = assertAllowedByLittleSnitch(before, ctx.uid, 'edit-rules');
          const { model: next, removed } = removeRule(before, args.ref);
          assertFitsPrompt(removed, true);
          removedSummary = summarize(removed, before);
          return {
            tool: 'remove_rule',
            summary: `remove rule: ${ruleText(removed, ctx.uid)}`,
            prompt: prompts.remove(removed, ctx.uid),
            next,
            written: [],
            removedRefs: [args.ref],
            preview: { wouldRemove: removedSummary, approvalPrompt: prompts.remove(removed, ctx.uid) },
            warnings: one(warning),
          };
        },
        args.dry_run === true,
      );
      if (!outcome.applied) {
        return outcome;
      }
      return { applied: true, removed: removedSummary ?? null, backup: outcome.backup, approvedThrough: outcome.method, ...sideNotes(outcome) };
    }),
  );
}

function registerRestoreTool(server: McpServer, ctx: Context): void {
  server.registerTool(
    'restore_backup',
    {
      title: 'Restore a backup',
      description:
        'Replace the whole Little Snitch configuration (every rule, group, profile and setting) with a backup this server saved, named as list_backups shows it. ' +
        'Everything changed since that backup is lost, so call with dry_run first and tell the person what would go and what would come back. ' +
        `The current configuration is backed up first. ${APPROVAL}`,
      inputSchema: {
        name: z.string().max(120).describe('The backup\'s file name, as list_backups shows it.'),
        dry_run: DRY_RUN,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: 'Restore a backup' },
    },
    safely(async (args) => {
      const { info, text } = await ctx.store.readBackup(args.name);
      const target = parseModelText(text);
      /** What restoring would do to the configuration as it is now. */
      const effectOn = (current: JsonObject) => {
        const difference = compareModels(target, current);
        return {
          rulesRemoved: difference.unexpected.length,
          rulesAdded: difference.missing.length,
          examplesRemoved: difference.unexpected.slice(0, 10),
          examplesAdded: difference.missing.slice(0, 10),
          otherPartsChanged: difference.changedSections,
          otherChanges: difference.otherChanges,
        };
      };
      if (args.dry_run === true) {
        const { model } = await ctx.models.fresh();
        return { applied: false, dryRun: true, backup: info.name, effect: effectOn(model) };
      }
      return ctx.changes.run(async () => {
        const { model: current, text: currentText } = await ctx.models.fresh();
        const warning = assertAllowedByLittleSnitch(current, ctx.uid, 'edit-rules');
        const effect = effectOn(current);
        // Saving the copy from before must never remove the backup that is being restored.
        const safety = await ctx.store.writeBackup(currentText, 'before-restore_backup', [info.name]);
        // Root restores the content that was read and shown here, from a fresh file, whatever happens to the backup file meanwhile.
        const restored = await restoreText(ctx, text, {
          tool: 'restore_backup',
          summary: `restore the backup ${info.name}`,
          prompt: prompts.restore(info.name, effect.rulesRemoved, effect.rulesAdded, effect.otherPartsChanged.length),
          before: current,
          beforeText: currentText,
          backup: safety,
          expected: target,
        });
        return {
          applied: true,
          restored: info.name,
          rulesNow: rulesOf(restored.after).length,
          effect,
          savedBefore: safety.name,
          approvedThrough: restored.method,
          ...sideNotes({ ...restored, warnings: [...one(warning), ...restored.warnings] }),
        };
      });
    }),
  );
}

/** Registers only the tools the person switched on with --allow. A tool that is not allowed is not offered at all. */
export function registerWriteTools(server: McpServer, ctx: Context): void {
  if (ctx.config.allow.has('switches')) {
    registerSwitchTools(server, ctx);
  }
  if (ctx.config.allow.has('rules')) {
    registerRuleTools(server, ctx);
  }
  if (ctx.config.allow.has('restore')) {
    registerRestoreTool(server, ctx);
  }
}
