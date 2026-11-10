// Actual installed-host model turns with ordinary synthetic prompts. Explicit
// opt-in only. Never installed as a product hook or included in runtime behavior.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { episodeHookCommand, sessionHookCommand } from '../src/setup.mjs';
if (process.env.FOUNDOCS_EPISODE_LIVE !== '1') throw new Error('Explicit live host inference opt-in required.');
const fixture = JSON.parse(await readFile(process.env.FOUNDOCS_EPISODE_FIXTURE_INFO ?? '/tmp/foundocs-episode-fixture.json', 'utf8'));
const host = process.env.FOUNDOCS_EPISODE_CLIENT, scenario = process.env.FOUNDOCS_EPISODE_CASE;
assert.ok(['codex', 'claude'].includes(host)); assert.ok(['important', 'routine'].includes(scenario));
const { root, projectId } = fixture.clients.find(c => c.client === host);
const task = host === 'codex' ? 'LAUNCH-18' : 'LAUNCH-17';
const prompt = scenario === 'important'
  ? `For ${task}, we have decided to use a bounded queue with an explicit retry limit. Update launch.json to set transport to bounded-queue and retryLimit to 3. Run a Node assertion to verify both values, then tell me the result.`
  : 'What is 2 + 2?';
const env = { ...process.env, FOUNDOCS_SETUP_HOME: fixture.storageDir, npm_config_cache: join(fixture.directory, 'npm-cache') };
const result = { host, scenario, prompt, hooks: [], tools: [], approvals: 0, finalMessages: [], model: null, stopFollowups: 0 };

async function claude() {
  const child = spawn('claude', ['-p', '--strict-mcp-config', '--mcp-config', join(root, '.mcp.json'), '--setting-sources', 'project,local', '--allowedTools', 'Read,Edit,Write,Bash(node *),mcp__foundocs__*', '--max-turns', '20', '--output-format', 'stream-json', '--verbose', prompt], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let raw = ''; result.stopFollowups = null; result.stopCallbackCount = null; result.assistantTextCount = 0; result.followupToolCalls = 0; child.stdout.on('data', bytes => { raw += bytes; }); child.stderr.on('data', () => {});
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timer);
  assert.equal(code, 0, 'Claude fixture did not complete');
  for (const line of raw.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'system' && event.subtype === 'init') { result.model = event.model; result.sessionId = event.session_id; }
    if (event.type === 'system' && event.subtype === 'hook_response') result.hooks.push({ event: event.hook_event, exitCode: event.exit_code });
    if (event.type === 'assistant') for (const part of event.message?.content ?? []) {
      if (part.type === 'text' && part.text?.trim()) result.assistantTextCount++;
      if (part.type === 'tool_use' && result.assistantTextCount) result.followupToolCalls++;
      if (part.type === 'tool_use') result.tools.push({ name: part.name, ...(part.name.endsWith('episode_checkpoint') ? { operation: part.input.operation } : {}) });
    }
    if (event.type === 'result') { assert.equal(event.is_error, false); result.finalMessages.push(event.result); result.approvals += event.permission_denials?.length ?? 0; }
  }
  const state = JSON.parse(await readFile(join(fixture.storageDir, 'episodes', createHash('sha256').update(root).digest('hex'), 'checkpoints.json'), 'utf8'));
  const checkpoint = state.checkpoints.findLast(c => c.sessionId === result.sessionId);
  result.checkpoint = checkpoint ? { acknowledged: checkpoint.acknowledged, fallbackIssued: checkpoint.fallbackIssued } : null;
}
async function codex() {
  if (process.env.FOUNDOCS_EPISODE_REVIEW_HOOKS !== '1') throw new Error('Review the generated fixture hook commands and explicitly set FOUNDOCS_EPISODE_REVIEW_HOOKS=1.');
  const model = process.env.FOUNDOCS_EPISODE_MODEL;
  if (!model) throw new Error('Supply the actual test model in FOUNDOCS_EPISODE_MODEL.');
  result.model = model;
  const home = join(fixture.directory, 'codex-host-review'); await mkdir(home, { recursive: true, mode: 0o700 });
  // Reuse host authentication privately; never log/read it into model context.
  // No developer settings, unrelated MCP servers or skills are copied.
  if (!process.env.OPENAI_API_KEY) { await copyFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), join(home, 'auth.json')); await chmod(join(home, 'auth.json'), 0o600); }
  await writeFile(join(home, 'config.toml'), `[features]\napps = false\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
  const child = spawn('codex', ['app-server', '--stdio'], { cwd: root, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  let id = 0, finish; const pending = new Map(), lines = createInterface({ input: child.stdout });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 45000);
    pending.set(requestId, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
  });
  lines.on('line', line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    const waiting = pending.get(event.id);
    if (waiting) { pending.delete(event.id); event.error ? waiting.reject(new Error('Host RPC rejected')) : waiting.resolve(event.result); return; }
    if (event.id && event.method) { result.approvals++; child.stdin.write(JSON.stringify({ id: event.id, result: { decision: 'decline' } }) + '\n'); return; }
    if (event.method === 'hook/completed') { const run = event.params.run; result.hooks.push({ event: run.eventName, status: run.status }); if (run.eventName === 'stop') result.stopFollowups += run.entries.filter(entry => entry.kind === 'feedback').length; }
    if (event.method === 'item/completed') {
      const item = event.params.item;
      if (item.type === 'mcpToolCall') result.tools.push({ name: item.tool, ...(item.tool === 'episode_checkpoint' ? { operation: item.arguments?.operation } : {}) });
      if (item.type === 'agentMessage' && item.phase !== 'commentary') result.finalMessages.push(item.text);
    }
    if (event.method === 'turn/completed') finish?.(event.params.turn);
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
  try {
    await rpc('initialize', { clientInfo: { name: 'foundocs-episode-validation', version: '1' }, capabilities: { experimentalApi: true } }); child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const inventory = await rpc('hooks/list', { cwds: [root] });
    const hooks = inventory.data.flatMap(data => data.hooks).filter(h => h.sourcePath === join(root, '.codex/hooks.json'));
    const expected = new Set([episodeHookCommand('codex', projectId), sessionHookCommand('codex', projectId)]);
    assert.equal(hooks.length, 3); for (const hook of hooks) assert.ok(expected.has(hook.command), 'Unreviewed fixture hook command');
    // Same exact-hash review RPC used by /hooks. Only this isolated CODEX_HOME.
    await rpc('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value: Object.fromEntries(hooks.map(h => [h.key, { trusted_hash: h.currentHash }])), mergeStrategy: 'upsert' }], reloadUserConfig: true });
    const trusted = await rpc('hooks/list', { cwds: [root] }); assert.ok(trusted.data.flatMap(data => data.hooks).filter(h => h.sourcePath === join(root, '.codex/hooks.json')).every(h => h.trustStatus === 'trusted'));
    const thread = await rpc('thread/start', { cwd: root, ephemeral: true, approvalPolicy: 'on-request', sandbox: 'workspace-write', model });
    const completed = new Promise(resolve => { finish = resolve; });
    await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: prompt }], effort: 'medium' });
    assert.equal((await completed).status, 'completed');
  } finally { clearTimeout(timer); lines.close(); child.kill('SIGTERM'); }
}
await (host === 'codex' ? codex() : claude());
const captureCalls = result.tools.filter(t => /(?:^|__)capture_episode$/.test(t.name)).length;
const checkpointCalls = result.tools.filter(t => /(?:^|__)episode_checkpoint$/.test(t.name));
if (scenario === 'routine') assert.equal(result.approvals, 0, 'The routine flow needed unexpected approval');
assert.ok(checkpointCalls.length > 0, 'Installed local checkpoint tool was not used');
if (scenario === 'important') { assert.ok(captureCalls > 0); assert.ok(checkpointCalls.some(t => t.operation === 'prepare')); assert.ok(checkpointCalls.some(t => t.operation === 'ack')); }
else { assert.equal(captureCalls, 0); assert.ok(checkpointCalls.some(t => t.operation === 'skip')); assert.equal(result.finalMessages.length, 1); assert.match(result.finalMessages[0], /4/); if (host === 'codex') assert.equal(result.stopFollowups, 0); else { assert.equal(result.assistantTextCount, 1); assert.equal(result.followupToolCalls, 0); assert.deepEqual(result.checkpoint, { acknowledged: true, fallbackIssued: false }); } }
console.log(JSON.stringify({ ...result, captureCalls, status: 'passed' }, null, 2));
