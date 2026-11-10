import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { codexSessionModel } from '../src/effect-host.mjs';
import { codexUsage, codexEnvironment, codexCapabilities, CODEX_RUNNER, CODEX_VERSION } from '../src/effect-codex.mjs';
import { snapshotTool } from '../src/effect-codex-tools.mjs';
import { freezeSnapshot } from '../src/effect-storage.mjs';
import { EffectCoordinator } from '../src/effect.mjs';
import { hash, missingObservation } from '../src/effect-core.mjs';
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'effect-codex-unit-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'); await mkdir(root); await writeFile(join(root, 'source.txt'), 'color cobalt\nsecond line');
  return { dir, root };
}
test('Codex uses only current thread turn metadata, rejects identity/provider/path/stale/model problems and never config guesses', async t => {
  const { dir, root } = await fixture(t), sessionId = randomUUID(), path = join(dir, `rollout-fixture-${sessionId}.jsonl`);
  const meta = { type: 'session_meta', payload: { id: sessionId, cwd: root, model_provider: 'openai' } };
  const turn = { type: 'turn_context', timestamp: new Date(Date.now() - 600000).toISOString(), payload: { cwd: root, model: 'gpt-6-astra', effort: 'high' } };
  const host = { client: 'codex', sessionId, transcriptPath: path };
  const write = async (m = meta, last = turn) => writeFile(path, JSON.stringify(m)+'\n'+JSON.stringify(last)+'\n');
  await write();
  const identify = () => codexSessionModel(host, root, Date.now(), { CODEX_THREAD_ID: sessionId });
  assert.deepEqual(await identify(), { status: 'identified', runner: CODEX_RUNNER, model: 'gpt-6-astra', modelSource: 'working_session', reasoningEffort: 'high' });
  await writeFile(path, JSON.stringify(meta)+'\n'+JSON.stringify(turn)+'\n'+JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(2 * 1024 * 1024) } })+'\n');
  assert.equal((await identify()).model, 'gpt-6-astra');
  const home = join(dir, 'home'), sessions = join(home, 'sessions', '2026', '11', '11'); await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, `rollout-fixture-${sessionId}.jsonl`), JSON.stringify(meta)+'\n'+JSON.stringify(turn)+'\n');
  assert.equal((await codexSessionModel({ sessionId }, root, Date.now(), { CODEX_HOME: home, CODEX_THREAD_ID: sessionId })).model, 'gpt-6-astra');
  assert.equal((await codexSessionModel(host, root, Date.now(), { CODEX_THREAD_ID: randomUUID() })).reason, 'working_model_unavailable');
  for (const change of [{ model: 'auto' }, { model: 'gpt-6-latest' }, { model: 'claude-sonnet-5' }, { cwd: dir }]) { await write(meta, { ...turn, payload: { ...turn.payload, ...change } }); assert.equal((await identify()).reason, 'working_model_unavailable'); }
  await write({ ...meta, payload: { ...meta.payload, model_provider: 'other' } }); assert.equal((await identify()).reason, 'working_model_unavailable');
  await write(); await utimes(path, new Date(0), new Date(0)); assert.equal((await identify()).reason, 'working_model_unavailable');
  await write(); await writeFile(path, JSON.stringify(meta)+'\n'+JSON.stringify(turn)+'\n{"type":'); assert.equal((await identify()).reason, 'working_model_unavailable');
  await rm(path); await symlink(join(root, 'source.txt'), path); assert.equal((await identify()).reason, 'working_model_unavailable');
});
test('read tools allow partial reads and literal search, deny siblings/traversal/symlinks/changed content and unknown tools', async t => {
  const { dir, root } = await fixture(t), cwd = join(dir, 'snapshot'); const snapshot = await freezeSnapshot(root, cwd, ['source.txt']);
  const tool = (name, args) => snapshotTool(name, args, cwd, snapshot.files);
  assert.equal(await tool('Read', { path: 'source.txt', offset: 2, limit: 1 }), '2: second line');
  assert.match(await tool('Grep', { query: 'cobalt', path: '' }), /source.txt:1: color cobalt/);
  assert.equal(await tool('Glob', { query: '' }), 'source.txt');
  for (const path of ['../root/source.txt', join(root, 'source.txt'), 'source.txt/../source.txt', '.codex/auth.json']) {
    await assert.rejects(tool('Read', { path, offset: 1, limit: 1 })); await assert.rejects(tool('Grep', { path, query: 'color' }));
  }
  await assert.rejects(tool('exec_command', { command: 'cat source.txt' }));
  await rm(join(cwd, 'source.txt')); await symlink(join(root, 'source.txt'), join(cwd, 'source.txt')); await assert.rejects(tool('Read', { path: 'source.txt', offset: 1, limit: 1 }));
  await rm(join(cwd, 'source.txt')); await writeFile(join(cwd, 'source.txt'), 'changed'); await assert.rejects(tool('Read', { path: 'source.txt', offset: 1, limit: 1 }));
});
test('Codex cumulative usage includes cached and reasoning only once, rejects invalid data, strips injected credentials/config', async () => {
  assert.deepEqual(codexUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, reasoningOutputTokens: 15 }), { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadInputTokens: 80, cacheCreationInputTokens: null });
  assert.equal(codexUsage({ inputTokens: 1, outputTokens: -1, cachedInputTokens: 0 }), null);
  assert.equal(codexUsage({ inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 }), null);
  assert.deepEqual(codexEnvironment({ PATH: '/bin', FOUNDOCS_API_KEY: 'private', NODE_OPTIONS: 'injection', OPENAI_BASE_URL: 'other', CODEX_THREAD_ID: randomUUID() }), { PATH: '/bin' });
  await assert.rejects(codexCapabilities({ platform: 'linux' }), { code: 'unsupported_runner' });
  const execute = async (_file, args) => ({ stdout: args[0] === '--version' ? 'codex-cli 0.166.0' : '', stderr: args[0] === 'login' ? 'Logged in using ChatGPT' : '' });
  assert.equal(await codexCapabilities({ platform: 'darwin', execute }), CODEX_VERSION);
});
test('coordinator chooses Codex from working session for both arms and freezes its model/effort without changing project policy', async t => {
  const { dir, root } = await fixture(t), calls = [], probes = [];
  const policy = { enabled: true, revision: 1, runner: 'claude_code_restricted_v1', model: null, perProbeTimeoutMs: 60000, perProbeMaxTurns: 4, perProbeEstimatedUsdLimit: .05 };
  const working = { status: 'identified', runner: CODEX_RUNNER, model: 'gpt-6-astra', modelSource: 'working_session', reasoningEffort: 'high' };
  const c = new EffectCoordinator({ root, base: join(dir, 'state'), identify: async () => working, check: async ({ runner }) => { assert.equal(runner, CODEX_RUNNER); return CODEX_VERSION; }, remote: { call: async (name, args) => {
    calls.push({ name, args });
    if (name === 'prepare_effect_measurement') return { id: randomUUID(), taskId: args.brief.taskId, policyRevision: 1, expiresAt: new Date(Date.now()+86400000).toISOString() };
    if (name === 'reserve_effect_measurement') return { status: 'reserved', reservation: { runId: randomUUID(), leaseToken: randomUUID(), firstArm: 'without_foundocs', policy: { ...policy, runner: CODEX_RUNNER, model: working.model }, deliveredContext: [], deliveredContextSha256: hash('context') } };
    if (name === 'control_effect_measurement') return { action: 'continue', policyRevision: 1 };
    return { status: 'failed' };
  } }, probe: async input => { probes.push(input); return { ...input.probe, status: 'failed', finishedAt: new Date().toISOString(), observation: missingObservation() }; } });
  await c.initialize(); const brief = { taskId: randomUUID(), question: 'color?', knownContext: '', criteria: [{ id: 'color', description: 'find color' }] };
  await c.prepare({ policy, brief, allowlist: ['source.txt'] }); await c.run({ taskId: brief.taskId, retrievalIds: [] });
  assert.equal(calls[0].args.runner, CODEX_RUNNER); assert.equal(calls[0].args.model, working.model); assert.equal(probes.length, 2);
  for (const p of probes) { assert.equal(p.probe.provider, 'openai'); assert.equal(p.policy.model, working.model); assert.equal(p.policy.reasoningEffort, 'high'); }
  assert.equal(probes[0].probe.toolPolicySha256, probes[1].probe.toolPolicySha256); assert.equal(policy.model, null);
  working.reasoningEffort = 'low'; await assert.rejects(c.prepare({ policy, brief, allowlist: ['source.txt'] }), { code: 'task_conflict' });
});

test('Codex process reports actual partial usage on stop and rejects wrong model before inference', async t => {
  const { dir, root } = await fixture(t);
  const { runProbe } = await import('../src/effect-runner.mjs');
  const bin = join(dir, 'bin'); await mkdir(bin);
  const previous = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.PATH = `${bin}:${process.env.PATH}`; process.env.OPENAI_API_KEY = 'synthetic-not-a-key';
  const script = badModel => `#!${process.execPath}
import {createInterface} from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const e=JSON.parse(line);if(e.method==='initialize')send({id:e.id,result:{}});if(e.method==='thread/start')send({id:e.id,result:{model:${JSON.stringify(badModel ? 'gpt-5' : 'gpt-6-astra')},modelProvider:'openai',thread:{id:'t',environments:[],ephemeral:true},instructionSources:[],approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}}});if(e.method==='turn/start'){send({id:e.id,result:{turn:{id:'u'}}});send({method:'turn/started',params:{threadId:'t',turn:{id:'u'}}});send({method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:'u',tokenUsage:{total:{inputTokens:100,outputTokens:20,cachedInputTokens:50}}}});}});
setInterval(()=>{},1000);
`;
  const snapshot = await freezeSnapshot(root, join(dir, 'snapshot'), ['source.txt']);
  const brief = { taskId: randomUUID(), question: 'color?', knownContext: '', criteria: [{ id: 'color', description: 'find' }] };
  const policy = { runner: CODEX_RUNNER, model: 'gpt-6-astra', perProbeTimeoutMs: 1000, perProbeMaxTurns: 4 };
  const probe = { arm: 'without_foundocs', startedAt: new Date().toISOString(), observation: missingObservation(), output: null };
  await writeFile(join(bin, 'codex'), script(false), { mode: 0o700 });
  let observed;
  const partial = await runProbe({ cwd: join(dir, 'snapshot'), brief, snapshot, context: [], policy, probe, heartbeatMs: 20, heartbeat: async () => !observed, observe: async value => { observed = value; } });
  assert.equal(partial.status, 'cancelled'); assert.equal(partial.observation.completeness, 'partial'); assert.equal(partial.observation.usage.totalTokens, 120); assert.equal(partial.observation.estimatedCostUsd, null);
  await writeFile(join(bin, 'codex'), script(true), { mode: 0o700 });
  const rejected = await runProbe({ cwd: join(dir, 'snapshot'), brief, snapshot, context: [], policy, probe, heartbeat: async () => true });
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.isolationVerified, false); assert.equal(rejected.observation.completeness, 'missing');
});

test('Codex supervisor terminates its CLI and removes private runtime after coordinator SIGKILL', async t => {
  const { dir, root } = await fixture(t);
  const { spawn } = await import('node:child_process');
  const { readFile, readdir } = await import('node:fs/promises');
  const bin = join(dir, 'bin'), marker = join(dir, 'pid'); await mkdir(bin);
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},String(process.pid));\nprocess.stdin.resume();setInterval(()=>{},1000);`, { mode: 0o700 });
  const snapshot = await freezeSnapshot(root, join(dir, 'snapshot'), ['source.txt']);
  const script = join(dir, 'coordinator.mjs');
  await writeFile(script, `import {runProbe} from ${JSON.stringify(new URL('../src/effect-runner.mjs', import.meta.url).href)};await runProbe({cwd:${JSON.stringify(join(dir,'snapshot'))},brief:{criteria:[]},snapshot:${JSON.stringify(snapshot)},context:[],policy:{runner:'codex_read_tools_v1',model:'gpt-6-astra',perProbeTimeoutMs:60000,perProbeMaxTurns:4},probe:{},heartbeat:async()=>true});`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENAI_API_KEY: 'synthetic-not-a-key' }, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let pid;
  for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(marker, 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
  assert.ok(pid);
  child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve));
  let gone = false;
  for (let i = 0; i < 300; i++) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { gone = true; break; } } await new Promise(r => setTimeout(r, 20)); }
  assert.equal(gone, true);
  for (let i = 0; i < 100 && (await readdir(dir)).some(n => n.startsWith('codex-runtime-')); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal((await readdir(dir)).some(n => n.startsWith('codex-runtime-')), false);
});
