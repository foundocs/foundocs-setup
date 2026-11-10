// Opt-in integration fixture. Run with Bun: imports the product's real HTTP/DB
// fixture from an explicitly supplied checkout; never bundles product sources.
// Installs the packed npm artifact. No host trust or permission settings are edited.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
if (process.env.FOUNDOCS_EPISODE_LIVE !== '1') throw new Error('Set FOUNDOCS_EPISODE_LIVE=1 for an explicit live fixture.');
const product = process.env.FOUNDOCS_PRODUCT_DIR, tarball = process.env.FOUNDOCS_EPISODE_PACKAGE;
if (!product || !tarball?.endsWith('.tgz')) throw new Error('Supply product checkout and packed installer tarball paths.');
const { httpFixture } = await import(pathToFileURL(join(resolve(product), 'apps/server/src/mcp/http-fixture.ts')).href);
const fixture = await httpFixture();
const directory = await realpath(fixture.directory);
const metadata = { directory, storageDir: join(directory, 'private-store'), clients: [] };
async function run(command, args, cwd, input) {
  const child = spawn(command, args, { cwd, env: { ...process.env, FOUNDOCS_SETUP_HOME: metadata.storageDir, npm_config_cache: join(directory, 'npm-cache') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', () => {}); child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done); }); clearTimeout(timer);
  if (code !== 0) throw new Error(`${command} fixture operation failed; diagnostics withheld.`);
  return stdout;
}
const accounts = [];
try {
  for (const client of (process.env.FOUNDOCS_EPISODE_CLIENT ?? 'codex,claude').split(',')) {
    assert.ok(['codex', 'claude'].includes(client));
    const account = await fixture.account(), root = join(directory, client);
    await mkdir(root); await writeFile(join(root, 'AGENTS.md'), '# Synthetic package validation project\nUse this project only.\n');
    await writeFile(join(root, 'launch.json'), '{"transport":"unset"}\n');
    const attemptId = crypto.randomUUID();
    const issued = await account.ownerFetch(`/api/workspaces/${account.workspaceId}/setup-codes`, { attemptId, projectId: account.projectId, client });
    assert.equal(issued.status, 201);
    const { code } = await issued.json();
    const input = { version: 1, client, attemptId, projectId: account.projectId, workspaceId: account.workspaceId, code, exchangeUrl: `${fixture.origin}/api/setup/exchange`, mcpUrl: `${fixture.origin}/mcp` };
    await run('npm', ['install', '--prefix', root, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', resolve(tarball)], root);
    const cli = join(root, 'node_modules/@foundocs/foundocs-setup/src/cli.mjs');
    const installed = JSON.parse(await run(process.execPath, [cli, 'install', '--root', root], root, JSON.stringify(input)));
    assert.equal(installed.diagnostic.status, 'diagnostic_passed');
    assert.deepEqual(JSON.parse(await run(process.execPath, [cli, 'install', '--root', root], root, JSON.stringify(input))).changedFiles, []);
    const doctor = JSON.parse(await run(process.execPath, [cli, 'doctor', '--root', root], root));
    assert.equal(doctor.diagnostic.status, 'diagnostic_passed');
    const prefix = client === 'codex' ? '.agents' : '.claude';
    assert.match(await readFile(join(root, prefix, 'skills/foundocs-capture-episode/SKILL.md'), 'utf8'), /Automatically retain/);
    accounts.push({ client, account, root }); metadata.clients.push({ client, root, projectId: account.projectId });
  }
  await writeFile(process.env.FOUNDOCS_EPISODE_FIXTURE_INFO ?? '/tmp/foundocs-episode-fixture.json', JSON.stringify(metadata, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: 'fixture_ready', ...metadata, instructions: 'Review/trust the generated project hooks through the host. Run ordinary tasks in the fixture. Send verify to this process to inspect real episodes, or close to stop the isolated fixture.' }));
  const lines = createInterface({ input: process.stdin });
  for await (const command of lines) {
    if (command === 'close') break;
    if (command !== 'verify') continue;
    for (const { client, account } of accounts) {
      const remote = await account.connect();
      const result = await remote.callTool({ name: 'search_episodes', arguments: { project_id: account.projectId, limit: 20 } });
      const body = result.structuredContent;
      console.log(JSON.stringify({ client, ok: body?.ok, episodes: body?.data?.items?.map(e => ({ id: e.id, title: e.title, kind: e.kind, status: e.status, taskKey: e.taskKey, boundaryKey: e.boundaryKey, version: e.version })), captureCalls: fixture.traffic.filter(t => t.tool === 'capture_episode').length }));
      await remote.close();
    }
  }
} finally { await fixture.close(); }
