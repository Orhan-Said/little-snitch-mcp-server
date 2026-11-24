#!/usr/bin/env node
// Writes the package version into every file that names it: the two plugin
// manifests, the two marketplaces, and the install commands in the README and
// the skill. `npm version` runs it (the "version" script in package.json), so a
// release cannot ship a plugin that names another version.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changed = syncVersion(root, version);
  process.stdout.write(
    changed.length === 0
      ? `Every file already names version ${version}.\n`
      : `Version ${version} written to: ${changed.join(', ')}\nAdd these files to the release commit.\n`,
  );
}
