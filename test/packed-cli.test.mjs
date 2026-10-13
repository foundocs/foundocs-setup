import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const projectId = '8e68aeb1-3a40-454f-a74d-672307e12a37';
const workspaceId = '411212ef-b143-4cba-8411-5a7d48b616de';
const attemptId = '8c11c83b-645d-4a76-8aaf-a9ae2f43e561';
const key = 'packed_cli_fixture_key';
const code = 'packed_cli_fixture_one_time_code';
const originalAgents = '# User instructions\nPreserve this rule.\n';
const snapshot = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(path, 'utf8')])));

// CLI capability checks are external-host substitutes. No live host settings or
// credentials are used; actual MCP HTTP transport and every installer layer run.
const probeScript = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('isolated-capability-fixture'); process.exit(0); }
if (args.includes('get')) { console.log(JSON.stringify({transport:{type:'stdio',command:process.execPath,args:['--version']}})); process.exit(0); }
const configuration = JSON.parse(args.at(-1));
if (typeof configuration.headersHelper !== 'string') process.exit(1);
fs.writeFileSync('.mcp.json', JSON.stringify({mcpServers:{foundocs_setup_probe:configuration}}));
`;

function command(cli, root, env, operation, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, operation, '--root', root], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Packed CLI timed out')); }, 30000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', status => {
      clearTimeout(timeout);
      try {
        assert.ok(!stdout.includes(key) && !stderr.includes(key), 'CLI must not expose credential');
        assert.ok(!stdout.includes(code) && !stderr.includes(code), 'CLI must not expose code');
        resolve({ status, result: JSON.parse(status === 0 ? stdout : stderr) });
      } catch (error) { reject(error); }
    });
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

test('AC-26/28/29/30/31/33/38: packed CLI installs both clients, updates offline, diagnoses HTTP MCP and rolls back', { skip: process.platform === 'win32', timeout: 120000 }, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'foundocs-packed-cli-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', base], { cwd: packageRoot, env: { ...process.env, npm_config_cache: join(base, 'npm-cache') }, maxBuffer: 1024 * 1024 })).stdout)[0];
  for (const name of ['src/cli.mjs', 'src/skill-assets.mjs', 'skills/foundocs-capture-knowledge/SKILL.md', 'skills/foundocs-capture-knowledge/references/writing-guide.md', 'skills/foundocs/scripts/check-update.mjs', 'skills/foundocs/references/updates.md', 'templates/knowledge-policy.md', 'templates/update-policy.md']) {
    assert.ok(packed.files.some(file => file.path === name), `tarball is missing ${name}`);
  }
  await exec('tar', ['-xzf', join(base, packed.filename), '-C', base]);
  const extracted = join(base, 'package');
  // Only dependency resolution uses the local dependency cache. CLI, bridge,
  // skill and template reads must originate inside the extracted tarball.
  await symlink(join(packageRoot, 'node_modules'), join(extracted, 'node_modules'), 'dir');
  const cli = join(extracted, 'src/cli.mjs');
  const probes = join(base, 'probes'); await mkdir(probes);
  for (const client of ['codex', 'claude']) await writeFile(join(probes, client), probeScript, { mode: 0o755 });
  const blockNetwork = join(base, 'offline.mjs');
  await writeFile(blockNetwork, "globalThis.fetch = () => { throw new Error('Network forbidden for offline update'); };\n");
  const registryFixture = join(base, 'registry.mjs');
  await writeFile(registryFixture, `
globalThis.fetch = async (url, options) => {
  if (url !== 'https://registry.npmjs.org/@foundocs%2ffoundocs-setup/latest' ||
      JSON.stringify(options.headers) !== '{"Accept":"application/json"}' ||
      options.body !== undefined || options.redirect !== 'error') throw new Error('Unexpected registry request');
  return Response.json({ name: '@foundocs/foundocs-setup', version: '999.0.0', foundocsRelease: { summary: 'Public fixture release' } });
};
`);
  const requests = [];
  const serverErrors = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      if (request.url === '/exchange') {
        assert.equal(data.code, code); assert.equal(data.projectId, projectId);
        requests.push('exchange');
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value: key, projectId, workspaceId })); return;
      }
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      requests.push(data.method);
      if (data.method.startsWith('notifications/')) { response.writeHead(202).end(); return; }
      let result;
      if (data.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'packed-cli-fixture', version: '1' } };
      else if (data.method === 'tools/list') result = { tools: [{ name: 'get_project_context', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } }] };
      else if (data.method === 'tools/call') {
        assert.equal(data.params.name, 'get_project_context'); assert.equal(data.params.arguments.project_id, projectId);
        const structuredContent = { ok: true, data: { project: { id: projectId } } };
        result = { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
      } else throw new Error(`Unexpected MCP method: ${data.method}`);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result }));
    } catch (error) { serverErrors.push(error); response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  for (const client of ['codex', 'claude']) {
    const root = join(base, `${client} 프로젝트 '#%`), storage = join(base, `${client}-private`);
    await mkdir(root); await writeFile(join(root, 'AGENTS.md'), originalAgents);
    const env = { ...process.env, PATH: `${probes}:${process.env.PATH}`, FOUNDOCS_SETUP_HOME: storage };
    for (const name of ['FOUNDOCS_API_KEY', 'FOUNDOCS_PROJECT_ID', 'FOUNDOCS_WORKSPACE_ID', 'STEERDOCS_API_KEY', 'STEERDOCS_PROJECT_ID', 'STEERDOCS_WORKSPACE_ID', 'NODE_OPTIONS']) delete env[name];
    const input = { version: 1, client, projectId, workspaceId, attemptId, code, exchangeUrl: `${endpoint}/exchange`, mcpUrl: `${endpoint}/mcp` };
    const installed = await command(cli, root, env, 'install', input);
    assert.equal(installed.status, 0); assert.equal(installed.result.skills.status, 'installed');
    const skillRelative = `${client === 'codex' ? '.agents' : '.claude'}/skills/foundocs-capture-knowledge`;
    const skillRoot = join(root, skillRelative);
    const assetNames = ['SKILL.md', 'references/writing-guide.md'];
    for (const name of assetNames) assert.equal(await readFile(join(skillRoot, name), 'utf8'), await readFile(join(extracted, 'skills/foundocs-capture-knowledge', name), 'utf8'));
    const foundocsRoot = join(root, client === 'codex' ? '.agents' : '.claude', 'skills/foundocs');
    const foundocsAssets = ['SKILL.md', 'references/dreaming.md', 'references/updates.md', 'scripts/check-update.mjs'];
    for (const name of foundocsAssets) assert.equal(await readFile(join(foundocsRoot, name), 'utf8'), await readFile(join(extracted, 'skills/foundocs', name), 'utf8'));
    const packageVersion = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8')).version;
    assert.equal(JSON.parse(await readFile(join(foundocsRoot, 'release.json'), 'utf8')).version, packageVersion);
    const [installationName] = await readdir(join(storage, 'projects'));
    const directory = join(storage, 'projects', installationName);
    const manifest = JSON.parse(await readFile(join(directory, 'installation.json'), 'utf8'));
    const protectedPaths = [join(root, 'foundocs.json'), join(root, client === 'codex' ? '.codex/config.toml' : '.mcp.json'), manifest.credentialPath, manifest.helperPath, join(dirname(manifest.helperPath), 'legacy-compat.mjs'), join(directory, 'installation.json')];
    if (client === 'codex') protectedPaths.push(join(dirname(manifest.helperPath), 'bridge-v1.mjs'));
    const before = await snapshot(protectedPaths);
    // Reproduce an already-recorded installation before knowledge assets existed.
    await rm(skillRoot, { recursive: true });
    await rm(join(root, client === 'codex' ? '.agents' : '.claude', 'skills/foundocs'), { recursive: true });
    await rm(join(directory, 'skills.json')); await rm(join(directory, 'rollback.json'));
    await writeFile(join(root, 'AGENTS.md'), `${originalAgents}\n<!-- foundocs:setup:start -->\nRead foundocs.json.\n<!-- foundocs:setup:end -->\n`);
    const previousInstructions = await readFile(join(root, 'AGENTS.md'), 'utf8');
    const missing = await command(cli, root, env, 'doctor');
    assert.equal(missing.status, 1); assert.equal(missing.result.stage, 'skills'); assert.equal(missing.result.skills.status, 'missing');
    const offlineEnv = { ...env, NODE_OPTIONS: `--import=${blockNetwork}` };
    const requestCount = requests.length;
    const updated = await command(cli, root, offlineEnv, 'update-skills');
    assert.equal(updated.status, 0); assert.equal(updated.result.status, 'skills_updated');
    assert.ok((await readFile(join(root, 'AGENTS.md'), 'utf8')).includes(`](${skillRelative}/SKILL.md)`));
    for (const name of foundocsAssets) assert.equal(await readFile(join(foundocsRoot, name), 'utf8'), await readFile(join(extracted, 'skills/foundocs', name), 'utf8'));
    assert.equal(JSON.parse(await readFile(join(foundocsRoot, 'release.json'), 'utf8')).version, packageVersion);
    const checkerScript = join(foundocsRoot, 'scripts/check-update.mjs');
    const check = async (checkerEnv, extra = []) => JSON.parse((await exec(process.execPath,
      [checkerScript, '--root', root, ...extra], { cwd: root, env: { ...checkerEnv, PATH: '' } })).stdout);
    const offered = await check({ ...env, NODE_OPTIONS: `--import=${registryFixture}` });
    assert.equal(offered.installedVersion, packageVersion);
    assert.equal(offered.latestVersion, '999.0.0');
    assert.equal(offered.shouldPrompt, true);
    assert.equal(offered.summary, 'Public fixture release');
    const cached = await check(offlineEnv);
    assert.equal(cached.status, 'update_available');
    assert.equal(cached.cached, true);
    assert.equal(cached.shouldPrompt, false);
    assert.equal((await check(offlineEnv, ['--defer', offered.latestVersion])).status, 'deferred');
    assert.equal((await check(offlineEnv)).status, 'deferred');
    const repeated = await command(cli, root, offlineEnv, 'update-skills');
    assert.equal(repeated.status, 0); assert.deepEqual(repeated.result.changedFiles, []);
    assert.equal(requests.length, requestCount); assert.deepEqual(await snapshot(protectedPaths), before);
    const diagnosed = await command(cli, root, env, 'doctor');
    assert.equal(diagnosed.status, 0); assert.equal(diagnosed.result.diagnostic.status, 'diagnostic_passed');
    assert.equal(diagnosed.result.skills.hostVerification, 'required');
    assert.ok(requests.slice(requestCount).includes('tools/list')); assert.ok(requests.slice(requestCount).includes('tools/call'));
    const rolledBack = await command(cli, root, offlineEnv, 'rollback');
    assert.equal(rolledBack.status, 0); assert.equal(rolledBack.result.status, 'rolled_back');
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), previousInstructions);
    for (const name of assetNames) assert.equal(await readFile(join(skillRoot, name)).catch(error => error.code), 'ENOENT');
    for (const name of [...foundocsAssets, 'release.json']) assert.equal(await readFile(join(foundocsRoot, name)).catch(error => error.code), 'ENOENT');
    assert.deepEqual(await snapshot(protectedPaths), before);
    assert.equal((await command(cli, root, offlineEnv, 'update-skills')).status, 0);
    const changedPath = join(skillRoot, 'SKILL.md');
    const changed = `${await readFile(changedPath, 'utf8')}\nUser modification.\n`;
    await writeFile(changedPath, changed);
    const conflicted = await command(cli, root, offlineEnv, 'update-skills');
    assert.equal(conflicted.status, 1); assert.equal(conflicted.result.stage, 'preflight');
    const conflictedDoctor = await command(cli, root, env, 'doctor');
    assert.equal(conflictedDoctor.status, 1); assert.equal(conflictedDoctor.result.skills.status, 'conflict');
    const safeRollback = await command(cli, root, offlineEnv, 'rollback');
    assert.equal(safeRollback.result.ok, false); assert.deepEqual(safeRollback.result.conflicts, [changedPath]);
    assert.equal(await readFile(changedPath, 'utf8'), changed);
    assert.deepEqual(await snapshot(protectedPaths), before);
  }
  assert.equal(requests.filter(method => method === 'exchange').length, 2);
  assert.deepEqual(serverErrors, []);
  t.diagnostic(`Packed ${packed.name}@${packed.version}; actual CLI and HTTP MCP passed for both clients. Dependencies resolved from local node_modules; host capability probes substituted.`);
});
