import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyModelChange, restoreVerified } from '../apply.js';
import { assertFitsPrompt, prompts, ruleText, shown } from '../approval.js';
import type { Context } from '../context.js';
import { LittleSnitchError } from '../errors.js';
import { addRule, buildRule, removeRule, SPECIAL_REMOTES, updateRule, validateNewRule, type NewRuleSpec, type RulePatch } from '../model/edit.js';
import { groupDisplayNames, resolveGroup, summarizeGroups } from '../model/groups.js';
import { asNumber, asString, parseModelText, rulesOf, sha256, type JsonObject } from '../model/json.js';
import { activeProfile, resolveProfile } from '../model/profiles.js';
import { ruleRef, semanticKey, summarizeRule, tolerantKey, type RuleSummary } from '../model/rules.js';
import { compareModels } from '../model/verify.js';
import { NAME_CACHE_MS, safely } from './shared.js';

const REF = z.string().regex(/^r[0-9a-f]{12}$/, 'A rule reference looks like r1a2b3c4d5e6f, as list_rules shows it.');
const DRY_RUN = z.boolean().optional().describe('When true, nothing is changed: the result shows what would happen.');
const APPROVAL =
  'The person at the Mac approves each change in the macOS administrator dialog, which states the change, unless they switched that off. ' +
  'Afterwards the whole configuration is read back and compared; if anything differs from what was intended, the change is undone.';

function summarize(rule: JsonObject, model: JsonObject): RuleSummary {
  return summarizeRule(rule, groupDisplayNames(model));
}

/** Finds, in the configuration read back, the rule that was written. */
function readBack(after: JsonObject, written: JsonObject): RuleSummary | null {
  const key = tolerantKey(written);
  const found = rulesOf(after).findLast((rule) => tolerantKey(rule) === key);
  return found === undefined ? null : summarize(found, after);
}

function registerSwitchTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'set_active_profile',
    {
      title: 'Switch profile',
      description:
        'Activate a Little Snitch profile by its exact name, or deactivate all profiles. A profile changes which rules apply, so it can loosen or tighten the firewall; ' +
        'say which profile you are switching to and why before calling. The person at the Mac approves the switch in the macOS administrator dialog, unless they switched that off.',
      inputSchema: {
        profile: z.string().max(200).nullable().describe('Exact profile name as list_profiles shows it, or null to deactivate all profiles.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Switch profile' },
    },
    safely(({ profile }) =>
      ctx.changes.run(async () => {
        if (profile !== null) {
          resolveProfile(await ctx.models.get(NAME_CACHE_MS), profile);
        }
        const summary = profile === null ? 'deactivate all profiles' : `activate profile "${shown(profile, 80)}"`;
        ctx.models.clear();
        const result = profile === null ? await ctx.cli.deactivateAllProfiles() : await ctx.cli.activateProfile(profile);
        const after = parseModelText(result.modelText);
        ctx.models.put(after);
        const active = activeProfile(after, ctx.uid);
        if (active.known && active.name !== profile) {
          await ctx.store.audit({ tool: 'set_active_profile', summary, outcome: 'failed', method: result.method, detail: `active is ${String(active.name)}` });
          throw new LittleSnitchError('verification-failed', `Little Snitch accepted the request, but the active profile reads as ${active.name === null ? 'none' : `"${active.name}"`}.`);
        }
        await ctx.store.audit({ tool: 'set_active_profile', summary, outcome: 'applied', method: result.method });
        return {
          applied: true,
          activeProfile: profile,
          confirmedByReadBack: active.known,
          ...(active.known ? {} : { note: 'Little Snitch accepted the request. The configuration does not say which profile is active in a form this server recognises, so it was not double-checked.' }),
          approvedThrough: result.method,
        };
      }),
    ),
  );

  server.registerTool(
    'set_rule_group_enabled',
    {
      title: 'Switch a rule group or blocklist on or off',
      description:
        'Switch a Little Snitch rule group or blocklist on or off, by the exact id or name list_rule_groups shows. Switching a group off stops its rules from applying, ' +
        'which can loosen the firewall; say what you are switching and why before calling. The person at the Mac approves the switch in the macOS administrator dialog, unless they switched that off.',
      inputSchema: {
        group: z.string().min(1).max(200).describe('The group\'s id or its exact name, as list_rule_groups shows it.'),
        enabled: z.boolean().describe('true switches the group on, false switches it off.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Switch a rule group or blocklist' },
    },
    safely(({ group, enabled }) =>
      ctx.changes.run(async () => {
        const target = resolveGroup(await ctx.models.get(NAME_CACHE_MS), group);
        if (target.name === null) {
          throw new LittleSnitchError(
            'not-found',
            `The built-in group with kind "${target.kind ?? 'unknown'}" has no name in the configuration, and Little Snitch only accepts a name. Switch it in Little Snitch itself.`,
            { remedy: 'Please report this group kind and the name Little Snitch shows for it, so it can be added.' },
          );
        }
        const summary = `switch rule group "${shown(target.name, 80)}" ${enabled ? 'on' : 'off'}`;
        ctx.models.clear();
        const result = await ctx.cli.setRuleGroupEnabled(target.name, enabled);
        const after = parseModelText(result.modelText);
        ctx.models.put(after);
        const now = summarizeGroups(after).find((entry) => entry.id === target.id);
        if (now === undefined || now.active !== enabled) {
          await ctx.store.audit({ tool: 'set_rule_group_enabled', summary, outcome: 'failed', method: result.method });
          throw new LittleSnitchError('verification-failed', `Little Snitch accepted the request, but the group "${target.name}" does not read as ${enabled ? 'on' : 'off'}.`);
        }
        await ctx.store.audit({ tool: 'set_rule_group_enabled', summary, outcome: 'applied', method: result.method });
        return { applied: true, group: { id: target.id, name: target.name }, enabled, confirmedByReadBack: true, approvedThrough: result.method };
      }),
    ),
  );
}

function registerRuleTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'add_rule',
    {
      title: 'Add a firewall rule',
      description:
        'Add one Little Snitch rule that allows or denies connections of a process to a remote. Give exactly one of remote_domains, remote_hosts, remote_addresses or remote. ' +
        'The rule applies in all profiles and is marked in its notes as added through MCP. A rule for any process and any remote is refused, and so is a remote list too long to show in the approval prompt. ' +
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
            summary: `add rule: ${ruleText(rule)}`,
            prompt: prompts.add(rule),
            next: addRule(before, rule),
            written: [rule],
            removedRefs: [],
            preview: { wouldAdd: summarize(rule, before), approvalPrompt: prompts.add(rule) },
          };
        },
        args.dry_run === true,
      );
      if (!outcome.applied) {
        return outcome;
      }
      return { applied: true, rule: built === undefined ? null : readBack(outcome.after, built), backup: outcome.backup, approvedThrough: outcome.method };
    }),
  );

  server.registerTool(
    'update_rule',
    {
      title: 'Change a firewall rule',
      description:
        'Change the action, priority or notes of one rule, found by the ref list_rules shows. Protected and factory rules are refused. ' +
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
          const updated = updateRule(before, args.ref, patch, ctx.now());
          written = updated.after;
          const was = (key: string, fallback: string): string => asString(updated.before[key]) ?? fallback;
          const now = (key: string, fallback: string): string => asString(updated.after[key]) ?? fallback;
          const changes = [
            ...(was('action', '') === now('action', '') ? [] : [`action ${was('action', 'none').toUpperCase()} becomes ${now('action', 'none').toUpperCase()}`]),
            ...(was('priority', 'regular') === now('priority', 'regular') ? [] : [`priority ${was('priority', 'regular')} becomes ${now('priority', 'regular')}`]),
            ...(was('notes', '') === now('notes', '') ? [] : ['notes change']),
          ];
          return {
            tool: 'update_rule',
            summary: `change rule (${changes.join('; ')}): ${ruleText(updated.before)}`,
            prompt: prompts.update(updated.before, changes),
            next: updated.model,
            written: [updated.after],
            removedRefs: [args.ref],
            preview: { before: summarize(updated.before, before), after: summarize(updated.after, before), approvalPrompt: prompts.update(updated.before, changes) },
          };
        },
        args.dry_run === true,
      );
      if (!outcome.applied) {
        return outcome;
      }
      return { applied: true, rule: written === undefined ? null : readBack(outcome.after, written), backup: outcome.backup, approvedThrough: outcome.method };
    }),
  );

  server.registerTool(
    'remove_rule',
    {
      title: 'Remove a firewall rule',
      description:
        'Remove one rule, found by the ref list_rules shows. Protected and factory rules are refused. Removing a deny rule opens the firewall, and removing an allow rule ' +
        `can break an app: state the rule to the person before calling, or call with dry_run first. A backup is saved first, so restore_backup can bring the rule back. ${APPROVAL}`,
      inputSchema: { ref: REF, dry_run: DRY_RUN },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, title: 'Remove a firewall rule' },
    },
    safely(async (args) => {
      let removedSummary: RuleSummary | undefined;
      const outcome = await applyModelChange(
        ctx,
        (before) => {
          const { model: next, removed } = removeRule(before, args.ref);
          removedSummary = summarize(removed, before);
          return {
            tool: 'remove_rule',
            summary: `remove rule: ${ruleText(removed)}`,
            prompt: prompts.remove(removed),
            next,
            written: [],
            removedRefs: [args.ref],
            preview: { wouldRemove: removedSummary, approvalPrompt: prompts.remove(removed) },
          };
        },
        args.dry_run === true,
      );
      if (!outcome.applied) {
        return outcome;
      }
      return { applied: true, removed: removedSummary ?? null, backup: outcome.backup, approvedThrough: outcome.method };
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
        const effect = effectOn(current);
        const safety = await ctx.store.writeBackup(currentText, 'before-restore_backup');
        const { after, method } = await restoreVerified(ctx, {
          tool: 'restore_backup',
          summary: `restore the backup ${info.name}`,
          prompt: prompts.restore(info.name, effect.rulesRemoved, effect.rulesAdded, effect.otherPartsChanged.length),
          before: current,
          beforeText: currentText,
          backup: safety,
          file: info.path,
          // The checksum of what was read and shown here. Root restores this content or nothing.
          fileSha256: sha256(text),
          expected: target,
        });
        return { applied: true, restored: info.name, rulesNow: rulesOf(after).length, effect, savedBefore: safety.name, approvedThrough: method };
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
