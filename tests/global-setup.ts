import { chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Builds the server once before any test file runs. The end-to-end tests start
 * dist/index.js and pack the package, so they need a build, and two test files
 * building in parallel could read a file while the other writes it.
 */
export default function setup(): void {
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: ROOT });
  const entry = path.join(ROOT, 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error('The build produced no dist/index.js.');
  }
  chmodSync(entry, 0o755);
}
