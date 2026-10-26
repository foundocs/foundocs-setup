import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat, readdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parse } from 'smol-toml';
import { install, doctor, rollback, migrate, validateInput, markedBlock, helperCommand, diagnose, portableVersion } from '../src/setup.mjs';
import { readCredential, windowsPrivateAcl } from '../src/auth.mjs';

const currentVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const projectId = '8e68aeb1-3a40-454f-a74d-672307e12a37';
const workspaceId = '411212ef-b143-4cba-8411-5a7d48b616de';
const attemptId = '8c11c83b-645d-4a76-8aaf-a9ae2f43e561';
const otherAttempt = '7bc0257d-dc37-4e4d-ae69-6d55002f3ec3';
const key = 'sdocs_private_test_key_never_in_reports';
const input = { version: 1, client: 'codex', projectId, workspaceId, attemptId, code: 'one_time_private_code_32charslong', exchangeUrl: 'https://api.example.test/setup/exchange', mcpUrl: 'https://api.example.test/mcp' };
const exec = promisify(execFile);

async function fixture(t, client = 'codex') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'foundocs-tests-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "프로젝트 공백 '#%"), storageDir = join(base, "비공개 store '#%");
  await mkdir(root);
  let exchanges = 0;
  const options = {
    storageDir,
    probeClient: async () => ({ client, version: 'fixture', helper: 'supported' }),
    fetch: async (_url, init) => {
      exchanges++;
      assert.equal(init.redirect, 'error');
      assert.equal(JSON.parse(init.body).projectId, projectId);
      return Response.json({ value: key, projectId, workspaceId, key: { id: 'key-id' } });
    },
    diagnose: async () => ({ status: 'diagnostic_passed', hostVerification: 'required' }),
  };
  return { root, storageDir, options, input: { ...input, client }, exchanges: () => exchanges };
}

async function manifest(storageDir) {
  const directories = await readdir(join(storageDir, 'projects'));
  return JSON.parse(await readFile(join(storageDir, 'projects', directories[0], 'installation.json'), 'utf8'));
}

for (const client of ['codex', 'claude']) test(`${client}: preserves foreign settings and instructions, same attempt is idempotent`, async (t) => {
  const f = await fixture(t, client);
  await writeFile(join(f.root, 'AGENTS.md'), '# Existing instructions\nKeep this rule.\n');
  await chmod(join(f.root, 'AGENTS.md'), 0o600);
  if (client === 'codex') {
    await mkdir(join(f.root, '.codex'));
    await writeFile(join(f.root, '.codex/config.toml'), '# foreign comment\nmodel="example"\n[mcp_servers.other]\nurl="https://other.test/mcp"\n');
  } else {
    await writeFile(join(f.root, '.mcp.json'), JSON.stringify({ custom: true, mcpServers: { other: { command: 'other' } } }));
    await writeFile(join(f.root, 'CLAUDE.md'), '# Claude rule\n');
  }
  const first = await install(f.root, f.input, f.options);
  assert.equal(first.status, 'configured');
  assert.equal(first.diagnostic.hostVerification, 'required');
  const second = await install(f.root, f.input, f.options);
  assert.deepEqual(second.changedFiles, []);
  assert.equal(second.reusedCredential, true);
  assert.equal(f.exchanges(), 1);
  const agents = await readFile(join(f.root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Existing instructions\nKeep this rule.\n'));
  assert.equal(agents.split('<!-- foundocs:setup:start -->').length, 2);
  assert.equal((await stat(join(f.root, 'AGENTS.md'))).mode & 0o777, 0o600);
  const prefix = client === 'codex' ? '.agents' : '.claude';
  assert.ok(agents.includes(`](${prefix}/skills/foundocs/SKILL.md)`));
  const configuration = await readFile(join(f.root, prefix, 'skills/foundocs/references/configuration.md'), 'utf8');
  assert.match(configuration, /never reinterpret the root/);
  const configText = await readFile(join(f.root, client === 'codex' ? '.codex/config.toml' : '.mcp.json'), 'utf8');
  const config = client === 'codex' ? parse(configText) : JSON.parse(configText);
  assert.ok((config.mcp_servers ?? config.mcpServers).other);
  if (client === 'codex') assert.ok(configText.startsWith('# foreign comment'));
  else assert.equal(config.custom, true);
  for (const text of [agents, configText, JSON.stringify(first), await readFile(join(f.root, 'foundocs.json'), 'utf8')]) {
    assert.equal(text.includes(key), false); assert.equal(text.includes(input.code), false);
  }
  const saved = await manifest(f.storageDir);
  assert.equal((await stat(saved.credentialPath)).mode & 0o777, 0o600);
  assert.equal((await stat(f.storageDir)).mode & 0o777, 0o700);
  const server = (config.mcp_servers ?? config.mcpServers).foundocs;
  if (client === 'codex') {
    assert.equal(server.command, 'npx');
    assert.equal(portableVersion(server, projectId), currentVersion);
    assert.ok(server.env_vars.includes('FOUNDOCS_SETUP_HOME'));
    assert.ok(server.env_vars.includes('FOUNDOCS_API_KEY'));
    assert.equal(configText.includes(f.root), false);
    assert.equal(configText.includes(f.storageDir), false);
  }
  const command = helperCommand([process.execPath, saved.helperPath, '--headers', saved.credentialPath, projectId, workspaceId]);
  const output = await exec('/bin/sh', ['-c', command], { env: { ...process.env, FOUNDOCS_API_KEY: 'other_workspace_key' } });
  assert.deepEqual(JSON.parse(output.stdout), { Authorization: `Bearer ${key}` });
  assert.equal(output.stderr, '');
  assert.equal((await doctor(f.root, f.options)).diagnostic.status, 'diagnostic_passed');
});

test('new attempt repairs a revoked saved key while retaining private previous credential', async (t) => {
  const f = await fixture(t);
  await install(f.root, input, f.options);
  const result = await install(f.root, { ...input, attemptId: otherAttempt }, f.options);
  assert.equal(f.exchanges(), 2);
  assert.equal(result.reusedCredential, false);
  const saved = await manifest(f.storageDir);
  assert.equal(JSON.parse(await readFile(saved.credentialPath, 'utf8')).attemptId, otherAttempt);
  assert.equal(JSON.parse(await readFile(join(saved.credentialPath, '..', `previous-${attemptId}.json`), 'utf8')).attemptId, attemptId);
});

for (const [path, content] of [['foundocs.json', '{'], ['foundocs.json', '{"project_id":"different"}'], ['.mcp.json', '{"mcpServers":{"foundocs":{"url":"https://other.test"}}}'], ['AGENTS.md', '<!-- foundocs:setup:start -->']]) {
  test(`conflict ${path} stops before exchange or file edits`, async (t) => {
    const f = await fixture(t, 'claude');
    await writeFile(join(f.root, path), content);
    await assert.rejects(install(f.root, f.input, f.options), { stage: 'preflight' });
    assert.equal(f.exchanges(), 0);
    assert.equal(await readFile(join(f.root, path), 'utf8'), content);
  });
}

test('unsupported client and unsafe symlinks stop before code consumption', async (t) => {
  const f = await fixture(t);
  await assert.rejects(install(f.root, input, { ...f.options, probeClient: async () => { throw new Error('unsupported'); } }));
  assert.equal(f.exchanges(), 0);
  await symlink(join(f.root, '..'), join(f.root, '.codex'));
  await assert.rejects(install(f.root, input, f.options), { stage: 'preflight' });
  assert.equal(f.exchanges(), 0);
});

test('nested Git root ambiguity stops before code exchange', async (t) => {
  const f = await fixture(t);
  await exec('git', ['init', '--quiet', f.root]);
  const nested = join(f.root, 'nested'); await mkdir(nested);
  await assert.rejects(install(nested, input, f.options), { stage: 'preflight' });
  assert.equal(f.exchanges(), 0);
  assert.deepEqual(await readdir(nested), []);
});

test('failed exchange never leaks response body, code, or key', async (t) => {
  const f = await fixture(t);
  await assert.rejects(install(f.root, input, { ...f.options, fetch: async () => new Response(key + input.code, { status: 409 }) }), (error) => {
    assert.equal(error.stage, 'exchange');
    assert.equal(error.details.attemptId, attemptId);
    assert.equal(error.details.recoveryUrl, `/app/projects/${projectId}/agents`);
    assert.equal(error.message.includes(key), false);
    return true;
  });
  assert.deepEqual(await readdir(f.root), []);
});

test('network response loss gives attempt recovery and never retries exchange', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(install(f.root, input, { ...f.options, fetch: async () => { calls++; throw new Error(key); } }), { stage: 'exchange' });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(f.root), []);
});

test('diagnostic failure preserves credential for same-attempt retry', async (t) => {
  const f = await fixture(t);
  await assert.rejects(install(f.root, input, { ...f.options, diagnose: async () => { throw new Error('offline'); } }));
  await install(f.root, input, f.options);
  assert.equal(f.exchanges(), 1);
});

test('portable Claude no longer depends on copied legacy helper and reinstall repairs it for compatibility', async (t) => {
  const f = await fixture(t, 'claude'); await install(f.root, f.input, f.options);
  const saved = await manifest(f.storageDir);
  await rm(saved.helperPath);
  assert.equal((await doctor(f.root, f.options)).status, 'configured');
  await install(f.root, f.input, f.options);
  assert.equal(f.exchanges(), 1);
  assert.equal((await doctor(f.root, f.options)).status, 'configured');
});

test('rollback restores originals but preserves concurrent edits', async (t) => {
  const f = await fixture(t, 'claude');
  const original = '# Before\n'; await writeFile(join(f.root, 'AGENTS.md'), original);
  await install(f.root, f.input, f.options);
  await install(f.root, f.input, f.options);
  const userEdit = `${await readFile(join(f.root, 'CLAUDE.md'), 'utf8')}\nUser edit\n`;
  await writeFile(join(f.root, 'CLAUDE.md'), userEdit);
  const result = await rollback(f.root, f.options);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, [join(f.root, 'CLAUDE.md')]);
  assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), original);
  assert.equal(await readFile(join(f.root, 'CLAUDE.md'), 'utf8'), userEdit);
  assert.equal(result.credentialRetained, true);
});

test('transport accepts loopback only for HTTP and rejects credential-bearing URLs', () => {
  for (const exchangeUrl of ['http://remote.test/exchange', 'https://user:pass@remote.test/exchange', 'https://remote.test/exchange?secret=foo', 'file:///tmp/code']) assert.throws(() => validateInput({ ...input, exchangeUrl }));
  validateInput({ ...input, exchangeUrl: 'http://127.0.0.1:6400/exchange' });
  assert.throws(() => markedBlock('<!-- foundocs:setup:end --><!-- foundocs:setup:start -->', 'test'));
});

test('Windows shell helper and private ACL scripts quote space, Unicode, apostrophe paths', async () => {
  const args = ["C:\\Program Files\\node.exe", "C:\\사용자\\O'Brien #$%\\auth.mjs", 'credential path', projectId, workspaceId];
  const command = helperCommand(args, 'win32');
  assert.match(command, /^powershell.exe -NoProfile -NonInteractive -EncodedCommand [\w+/=]+$/);
  const decoded = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /O''Brien/); assert.match(decoded, /exit \$LASTEXITCODE/);
  let script;
  await windowsPrivateAcl(args[1], { directory: true, apply: true, execute: async (name, parameters) => {
    assert.equal(name, 'powershell.exe'); script = Buffer.from(parameters.at(-1), 'base64').toString('utf16le');
  } });
  assert.match(script, /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(script, /SetOwner\(\$sid\)/);
  assert.match(script, /IdentityReference.Value -ne \$sid.Value/);
  assert.match(script, /IsInherited/);
});

test('MCP doctor initializes, lists tools and calls exact project; rejects redirects and mismatched project', async (t) => {
  const f = await fixture(t);
  await install(f.root, input, f.options);
  const saved = await manifest(f.storageDir);
  const methods = [];
  let wrongProject = false;
  const mockFetch = async (_url, init) => {
    assert.equal(init.redirect, 'error');
    const request = JSON.parse(init.body);
    methods.push(request.method);
    if (request.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    if (request.method === 'tools/list') result = { tools: [{ name: 'get_project_context', inputSchema: { type: 'object' } }] };
    if (request.method === 'tools/call') {
      assert.equal(request.params.arguments.project_id, projectId);
      const structuredContent = { ok: true, data: { project: { id: wrongProject ? workspaceId : projectId } } };
      result = { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
  const result = await diagnose(saved, saved.credentialPath, { fetch: mockFetch });
  assert.equal(result.status, 'diagnostic_passed');
  for (const method of ['initialize', 'tools/list', 'tools/call']) assert.ok(methods.includes(method));
  wrongProject = true;
  await assert.rejects(diagnose(saved, saved.credentialPath, { fetch: mockFetch }), { stage: 'diagnostic' });
  await assert.rejects(diagnose(saved, saved.credentialPath, { fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }) }), { stage: 'diagnostic' });
});

test('scoped environment compatibility does not switch unrelated workspace credentials', async (t) => {
  const f = await fixture(t); await install(f.root, input, f.options);
  const saved = await manifest(f.storageDir);
  const environment = { FOUNDOCS_API_KEY: process.env.FOUNDOCS_API_KEY, FOUNDOCS_PROJECT_ID: process.env.FOUNDOCS_PROJECT_ID, FOUNDOCS_WORKSPACE_ID: process.env.FOUNDOCS_WORKSPACE_ID };
  try {
    process.env.FOUNDOCS_API_KEY = 'override';
    process.env.FOUNDOCS_PROJECT_ID = projectId;
    process.env.FOUNDOCS_WORKSPACE_ID = 'unrelated';
    assert.equal(await readCredential(saved.credentialPath, projectId, workspaceId), key);
    process.env.FOUNDOCS_WORKSPACE_ID = workspaceId;
    assert.equal(await readCredential(saved.credentialPath, projectId, workspaceId), 'override');
  } finally { for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});

test('durable Codex bridge relays MCP metadata/results and explicit project unchanged without exposing credentials', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const tool = { name: 'get_project_context', description: 'Fixture context', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] }, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const rpc = JSON.parse(text); calls.push(rpc.method);
    if (rpc.method.startsWith('notifications/')) { response.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    if (rpc.method === 'tools/list') result = { tools: [tool] };
    if (rpc.method === 'tools/call') {
      const structuredContent = { ok: true, data: { project: { id: rpc.params.arguments.project_id } } };
      result = { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  await install(f.root, { ...input, mcpUrl }, f.options);
  const config = parse(await readFile(join(f.root, '.codex/config.toml'), 'utf8')).mcp_servers.foundocs;
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../src/cli.mjs', import.meta.url).pathname, ...config.args.slice(2)], cwd: f.root, env: { ...process.env, FOUNDOCS_SETUP_HOME: f.storageDir }, stderr: 'pipe' });
  const client = new Client({ name: 'bridge-test', version: '1' });
  t.after(() => client.close());
  let stderr = ''; transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  await client.connect(transport);
  const list = await client.listTools();
  assert.deepEqual(list.tools, [tool]);
  const result = await client.callTool({ name: 'get_project_context', arguments: { project_id: projectId } });
  assert.equal(result.structuredContent.data.project.id, projectId);
  await assert.rejects(client.callTool({ name: 'get_project_context', arguments: {} }), /project_id/);
  const changed = await client.callTool({ name: 'get_project_context', arguments: { project_id: workspaceId } });
  assert.equal(changed.structuredContent.data.project.id, workspaceId);
  assert.equal(calls.filter((method) => method === 'tools/call').length, 2);
  assert.equal(stderr.includes(key), false);
  assert.equal(stderr.includes(input.code), false);
  await client.close();
});

test('private storage rejects project descendants whose names begin with dot-dot before exchanging a code', async (t) => {
  const f = await fixture(t);
  for (const name of ['private', '..private']) {
    await assert.rejects(install(f.root, input, { ...f.options, storageDir: join(f.root, name) }), { stage: 'preflight' });
  }
  assert.equal(f.exchanges(), 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('actual credential-file persistence failure reports consumed-attempt recovery without writing project settings', async (t) => {
  const f = await fixture(t);
  const response = f.options.fetch;
  const fetch = async (...args) => {
    const directory = join(f.storageDir, 'credentials', workspaceId, projectId);
    const [rootHash] = await readdir(directory);
    await mkdir(join(directory, rootHash, 'key.json'));
    return response(...args);
  };
  await assert.rejects(install(f.root, input, { ...f.options, fetch }), (error) => {
    assert.equal(error.stage, 'credential-storage');
    assert.equal(error.details.attemptId, attemptId);
    assert.equal(JSON.stringify(error.details).includes(key), false);
    return true;
  });
  assert.equal(f.exchanges(), 1);
  assert.deepEqual(await readdir(f.root), []);
});

test('partial configuration failure can retry with saved key and rollback to initial baseline', async (t) => {
  const f = await fixture(t);
  const response = f.options.fetch;
  const fetch = async (...args) => {
    await mkdir(join(f.root, '.codex', 'config.toml'), { recursive: true });
    return response(...args);
  };
  await assert.rejects(install(f.root, input, { ...f.options, fetch }), (error) => {
    assert.equal(error.stage, 'configuration');
    assert.equal(error.details.attemptId, attemptId);
    assert.match(error.message, /key is saved/);
    return true;
  });
  assert.equal(JSON.parse(await readFile(join(f.root, 'foundocs.json'), 'utf8')).project_id, projectId);
  await rm(join(f.root, '.codex', 'config.toml'), { recursive: true });
  const result = await install(f.root, input, f.options);
  assert.equal(result.reusedCredential, true);
  assert.equal(f.exchanges(), 1);
  const restored = await rollback(f.root, f.options);
  assert.equal(restored.ok, true);
  assert.equal(await readFile(join(f.root, 'foundocs.json'), 'utf8').catch(error => error.code), 'ENOENT');
  assert.equal(await readFile(join(f.root, 'AGENTS.md'), 'utf8').catch(error => error.code), 'ENOENT');
});

for (const client of ['codex', 'claude']) test(`${client}: packaged skill installs, diagnoses, preserves edits, and rolls back`, async (t) => {
  const f = await fixture(t, client);
  const directory = join(f.root, client === 'codex' ? '.agents' : '.claude', 'skills', 'foundocs');
  await install(f.root, f.input, f.options);
  for (const name of ['SKILL.md', 'references/dreaming.md']) assert.equal(await readFile(join(directory, name), 'utf8'), await readFile(new URL(`../skills/foundocs/${name}`, import.meta.url), 'utf8'));
  assert.equal((await doctor(f.root, f.options)).ok, true);
  const edited = '# My customized Foundocs skill\n';
  await writeFile(join(directory, 'SKILL.md'), edited);
  await assert.rejects(install(f.root, f.input, f.options), { stage: 'preflight' });
  assert.equal(f.exchanges(), 1);
  const result = await rollback(f.root, f.options);
  assert.deepEqual(result.conflicts, [join(directory, 'SKILL.md')]);
  assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), edited);
  assert.equal(await readFile(join(directory, 'references/dreaming.md'), 'utf8').catch(error => error.code), 'ENOENT');
});

for (const unsafe of ['foreign', 'symlink']) test(`skill ${unsafe} stops before consuming a code`, async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, '.agents/skills/foundocs');
  await mkdir(directory, { recursive: true });
  if (unsafe === 'foreign') await writeFile(join(directory, 'SKILL.md'), '# Existing unrelated skill');
  else await symlink(join(f.root, 'nonexistent.md'), join(directory, 'SKILL.md'));
  await assert.rejects(install(f.root, f.input, f.options), { stage: 'preflight' });
  assert.equal(f.exchanges(), 0);
});

test('rerun upgrades only the recorded installer-owned skill and retains original rollback baseline', async (t) => {
  const f = await fixture(t);
  await install(f.root, input, f.options);
  const path = join(f.root, '.agents/skills/foundocs/SKILL.md');
  const current = await readFile(path, 'utf8');
  const [rootHash] = await readdir(join(f.storageDir, 'projects'));
  const journalPath = join(f.storageDir, 'projects', rootHash, 'rollback.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const earlier = current.replace('Prompt version: dreaming-v1', 'Prompt version: dreaming-v0') + '\n<!-- prior packaged revision -->\n';
  journal.entries.find(entry => entry.path === path).after = earlier;
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(path, earlier);
  const statePath = join(f.storageDir, 'projects', rootHash, 'skills.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.files['.agents/skills/foundocs/SKILL.md'].installedHash = createHash('sha256').update(earlier).digest('hex');
  await writeFile(statePath, JSON.stringify(state));
  const updated = await install(f.root, input, f.options);
  assert.ok(updated.changedFiles.includes(path));
  assert.equal(await readFile(path, 'utf8'), current);
  assert.equal(f.exchanges(), 1);
  assert.equal((await rollback(f.root, f.options)).ok, true);
  assert.equal(await readFile(path, 'utf8').catch(error => error.code), 'ENOENT');
});
