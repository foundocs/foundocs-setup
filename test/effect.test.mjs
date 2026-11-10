import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EffectCoordinator, crashSettlementDeadline } from '../src/effect.mjs';
import { freezeSnapshot, readJson, saveJson, cleanExpired } from '../src/effect-storage.mjs';
import { Observation, hash, EffectError, missingObservation, normalizeProbe } from '../src/effect-core.mjs';
import { providerEnvironment, verifiedInit } from '../src/effect-runner.mjs';

const policy = { enabled: true, revision: 1, model: 'claude-haiku-5-5', runner: 'claude_code_restricted_v1', perProbeTimeoutMs: 60000, perProbeMaxTurns: 4, perProbeEstimatedUsdLimit: .05 };
const brief = () => ({ taskId: randomUUID(), question: 'What is the setting?', knownContext: '', criteria: [{ id: 'setting', description: 'Find setting' }] });
const rawUsage = { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 };
const observation = () => { const o = new Observation(); o.accept({ type: 'result', subtype: 'success', usage: rawUsage, total_cost_usd: .001, modelUsage: { 'claude-haiku-5-5': {} } }); return o.value(); };
async function fixture(t, overrides = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'effect-unit-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'), base = join(dir, 'state'); await mkdir(root); await writeFile(join(root, 'source.txt'), 'setting alpha');
  const calls = [], spawns = []; let preparedModel = policy.model;
  const remote = { call: async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (overrides.remote) { const r = await overrides.remote(name, args); if (r !== undefined) return r; }
    if (name === 'prepare_effect_measurement') { preparedModel = args.model; return { id: randomUUID(), taskId: args.brief.taskId, policyRevision: 1, preparedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }; }
    if (name === 'reserve_effect_measurement') return { status: 'reserved', reservation: { runId: randomUUID(), leaseToken: randomUUID(), firstArm: 'without_foundocs', policy: { ...policy, model: preparedModel }, deliveredContext: [{ invocationId: randomUUID(), retrievalIds: [], text: 'setting alpha', sha256: hash('setting alpha') }], deliveredContextSha256: hash('context') } };
    if (name === 'control_effect_measurement') return { action: 'continue', policyRevision: 1 };
    if (name === 'report_effect_measurement') return { status: 'completed' };
  }};
  const coordinator = new EffectCoordinator({ root, base, remote, identify: async () => ({ status: 'identified', model: policy.model, modelSource: 'working_session' }), check: async () => '2.1.312', probe: async input => {
    spawns.push(input); if (overrides.probe) return overrides.probe(input);
    return { ...input.probe, status: 'completed', finishedAt: new Date().toISOString(), observation: { ...observation(), models: [input.policy.model] }, isolationVerified: true, evidenceVerified: true, output: { outcome: 'acquired', criteria: [{ id: 'setting', satisfied: true, finding: 'alpha', evidence: [{ source: 'snapshot', reference: 'source.txt', quote: 'setting alpha' }] }], questions: [] } };
  }});
  await coordinator.initialize(); return { dir, root, base, calls, spawns, coordinator };
}
test('OFF performs zero capability checks, remote requests, snapshots or probe spawns', async t => {
  const f = await fixture(t); f.coordinator.check = () => { throw Error('must not run'); };
  assert.deepEqual(await f.coordinator.prepare({ policy: { enabled: false } }), { status: 'skipped', reason: 'disabled' }); assert.equal(f.calls.length, 0); assert.equal(f.spawns.length, 0);
});
test('snapshot freezes uncommitted extensionless text, excludes secrets/symlinks/hardlinks/export and rejects limits atomically', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'src')); await mkdir(join(f.root, 'docs'));
  for (const name of ['Dockerfile', 'Makefile', 'README', 'src/file.custom', 'docs/user.md', 'AGENTS.md', '.env', 'foundocs.json']) await writeFile(join(f.root, name), 'original');
  await writeFile(join(f.root, 'docs/export.md'), 'foundocs:export private');
  await symlink('/etc', join(f.root, 'outside')); await symlink('../source.txt', join(f.root, 'src/link.txt')); await link(join(f.root, 'source.txt'), join(f.root, 'hard.txt'));
  const s = await freezeSnapshot(f.root, join(f.dir, 'snap'), ['Dockerfile','Makefile','README','src','docs','AGENTS.md','.env','foundocs.json','outside/hosts','hard.txt']);
  assert.deepEqual(s.files.map(x => x.path), ['Dockerfile','Makefile','README','docs/user.md','src/file.custom']);
  await writeFile(join(f.root, 'README'), 'changed'); assert.equal(await readFile(join(f.dir, 'snap/README'), 'utf8'), 'original');
  await assert.rejects(freezeSnapshot(f.root, join(f.dir, 'large'), ['README'], [], { bytes: 1 }), { code: 'snapshot_unavailable' });
  await assert.rejects(readFile(join(f.dir, 'large/README')), { code: 'ENOENT' });
  await assert.rejects(freezeSnapshot(f.root, join(f.dir, 'escape'), ['../root']), { code: 'snapshot_unavailable' });
});
test('result usage supersedes deduplicated assistant counts; partial, missing and crash USD stay independent', () => {
  const o = new Observation(); const a = { type: 'assistant', message: { id: 'm', model: policy.model, usage: rawUsage } }; o.accept(a);o.accept(a);assert.equal(o.value().usage.totalTokens, 17);assert.equal(o.value().completeness,'partial');
  o.accept({type:'result',subtype:'success',usage:rawUsage,total_cost_usd:.5,modelUsage:{[policy.model]:{}}});assert.equal(o.value().usage.totalTokens,17);assert.equal(o.value().completeness,'complete');
  o.accept({type:'result',subtype:'error_session_crashed',total_cost_usd:.3});assert.equal(o.value().estimatedCostUsd,.3);assert.equal(o.value().completeness,'partial');
  const missing=new Observation();missing.accept({type:'result',total_cost_usd:.4});assert.equal(missing.value().usage,null);assert.equal(missing.value().estimatedCostUsd,.4);
});
test('canonical hashes sort objects, preserve array order; provider environment strips coordinator keys and injection', () => {
  assert.equal(hash({b:2,a:1}),hash({a:1,b:2}));assert.notEqual(hash([1,2]),hash([2,1]));
  assert.deepEqual(providerEnvironment({ HOME:'/home',ANTHROPIC_API_KEY:'provider',FOUNDOCS_API_KEY:'secret',NODE_OPTIONS:'--import=evil',STEERCARDS_AGENT_KEY:'secret',ANTHROPIC_BASE_URL:'evil'}),{HOME:'/home',ANTHROPIC_API_KEY:'provider'});
  assert.equal(verifiedInit({type:'system',subtype:'init',model:policy.model,tools:['Read','Glob','Grep'],mcp_servers:[],skills:[]},policy.model),true);
  assert.equal(verifiedInit({type:'system',subtype:'init',model:policy.model,tools:['Read','Bash'],mcp_servers:[],skills:[]},policy.model),false);
});
test('server order, two independent snapshots, task grouping, duplicate execution suppression', async t => {
  const f = await fixture(t), b = brief(); await f.coordinator.prepare({policy,brief:b,allowlist:['source.txt']});
  await writeFile(join(f.root,'source.txt'),'changed after prepare');
  const run = {taskId:b.taskId,retrievalIds:[randomUUID(),randomUUID()]}; assert.equal((await f.coordinator.run(run)).status,'reported');
  assert.deepEqual(f.spawns.map(s=>s.probe.arm),['without_foundocs','with_foundocs']);assert.equal(f.spawns[0].context.length,0);assert.equal(f.spawns[1].context.length,1);
  assert.notEqual(f.spawns[0].cwd,f.spawns[1].cwd);assert.equal((await f.coordinator.run(run)).status,'already_reported');assert.equal(f.spawns.length,2);
  assert.equal(f.calls.filter(c=>c.name==='reserve_effect_measurement').length,1);
});
test('stop after first arm prevents second and preserves incurred cost', async t => {
  const f=await fixture(t,{remote:(name,args)=> name==='control_effect_measurement' && args.probe ? {action:'stop',policyRevision:2}:undefined});const b=brief();await f.coordinator.prepare({policy,brief:b,allowlist:['source.txt']});await f.coordinator.run({taskId:b.taskId,retrievalIds:[randomUUID()]});assert.equal(f.spawns.length,1);
  const report=f.calls.find(c=>c.name==='report_effect_measurement').args;assert.equal(report.withoutFoundocs.observation.usage.totalTokens,17);assert.equal(report.withFoundocs.status,'not_started');
});
test('oversized output normalized BEFORE observation heartbeat, usage/USD retained', async t => {
  const f=await fixture(t,{probe:async i=>({...i.probe,status:'completed',finishedAt:new Date().toISOString(),observation:observation(),output:{bad:'x'.repeat(50000)}})});const b=brief();await f.coordinator.prepare({policy,brief:b,allowlist:['source.txt']});await f.coordinator.run({taskId:b.taskId,retrievalIds:[]});
  for(const call of f.calls.filter(c=>c.args.probe)) {assert.equal(call.args.probe.output,null);assert.equal(call.args.probe.status,'failed');assert.equal(call.args.probe.observation.estimatedCostUsd,.001);}
});
test('outbox replays identical request/payload only, never inference, definite rejection is not retried', async t => {
  let attempts=0;const f=await fixture(t,{remote:name=>{if(name==='report_effect_measurement' && ++attempts<2) throw new EffectError('network','network',true);}});const b=brief();await f.coordinator.prepare({policy,brief:b,allowlist:['source.txt']});assert.equal((await f.coordinator.run({taskId:b.taskId,retrievalIds:[]})).status,'report_pending');assert.equal((await f.coordinator.flush(b.taskId)).status,'reported');assert.equal(f.spawns.length,2);
  const reports=f.calls.filter(c=>c.name==='report_effect_measurement');assert.deepEqual(reports[0].args,reports[1].args);
  const f2=await fixture(t,{remote:name=>{if(name==='report_effect_measurement') throw new EffectError('VALIDATION_ERROR');}});const b2=brief();await f2.coordinator.prepare({policy,brief:b2,allowlist:['source.txt']});assert.equal((await f2.coordinator.run({taskId:b2.taskId,retrievalIds:[]})).status,'report_rejected');await f2.coordinator.flush(b2.taskId);assert.equal(f2.calls.filter(c=>c.name==='report_effect_measurement').length,1);
});
test('expired local raw state/outbox physically removed on next command', async t => {
  const f=await fixture(t),id=randomUUID(),dir=join(f.base,id);await mkdir(dir,{mode:0o700});await saveJson(join(dir,'state.json'),{expiresAt:new Date(0).toISOString()});await saveJson(join(dir,'outbox.json'),{payload:{}});await cleanExpired(f.base);await assert.rejects(readJson(join(dir,'state.json')),{code:'ENOENT'});
});
test('raw expiry preserves settlement outbox, flush works without brief/snapshot/context, retry never extends TTL', async t => {
  let fail=true;const f=await fixture(t,{remote:name=>{if(name==='report_effect_measurement'&&fail)throw new EffectError('network','network',true);}});const b=brief();await f.coordinator.prepare({policy,brief:b,allowlist:['source.txt']});await f.coordinator.run({taskId:b.taskId,retrievalIds:[]});
  const dir=join(f.base,b.taskId),state=await readJson(join(dir,'state.json'));state.expiresAt=new Date(0).toISOString();await saveJson(join(dir,'state.json'),state);const deadline=state.settlementExpiresAt;
  await cleanExpired(f.base);const pruned=await readJson(join(dir,'state.json'));assert.equal(pruned.brief,undefined);assert.equal(pruned.snapshot,undefined);assert.equal(pruned.reservation.deliveredContext,undefined);assert.equal(pruned.prepareInput,undefined);assert.equal(pruned.settlementExpiresAt,deadline);
  assert.equal((await f.coordinator.flush(b.taskId)).status,'report_pending');assert.equal((await readJson(join(dir,'state.json'))).settlementExpiresAt,deadline);fail=false;assert.equal((await f.coordinator.flush(b.taskId)).status,'reported');
});
test('pre-aborted probe never spawns and lost start_arm response never reaches child', async t => {
  const {runProbe}=await import('../src/effect-runner.mjs');const c=new AbortController();c.abort();let spawns=0;
  const p=await runProbe({signal:c.signal,probe:{status:'failed',startedAt:new Date().toISOString(),finishedAt:null},spawnChild:()=>{spawns++;}});assert.equal(p.status,'not_started');assert.equal(spawns,0);
  const f=await fixture(t,{remote:(name,args)=>{if(name==='control_effect_measurement'&&args.action==='start_arm')throw new EffectError('transport_uncertain','lost grant',true);}}),b=brief();await f.coordinator.prepare({policy,brief:b,allowlist:['source.txt']});await f.coordinator.run({taskId:b.taskId,retrievalIds:[]});assert.equal(f.spawns.length,0);assert.equal(f.calls.filter(c=>c.args.action==='start_arm').length,1);
});
test('watchdog stops orphan process group after coordinator SIGKILL', {timeout:15000}, async t => {
  const {spawn}=await import('node:child_process');const f=await fixture(t),bin=join(f.dir,'bin');await mkdir(bin);
  const pidFile=join(f.dir,'provider.pid');await writeFile(join(bin,'claude'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,{mode:0o700});
  const script=join(f.dir,'coordinator.mjs');await writeFile(script,`import {spawnSupervised} from ${JSON.stringify(new URL('../src/effect-runner.mjs',import.meta.url).href)};const c=spawnSupervised('claude',[],{cwd:${JSON.stringify(f.root)},env:{PATH:${JSON.stringify(bin)},HOME:${JSON.stringify(f.dir)}},effectTimeoutMs:20000});c.stdin.end('fixture');c.stdout.resume();c.stderr.resume();`);
  const child=spawn(process.execPath,[script],{stdio:'ignore'});t.after(()=>child.kill('SIGKILL'));
  let pid;for(let i=0;i<100;i++){try{pid=Number(await readFile(pidFile,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,20));}}
  assert.ok(pid);child.kill('SIGKILL');await new Promise(r=>child.once('close',r));
  let alive=true;for(let i=0;i<350;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){alive=false;break;}}await new Promise(r=>setTimeout(r,20));}
  if(alive)process.kill(pid,'SIGKILL');assert.equal(alive,false,'orphan provider survived watchdog grace');
});
test('SIGKILL after usage fsync recovers known cost without spawning again', {timeout:10000}, async t => {
  const {spawn}=await import('node:child_process');const f=await fixture(t),b=brief();await f.coordinator.prepare({policy,brief:b,allowlist:['source.txt']});
  const statePath=join(f.base,b.taskId,'state.json'),script=join(f.dir,'crash.mjs');
  await writeFile(script,`import {EffectCoordinator} from ${JSON.stringify(new URL('../src/effect.mjs',import.meta.url).href)};const remote={call:async(name,args)=>name==='reserve_effect_measurement'?{status:'reserved',reservation:{runId:${JSON.stringify(randomUUID())},leaseToken:${JSON.stringify(randomUUID())},firstArm:'without_foundocs',policy:${JSON.stringify(policy)},deliveredContext:[],deliveredContextSha256:${JSON.stringify(hash('context'))}}}:{action:'continue',policyRevision:1}};const c=new EffectCoordinator({root:${JSON.stringify(f.root)},base:${JSON.stringify(f.base)},remote,check:async()=>'2.1.312',probe:async i=>{await i.observe(${JSON.stringify(observation())});process.kill(process.pid,'SIGKILL');}});await c.run({taskId:${JSON.stringify(b.taskId)},retrievalIds:[]});`);
  const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',d=>stderr+=d);const result=await new Promise(r=>child.on('close',(code,signal)=>r({code,signal})));assert.equal(result.signal,'SIGKILL',stderr);const before=await readJson(statePath);assert.equal(before.probes.without_foundocs.observation.usage.totalTokens,17);
  assert.equal((await f.coordinator.flush(b.taskId)).status,'reported');assert.equal(f.spawns.length,0);const report=f.calls.find(c=>c.name==='report_effect_measurement').args;assert.equal(report.withoutFoundocs.status,'failed');assert.equal(report.withoutFoundocs.observation.usage.totalTokens,17);assert.equal((await readJson(statePath)).settlementExpiresAt,before.settlementExpiresAt);
});
test('concurrent raw cleanup and stale journal writers never resurrect raw or lose known usage', async t => {
  const f=await fixture(t),b=brief();await f.coordinator.prepare({policy,brief:b,allowlist:['source.txt']});
  const dir=join(f.base,b.taskId),path=join(dir,'state.json'),stale=await readJson(path);
  stale.settlementExpiresAt=new Date(Date.now()+86400000).toISOString();stale.expiresAt=new Date(Date.now()-1).toISOString();stale.probes={without_foundocs:{observation:observation()}};
  // All raw gets stripped at the write boundary, even before the cleaner wins its lock.
  await Promise.all([saveJson(path,stale),saveJson(path,stale)]);await cleanExpired(f.base);await saveJson(path,{...stale,rawExpired:false});
  const final=await readJson(path);assert.equal(final.rawExpired,true);assert.equal(final.brief,undefined);assert.equal(final.snapshot,undefined);assert.equal(final.prepareInput,undefined);assert.equal(final.probes.without_foundocs.observation.usage.totalTokens,17);await assert.rejects(readFile(join(dir,'snapshot/source.txt')),{code:'ENOENT'});
});
test('heartbeat failure stops running child and preserves partial tokens plus terminal failure USD', {timeout:10000}, async t => {
  const {runProbe}=await import('../src/effect-runner.mjs');const f=await fixture(t),bin=join(f.dir,'heartbeat-bin');await mkdir(bin);
  const init={type:'system',subtype:'init',model:policy.model,tools:['Read','Glob','Grep'],mcp_servers:[],skills:[]};
  const assistant={type:'assistant',message:{id:'known',model:policy.model,usage:rawUsage,content:[]}};
  await writeFile(join(bin,'claude'),`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(init))});console.log(${JSON.stringify(JSON.stringify(assistant))});process.on('SIGINT',()=>{console.log(JSON.stringify({type:'result',subtype:'error_session_crashed',total_cost_usd:.02,modelUsage:{'claude-haiku-5-5':{}}}));process.exit(1)});setInterval(()=>{},1000);`,{mode:0o700});
  const before=process.env.PATH;process.env.PATH=`${bin}:${before}`;t.after(()=>{process.env.PATH=before;});let checks=0,observed=false;
  const result=await runProbe({cwd:f.root,brief:brief(),snapshot:{files:[]},context:[],policy,probe:{arm:'without_foundocs',startedAt:new Date().toISOString()},observe:async()=>{observed=true;},heartbeat:async()=>{if(!observed)return true;checks++;throw new Error('network');},heartbeatMs:100});
  assert.equal(checks,1);assert.equal(result.status,'cancelled');assert.equal(result.observation.completeness,'partial');assert.equal(result.observation.usage.totalTokens,17);assert.equal(result.observation.estimatedCostUsd,.02);
});

test('unobserved crash settlement includes bounded execution allowance and is deterministic', () => {
  assert.equal(Date.parse(crashSettlementDeadline(policy, 0)), 86400000 + 2 * (60000 + 5000));
});

test('working model comes from current session, never the legacy policy or an override', async t => {
  const { workingSessionModel } = await import('../src/effect-host.mjs');
  const f = await fixture(t), sessionId = randomUUID(), transcriptPath = join(f.dir, `${sessionId}.jsonl`);
  const host = { client: 'claude_code', sessionId, transcriptPath };
  const event = model => ({ type: 'assistant', sessionId, cwd: f.root, timestamp: new Date().toISOString(), message: { model, content: [{ type: 'text', text: 'private conversation must not leave reader' }] } });
  await writeFile(transcriptPath, [event('claude-haiku-5-5'), event('claude-sonnet-5')].map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(await workingSessionModel(host, f.root), { status: 'identified', model: 'claude-sonnet-5', modelSource: 'working_session' });
  f.coordinator.identify = workingSessionModel;
  const b = brief();
  await f.coordinator.prepare({ policy: { ...policy, model: 'claude-haiku-5-5' }, host, brief: b, allowlist: ['source.txt'] });
  const preparation = f.calls.find(c => c.name === 'prepare_effect_measurement').args;
  assert.equal(preparation.model, 'claude-sonnet-5');
  assert.equal(preparation.modelSource, 'working_session');
  assert.equal(JSON.stringify(preparation).includes('private conversation'), false);
  assert.equal(JSON.stringify(preparation).includes('transcriptPath'), false);
  const state = await readJson(join(f.base, b.taskId, 'state.json'));
  assert.equal(state.policy.model, 'claude-sonnet-5');
  assert.equal((await f.coordinator.run({ taskId: b.taskId, retrievalIds: [randomUUID()] })).status, 'reported');
  assert.deepEqual(f.spawns.map(input => input.policy.model), ['claude-sonnet-5', 'claude-sonnet-5']);
  assert.deepEqual(f.spawns.map(input => input.probe.model), ['claude-sonnet-5', 'claude-sonnet-5']);
  // A later /model switch must not silently change an already prepared task.
  await writeFile(transcriptPath, JSON.stringify(event('claude-opus-5')));
  await assert.rejects(f.coordinator.prepare({ policy, host, brief: b, allowlist: ['source.txt'] }), { code: 'task_conflict' });
  await writeFile(transcriptPath, JSON.stringify(event('claude-haiku-5-5')) + '\n{\"type\":\"assistant\"');
  assert.equal((await workingSessionModel(host, f.root)).reason, 'working_model_unavailable');
  assert.equal((await workingSessionModel({ ...host, transcriptPath: 42 }, f.root)).reason, 'working_model_unavailable');
  for (const changed of [event('haiku'), { ...event('claude-sonnet-5'), sessionId: randomUUID() }, { ...event('claude-sonnet-5'), timestamp: new Date(0).toISOString() }]) {
    await writeFile(transcriptPath, JSON.stringify(event('claude-haiku-5-5')) + '\n' + JSON.stringify(changed));
    assert.equal((await workingSessionModel(host, f.root)).reason, 'working_model_unavailable');
  }
});

test('missing session, Codex host, unavailable runner and OFF never launch a substitute model', async t => {
  const { workingSessionModel } = await import('../src/effect-host.mjs');
  const f = await fixture(t); f.coordinator.identify = workingSessionModel;
  f.coordinator.check = () => { throw Error('must not inspect runner'); };
  for (const [host, reason] of [[undefined, 'working_model_unavailable'], [{ client: 'codex' }, 'working_model_unavailable'], [{ client: 'claude_code', model: policy.model }, 'working_model_unavailable']]) {
    assert.deepEqual(await f.coordinator.prepare({ policy, host, brief: brief(), allowlist: ['source.txt'] }), { status: 'skipped', reason });
  }
  f.coordinator.identify = () => { throw Error('must not read metadata when OFF'); };
  assert.deepEqual(await f.coordinator.prepare({ policy: { enabled: false } }), { status: 'skipped', reason: 'disabled' });
  f.coordinator.identify = async () => ({ status: 'identified', model: policy.model, modelSource: 'working_session' });
  f.coordinator.check = () => { throw new EffectError('unsupported_runner'); };
  assert.deepEqual(await f.coordinator.prepare({ policy, brief: brief(), allowlist: ['source.txt'] }), { status: 'skipped', reason: 'unsupported_runner' });
  assert.equal(f.calls.length, 0); assert.equal(f.spawns.length, 0);
});
