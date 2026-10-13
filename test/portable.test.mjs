import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, cp, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { install, doctor, migrate, rollback, updateSkills, portableVersion } from '../src/setup.mjs';
import { resolveRuntime } from '../src/runtime.mjs';

const projectId = '8e68aeb1-3a40-454f-a74d-672307e12a37';
const workspaceId = '411212ef-b143-4cba-8411-5a7d48b616de';
const attemptId = '8c11c83b-645d-4a76-8aaf-a9ae2f43e561';
const input = { version: 1, client: 'codex', projectId, workspaceId, attemptId, code: 'private_one_time_portable_code', exchangeUrl: 'https://api.example.test/exchange', mcpUrl: 'https://api.example.test/mcp' };
const hash = value => createHash('sha256').update(value).digest('hex');
const exec = promisify(execFile);
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'portable-tests-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, '한글 project A'), homeDir = join(base, 'user A'); await mkdir(root); await mkdir(homeDir);
  let exchanges = 0;
  const options = { homeDir, probeClient: async () => ({}), diagnose: async () => ({ status: 'diagnostic_passed' }), fetch: async () => { exchanges++; return Response.json({ value: 'private_portable_test_key', projectId, workspaceId }); } };
  await install(root, input, options);
  const directory = join(homeDir, '.local/share/foundocs/setup/projects', hash(root));
  const manifestPath = join(directory, 'installation.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return { base, root, homeDir, directory, manifestPath, manifest, options, config: join(root, '.codex/config.toml'), exchanges: () => exchanges };
}
async function legacyFixture(t) {
  const f = await fixture(t);
  const old = { command: process.execPath, args: [join(f.homeDir, '.local/share/foundocs/setup/bridge-v1.mjs'), f.manifest.credentialPath, projectId, workspaceId, input.mcpUrl], tool_timeout_sec: 91, enabled_tools: ['get_project_context'], env_vars: ['CUSTOM_NAME'] };
  const text = '# Keep my model\nmodel = "fixture"\n[mcp_servers.foundocs] # keep table\n# Keep server note\n' + stringify(old).replace('command = ', '# command comment\ncommand = ').replace(/\nargs = /, '\n# arguments comment\nargs = ') + '\n[mcp_servers.other]\ncommand="other"\n';
  await writeFile(f.config, text);
  delete f.manifest.runtimeVersion;
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await writeFile(join(f.directory, 'rollback.json'), JSON.stringify({ root: f.root, entries: [{ path: f.config, before: text, after: text, mode: 0o644 }] }));
  return { ...f, old, text };
}

test('AC-42/46: clone with another home/root adopts identical shared configuration and assets', async t => {
  const f = await fixture(t); const before = await readFile(f.config, 'utf8');
  const clone = join(f.base, '팀원 clone B'), homeDir = join(f.base, 'user B');
  await cp(f.root, clone, { recursive: true }); await mkdir(homeDir);
  await assert.rejects(resolveRuntime(projectId, { cwd: clone, homeDir }), { stage: 'runtime' });
  const result = await install(clone, input, { ...f.options, homeDir });
  assert.deepEqual(result.changedFiles, []);
  assert.equal(await readFile(join(clone, '.codex/config.toml'), 'utf8'), before);
  assert.equal((await resolveRuntime(projectId, { cwd: clone, homeDir })).root, clone);
  assert.notEqual((await resolveRuntime(projectId, { cwd: clone, homeDir })).credentialPath, f.manifest.credentialPath);
  assert.ok(!before.includes(f.root) && !before.includes(f.homeDir) && !before.includes('private_portable_test_key'));
  assert.deepEqual((await install(clone, input, { ...f.options, homeDir })).changedFiles, []);
});

test('AC-43/44: nearest project, canonical aliases, malformed/nested config and Git boundary', async t => {
  const f = await fixture(t); const nested = join(f.root, 'src', '공백 child'); await mkdir(nested, { recursive: true });
  assert.equal((await resolveRuntime(projectId, { ...f.options, cwd: nested })).root, f.root);
  const alias = join(f.base, 'alias'); await symlink(f.root, alias, 'dir');
  assert.equal((await resolveRuntime(projectId, { ...f.options, cwd: alias })).root, f.root);
  for (const text of ['{', '[]', '{}', JSON.stringify({ project_id: workspaceId }), JSON.stringify({ project_id: projectId })]) {
    await writeFile(join(nested, 'foundocs.json'), text);
    await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: nested }), { stage: 'runtime' });
  }
  await rm(join(nested, 'foundocs.json')); await mkdir(join(nested, '.git'));
  await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: nested }), { stage: 'runtime' });
});

for (const field of ['root', 'projectId', 'workspaceId', 'mcpUrl', 'credentialPath', 'attemptId']) test(`AC-44: rejects mismatched private ${field}`, async t => {
  const f = await fixture(t);
  const changed = { ...f.manifest, [field]: field.endsWith('Id') ? '7bc0257d-dc37-4e4d-ae69-6d55002f3ec3' : field === 'mcpUrl' ? 'https://other.invalid/mcp' : join(f.base, 'another') };
  await writeFile(f.manifestPath, JSON.stringify(changed));
  await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: f.root }), { stage: 'runtime' });
});

test('AC-44: rejects credential endpoint mismatch, unsafe permissions and symlinks', async t => {
  const f = await fixture(t); const text = await readFile(f.manifest.credentialPath, 'utf8');
  await writeFile(f.manifest.credentialPath, JSON.stringify({ ...JSON.parse(text), mcpUrl: 'https://other.invalid/mcp' }));
  await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: f.root }), { stage: 'runtime' });
  await writeFile(f.manifest.credentialPath, text); await chmod(f.manifest.credentialPath, 0o644);
  if (process.platform !== 'win32') await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: f.root }), { stage: 'runtime' });
  await chmod(f.manifest.credentialPath, 0o600);
  const alternate = join(f.base, 'alternate-key'); await writeFile(alternate, text, { mode: 0o600 });
  await rm(f.manifest.credentialPath); await symlink(alternate, f.manifest.credentialPath);
  await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: f.root }), { stage: 'runtime' });
});

test('AC-44: unconfigured CLI has empty stdout and an actionable redacted error', async t => {
  const f = await fixture(t); const empty = join(f.base, 'empty'); await mkdir(empty);
  await assert.rejects(exec(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, 'mcp', '--project-id', projectId], { cwd: empty, env: { ...process.env, FOUNDOCS_SETUP_HOME: join(f.base, 'unused-private') } }), error => {
    assert.equal(error.stdout, ''); assert.match(error.stderr, /integration install/);
    assert.ok(!error.stderr.includes(f.manifest.credentialPath) && !error.stderr.includes('private_portable_test_key'));
    return true;
  });
});

test('AC-45/46: migrate needs no key exchange, preserves customization, repeats, and rolls back', async t => {
  const f = await legacyFixture(t); const keyBefore = await readFile(f.manifest.credentialPath, 'utf8');
  await assert.rejects(doctor(f.root, f.options), /migrate/);
  const beforeSkillUpdate = await readFile(f.config, 'utf8'); await updateSkills(f.root, f.options);
  assert.equal(await readFile(f.config, 'utf8'), beforeSkillUpdate);
  const result = await migrate(f.root, f.options); assert.equal(result.status, 'migrated');
  const after = await readFile(f.config, 'utf8');
  for (const fragment of ['# Keep my model', '# keep table', '# Keep server note', '# command comment', '# arguments comment', '[mcp_servers.other]\ncommand="other"']) assert.ok(after.includes(fragment), fragment);
  const server = parse(after).mcp_servers.foundocs;
  assert.equal(server.tool_timeout_sec, 91); assert.deepEqual(server.enabled_tools, ['get_project_context']); assert.ok(server.env_vars.includes('CUSTOM_NAME'));
  assert.equal(portableVersion(server, projectId), '0.3.4');
  assert.equal(f.exchanges(), 1); assert.equal(await readFile(f.manifest.credentialPath, 'utf8'), keyBefore);
  assert.equal((await migrate(f.root, f.options)).status, 'already_portable');
  assert.equal((await doctor(f.root, f.options)).status, 'configured');
  assert.equal((await rollback(f.root, f.options)).ok, true); assert.equal(await readFile(f.config, 'utf8'), f.text);
});

test('AC-45: installer rerun migrates, detects concurrent edits, retries from journal, and preserves rollback edits', async t => {
  const f = await legacyFixture(t);
  const concurrent = f.text + '# simultaneous edit\n';
  await assert.rejects(install(f.root, input, { ...f.options, probeClient: async () => { await writeFile(f.config, concurrent); return {}; } }), { stage: 'configuration' });
  assert.equal(await readFile(f.config, 'utf8'), concurrent);
  await install(f.root, input, f.options);
  assert.equal(f.exchanges(), 1);
  const after = await readFile(f.config, 'utf8'); assert.ok(after.includes('# simultaneous edit'));
  await writeFile(f.config, after + '# later user edit\n');
  const result = await rollback(f.root, f.options); assert.ok(result.conflicts.includes(f.config));
  assert.equal(await readFile(f.config, 'utf8'), after + '# later user edit\n');
});

test('AC-45: absent evidence, backed-up foreign transport and changed command are never adopted', async t => {
  for (const scenario of ['absent', 'backup-only', 'changed']) {
    const f = await legacyFixture(t);
    if (scenario === 'absent') await rm(join(f.directory, 'rollback.json'));
    if (scenario === 'backup-only') await writeFile(join(f.directory, 'rollback.json'), JSON.stringify({ root: f.root, entries: [{ path: f.config, before: f.text, after: '[mcp_servers.other]\ncommand="other"\n' }] }));
    if (scenario === 'changed') await writeFile(f.config, f.text.replace(JSON.stringify(process.execPath), '"/other/node"'));
    const before = await readFile(f.config, 'utf8');
    await assert.rejects(migrate(f.root, f.options), { stage: 'preflight' });
    assert.equal(await readFile(f.config, 'utf8'), before); assert.equal(f.exchanges(), 1);
  }
});

for (const override of [{ cwd: '/another' }, { env: { FOUNDOCS_SETUP_HOME: '/another' } }, { env_vars: [] }, { args: ['--yes', '@foundocs/foundocs-setup@latest', 'mcp', '--project-id', projectId] }]) test('AC-46: doctor and install reject unsafe or non-reproducible portable overrides', async t => {
  const f = await fixture(t); const config = parse(await readFile(f.config, 'utf8')); Object.assign(config.mcp_servers.foundocs, override);
  await writeFile(f.config, stringify(config)); const before = await readFile(f.config, 'utf8');
  await assert.rejects(doctor(f.root, f.options), /configuration differs/);
  await assert.rejects(install(f.root, input, f.options), { stage: 'preflight' });
  assert.equal(await readFile(f.config, 'utf8'), before);
});

test('AC-46: re-authentication preserves an existing exact portable runtime pin', async t => {
  const f = await fixture(t); const text = (await readFile(f.config, 'utf8')).replace('@0.3.4', '@0.4.0'); await writeFile(f.config, text);
  await install(f.root, { ...input, attemptId: '7bc0257d-dc37-4e4d-ae69-6d55002f3ec3' }, f.options);
  assert.equal(await readFile(f.config, 'utf8'), text);
  assert.equal(JSON.parse(await readFile(f.manifestPath, 'utf8')).runtimeVersion, '0.4.0');
});


test('AC-44: historical nearer or conflicting configuration cannot select a parent/current key', async t => {
  const f = await fixture(t);
  const nested = join(f.root, 'historical child'); await mkdir(nested);
  await writeFile(join(nested, 'steerdocs.json'), JSON.stringify({ project_id: workspaceId }));
  await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: nested }), { stage: 'runtime' });
  await writeFile(join(f.root, 'steerdocs.json'), JSON.stringify({ project_id: workspaceId }));
  await assert.rejects(resolveRuntime(projectId, { ...f.options, cwd: f.root }), { stage: 'runtime' });
});

test('AC-45: migration remains repeatable after restoring its legacy baseline', async t => {
  const f = await legacyFixture(t);
  await migrate(f.root, f.options);
  await rollback(f.root, f.options);
  assert.equal(await readFile(f.config, 'utf8'), f.text);
  assert.equal((await migrate(f.root, f.options)).status, 'migrated');
  assert.equal(f.exchanges(), 1);
});

test('AC-45: migration preserves a trailing custom setting without final newline', async t => {
  const f = await legacyFixture(t);
  const text = f.text.split('\n[mcp_servers.other]')[0].trimEnd() + '\ntool_timeout_sec = 92';
  const clean = text.replace('tool_timeout_sec = 91\n', '');
  await writeFile(f.config, clean);
  await migrate(f.root, f.options);
  assert.equal(parse(await readFile(f.config, 'utf8')).mcp_servers.foundocs.tool_timeout_sec, 92);
});

test('AC-46: doctor distinguishes a changed execution command from an owned legacy transport', async t => {
  const f = await fixture(t);
  await writeFile(f.config, (await readFile(f.config, 'utf8')).replace('command = "npx"', 'command = "foreign-runtime"'));
  await assert.rejects(doctor(f.root, f.options), error => error.stage === 'diagnostic' && /conflict|differs/.test(error.message) && !/Run foundocs-setup migrate/.test(error.message));
});
