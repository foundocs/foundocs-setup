// Non-model supervisor. Only normalized observations leave this process.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { CODEX_CONFIG, CODEX_TOOLS, codexUsage } from './effect-codex.mjs';
import { snapshotTool } from './effect-codex-tools.mjs';
import { SYSTEM, missingObservation } from './effect-core.mjs';
const policy = JSON.parse(process.argv[2]);
let child, temporary, stopping = false, closed = false, input = '', line = '', threadId, turnId, output = null, usage = null, steps = 0, calls = 0, sequence = 0;
const pending = new Map(), timers = [];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const observation = complete => usage ? { completeness: complete ? 'complete' : 'partial', source: complete ? 'codex_turn_completed' : 'codex_token_usage', usage, estimatedCostUsd: null, models: [policy.model] } : missingObservation();
function signal(name) { if (!child?.pid || closed) return; try { process.kill(-child.pid, name); } catch { child.kill(name); } }
function stop() {
  if (stopping) return; stopping = true;
  if (!child) return;
  signal('SIGINT'); timers.push(setTimeout(() => signal('SIGTERM'), 3000), setTimeout(() => signal('SIGKILL'), 5000));
}
process.on('disconnect', stop);
process.on('message', message => { if (message?.type === 'stop') stop(); });
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, stop);
process.stdout.on('error', stop);
const send = value => { if (!stopping && !closed) child.stdin.write(JSON.stringify(value) + '\n'); };
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); send({ id, method, params });
});
async function accept(event, payload) {
  if (event.id !== undefined && pending.has(event.id)) {
    const p = pending.get(event.id); pending.delete(event.id); if (event.error) p.reject(new Error('codex request failed')); else p.resolve(event.result); return;
  }
  const p = event.params;
  if (!p || stopping) return;
  if (p.threadId && p.threadId !== threadId) throw new Error('unexpected thread');
  if (event.method === 'turn/started') { if (turnId && turnId !== p.turn.id) throw new Error('unexpected turn'); turnId = p.turn.id; }
  if (p.turnId && turnId && p.turnId !== turnId) throw new Error('unexpected turn');
  if (event.method === 'thread/settings/updated') {
    const settings = p.threadSettings;
    if (!settings || settings.model !== policy.model || settings.modelProvider !== 'openai' || settings.approvalPolicy !== 'never' || settings.sandboxPolicy?.type !== 'readOnly' || settings.sandboxPolicy.networkAccess !== false) throw new Error('settings changed');
  }
  if (event.method === 'item/tool/call') {
    if (!CODEX_TOOLS.some(t => t.name === p.tool) || p.namespace || ++calls > policy.perProbeMaxTurns) throw new Error('tool limit');
    let text, success = true;
    try { text = await snapshotTool(p.tool, p.arguments, process.cwd(), payload.snapshotFiles); }
    catch { text = 'Source unavailable: only frozen snapshot paths and supported read operations are allowed.'; success = false; }
    send({ id: event.id, result: { success, contentItems: [{ type: 'inputText', text }] } });
  } else if (event.id !== undefined) {
    // No approvals, network, MCP, delegation or user interaction in probes.
    throw new Error('unexpected server request');
  }
  if (event.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall'].includes(p.item?.type)) throw new Error('unexpected tool');
  if (event.method === 'item/completed' && p.item?.type === 'agentMessage') {
    try { output = Buffer.byteLength(p.item.text) <= 40 * 1024 ? JSON.parse(p.item.text) : null; } catch { output = null; }
  }
  if (event.method === 'thread/tokenUsage/updated') {
    const next = codexUsage(p.tokenUsage?.total);
    if (!next || (usage && next.totalTokens < usage.totalTokens)) throw new Error('invalid usage');
    usage = next; steps++; emit({ type: 'effect_observation', observation: observation(false) });
    if (steps >= policy.perProbeMaxTurns && output === null) throw new Error('turn limit');
  }
  if (event.method === 'turn/completed') {
    emit({ type: 'effect_observation', observation: observation(p.turn.status === 'completed') });
    emit({ type: 'effect_result', success: p.turn.status === 'completed', output });
    stop();
  }
}
async function run(payload) {
  try {
    temporary = await mkdtemp(join(dirname(process.cwd()), 'codex-runtime-'));
    const home = join(temporary, 'home'), empty = join(temporary, 'empty');
    await mkdir(home, { mode: 0o700 }); await mkdir(empty, { mode: 0o700 });
    if (!process.env.OPENAI_API_KEY) {
      const auth = await open(join(process.env.CODEX_HOME || join(process.env.HOME, '.codex'), 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await auth.stat(); if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('auth unavailable');
        await writeFile(join(home, 'auth.json'), await auth.readFile(), { mode: 0o600 });
      } finally { await auth.close(); }
    }
    await writeFile(join(home, 'config.toml'), CODEX_CONFIG, { mode: 0o600 });
    if (stopping || !process.connected) return;
    // No source files, personal instructions, MCP configuration or skills in the CLI's HOME/cwd.
    child = spawn('codex', ['app-server'], { cwd: empty, env: { PATH: process.env.PATH, HOME: temporary, CODEX_HOME: home, ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}) }, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', stop);
    const finished = new Promise(resolve => { child.once('error', resolve); child.once('close', () => { closed = true; for (const p of pending.values()) p.reject(new Error('closed')); pending.clear(); resolve(); }); });
    let queue = Promise.resolve();
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      line += chunk; let i;
      while ((i = line.indexOf('\n')) !== -1) {
        const entry = line.slice(0, i); line = line.slice(i + 1);
        if (entry) { try { const e = JSON.parse(entry); queue = queue.then(() => accept(e, payload)).catch(() => { emit({ type: 'effect_invalid' }); stop(); }); } catch { stop(); } }
      }
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) { line = ''; stop(); }
    });
    timers.push(setTimeout(stop, policy.perProbeTimeoutMs));
    try {
      await call('initialize', { clientInfo: { name: 'foundocs_effect', version: '1' }, capabilities: { experimentalApi: true } }); send({ method: 'initialized' });
      const t = await call('thread/start', { model: policy.model, modelProvider: 'openai', allowProviderModelFallback: false, cwd: empty, environments: [], ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: SYSTEM, dynamicTools: CODEX_TOOLS });
      if (t.model !== policy.model || t.modelProvider !== 'openai' || t.thread.ephemeral !== true || !Array.isArray(t.thread.environments) || t.thread.environments.length || !Array.isArray(t.instructionSources) || t.instructionSources.length || t.approvalPolicy !== 'never' || t.sandbox.type !== 'readOnly' || t.sandbox.networkAccess !== false) throw new Error('isolation unavailable');
      threadId = t.thread.id;
      emit({ type: 'effect_init', model: t.model, verified: true });
      const prompt = { ...payload, snapshotFiles: payload.snapshotFiles.map(f => f.path) };
      await call('turn/start', { threadId, model: policy.model, ...(policy.reasoningEffort ? { effort: policy.reasoningEffort } : {}), input: [{ type: 'text', text: JSON.stringify(prompt) }] });
    } catch { stop(); }
    await finished; await queue;
  } finally { timers.forEach(clearTimeout); if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > 2 * 1024 * 1024) stop(); });
process.stdin.on('end', async () => {
  try { if (!stopping) await run(JSON.parse(input)); } catch { stop(); }
  process.exit(0);
});
