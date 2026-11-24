#!/usr/bin/env node
// Writes the package version into every file that names it: the two plugin
// manifests, the two marketplaces, and the install commands in the README and
// the skill. `npm version` runs it as the "version" script, in the package
// folder, and it stages the files it changed, so the commit and tag that a
// plain `npm version` makes hold them too. A test fails if any file still
// names another version, and prepublishOnly runs the tests.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE_NAME = 'little-snitch-mcp-server';
export const VERSION_PIN = /little-snitch-mcp-server@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];

function editJson(transform) {
  return (text) => `${JSON.stringify(transform(JSON.parse(text)), null, 2)}\n`;
}

function withPluginVersions(marketplace, version) {
  return {
    ...marketplace,
    plugins: marketplace.plugins.map((plugin) =>
      plugin.source?.package === PACKAGE_NAME ? { ...plugin, source: { ...plugin.source, version } } : plugin,
    ),
  };
}

function markdownUnder(root, relativeDir) {
  const full = path.join(root, relativeDir);
  if (!existsSync(full)) {
    return [];
  }
  return readdirSync(full, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => path.join(relativeDir, name));
}

/**
 * Writes `version` into every file that names the package version under `root`
 * and returns the paths (relative to `root`) it changed. It reads every file
 * before it writes any, so a missing manifest changes nothing.
 */
export function syncVersion(root, version) {
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not a version such as 1.2.3.`);
  }
  const pin = `${PACKAGE_NAME}@${version}`;
  const edits = [
    ...MANIFESTS.map((file) => [file, editJson((manifest) => ({ ...manifest, version }))]),
    ...MARKETPLACES.map((file) => [file, editJson((marketplace) => withPluginVersions(marketplace, version))]),
    ...['README.md', ...markdownUnder(root, 'skills')].map((file) => [file, (text) => text.replace(VERSION_PIN, pin)]),
  ];
  const missing = edits.map(([file]) => file).filter((file) => !existsSync(path.join(root, file)));
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} is missing, so its version cannot be updated.`);
  }
  const results = edits.map(([file, edit]) => {
    const before = readFileSync(path.join(root, file), 'utf8');
    return { file, before, after: edit(before) };
  });
  const changed = results.filter(({ before, after }) => before !== after);
  for (const { file, after } of changed) {
    writeFileSync(path.join(root, file), after);
  }
  return changed.map(({ file }) => file);
}

function insideGitWorkTree(root) {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // npm runs lifecycle scripts in the package folder.
  const root = process.cwd();
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changed = syncVersion(root, version);
  if (changed.length === 0) {
    process.stdout.write(`Every file already names version ${version}.\n`);
  } else if (insideGitWorkTree(root)) {
    execFileSync('git', ['add', '--', ...changed], { cwd: root });
    process.stdout.write(`Version ${version} written to and staged: ${changed.join(', ')}\n`);
  } else {
    process.stdout.write(`Version ${version} written to: ${changed.join(', ')}\nAdd these files to the release commit.\n`);
  }
}
