import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AutomaticMeasurement, automaticTool } from '../src/effect-automatic.mjs';
import { validateAutomaticConsent } from '../src/effect-config.mjs';
const envelope = data => ({ structuredContent: { ok: true, data }, content: [] });
function fixture(options = {}) {
  const projectId = randomUUID(), taskId = randomUUID(), preparation = randomUUID(), calls = [], states = new Map();
  const task = { taskId, question: 'Where is retry configured?', knownContext: '', criteria: [{ id: 'setting', description: 'Find the setting.' }] };
  let id = randomUUID();
  const remote = async (name, args, raw) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'get_effect_measurement_policy') return { enabled: options.enabled !== false };
    if (name === 'report_effect_diagnostic') { if (options.diagnosticFailure) throw new Error('offline'); return { recorded: true }; }
    if (name === 'report_retrieval_evaluation') return options.evaluationFailure ? { structuredContent: { ok: false } } : envelope({});
    assert.equal(raw, true); return envelope({ retrievals: [{ retrievalId: id }] });
  };
  const automatic = new AutomaticMeasurement({ projectId, remote,
    store: { load: async id => structuredClone(states.get(id) ?? null), save: async state => states.set(state.taskId, structuredClone(state)) },
    factory: async () => ({ config: { enabled: options.consent !== false, allowlist: options.allowlist ?? ['src'], excludePaths: [] }, coordinator: {
      prepare: async args => { calls.push({ name: 'prepare', args }); if (options.prepareError) throw Object.assign(new Error(), { code: options.prepareError }); return { status: 'prepared', effectPreparationId: preparation }; },
      run: async args => { calls.push({ name: 'run', args }); return options.runResult ?? { status: 'reported', result: { status: 'completed' } }; },
    } }),
  });
  return { automatic, task, taskId, projectId, preparation, calls, states,
    read: (metadata = task) => automatic.call({ name: 'get_doc', arguments: { project_id: projectId, effectTask: metadata } }),
    nextId: () => id = randomUUID(),
    evaluate: (complete = true, verdict = 'beneficial') => automatic.call({ name: 'report_retrieval_evaluation', arguments: { project_id: projectId, retrievalId: id, verdict, effectTaskId: taskId, effectTaskComplete: complete } }),
  };
}
test('first read prepares before exposure, attaches identity, and final successful evaluation starts one comparison', async () => {
  const f = fixture(); await f.read();
  assert(f.calls.findIndex(c => c.name === 'prepare') < f.calls.findIndex(c => c.name === 'get_doc'));
  assert.equal(f.calls.find(c => c.name === 'get_doc').args.effectPreparationId, f.preparation);
  assert(!('effectTask' in f.calls.find(c => c.name === 'get_doc').args));
  await f.evaluate(); await f.evaluate(); await f.automatic.drain();
  assert.equal(f.calls.filter(c => c.name === 'run').length, 1);
  assert.equal(f.calls.at(-1).args.status, 'completed');
});
test('multiple reads are frozen once and every retrieval must be evaluated before completion', async () => {
  const f = fixture(); await f.read(); const first = f.states.get(f.taskId).retrievals[0];
  f.nextId(); await f.read({ taskId: f.taskId }); await f.evaluate(); await f.automatic.drain();
  assert.equal(f.calls.filter(c => c.name === 'run').length, 0);
  await f.automatic.call({ name: 'report_retrieval_evaluation', arguments: { project_id: f.projectId, retrievalId: first, verdict: 'not_beneficial', effectTaskId: f.taskId, effectTaskComplete: true } });
  await f.automatic.drain(); assert.equal(f.calls.filter(c => c.name === 'prepare').length, 1);
  assert.equal(f.calls.find(c => c.name === 'run').args.retrievalIds.length, 2);
});
for (const options of [{ enabled: false }, { consent: false }, { prepareError: 'EPERM' }, { prepareError: 'connection_unavailable' }]) test(`ordinary read survives unmeasured path ${JSON.stringify(options)}`, async () => {
  const f = fixture(options); const result = await f.read(); await f.evaluate(); await f.automatic.drain();
  assert.equal(result.structuredContent.ok, true); assert(!f.calls.some(c => c.name === 'run'));
  if (options.enabled === false || options.consent === false) assert(!f.calls.some(c => c.name === 'prepare'));
});
test('no metadata is recorded as missing preparation, never reconstructed on a later read', async () => {
  const f = fixture(); await f.read({ taskId: f.taskId });
  await assert.rejects(f.read(), /frozen/); assert(!f.calls.some(c => c.name === 'prepare'));
});
test('failed evaluation is not admission for inference', async () => {
  const f = fixture({ evaluationFailure: true }); await f.read(); await f.evaluate(); await f.automatic.drain();
  assert(!f.calls.some(c => c.name === 'run'));
});
test('all unhelpful evaluations close without inference', async () => {
  const f = fixture(); await f.read(); await f.evaluate(true, 'not_beneficial'); await f.automatic.drain();
  assert(!f.calls.some(c => c.name === 'run')); assert.equal(f.calls.at(-1).args.reason, 'no_beneficial_retrieval'); assert.equal(f.states.get(f.taskId).settled, true);
});
test('diagnostic network failure retains an outbox and does not fail a read', async () => {
  const f = fixture({ diagnosticFailure: true }); assert.equal((await f.read()).structuredContent.ok, true);
  assert(f.states.get(f.taskId).diagnostic);
});
test('different project cannot use the installed source snapshot', async () => {
  const f = fixture(); await assert.rejects(f.automatic.call({ name: 'get_doc', arguments: { project_id: randomUUID(), effectTask: f.task } }), /project mismatch/);
  assert(!f.calls.some(c => c.name === 'prepare'));
});
test('reservation denial is visible and not retried', async () => {
  const f = fixture({ runResult: { status: 'skipped', reason: 'budget_admission_denied' } }); await f.read(); await f.evaluate(); await f.automatic.drain();
  assert.equal(f.calls.at(-1).args.reason, 'budget_admission_denied');
  await f.evaluate(); assert.equal(f.calls.filter(c => c.name === 'run').length, 1);
});
test('tool metadata admits local context but does not claim reads cannot trigger outside work', () => {
  const tool = automaticTool({ name: 'get_doc', description: 'Read', inputSchema: { properties: { project_id: {} } }, annotations: { readOnlyHint: true } });
  assert(tool.inputSchema.properties.effectTask); assert.equal(tool.annotations.readOnlyHint, false);
});
test('consent cannot be inferred from policy ON or widened by parent paths', () => {
  assert.throws(() => validateAutomaticConsent({ enabled: true }), /consent_required/);
  const input = { enabled: true, consentVersion: 1, shareProjectDataWithWorkingModel: true, additionalModelUsage: true, allowlist: ['src'], excludePaths: [] };
  assert.equal(validateAutomaticConsent(input).enabled, true);
  for (const path of ['.', '../other', '/absolute', 'src/../other', 'src\\other']) assert.throws(() => validateAutomaticConsent({ ...input, allowlist: [path] }));
  assert.deepEqual(validateAutomaticConsent({ enabled: false }), { enabled: false });
});

test('restart recovers reports without ever calling prepare or run', async () => {
  const f = fixture(); await f.read();
  const state = f.states.get(f.taskId); state.closed = true; state.settled = false;
  const recovered = new AutomaticMeasurement({ projectId: f.projectId,
    store: { list: async () => [state], save: async () => {} },
    remote: async name => { assert.equal(name, 'report_effect_diagnostic'); return { recorded: true }; },
    factory: async () => ({ coordinator: { flush: async id => { assert.equal(id, f.taskId); return { status: 'already_reported' }; }, prepare: () => assert.fail(), run: () => assert.fail() } }),
  });
  await recovered.recover(); assert.equal(state.settled, true);
});
test('readiness identifies separate consent, CLI, connection and model blockers with zero inference', async () => {
  const { automaticReadiness } = await import('../src/effect-config.mjs');
  const result = await automaticReadiness({ config: { enabled: false }, checkCli: async () => { throw new Error(); },
    checkConnection: async () => { throw new Error(); }, identify: async () => ({ status: 'skipped' }) });
  assert.equal(result.inferenceExecuted, false); assert.equal(result.ready, false);
  assert.deepEqual(result.issues, ['consent_required', 'unsupported_runner', 'connection_unavailable', 'working_model_unavailable']);
});

test('legacy reads preserve non-UUID task labels without implicit automatic preparation', async () => {
  const f = fixture();
  await f.automatic.call({ name: 'get_doc', arguments: { project_id: f.projectId, taskId: 'existing-task' } });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.taskId, 'existing-task');
});

test('changed source consent never runs a previously frozen snapshot', async () => {
  const options = { allowlist: ['src'] }, f = fixture(options);
  await f.read(); options.allowlist = ['other'];
  await f.evaluate(); await f.automatic.drain();
  assert(!f.calls.some(c => c.name === 'run'));
  assert.equal(f.calls.at(-1).args.reason, 'consent_required');
});

test('uncertain report remains recoverable and visible without repeating inference', async () => {
  const f = fixture({ runResult: { status: 'report_pending', reason: 'transport_uncertain' } });
  await f.read(); await f.evaluate(); await f.automatic.drain();
  assert.equal(f.calls.at(-1).args.reason, 'report_pending');
  assert.equal(f.states.get(f.taskId).settled, false);
  await f.evaluate(); assert.equal(f.calls.filter(c => c.name === 'run').length, 1);
});
