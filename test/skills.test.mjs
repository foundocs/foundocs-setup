import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { install, updateSkills, doctor, rollback } from '../src/setup.mjs';

const projectId = '8e68aeb1-3a40-454f-a74d-672307e12a37';
const workspaceId = '411212ef-b143-4cba-8411-5a7d48b616de';
const input = { version: 1, client: 'codex', projectId, workspaceId, attemptId: '8c11c83b-645d-4a76-8aaf-a9ae2f43e561', code: 'private_one_time_skill_fixture', exchangeUrl: 'https://api.example.test/setup/exchange', mcpUrl: 'https://api.example.test/mcp' };
const skillNames = ['SKILL.md', 'references/writing-guide.md'];
const hash = text => createHash('sha256').update(text).digest('hex');
const assetDirectory = client => `${client === 'codex' ? '.agents' : '.claude'}/skills/foundocs-capture-knowledge`;
const originalAgents = '# Existing project instructions\nKeep this unrelated rule.\n';

async function fixture(t, client = 'codex') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'foundocs-skills-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "프로젝트 '#%"), storageDir = join(base, 'private');
  await mkdir(root);
  await writeFile(join(root, 'AGENTS.md'), originalAgents);
  if (client === 'claude') await writeFile(join(root, 'CLAUDE.md'), '# Unrelated Claude instructions\n');
  const calls = { exchange: 0, probe: 0, diagnostic: 0 };
  const options = {
    storageDir,
    probeClient: async () => { calls.probe++; return { client, version: 'fixture' }; },
    fetch: async () => { calls.exchange++; return Response.json({ value: 'private_skill_fixture_key', projectId, workspaceId }); },
    diagnose: async () => { calls.diagnostic++; return { status: 'diagnostic_passed', hostVerification: 'required' }; },
  };
  return { root, storageDir, client, calls, options, input: { ...input, client }, assetRoot: join(root, assetDirectory(client)) };
}

async function installation(f) {
  const [name] = await readdir(join(f.storageDir, 'projects'));
  const directory = join(f.storageDir, 'projects', name);
  return { directory, manifest: JSON.parse(await readFile(join(directory, 'installation.json'), 'utf8')) };
}

async function snapshot(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(path, 'utf8')])));
}

function offlineOptions(f) {
  const forbidden = async () => assert.fail('update-skills must not probe clients, exchange keys, or diagnose MCP');
  return { ...f.options, fetch: forbidden, probeClient: forbidden, diagnose: forbidden };
}

async function preSkillInstallation(f, historical) {
  await install(f.root, f.input, f.options);
  const saved = await installation(f);
  await rm(f.assetRoot, { recursive: true });
  await rm(join(f.root, f.client === 'codex' ? '.agents' : '.claude', 'skills/foundocs'), { recursive: true });
  await rm(join(saved.directory, 'skills.json'), { force: true });
  await rm(join(saved.directory, 'rollback.json'), { force: true });
  const brand = historical ? 'steerdocs' : 'foundocs';
  const configName = f.client === 'codex' ? '.codex/config.toml' : '.mcp.json';
  await writeFile(join(f.root, 'AGENTS.md'), `${originalAgents}\n<!-- ${brand}:setup:start -->\nRead ${brand}.json and pass project_id explicitly.\n<!-- ${brand}:setup:end -->\n`);
  if (f.client === 'claude') await writeFile(join(f.root, 'CLAUDE.md'), `# Unrelated Claude instructions\n<!-- ${brand}:setup:start -->\nRead @AGENTS.md.\n<!-- ${brand}:setup:end -->\n`);
  if (historical) {
    delete saved.manifest.brandingVersion;
    await writeFile(join(saved.directory, 'installation.json'), JSON.stringify(saved.manifest));
    await rename(join(f.root, 'foundocs.json'), join(f.root, 'steerdocs.json'));
    const config = await readFile(join(f.root, configName), 'utf8');
    await writeFile(join(f.root, configName), f.client === 'codex'
      ? config.replace('[mcp_servers.foundocs]', '[mcp_servers.steerdocs]')
      : config.replace('"foundocs":', '"steerdocs":'));
  }
  return { ...saved, protectedPaths: [join(f.root, `${brand}.json`), join(f.root, configName), saved.manifest.credentialPath, saved.manifest.helperPath, join(dirname(saved.manifest.helperPath), 'legacy-compat.mjs'), ...(f.client === 'codex' ? [join(dirname(saved.manifest.helperPath), 'bridge-v1.mjs')] : []), join(saved.directory, 'installation.json')] };
}

test('AC-26: both clients install the same English skill and references with resolvable instruction links', async t => {
  const contents = [];
  for (const client of ['codex', 'claude']) {
    const f = await fixture(t, client);
    const foreign = join(f.root, client === 'codex' ? '.agents' : '.claude', 'skills', 'unrelated', 'SKILL.md');
    await mkdir(dirname(foreign), { recursive: true });
    await writeFile(foreign, 'Keep my unrelated skill.');
    const result = await install(f.root, f.input, f.options);
    assert.equal(result.skills.status, 'installed');
    assert.equal(result.skills.hostVerification, 'required');
    const files = await Promise.all(skillNames.map(name => readFile(join(f.assetRoot, name), 'utf8')));
    assert.match(files[0], /name: foundocs-capture-knowledge/);
    for (const text of files) assert.doesNotMatch(text, /[\uac00-\ud7a3]/);
    contents.push(files);
    const agents = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith(originalAgents));
    const block = agents.split('<!-- foundocs:setup:start -->')[1]?.split('<!-- foundocs:setup:end -->')[0]
      ?? agents.split('<!-- steerdocs:setup:start -->')[1].split('<!-- steerdocs:setup:end -->')[0];
    assert.ok(block.length < 1200, 'always-loaded bootstrap must stay compact');
    assert.doesNotMatch(block, /view: "index"|shouldPrompt|dream_memory/);
    assert.match(block, /same turn/);
    assert.match(block, /explicit user request/);
    const prefix = client === 'codex' ? '.agents' : '.claude';
    assert.ok(block.includes(`](${prefix}/skills/foundocs/SKILL.md)`));
    const documents = await readFile(join(f.root, prefix, 'skills/foundocs/references/documents.md'), 'utf8');
    assert.match(documents, /view: "index"/);
    assert.match(documents, /missing entries do not prove absence/);
    assert.match(documents, /older server lacks index mode/);
    assert.match(documents, /Explicit user destinations and formats take precedence/);
    const configuration = await readFile(join(f.root, prefix, 'skills/foundocs/references/configuration.md'), 'utf8');
    assert.match(configuration, /never reinterpret the root/);
    assert.match(configuration, /stop all Foundocs calls/);
    const discoverySkill = await readFile(join(f.root, client === 'codex' ? '.agents' : '.claude', 'skills/foundocs/SKILL.md'), 'utf8');
    assert.match(discoverySkill, /recently beneficial retrievals/);
    assert.match(discoverySkill, /Never conclude that a document does not exist/);
    assert.match(discoverySkill, /unsupported-view validation error/);

    assert.ok(agents.includes(`](${assetDirectory(client)}/SKILL.md)`));
    assert.equal(await readFile(foreign, 'utf8'), 'Keep my unrelated skill.');
    if (client === 'claude') assert.ok((await readFile(join(f.root, 'CLAUDE.md'), 'utf8')).startsWith('# Unrelated Claude instructions\n'));
    assert.deepEqual((await install(f.root, f.input, f.options)).changedFiles, []);
    assert.equal(f.calls.exchange, 1);
  }
  assert.deepEqual(contents[0], contents[1]);
});

for (const client of ['codex', 'claude']) for (const historical of [false, true]) {
  test(`AC-28: ${client} ${historical ? 'historical' : 'current'} pre-skill installation updates offline without touching connection files`, async t => {
    const f = await fixture(t, client);
    const saved = await preSkillInstallation(f, historical);
    const before = await snapshot(saved.protectedPaths);
    const result = await updateSkills(f.root, offlineOptions(f));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skills_updated');
    assert.equal(result.skills.status, 'installed');
    assert.equal(result.skills.hostVerification, 'required');
    for (const name of skillNames) assert.ok(result.changedFiles.includes(join(f.assetRoot, name)));
    assert.deepEqual(await snapshot(saved.protectedPaths), before);
    const agents = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith(originalAgents));
    const block = agents.split('<!-- foundocs:setup:start -->')[1]?.split('<!-- foundocs:setup:end -->')[0]
      ?? agents.split('<!-- steerdocs:setup:start -->')[1].split('<!-- steerdocs:setup:end -->')[0];
    assert.ok(block.length < 1200, 'always-loaded bootstrap must stay compact');
    assert.doesNotMatch(block, /view: "index"|shouldPrompt|dream_memory/);
    assert.match(block, /same turn/);
    assert.match(block, /explicit user request/);
    const prefix = client === 'codex' ? '.agents' : '.claude';
    assert.ok(block.includes(`](${prefix}/skills/foundocs/SKILL.md)`));
    const documents = await readFile(join(f.root, prefix, 'skills/foundocs/references/documents.md'), 'utf8');
    assert.match(documents, /view: "index"/);
    assert.match(documents, /missing entries do not prove absence/);
    assert.match(documents, /older server lacks index mode/);
    assert.match(documents, /Explicit user destinations and formats take precedence/);
    const configuration = await readFile(join(f.root, prefix, 'skills/foundocs/references/configuration.md'), 'utf8');
    assert.match(configuration, /never reinterpret the root/);
    assert.match(configuration, /stop all Foundocs calls/);
    const discoverySkill = await readFile(join(f.root, client === 'codex' ? '.agents' : '.claude', 'skills/foundocs/SKILL.md'), 'utf8');
    assert.match(discoverySkill, /recently beneficial retrievals/);
    assert.match(discoverySkill, /Never conclude that a document does not exist/);
    assert.match(discoverySkill, /unsupported-view validation error/);

    assert.ok(agents.includes(`${historical ? 'steerdocs' : 'foundocs'}.json`));
    assert.ok(agents.includes(`${assetDirectory(client)}/SKILL.md`));
    assert.deepEqual((await updateSkills(f.root, offlineOptions(f))).changedFiles, []);
    assert.deepEqual(await snapshot(saved.protectedPaths), before);
    assert.equal(f.calls.exchange, 1);
  });
}

for (const client of ['codex', 'claude']) test(`AC-29: ${client} foreign same-name assets stop fresh installation before exchange or project writes`, async t => {
  const f = await fixture(t, client);
  await mkdir(f.assetRoot, { recursive: true });
  const path = join(f.assetRoot, 'SKILL.md');
  await writeFile(path, '# My own same-name skill\n');
  const before = await snapshot([path, join(f.root, 'AGENTS.md')]);
  await assert.rejects(install(f.root, f.input, f.options), { stage: 'preflight' });
  assert.equal(f.calls.exchange, 0);
  assert.deepEqual(await snapshot(Object.keys(before)), before);
  assert.equal(await readFile(join(f.root, 'foundocs.json')).catch(e => e.code), 'ENOENT');
});

test('AC-29: modified managed assets stop both update and new-attempt install without changing instructions or consuming a code', async t => {
  const f = await fixture(t);
  await install(f.root, f.input, f.options);
  const path = join(f.assetRoot, 'references/writing-guide.md');
  await writeFile(path, `${await readFile(path, 'utf8')}\nMy local customization.\n`);
  const saved = await installation(f);
  const before = await snapshot([path, join(f.root, 'AGENTS.md'), join(saved.directory, 'skills.json'), saved.manifest.credentialPath]);
  await assert.rejects(updateSkills(f.root, offlineOptions(f)), { stage: 'preflight' });
  await assert.rejects(install(f.root, { ...f.input, attemptId: '7bc0257d-dc37-4e4d-ae69-6d55002f3ec3' }, f.options), { stage: 'preflight' });
  assert.equal(f.calls.exchange, 1);
  assert.deepEqual(await snapshot(Object.keys(before)), before);
});

test('AC-29: malformed update markers preserve missing assets and existing instructions', async t => {
  const f = await fixture(t);
  await preSkillInstallation(f, false);
  const path = join(f.root, 'AGENTS.md');
  const malformed = '<!-- foundocs:setup:start -->\nUser content with no end marker.\n';
  await writeFile(path, malformed);
  await assert.rejects(updateSkills(f.root, offlineOptions(f)), { stage: 'preflight' });
  assert.equal(await readFile(path, 'utf8'), malformed);
  assert.equal(await readFile(join(f.assetRoot, 'SKILL.md')).catch(e => e.code), 'ENOENT');
});

for (const linkedName of ['.agents', '.agents/skills', '.agents/skills/foundocs-capture-knowledge', '.agents/skills/foundocs-capture-knowledge/SKILL.md']) {
  test(`AC-29: symlink ${linkedName} is rejected before exchange and preserves its target`, async t => {
    const f = await fixture(t);
    const target = join(dirname(f.root), 'outside');
    if (linkedName.endsWith('SKILL.md')) await writeFile(target, 'Unrelated external file');
    else await mkdir(target);
    const path = join(f.root, linkedName);
    await mkdir(dirname(path), { recursive: true });
    await symlink(target, path);
    await assert.rejects(install(f.root, f.input, f.options), { stage: 'preflight' });
    assert.equal(f.calls.exchange, 0);
    assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), originalAgents);
    if (linkedName.endsWith('SKILL.md')) assert.equal(await readFile(target, 'utf8'), 'Unrelated external file');
    else assert.deepEqual(await readdir(target), []);
  });
}

test('AC-29: interrupted asset writes retry using the saved key and rollback includes assets', async t => {
  const f = await fixture(t);
  const obstructed = join(f.assetRoot, 'references/writing-guide.md');
  const fetch = async (...args) => {
    await mkdir(obstructed, { recursive: true });
    return f.options.fetch(...args);
  };
  await assert.rejects(install(f.root, f.input, { ...f.options, fetch }), { stage: 'configuration' });
  await rm(obstructed, { recursive: true });
  const result = await install(f.root, f.input, f.options);
  assert.equal(result.reusedCredential, true);
  assert.equal(f.calls.exchange, 1);
  for (const name of skillNames) assert.ok((await readFile(join(f.assetRoot, name), 'utf8')).length > 0);
  const restored = await rollback(f.root, f.options);
  assert.equal(restored.ok, true);
  for (const name of skillNames) assert.equal(await readFile(join(f.assetRoot, name)).catch(e => e.code), 'ENOENT');
  assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), originalAgents);
});

test('AC-29: rollback preserves concurrent skill edits while removing untouched assets', async t => {
  const f = await fixture(t);
  await install(f.root, f.input, f.options);
  const path = join(f.assetRoot, 'SKILL.md');
  const modified = `${await readFile(path, 'utf8')}\nMy concurrent change.\n`;
  await writeFile(path, modified);
  const result = await rollback(f.root, f.options);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, [path]);
  assert.equal(await readFile(path, 'utf8'), modified);
  assert.equal(await readFile(join(f.assetRoot, 'references/writing-guide.md')).catch(e => e.code), 'ENOENT');
  assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), originalAgents);
});

for (const scenario of ['missing', 'outdated', 'conflict']) test(`AC-30: doctor reports ${scenario} skill assets separately from connection diagnostics`, async t => {
  const f = await fixture(t);
  await install(f.root, f.input, f.options);
  const path = join(f.assetRoot, 'SKILL.md');
  if (scenario === 'missing') await rm(path);
  else {
    const changed = '# Earlier or locally modified skill content\n';
    await writeFile(path, changed);
    if (scenario === 'outdated') {
      const { directory } = await installation(f);
      const statePath = join(directory, 'skills.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      state.files[`${assetDirectory(f.client)}/SKILL.md`].installedHash = hash(changed);
      await writeFile(statePath, JSON.stringify(state));
    }
  }
  await assert.rejects(doctor(f.root, f.options), error => {
    assert.equal(error.stage, 'skills');
    assert.equal(error.details.skills.status, scenario);
    return true;
  });
  if (scenario !== 'conflict') {
    await updateSkills(f.root, offlineOptions(f));
    const result = await doctor(f.root, f.options);
    assert.equal(result.skills.status, 'installed');
    assert.equal(result.skills.hostVerification, 'required');
    assert.equal(result.diagnostic.status, 'diagnostic_passed');
  }
});


test('AC-29: an owned earlier skill remains updateable after update and rollback', async t => {
  const f = await fixture(t);
  await install(f.root, f.input, f.options);
  const { directory } = await installation(f);
  const path = join(f.assetRoot, 'SKILL.md');
  const bundled = await readFile(path, 'utf8');
  const earlier = '# Earlier released skill content\n';
  await writeFile(path, earlier);
  const statePath = join(directory, 'skills.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.files[`${assetDirectory(f.client)}/SKILL.md`].installedHash = hash(earlier);
  await writeFile(statePath, JSON.stringify(state));
  await rm(join(directory, 'rollback.json'));
  await updateSkills(f.root, offlineOptions(f));
  assert.equal(await readFile(path, 'utf8'), bundled);
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.equal(await readFile(path, 'utf8'), earlier);
  await updateSkills(f.root, offlineOptions(f));
  assert.equal(await readFile(path, 'utf8'), bundled);
  assert.deepEqual((await updateSkills(f.root, offlineOptions(f))).changedFiles, []);
  assert.equal(f.calls.exchange, 1);
});

test('AC-30: doctor distinguishes malformed managed instructions as a skill conflict', async t => {
  const f = await fixture(t);
  await install(f.root, f.input, f.options);
  const path = join(f.root, 'AGENTS.md');
  const malformed = '<!-- foundocs:setup:start -->\nKeep this malformed content.\n';
  await writeFile(path, malformed);
  await assert.rejects(doctor(f.root, f.options), error => {
    assert.equal(error.stage, 'skills');
    assert.equal(error.details.skills.status, 'conflict');
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), malformed);
});

for (const client of ['codex', 'claude']) test(`${client}: existing knowledge bundle gains Dreaming offline and rollback preserves the prior bundle`, async t => {
  const f = await fixture(t, client);
  await install(f.root, f.input, f.options);
  const { directory, manifest } = await installation(f);
  const prefix = client === 'codex' ? '.agents' : '.claude';
  const dreamRoot = join(f.root, prefix, 'skills/foundocs');
  await rm(dreamRoot, { recursive: true });
  const statePath = join(directory, 'skills.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const name of Object.keys(state.files)) if (name.startsWith(`${prefix}/skills/foundocs/`)) delete state.files[name];
  await writeFile(statePath, JSON.stringify(state));
  await rm(join(directory, 'rollback.json'));
  const protectedPaths = [...skillNames.map(name => join(f.assetRoot, name)), join(f.root, 'foundocs.json'), manifest.credentialPath, manifest.helperPath];
  const before = await snapshot(protectedPaths);
  await assert.rejects(doctor(f.root, f.options), error => error.details.skills.status === 'missing');
  const result = await updateSkills(f.root, offlineOptions(f));
  for (const name of ['SKILL.md', 'references/dreaming.md']) assert.ok(result.changedFiles.includes(join(dreamRoot, name)));
  assert.deepEqual(await snapshot(protectedPaths), before);
  const agents = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(`](${assetDirectory(client)}/SKILL.md)`));
  assert.ok(agents.includes(`](${prefix}/skills/foundocs/SKILL.md)`));
  assert.deepEqual((await updateSkills(f.root, offlineOptions(f))).changedFiles, []);
  assert.equal((await doctor(f.root, f.options)).ok, true);
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.deepEqual(await snapshot(protectedPaths), before);
  assert.equal(await readFile(join(dreamRoot, 'SKILL.md')).catch(error => error.code), 'ENOENT');
  assert.equal(f.calls.exchange, 1);
});

for (const client of ['codex', 'claude']) test(`${client}: update replaces a verbose managed block while preserving surrounding instructions and rollback`, async t => {
  const f = await fixture(t, client);
  const saved = await preSkillInstallation(f, false);
  const agentsPath = join(f.root, 'AGENTS.md');
  const suffix = '\n# User instructions after Foundocs\nKeep these too.\n';
  const before = `${originalAgents}\n<!-- foundocs:setup:start -->\n## Foundocs\n${'Detailed setup policy. '.repeat(300)}\n<!-- foundocs:setup:end -->${suffix}`;
  await writeFile(agentsPath, before);
  const protectedBefore = await snapshot(saved.protectedPaths);
  await updateSkills(f.root, offlineOptions(f));
  const after = await readFile(agentsPath, 'utf8');
  assert.ok(after.startsWith(originalAgents));
  assert.ok(after.endsWith(suffix));
  assert.ok(after.length < before.length / 4);
  assert.equal(after.split('<!-- foundocs:setup:start -->').length, 2);
  assert.deepEqual(await snapshot(saved.protectedPaths), protectedBefore);
  assert.deepEqual((await updateSkills(f.root, offlineOptions(f))).changedFiles, []);
  assert.equal((await rollback(f.root, offlineOptions(f))).ok, true);
  assert.equal(await readFile(agentsPath, 'utf8'), before);
});
