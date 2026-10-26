import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { autoUpdate, updateCommand } from '../skills/foundocs/scripts/session-start.mjs';
import { install, updateSkills, rollback } from '../src/setup.mjs';

const projectId = '8e68aeb1-3a40-454f-a74d-672307e12a37';
const workspaceId = '411212ef-b143-4cba-8411-5a7d48b616de';
const execute = promisify(execFile);
async function fixture(t, client = 'codex') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'foundocs-session-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project ' $(literal) 한글"), storageDir = join(base, 'private');
  await mkdir(root);
  const hookFile = join(root, client === 'codex' ? '.codex/hooks.json' : '.claude/settings.json');
  await mkdir(join(root, client === 'codex' ? '.codex' : '.claude'));
  const original = { permissions: { allow: ['keep'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
  await writeFile(hookFile, JSON.stringify(original));
  const options = { storageDir, probeClient: async () => ({}), diagnose: async () => ({}), fetch: async () => Response.json({ value: 'private_fixture_key', projectId, workspaceId }) };
  const input = { version: 1, client, projectId, workspaceId, attemptId: '8c11c83b-645d-4a76-8aaf-a9ae2f43e561', code: 'private_one_time_fixture', exchangeUrl: 'https://example.test/exchange', mcpUrl: 'https://example.test/mcp' };
  const checkOptions = { stateDirectory: join(base, 'checks'), installedVersion: '1.0.0', readInstalledVersion: async () => '1.0.0', fetch: async () => Response.json({ name: '@foundocs/foundocs-setup', version: '1.1.0' }) };
  return { base, root, storageDir, options, input, hookFile, original, checkOptions };
}

for (const client of ['codex', 'claude']) test(`${client}: install/update preserve settings, install one executable hook, and roll back`, async t => {
  const f = await fixture(t, client);
  await install(f.root, f.input, f.options);
  const config = JSON.parse(await readFile(f.hookFile, 'utf8'));
  assert.deepEqual(config.permissions, f.original.permissions);
  assert.deepEqual(config.hooks.Stop, f.original.hooks.Stop);
  assert.deepEqual(config.hooks.SessionStart[0], f.original.hooks.SessionStart[0]);
  assert.equal(config.hooks.SessionStart.length, 2);
  const handler = config.hooks.SessionStart[1].hooks[0];
  assert.equal(handler.timeout, 60);
  // Execute the actual generated shell command from a nested cwd, with network
  // replaced by a current-version response. No npm execution is needed.
  const stub = join(f.base, 'registry.mjs');
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
  await writeFile(stub, `globalThis.fetch = async () => Response.json({ name: '@foundocs/foundocs-setup', version: '${version}' });`);
  const { stdout, stderr } = await execute('/bin/sh', ['-c', handler.command], { cwd: join(f.root, client === 'codex' ? '.codex' : '.claude'), env: { ...process.env, FOUNDOCS_SETUP_HOME: f.storageDir, NODE_OPTIONS: `--import=${stub}` } });
  assert.equal(stdout, ''); assert.equal(stderr, '');
  assert.deepEqual((await updateSkills(f.root, f.options)).changedFiles, []);
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.deepEqual(JSON.parse(await readFile(f.hookFile, 'utf8')), f.original);
  assert.equal((await install(f.root, f.input, f.options)).ok, true);
});

test('modified or removed managed hook prevents writes, while unrelated hook edits are retained', async t => {
  const f = await fixture(t);
  await install(f.root, f.input, f.options);
  const config = JSON.parse(await readFile(f.hookFile, 'utf8'));
  config.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo added' }] });
  await writeFile(f.hookFile, JSON.stringify(config));
  assert.deepEqual((await updateSkills(f.root, f.options)).changedFiles, []);
  const original = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
  for (const modified of [ { ...config, hooks: { ...config.hooks, SessionStart: config.hooks.SessionStart.slice(0, 1) } }, { ...config, hooks: { ...config.hooks, SessionStart: config.hooks.SessionStart.map((group, index) => index === 1 ? { ...group, matcher: 'startup' } : group) } } ]) {
    const before = JSON.stringify(modified);
    await writeFile(f.hookFile, before);
    await assert.rejects(updateSkills(f.root, f.options), /session hook was modified or removed/);
    assert.equal(await readFile(f.hookFile, 'utf8'), before);
    assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), original);
  }
});

test('each session performs a fresh lookup and installs the exact newer stable version without a prompt', async t => {
  const f = await fixture(t);
  let lookups = 0, installs = 0;
  const options = { ...f.checkOptions, fetch: async () => { lookups++; return Response.json({ name: '@foundocs/foundocs-setup', version: '1.1.0' }); }, runUpdate: async (root, version) => { assert.equal(root, f.root); assert.equal(version, '1.1.0'); installs++; return { ok: true, skills: { status: 'installed' } }; } };
  for (let i = 0; i < 2; i++) assert.deepEqual(await autoUpdate(f.root, options), { status: 'updated', version: '1.1.0' });
  assert.equal(lookups, 2); assert.equal(installs, 2);
  const [command, args] = updateCommand(f.root, '1.1.0');
  assert.equal(command, 'npx');
  assert.deepEqual(args, ['--yes', '@foundocs/foundocs-setup@1.1.0', 'update-skills', '--root', f.root]);
  const [windows, windowsArgs] = updateCommand(f.root, '1.1.0', 'win32');
  assert.equal(windows, 'powershell.exe');
  assert.ok(Buffer.from(windowsArgs.at(-1), 'base64').toString('utf16le').includes("project '' $(literal) 한글"));
});

test('concurrent newer installation prevents downgrade; failures and invalid releases remain quiet', async t => {
  const f = await fixture(t);
  const forbidden = async () => assert.fail('must not run npm');
  assert.equal((await autoUpdate(f.root, { ...f.checkOptions, readInstalledVersion: async () => '1.2.0', runUpdate: forbidden })).status, 'up_to_date');
  assert.equal((await autoUpdate(f.root, { ...f.checkOptions, fetch: async () => { throw new Error('private value'); }, runUpdate: forbidden })).status, 'unavailable');
  for (const version of ['1.0.0', '0.9.0', '2.0.0-beta', 'bad; command']) {
    const result = await autoUpdate(f.root, { ...f.checkOptions, fetch: async () => Response.json({ name: '@foundocs/foundocs-setup', version }), runUpdate: forbidden });
    assert.notEqual(result.status, 'updated');
  }
  assert.deepEqual(await autoUpdate(f.root, { ...f.checkOptions, runUpdate: async () => { throw new Error('private child stderr'); } }), { status: 'unavailable' });
  assert.deepEqual(await autoUpdate(f.root, { ...f.checkOptions, runUpdate: async () => ({ ok: false }) }), { status: 'unavailable' });
});

for (const client of ['codex', 'claude']) test(`${client}: generated hook executes npm and emits only confirmed update context`, async t => {
  const f = await fixture(t, client);
  await install(f.root, f.input, f.options);
  const prefix = client === 'codex' ? '.agents' : '.claude';
  const releasePath = join(f.root, prefix, 'skills/foundocs/release.json');
  const config = JSON.parse(await readFile(f.hookFile, 'utf8'));
  const hook = config.hooks.SessionStart[1].hooks[0].command;
  const registry = join(f.base, 'registry.mjs'), bin = join(f.base, 'bin');
  await mkdir(bin);
  await writeFile(registry, "globalThis.fetch = async () => Response.json({ name: '@foundocs/foundocs-setup', version: '999.0.0' });");
  const npm = join(bin, 'npx');
  await writeFile(npm, `#!/usr/bin/env node\nconst assert = require('node:assert/strict'); const fs = require('node:fs'); assert.deepEqual(process.argv.slice(2), ['--yes','@foundocs/foundocs-setup@999.0.0','update-skills','--root',process.cwd()]); fs.writeFileSync(${JSON.stringify(releasePath)}, JSON.stringify({version:'999.0.0'})); console.log(JSON.stringify({ok:true,skills:{status:'installed'}}));`);
  await chmod(npm, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOUNDOCS_SETUP_HOME: f.storageDir, NODE_OPTIONS: `--import=${registry}` };
  const result = await execute('/bin/sh', ['-c', hook], { cwd: f.root, env });
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'SessionStart');
  assert.match(output.additionalContext, /updated to 999\.0\.0/);
  assert.equal(output.reloadSkills, client === 'claude' ? true : undefined);
  assert.equal(result.stderr, '');
  await writeFile(releasePath, JSON.stringify({ version: '1.0.0' }));
  await writeFile(npm, '#!/usr/bin/env node\nconsole.error("private child diagnostic"); process.exit(1);');
  const failed = await execute('/bin/sh', ['-c', hook], { cwd: f.root, env });
  assert.equal(failed.stdout, ''); assert.equal(failed.stderr, '');
  // The update command also rejects a stale process after a newer installation.
  await writeFile(releasePath, JSON.stringify({ version: '999.0.0' }));
  await assert.rejects(updateSkills(f.root, f.options), /newer skill release is already installed/);
});
