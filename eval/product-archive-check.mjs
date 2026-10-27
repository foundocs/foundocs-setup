// Run from the installer checkout. Product sources remain in their own repository.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const product = resolve(process.env.FOUNDOCS_PRODUCT_DIR ?? '../foundocs');
const tarball = process.env.SETUP_CHECK_PACKAGE;
assert.ok(tarball?.endsWith('.tgz'), 'SETUP_CHECK_PACKAGE must identify the actual npm pack tarball');
const base = await mkdtemp(join(tmpdir(), 'foundocs-archive-package-'));
const script = join(product, 'apps/server/scripts', `.archive-package-${process.pid}.ts`);
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: product, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    assert.equal(code, 0, `Integration child failed: ${stderr.slice(-3000)}`);
    return stdout;
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); }
}
try {
  await run('npm', ['install', '--prefix', base, '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', resolve(tarball)]);
  const installed = join(base, 'node_modules/@foundocs/foundocs-setup');
  const baselinePrefix = join(base, 'baseline');
  await run('npm', ['install', '--prefix', baselinePrefix, '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', process.env.SETUP_BASELINE_PACKAGE ?? '@foundocs/foundocs-setup@0.3.12']);
  const baseline = join(baselinePrefix, 'node_modules/@foundocs/foundocs-setup');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@foundocs/foundocs-setup');
  await copyFile(new URL('./product-archive-fixture.ts', import.meta.url), script);
  process.stdout.write(await run(join(product, 'apps/server/node_modules/.bin/tsx'), [script], { ...process.env, ARCHIVE_SETUP_PACKAGE: installed, ARCHIVE_BASELINE_PACKAGE: baseline }));
} finally { await rm(script, { force: true }); await rm(base, { recursive: true, force: true }); }
