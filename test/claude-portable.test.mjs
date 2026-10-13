import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { install, doctor, migrate, rollback, updateSkills, helperCommand, portableVersion, portableTransport } from '../src/setup.mjs';
import { resolveRuntime } from '../src/runtime.mjs';
const currentVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const projectId = '8e68aeb1-3a40-454f-a74d-672307e12a37', workspaceId = '411212ef-b143-4cba-8411-5a7d48b616de', attemptId = '8c11c83b-645d-4a76-8aaf-a9ae2f43e561';
const input = { version: 1, client: 'claude', projectId, workspaceId, attemptId, code: 'private_one_time_claude_code', exchangeUrl: 'https://api.example.test/exchange', mcpUrl: 'https://api.example.test/mcp' };
async function fixture(t, legacy = false, windows = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claude-portable-'))); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "한글 project '#%"), storageDir = join(base, "private '#%"); await mkdir(root);
  let exchanges = 0;
  const options = { storageDir, probeClient: async () => ({}), diagnose: async () => ({ status: 'diagnostic_passed' }), fetch: async () => { exchanges++; return Response.json({ value: 'private_claude_test_key', projectId, workspaceId }); } };
  await install(root, input, options);
  const directory = join(storageDir, 'projects', createHash('sha256').update(root).digest('hex')), manifestPath = join(directory, 'installation.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), path = join(root, '.mcp.json');
  let text = await readFile(path, 'utf8');
  if (legacy) {
    const old = { type: 'http', url: input.mcpUrl, headersHelper: helperCommand([process.execPath, manifest.helperPath, '--headers', manifest.credentialPath, projectId, workspaceId], windows ? 'win32' : process.platform), customField: { preserve: true } };
    text = JSON.stringify({ note: 'preserve project setting', mcpServers: { foundocs: old, other: { type: 'stdio', command: 'other' } } }, null, 4);
    await writeFile(path, text); delete manifest.runtimeVersion; await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(directory, 'rollback.json'), JSON.stringify({ root, entries: [{ path, before: text, after: text, mode: 0o644 }] }));
  }
  return { root, path, text, directory, manifest, manifestPath, options, exchanges: () => exchanges };
}

test('AC-49: client-specific version floor and unchanged supported pins', async t => {
  assert.equal(portableVersion(portableTransport(projectId, '0.3.4'), projectId), '0.3.4');
  assert.equal(portableVersion(portableTransport(projectId, '0.3.4', 'claude'), projectId, 'claude'), null);
  const f = await fixture(t); const config = JSON.parse(f.text);
  assert.equal(config.mcpServers.foundocs.type, 'stdio');
  assert.equal(portableVersion(config.mcpServers.foundocs, projectId, 'claude'), currentVersion);
  for (const pin of ['0.3.5', '0.4.0']) {
    config.mcpServers.foundocs.args[1] = `@foundocs/foundocs-setup@${pin}`;
    const text = JSON.stringify(config, null, 3); await writeFile(f.path, text);
    await install(f.root, input, f.options);
    assert.equal(await readFile(f.path, 'utf8'), text);
    assert.equal((await doctor(f.root, f.options)).status, 'configured');
  }
  config.mcpServers.foundocs.args[1] = '@foundocs/foundocs-setup@0.3.4'; await writeFile(f.path, JSON.stringify(config));
  await assert.rejects(install(f.root, input, f.options), { stage: 'preflight' });
  await assert.rejects(doctor(f.root, f.options), /configuration differs/);
});

for (const windows of [false, true]) test(`AC-51: offline Claude migration preserves JSON/custom settings, key and rollback (${windows ? 'encoded Windows' : 'POSIX'} helper)`, async t => {
  const f = await fixture(t, true, windows), key = await readFile(f.manifest.credentialPath, 'utf8');
  await assert.rejects(doctor(f.root, f.options), /migrate/);
  await updateSkills(f.root, f.options); assert.equal(await readFile(f.path, 'utf8'), f.text);
  const offline = { ...f.options, fetch: () => { throw Error('network forbidden'); }, diagnose: () => { throw Error('network forbidden'); } };
  assert.equal((await migrate(f.root, offline)).status, 'migrated');
  const config = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(config.mcpServers.foundocs.customField, { preserve: true });
  assert.equal(config.note, 'preserve project setting'); assert.equal(config.mcpServers.other.command, 'other');
  assert.equal(config.mcpServers.foundocs.headersHelper, undefined); assert.equal(config.mcpServers.foundocs.url, undefined);
  assert.equal(portableVersion(config.mcpServers.foundocs, projectId, 'claude'), currentVersion);
  assert.equal((await migrate(f.root, offline)).status, 'already_portable');
  assert.equal((await doctor(f.root, f.options)).status, 'configured');
  assert.equal(await readFile(f.manifest.credentialPath, 'utf8'), key); assert.equal(f.exchanges(), 1);
  assert.equal((await rollback(f.root, f.options)).ok, true); assert.equal(await readFile(f.path, 'utf8'), f.text);
  assert.equal((await migrate(f.root, offline)).status, 'migrated');
});

for (const override of [{ url: 'https://other.invalid/mcp' }, { headersHelper: 'echo foreign' }, { headers: { Authorization: 'foreign' } }, { env: {} }, { cwd: '/another' }]) test('AC-51: changed or unsafe HTTP transport is preserved and diagnosed as conflict', async t => {
  const f = await fixture(t, true), config = JSON.parse(f.text); Object.assign(config.mcpServers.foundocs, override);
  const changed = JSON.stringify(config); await writeFile(f.path, changed);
  await assert.rejects(migrate(f.root, f.options), { stage: 'preflight' });
  await assert.rejects(install(f.root, input, f.options), { stage: 'preflight' });
  await assert.rejects(doctor(f.root, f.options), /configuration conflict/);
  assert.equal(await readFile(f.path, 'utf8'), changed); assert.equal(f.exchanges(), 1);
});

test('AC-51: foreign backup-only or absent ownership cannot adopt an HTTP helper', async t => {
  for (const backupOnly of [false, true]) {
    const f = await fixture(t, true);
    if (!backupOnly) await rm(join(f.directory, 'rollback.json'));
    else await writeFile(join(f.directory, 'rollback.json'), JSON.stringify({ root: f.root, entries: [{ path: f.path, before: f.text, after: '{"mcpServers":{}}' }] }));
    await assert.rejects(migrate(f.root, f.options), { stage: 'preflight' });
    assert.equal(await readFile(f.path, 'utf8'), f.text);
  }
});

test('AC-51: partial install migration preserves concurrent JSON, retries, and rollback retains later user edits', async t => {
  const f = await fixture(t, true); const changed = JSON.parse(f.text); changed.concurrent = true;
  const text = JSON.stringify(changed);
  await assert.rejects(install(f.root, input, { ...f.options, probeClient: async () => { await writeFile(f.path, text); return {}; } }), { stage: 'configuration' });
  assert.equal(await readFile(f.path, 'utf8'), text); await install(f.root, input, f.options);
  const after = JSON.parse(await readFile(f.path, 'utf8')); assert.equal(after.concurrent, true);
  after.laterEdit = true; const later = JSON.stringify(after); await writeFile(f.path, later);
  assert.ok((await rollback(f.root, f.options)).conflicts.includes(f.path));
  assert.equal(await readFile(f.path, 'utf8'), later); assert.equal(f.exchanges(), 1);
});

test('AC-50: Claude runtime validates nearest project and private authentication with the common resolver', async t => {
  const f = await fixture(t), nested = join(f.root, 'src'); await mkdir(nested);
  assert.equal((await resolveRuntime(projectId, { ...f.options, cwd: nested })).client, 'claude');
  for (const text of ['{', JSON.stringify({ project_id: workspaceId })]) {
    await writeFile(join(nested, 'foundocs.json'), text);
    await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: nested }), { stage: 'runtime' });
  }
  await rm(join(nested, 'foundocs.json')); await mkdir(join(nested, '.git'));
  await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: nested }), { stage: 'runtime' });
  await chmod(f.manifest.credentialPath, 0o644);
  if (process.platform !== 'win32') await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: f.root }), { stage: 'runtime' });
});


test('AC-49: noncanonical npm version pins stop before credential exchange', async t => {
  for (const pin of ['00.3.5', '0.03.5', '0.3.05']) {
    const f = await fixture(t), config = JSON.parse(f.text);
    config.mcpServers.foundocs.args[1] = `@foundocs/foundocs-setup@${pin}`;
    const text = JSON.stringify(config); await writeFile(f.path, text);
    assert.equal(portableVersion(config.mcpServers.foundocs, projectId, 'claude'), null);
    await assert.rejects(install(f.root, { ...input, attemptId: workspaceId }, f.options), { stage: 'preflight' });
    assert.equal(f.exchanges(), 1); assert.equal(await readFile(f.path, 'utf8'), text);
  }
});
