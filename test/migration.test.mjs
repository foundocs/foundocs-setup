import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir, rename, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import { install, doctor, rollback, storageBase } from '../src/setup.mjs';
import { readCredential } from '../src/auth.mjs';

const projectId = '8e68aeb1-3a40-454f-a74d-672307e12a37';
const workspaceId = '411212ef-b143-4cba-8411-5a7d48b616de';
const attemptId = '8c11c83b-645d-4a76-8aaf-a9ae2f43e561';
const key = 'private_migration_fixture_key';
const input = { version: 1, client: 'codex', projectId, workspaceId, attemptId, code: 'private_one_time_migration_input', exchangeUrl: 'https://api.example.test/setup/exchange', mcpUrl: 'https://api.example.test/mcp' };

async function fixture(t, client = 'codex', { keepJournal = false } = {}) {
  const homeDir = await realpath(await mkdtemp(join(tmpdir(), 'migration-tests-')));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const root = join(homeDir, 'project'), storageDir = join(homeDir, '.local/share/steerdocs/setup');
  await mkdir(root);
  await writeFile(join(root, 'AGENTS.md'), '# User rules\nKeep this unchanged.\n');
  if (client === 'codex') {
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex/config.toml'), '# Keep this comment\n[mcp_servers.other]\ncommand="other"\n');
  } else await writeFile(join(root, '.mcp.json'), '{"mcpServers":{"other":{"command":"other"}},"custom":true}');
  let exchanges = 0;
  const options = { homeDir, probeClient: async () => ({ client, version: 'fixture' }), diagnose: async () => ({ status: 'diagnostic_passed' }),
    fetch: async () => { exchanges++; return Response.json({ value: key, projectId, workspaceId }); } };
  await install(root, { ...input, client }, { ...options, storageDir });
  const [rootHash] = await readdir(join(storageDir, 'projects'));
  const directory = join(storageDir, 'projects', rootHash), manifestPath = join(directory, 'installation.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.brandingVersion;
  await writeFile(manifestPath, JSON.stringify(manifest));
  // A 0.1.x installation did not include the new skill assets or ownership state.
  const assetRoot = join(root, client === 'codex' ? '.agents' : '.claude', 'skills', 'foundocs-capture-knowledge');
  await rm(assetRoot, { recursive: true });
  const dreamingRoot = join(root, client === 'codex' ? '.agents' : '.claude', 'skills', 'foundocs');
  await rm(dreamingRoot, { recursive: true });
  await rm(join(directory, 'skills.json'));
  const historical = value => value.replaceAll('foundocs', 'steerdocs').replaceAll('FOUNDOCS', 'STEERDOCS');
  const configName = client === 'codex' ? '.codex/config.toml' : '.mcp.json';
  for (const name of ['AGENTS.md', configName, ...(client === 'claude' ? ['CLAUDE.md'] : [])]) {
    const path = join(root, name); await writeFile(path, historical(await readFile(path, 'utf8')));
  }
  await rename(join(root, 'foundocs.json'), join(root, 'steerdocs.json'));
  const journalPath = join(directory, 'rollback.json');
  if (keepJournal) {
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.entries = journal.entries.filter(entry => !entry.path.startsWith(`${assetRoot}/`) && !entry.path.startsWith(`${dreamingRoot}/`));
    await writeFile(journalPath, historical(JSON.stringify(journal)));
  } else await rm(journalPath);
  return { homeDir, root, storageDir, directory, manifest, configName, options, input: { ...input, client }, exchanges: () => exchanges };
}

for (const client of ['codex', 'claude']) test(`${client}: legacy doctor, migration, repeat and rollback preserve credentials and foreign settings`, async t => {
  const f = await fixture(t, client);
  const before = Object.fromEntries(await Promise.all(['steerdocs.json', 'AGENTS.md', f.configName, ...(client === 'claude' ? ['CLAUDE.md'] : [])].map(async name => [name, await readFile(join(f.root, name), 'utf8')])));
  const privateBefore = await readFile(f.manifest.credentialPath, 'utf8');
  await assert.rejects(doctor(f.root, f.options), { stage: 'skills', details: { skills: { status: 'missing' } } });
  assert.equal(await storageBase(f.options, f.root), f.storageDir);
  const result = await install(f.root, f.input, f.options);
  assert.equal(result.reusedCredential, true);
  assert.equal(f.exchanges(), 1);
  assert.equal(await readFile(f.manifest.credentialPath, 'utf8'), privateBefore);
  assert.equal(await readFile(join(f.root, 'steerdocs.json'), 'utf8').catch(e => e.code), 'ENOENT');
  const agents = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# User rules\nKeep this unchanged.\n'));
  assert.ok(agents.includes('<!-- foundocs:setup:start -->'));
  assert.ok(!agents.includes('steerdocs'));
  const text = await readFile(join(f.root, f.configName), 'utf8');
  const servers = client === 'codex' ? parse(text).mcp_servers : JSON.parse(text).mcpServers;
  assert.ok(servers.foundocs); assert.ok(servers.other); assert.equal(servers.steerdocs, undefined);
  if (client === 'codex') assert.ok(text.startsWith('# Keep this comment\n'));
  assert.equal((await doctor(f.root, f.options)).status, 'configured');
  assert.deepEqual((await install(f.root, f.input, f.options)).changedFiles, []);
  assert.equal((await rollback(f.root, f.options)).ok, true);
  for (const [name, text] of Object.entries(before)) assert.equal(await readFile(join(f.root, name), 'utf8'), text);
  assert.equal(await readFile(join(f.root, 'foundocs.json'), 'utf8').catch(e => e.code), 'ENOENT');
  await assert.rejects(doctor(f.root, f.options), { stage: 'skills', details: { skills: { status: 'missing' } } });
});

test('migration preserves the original installation rollback baseline', async t => {
  const f = await fixture(t, 'codex', { keepJournal: true });
  await install(f.root, f.input, f.options);
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), '# User rules\nKeep this unchanged.\n');
  for (const name of ['steerdocs.json', 'foundocs.json']) assert.equal(await readFile(join(f.root, name), 'utf8').catch(e => e.code), 'ENOENT');
});

for (const scenario of ['project', 'foreign-server', 'both-servers', 'markers', 'symlink']) test(`legacy ${scenario} conflict stops before exchange and preserves source files`, async t => {
  const f = await fixture(t, 'claude');
  if (scenario === 'project') await writeFile(join(f.root, 'foundocs.json'), JSON.stringify({ project_id: workspaceId }));
  if (scenario === 'foreign-server' || scenario === 'both-servers') {
    const config = JSON.parse(await readFile(join(f.root, f.configName), 'utf8'));
    if (scenario === 'foreign-server') config.mcpServers.steerdocs.url = 'https://other.test/mcp';
    else config.mcpServers.foundocs = config.mcpServers.steerdocs;
    await writeFile(join(f.root, f.configName), JSON.stringify(config));
  }
  if (scenario === 'markers') await writeFile(join(f.root, 'AGENTS.md'), '<!-- steerdocs:setup:start -->\n<!-- foundocs:setup:start -->\n<!-- foundocs:setup:end -->\n<!-- steerdocs:setup:end -->');
  if (scenario === 'symlink') { await rename(join(f.root, 'steerdocs.json'), join(f.root, 'outside.json')); await symlink(join(f.root, 'outside.json'), join(f.root, 'steerdocs.json')); }
  const before = await readFile(join(f.root, f.configName), 'utf8');
  await assert.rejects(install(f.root, { ...f.input, attemptId: '7bc0257d-dc37-4e4d-ae69-6d55002f3ec3' }, f.options), { stage: 'preflight' });
  assert.equal(f.exchanges(), 1);
  assert.equal(await readFile(join(f.root, f.configName), 'utf8'), before);
});

test('partial migration retains old configuration and retries with the saved key', async t => {
  const f = await fixture(t);
  const agents = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
  await assert.rejects(install(f.root, f.input, { ...f.options, probeClient: async () => { await writeFile(join(f.root, 'AGENTS.md'), 'Concurrent edit'); return {}; } }), { stage: 'configuration' });
  assert.ok(await readFile(join(f.root, 'steerdocs.json'), 'utf8'));
  assert.ok(await readFile(join(f.root, 'foundocs.json'), 'utf8'));
  assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), 'Concurrent edit');
  await writeFile(join(f.root, 'AGENTS.md'), agents);
  await install(f.root, f.input, f.options);
  assert.equal(f.exchanges(), 1);
  assert.equal((await doctor(f.root, f.options)).status, 'configured');
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), agents);
});

test('default storage refuses dual installations and chooses current name for new roots', async t => {
  const f = await fixture(t);
  const current = join(f.homeDir, '.local/share/foundocs/setup');
  const duplicate = join(current, 'projects', basename(f.directory));
  await mkdir(duplicate, { recursive: true });
  await writeFile(join(duplicate, 'installation.json'), JSON.stringify(f.manifest));
  await assert.rejects(storageBase(f.options, f.root), { stage: 'preflight' });
  assert.equal(await storageBase({ ...f.options, storageDir: f.storageDir }, f.root), f.storageDir);
  assert.equal(await storageBase(f.options, join(f.homeDir, 'new-project')), current);
});

test('legacy and new credential namespaces never mix or override another scope', async t => {
  const f = await fixture(t);
  const names = ['STEERDOCS_API_KEY', 'STEERDOCS_PROJECT_ID', 'STEERDOCS_WORKSPACE_ID', 'FOUNDOCS_API_KEY', 'FOUNDOCS_PROJECT_ID', 'FOUNDOCS_WORKSPACE_ID'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { STEERDOCS_API_KEY: 'old-override', STEERDOCS_PROJECT_ID: projectId, STEERDOCS_WORKSPACE_ID: workspaceId });
    assert.equal(await readCredential(f.manifest.credentialPath, projectId, workspaceId), 'old-override');
    process.env.FOUNDOCS_API_KEY = 'unscoped-new';
    assert.equal(await readCredential(f.manifest.credentialPath, projectId, workspaceId), key);
    Object.assign(process.env, { FOUNDOCS_PROJECT_ID: projectId, FOUNDOCS_WORKSPACE_ID: workspaceId });
    assert.equal(await readCredential(f.manifest.credentialPath, projectId, workspaceId), 'unscoped-new');
    process.env.FOUNDOCS_WORKSPACE_ID = projectId;
    assert.equal(await readCredential(f.manifest.credentialPath, projectId, workspaceId), key);
  } finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
