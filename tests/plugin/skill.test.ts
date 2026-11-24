import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from '../helpers/harness.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKILL_DIR = path.join(ROOT, 'skills', 'little-snitch');
const PAGES = ['SKILL.md', 'references/tools.md', 'references/changes.md', 'references/setup-and-recovery.md'];
const TOOL_LIKE = /^(get|list|set|add|update|remove|restore|create)_[a-z_]+$/;

function page(relative: string): string {
  return readFileSync(path.join(SKILL_DIR, relative), 'utf8');
}

function frontmatter(text: string): Readonly<Record<string, string>> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) {
    return {};
  }
  return Object.fromEntries(
    (match[1] ?? '')
      .split('\n')
      .map((line) => /^([a-z_-]+):\s*(.*)$/.exec(line))
      .filter((found): found is RegExpExecArray => found !== null)
      .map((found) => [found[1] ?? '', found[2] ?? '']),
  );
}

/** The text of one `## heading` section, up to the next heading of the same level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) {
    return '';
  }
  const rest = text.slice(start + heading.length + 4);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('the little-snitch skill', () => {
  let serverTools: readonly string[] = [];

  beforeAll(async () => {
    const { client, close } = await startHarness({ allow: 'all' });
    serverTools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    await close();
  });

  it('has a name that matches its folder and a description within the limit', () => {
    const meta = frontmatter(page('SKILL.md'));
    expect(meta['name']).toBe('little-snitch');
    expect(meta['name']).toMatch(/^[a-z0-9-]{1,64}$/);
    const description = meta['description'] ?? '';
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('keeps its main page short enough to load whole', () => {
    expect(page('SKILL.md').split('\n').length).toBeLessThanOrEqual(500);
  });

  it('links only to files that exist', () => {
    for (const file of PAGES) {
      const links = [...page(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((found) => found[1] ?? '');
      for (const link of links.filter((target) => !/^[a-z]+:/.test(target))) {
        expect(existsSync(path.join(SKILL_DIR, path.dirname(file), link)), `${file} -> ${link}`).toBe(true);
      }
    }
  });

  it('describes exactly the tools the server registers, one heading each', () => {
    const headings = [...page('references/tools.md').matchAll(/^### (\S+)$/gm)].map((found) => found[1] ?? '');
    expect(serverTools).toHaveLength(15);
    expect([...headings].sort()).toEqual(serverTools);
  });

  it('names no tool that does not exist', () => {
    for (const file of PAGES) {
      const named = [...page(file).matchAll(/`([a-z_]+)`/g)].map((found) => found[1] ?? '').filter((word) => TOOL_LIKE.test(word));
      expect(named.filter((name) => !serverTools.includes(name)), file).toEqual([]);
    }
  });

  it('starts with get_status and asks for a dry run before a change', () => {
    const text = page('SKILL.md');
    expect(text).toContain('`get_status`');
    expect(text).toContain('`dry_run`');
  });

  it('forbids every way around the server in a section of its own', () => {
    const never = section(page('SKILL.md'), 'Never');
    for (const phrase of ['`littlesnitch`', '`--unattended-writes`', '`--elevation none`', 'administrator dialog', 'lock file']) {
      expect(never, phrase).toContain(phrase);
    }
  });

  it('tells the person to keep one registration of the server', () => {
    expect(page('references/setup-and-recovery.md')).toContain('one registration');
  });

  it('gives Codex a display name and a starter prompt that invokes the skill', () => {
    const yaml = page('agents/openai.yaml');
    expect(yaml).toContain('display_name: "Little Snitch"');
    expect(yaml).toMatch(/short_description: ".+"/);
    expect(yaml).toMatch(/default_prompt: ".*\$little-snitch.*"/);
  });
});
