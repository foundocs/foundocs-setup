import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parse, stringify } from 'smol-toml';
import { install, updateInstallation, updateSkills, upgradeRuntime, rollback, doctor, portableVersion, portableTransport } from '../src/setup.mjs';
import { install as installPrevious, portableTransport as previousPortableTransport } from 'foundocs-setup-previous/src/setup.mjs';
import { episodeCheckpoint } from '../skills/foundocs/scripts/episode-checkpoint.mjs';
const currentVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

test('Codex requires the environment list belonging to the pinned release', () => {
  const projectId = randomUUID();
  assert.equal(portableVersion(previousPortableTransport(projectId), projectId), '0.3.18');
  for (const version of ['0.3.19', currentVersion]) {
    const server = portableTransport(projectId, version);
    server.env_vars = server.env_vars.filter(name => name !== 'FOUNDOCS_EPISODES');
    assert.equal(portableVersion(server, projectId), null);
  }
});

async function fixture(t, client = 'codex', installer = install) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'foundocs-episode-runtime-'))), root = join(base, 'project'), storageDir = join(base, 'private');
  await mkdir(root); const projectId = randomUUID(), workspaceId = randomUUID();
  const pages = [[{ name: 'get_project_context', inputSchema: { type: 'object' } }], [{ name: 'capture_episode', inputSchema: { type: 'object' } }]];
  const calls = [], controls = { delayList: null };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw); if (rpc.method.startsWith('notifications/')) { res.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'episode-fixture', version: '1' } };
    else if (rpc.method === 'tools/list') { if (controls.delayList) { const wait = controls.delayList; controls.delayList = null; await wait(); } const index = Number(rpc.params?.cursor ?? 0); result = { tools: pages[index], ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) }; }
    else { calls.push(rpc.params); result = { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const options = { storageDir, probeClient: async () => ({}), diagnose: async () => ({}), fetch: async () => Response.json({ value: 'private_episode_test_key', projectId, workspaceId }) };
  const configPath = join(root, client === 'codex' ? '.codex/config.toml' : '.mcp.json'), hookPath = join(root, client === 'codex' ? '.codex/hooks.json' : '.claude/settings.json');
  await mkdir(join(root, client === 'codex' ? '.codex' : '.claude'));
  const originalConfig = client === 'codex' ? '[mcp_servers.foreign]\ncommand = "foreign"\n' : JSON.stringify({ mcpServers: { foreign: { type: 'stdio', command: 'foreign' } } });
  const originalHooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }] } });
  await writeFile(configPath, originalConfig); await writeFile(hookPath, originalHooks);
  await installer(root, { version: 1, client, projectId, workspaceId, attemptId: randomUUID(), code: 'private_episode_test_code', exchangeUrl: 'https://example.test/exchange', mcpUrl: `http://127.0.0.1:${server.address().port}/mcp` }, options);
  const connections = [];
  const connect = async () => {
    const c = new Client({ name: 'local-episode-test', version: '1' }); connections.push(c);
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../src/cli.mjs', import.meta.url).pathname, 'mcp', '--project-id', projectId], cwd: root, env: { ...process.env, FOUNDOCS_SETUP_HOME: storageDir }, stderr: 'ignore' }));
    return c;
  };
  t.after(async () => { await Promise.all(connections.map(c => c.close())); await new Promise(r => server.close(r)); await rm(base, { recursive: true, force: true }); });
  const privateDir = join(storageDir, 'projects', createHash('sha256').update(root).digest('hex'));
  return { root, storageDir, projectId, options, pages, calls, connect, client, privateDir, controls, configPath, hookPath, originalConfig, originalHooks };
}
test('local MCP checkpoint finds paged capture, stays local, validates scope and handles dynamic collisions', async t => {
  const f = await fixture(t), c = await f.connect();
  assert.ok((await c.listTools()).tools.some(t => t.name === 'episode_checkpoint'));
  const hook = await episodeCheckpoint('hook', f.root, { hook_event_name: 'UserPromptSubmit', session_id: 'one', turn_id: 'one' }, { client: 'codex', storageDir: f.storageDir });
  const checkpoint = hook.hookSpecificOutput.additionalContext.match(/checkpoint: ([^.]+)\./)[1];
  const response = await c.callTool({ name: 'episode_checkpoint', arguments: { project_id: f.projectId, operation: 'skip', checkpoint } });
  assert.equal(response.structuredContent.data.status, 'acknowledged'); assert.equal(f.calls.length, 0);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.controls.delayList = async () => { started(); await new Promise(resolve => { release = resolve; }); };
  const refreshing = c.listTools(); await entered;
  const duringRefresh = await c.callTool({ name: 'episode_checkpoint', arguments: { project_id: f.projectId, operation: 'skip', checkpoint } });
  assert.equal(duringRefresh.structuredContent.data.status, 'acknowledged'); assert.equal(f.calls.length, 0);
  release(); await refreshing;
  await assert.rejects(c.callTool({ name: 'episode_checkpoint', arguments: { project_id: randomUUID(), operation: 'skip', checkpoint } }), /differs/);
  await writeFile(join(f.root, 'foundocs.json'), JSON.stringify({ project_id: randomUUID() }));
  assert.equal((await c.callTool({ name: 'episode_checkpoint', arguments: { project_id: f.projectId, operation: 'skip', checkpoint } })).structuredContent.data.status, 'unavailable');
  f.pages.push([{ name: 'episode_checkpoint', inputSchema: { type: 'object' } }]);
  const list = await c.listTools(); assert.equal(list.tools.filter(t => t.name === 'episode_checkpoint').length, 0);
  const blocked = await c.callTool({ name: 'episode_checkpoint', arguments: { project_id: f.projectId, operation: 'skip', checkpoint } });
  assert.equal(blocked.structuredContent.data.status, 'unavailable');
  assert.equal(f.calls.length, 0, 'a previously local name never forwards private input');
  f.pages.splice(1); assert.ok(!(await c.listTools()).tools.some(t => t.name === 'episode_checkpoint'));
});
for (const client of ['codex', 'claude']) test(`${client}: journaled runtime upgrade retries and a runtime-only rollback baseline restore the pin`, async t => {
  const f = await fixture(t, client), configPath = join(f.root, client === 'codex' ? '.codex/config.toml' : '.mcp.json'), manifestPath = join(f.privateDir, 'installation.json');
  const config = client === 'codex' ? parse(await readFile(configPath, 'utf8')) : JSON.parse(await readFile(configPath, 'utf8'));
  const server = client === 'codex' ? config.mcp_servers.foundocs : config.mcpServers.foundocs;
  server.args[1] = '@foundocs/foundocs-setup@0.3.18'; server.custom_marker = 'preserve';
  if (client === 'codex') server.env_vars = server.env_vars.filter(name => name !== 'FOUNDOCS_EPISODES');
  await writeFile(configPath, client === 'codex' ? stringify(config) : JSON.stringify(config));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.runtimeVersion = '0.3.18'; await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(join(f.privateDir, 'rollback.json'));
  const before = await readFile(configPath, 'utf8');
  await updateSkills(f.root, f.options); assert.equal(await readFile(configPath, 'utf8'), before);
  assert.equal((await doctor(f.root, f.options)).episodes.runtimeSupport, 'upgrade_required');
  assert.equal((await upgradeRuntime(f.root, f.options)).version, currentVersion);
  assert.match(await readFile(configPath, 'utf8'), /custom_marker/);
  await writeFile(manifestPath, JSON.stringify(manifest)); // Interrupted between config and manifest writes.
  assert.equal((await upgradeRuntime(f.root, f.options)).status, 'runtime_upgraded');
  assert.equal((await upgradeRuntime(f.root, f.options)).status, 'runtime_current');
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.equal(await readFile(configPath, 'utf8'), before);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).runtimeVersion, '0.3.18');
  await upgradeRuntime(f.root, f.options);
  await writeFile(configPath, (await readFile(configPath, 'utf8')).replace(currentVersion, '0.3.17'));
  await assert.rejects(upgradeRuntime(f.root, f.options), /not the recorded/);
  assert.equal((await rollback(f.root, f.options)).ok, false);
});

for (const client of ['codex', 'claude']) test(`${client}: published 0.3.18 install updates skills, diagnoses, upgrades and rolls back the original installation`, async t => {
  const f = await fixture(t, client, installPrevious);
  const before = await readFile(f.configPath, 'utf8');
  assert.match(before, /foundocs-setup@0\.3\.18/);
  const config = client === 'codex' ? parse(before) : JSON.parse(before);
  if (client === 'codex') assert.deepEqual(config.mcp_servers.foundocs.env_vars, ['FOUNDOCS_SETUP_HOME', 'FOUNDOCS_API_KEY', 'FOUNDOCS_PROJECT_ID', 'FOUNDOCS_WORKSPACE_ID', 'STEERDOCS_SETUP_HOME', 'STEERDOCS_API_KEY', 'STEERDOCS_PROJECT_ID', 'STEERDOCS_WORKSPACE_ID']);
  await updateSkills(f.root, f.options);
  assert.equal(await readFile(f.configPath, 'utf8'), before, 'skill updates preserve the exact old transport');
  assert.equal((await doctor(f.root, f.options)).episodes.runtimeSupport, 'upgrade_required');
  const hooks = await readFile(f.hookPath, 'utf8');
  assert.equal((await upgradeRuntime(f.root, f.options)).version, currentVersion);
  assert.equal(await readFile(f.hookPath, 'utf8'), hooks, 'runtime upgrades do not modify managed or foreign hooks');
  assert.equal((await doctor(f.root, f.options)).episodes.runtimeSupport, 'local_checkpoint_available_after_reconnect');
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.equal(await readFile(f.configPath, 'utf8'), f.originalConfig, 'generic rollback retains the original pre-installation baseline');
  assert.equal(await readFile(f.hookPath, 'utf8'), f.originalHooks);
});

for (const client of ['codex', 'claude']) test(`${client}: published old transport overrides and mismatched recorded pins stay protected`, async t => {
  const f = await fixture(t, client, installPrevious);
  await updateSkills(f.root, f.options);
  const before = await readFile(f.configPath, 'utf8');
  const changes = [server => { server.command = 'foreign'; }, server => { server.args[4] = randomUUID(); }, server => { server.env = { FOUNDOCS_API_KEY: 'foreign' }; }, server => { server.cwd = '/foreign'; }, server => { server.args[1] = '@foundocs/foundocs-setup@0.3.17'; }];
  if (client === 'codex') changes.push(server => { server.env_vars = server.env_vars.filter(name => name !== 'FOUNDOCS_API_KEY'); }, server => { server.args[1] = '@foundocs/foundocs-setup@0.3.19'; });
  for (const change of changes) {
    const config = client === 'codex' ? parse(before) : JSON.parse(before);
    change(client === 'codex' ? config.mcp_servers.foundocs : config.mcpServers.foundocs);
    const edited = client === 'codex' ? stringify(config) : JSON.stringify(config);
    await writeFile(f.configPath, edited);
    await assert.rejects(doctor(f.root, f.options), /configuration differs/);
    await assert.rejects(upgradeRuntime(f.root, f.options), /not the recorded/);
    assert.equal(await readFile(f.configPath, 'utf8'), edited);
  }
});

test('an existing remote same-name tool is preserved without local shadowing', async t => {
  const f = await fixture(t);
  f.pages.push([{ name: 'episode_checkpoint', inputSchema: { type: 'object' } }]);
  const c = await f.connect();
  assert.equal((await c.listTools()).tools.filter(t => t.name === 'episode_checkpoint').length, 1);
  await c.callTool({ name: 'episode_checkpoint', arguments: { project_id: f.projectId } });
  assert.equal(f.calls.at(-1).name, 'episode_checkpoint');
});

for (const client of ['codex', 'claude']) test(`${client}: unified update upgrades published 0.3.18 and connects without exchanging credentials`, async t => {
  const f = await fixture(t, client, installPrevious);
  const manifestPath = join(f.privateDir, 'installation.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const credential = await readFile(manifest.credentialPath, 'utf8');
  const result = await updateInstallation(f.root, f.options);
  assert.equal(result.runtime.version, currentVersion);
  assert.equal(result.runtime.reconnectRequired, true);
  assert.equal(result.skills.status, 'installed');
  assert.equal(await readFile(manifest.credentialPath, 'utf8'), credential);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).runtimeVersion, currentVersion);
  assert.equal((await doctor(f.root, f.options)).episodes.runtimeSupport, 'local_checkpoint_available_after_reconnect');
  const c = await f.connect();
  assert.ok((await c.listTools()).tools.some(tool => tool.name === 'episode_checkpoint'));
  const again = await updateInstallation(f.root, f.options);
  assert.deepEqual(again.changedFiles, []);
  assert.equal(again.runtime.reconnectRequired, false);
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.equal(await readFile(f.configPath, 'utf8'), f.originalConfig);
  assert.equal(await readFile(f.hookPath, 'utf8'), f.originalHooks);
  assert.equal(await readFile(manifest.credentialPath, 'utf8'), credential);
});

for (const client of ['codex', 'claude']) test(`${client}: unified preflight protects runtime and skills from conflicts and locks`, async t => {
  const f = await fixture(t, client, installPrevious);
  const skillPath = join(f.root, client === 'codex' ? '.agents' : '.claude', 'skills/foundocs/SKILL.md');
  const skill = await readFile(skillPath, 'utf8'), config = await readFile(f.configPath, 'utf8');
  const hooks = await readFile(f.hookPath, 'utf8');
  const manifestPath = join(f.privateDir, 'installation.json'), manifest = await readFile(manifestPath, 'utf8');
  await writeFile(skillPath, skill + '\nUser customization');
  await assert.rejects(updateInstallation(f.root, f.options), /unowned or modified/);
  assert.equal(await readFile(f.configPath, 'utf8'), config);
  assert.equal(await readFile(manifestPath, 'utf8'), manifest);
  assert.equal(await readFile(f.hookPath, 'utf8'), hooks);
  await writeFile(skillPath, skill);
  await writeFile(f.configPath, config.replace('0.3.18', '0.3.17'));
  await assert.rejects(updateInstallation(f.root, f.options), /not the recorded/);
  assert.equal(await readFile(skillPath, 'utf8'), skill);
  assert.equal(await readFile(f.hookPath, 'utf8'), hooks);
  await writeFile(f.configPath, config);
  const lock = join(f.privateDir, 'operation.lock');
  await writeFile(lock, 'fixture');
  await assert.rejects(updateInstallation(f.root, f.options), /holds the lock/);
  assert.equal(await readFile(f.configPath, 'utf8'), config);
  await rm(lock);
  await updateInstallation(f.root, f.options);
});

for (const client of ['codex', 'claude']) test(`${client}: unified update resumes an interrupted runtime commit before refreshing skills`, async t => {
  const f = await fixture(t, client, installPrevious);
  const manifestPath = join(f.privateDir, 'installation.json');
  const before = await readFile(manifestPath, 'utf8');
  await upgradeRuntime(f.root, f.options);
  await writeFile(manifestPath, before); // Config written, manifest and skills not committed yet.
  const result = await updateInstallation(f.root, f.options);
  assert.equal(result.runtime.version, currentVersion);
  assert.equal(result.runtime.reconnectRequired, true);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).runtimeVersion, currentVersion);
  assert.equal((await doctor(f.root, f.options)).ok, true);
});


for (const client of ['codex', 'claude']) test(`${client}: an actual published old SessionStart hook upgrades runtime through the CLI alias`, async t => {
  const f = await fixture(t, client, installPrevious);
  const hook = JSON.parse(await readFile(f.hookPath, 'utf8')).hooks.SessionStart[0].hooks[0].command;
  const bin = join(f.privateDir, 'bin'); await mkdir(bin);
  const shim = join(bin, 'npx'), registry = join(bin, 'registry.mjs');
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  await writeFile(registry, `globalThis.fetch = async () => Response.json({name:'@foundocs/foundocs-setup',version:${JSON.stringify(currentVersion)}});`);
  // Only substitute npm package resolution. Execute the real CLI and its writes.
  await writeFile(shim, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0,3), ['--yes',${JSON.stringify('@foundocs/foundocs-setup@' + currentVersion)},'update-skills']);
const result = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(cli)}, ...args.slice(2)], {stdio:'inherit'});
process.exit(result.status ?? 1);
`);
  await chmod(shim, 0o755);
  const output = await promisify(execFile)('/bin/sh', ['-c', hook], { cwd: f.root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOUNDOCS_SETUP_HOME: f.storageDir, NODE_OPTIONS: `--import=${registry}` } });
  assert.match(JSON.parse(output.stdout).hookSpecificOutput.additionalContext, /updated/);
  assert.equal(output.stderr, '');
  const manifest = JSON.parse(await readFile(join(f.privateDir, 'installation.json'), 'utf8'));
  assert.equal(manifest.runtimeVersion, currentVersion);
  assert.equal((await doctor(f.root, f.options)).ok, true);
});

for (const client of ['codex', 'claude']) test(`${client}: unified update refuses downgrades without refreshing any skill`, async t => {
  const f = await fixture(t, client, installPrevious);
  const manifestPath = join(f.privateDir, 'installation.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const config = await readFile(f.configPath, 'utf8');
  const next = client === 'codex' ? parse(config) : JSON.parse(config);
  const servers = client === 'codex' ? next.mcp_servers : next.mcpServers;
  servers.foundocs = { ...servers.foundocs, ...portableTransport(f.projectId, '999.0.0', client) };
  await writeFile(f.configPath, client === 'codex' ? stringify(next) : JSON.stringify(next));
  manifest.runtimeVersion = '999.0.0'; await writeFile(manifestPath, JSON.stringify(manifest));
  const hooks = await readFile(f.hookPath, 'utf8');
  await assert.rejects(updateInstallation(f.root, f.options), /newer MCP runtime/);
  assert.equal(await readFile(f.hookPath, 'utf8'), hooks);
  assert.match(await readFile(f.configPath, 'utf8'), /999\.0\.0/);
});
