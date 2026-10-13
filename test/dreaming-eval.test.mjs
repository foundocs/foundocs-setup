import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateTrace } from '../eval/evaluate-trace.mjs';

const fixtures = JSON.parse(await readFile(new URL('../eval/dreaming-cases.json', import.meta.url), 'utf8'));
const empty = fixtures.find(f => f.id === 'empty-project');
const stages = [3, 4, 5, 6, 7, 8].map(stage => ({ stage, status: 'not_applicable', reason: 'No knowledge' }));
const baseRun = { id: 'run', leaseGeneration: 1, targets: [], inspectedIds: [], stages: [], status: 'running', appliedCount: 0, pendingReviewCount: 0, observationCount: 0 };
const result = run => ({ ok: true, data: { run, reportUrl: '/report/run', reviewUrl: '/report/run?review=1' } });
const step = (action, extra, run) => ({ tool: 'dream_memory', arguments: { project_id: empty.projectId, requestId: action, action, ...(action === 'begin' ? {} : { runId: 'run', leaseGeneration: 1 }), ...extra }, result: result(run) });
function valid() {
  return { steps: [step('begin', {}, baseRun), step('checkpoint', { stages, inspectedIds: [] }, { ...baseRun, stages }), step('finish', { status: 'completed', summary: 'No changes justified' }, { ...baseRun, stages, status: 'completed' })], final: { status: 'completed', appliedCount: 0, pendingReviewCount: 0, observationCount: 0, inspectedCount: 0, reportUrl: '/report/run' } };
}

test('protocol checker accepts a server-confirmed zero-change lifecycle, without claiming model evaluation', () => {
  const evaluated = evaluateTrace(empty, valid());
  assert.deepEqual(evaluated.violations, []);
  assert.equal(evaluated.protocolPassed, true);
  assert.equal(evaluated.modelQualityVerified, false);
  assert.ok(evaluated.semanticReviewRequired.length > 0);
});

test('checker rejects bypass, stale lease, changed retry payload and fabricated final counts', () => {
  const trace = valid();
  trace.steps.splice(1, 0, { tool: 'delete_doc', arguments: { project_id: empty.projectId } });
  trace.steps[2].arguments.leaseGeneration = 0;
  trace.steps[3].arguments.requestId = 'checkpoint';
  trace.final.appliedCount = 17;
  const { violations } = evaluateTrace(empty, trace);
  for (const phrase of ['Generic content mutation', 'Stale lease', 'Changed payload', 'Final appliedCount']) assert.ok(violations.some(v => v.includes(phrase)), phrase);
});

test('checker rejects false coverage and omitted stages', () => {
  const trace = valid();
  for (const item of trace.steps) item.result.data.run = { ...item.result.data.run, targets: [{ contentId: 'unread', versionToken: 'v1' }], stages: [] };
  const { violations } = evaluateTrace(empty, trace);
  assert.ok(violations.some(v => v.includes('full coverage')));
  assert.ok(violations.some(v => v.includes('six stage')));
});

test('checker rejects quoted/unavailable triggers but permits truthful no-call handling', () => {
  for (const id of ['quoted-trigger', 'tools-unavailable', 'ambiguous-project']) {
    const fixture = fixtures.find(f => f.id === id);
    assert.equal(evaluateTrace(fixture, { steps: [] }).protocolPassed, true);
    assert.equal(evaluateTrace(fixture, valid()).protocolPassed, false);
  }
});

test('checker validates mutation policy, version preconditions and exact evidence passages', () => {
  const fixture = fixtures.find(f => f.id === 'old-unread-rule');
  const target = fixture.knowledge[0];
  const trace = valid();
  trace.steps.splice(2, 0, step('submit', { candidates: [{ candidateId: 'candidate', stages: [6], title: 'Archive old rule', reason: 'Unused', impact: 'Hidden', targets: [], evidence: [{ contentId: target.id, versionToken: 'wrong', excerpt: 'Invented' }], mutations: [{ type: 'archive', contentId: target.id }], dependsOn: [], alternatives: [], uncertainty: [], requestedDisposition: 'auto_candidate' }] }, baseRun));
  const { violations } = evaluateTrace(fixture, trace);
  for (const phrase of ['forbids archive', 'Meaningful mutation', 'version precondition', 'Evidence version', 'fabricated']) assert.ok(violations.some(v => v.includes(phrase)), phrase);
});

test('paginated receipts retain authoritative coverage without mistaking truncated inspected IDs for zero', () => {
  const trace = valid();
  const target = { contentId: 'source', versionToken: 'version-1' };
  const receipt = { ...baseRun, targets: [target], targetTotal: 1, targetNextOffset: null, inspectedIds: [], inspectedIdsTruncated: true, inspectedCount: 0, detailsTruncated: true };
  trace.steps[0].result = result(receipt);
  trace.steps.splice(1, 0, { tool: 'get_doc', arguments: { project_id: empty.projectId, id: target.contentId }, result: { ok: true, data: { id: target.contentId, versionToken: target.versionToken, bodyMarkdown: 'A real inspected source.' } } });
  trace.steps[2].arguments.inspectedIds = [target.contentId];
  trace.steps[2].result = result({ ...receipt, stages, inspectedCount: 1 });
  trace.steps[3].result = result({ ...receipt, stages, inspectedCount: 1, status: 'completed' });
  trace.final.inspectedCount = 1;
  assert.deepEqual(evaluateTrace(empty, trace).violations, []);
  trace.final.inspectedCount = 0;
  assert.ok(evaluateTrace(empty, trace).violations.some(v => v.includes('Final coverage')));
  trace.steps.splice(1, 1);
  assert.ok(evaluateTrace(empty, trace).violations.some(v => v.includes('without a captured source read')));
});


test('manual archive and restore cannot bypass Dreaming even when the tool is available', () => {
  for (const memoryStatus of ['archived', 'active']) {
    const trace = valid();
    trace.steps.splice(1, 0, { tool: 'set_knowledge_status', arguments: { project_id: empty.projectId, memoryStatus } });
    const fixture = { ...empty, availableTools: [...empty.availableTools, 'set_knowledge_status'] };
    const { violations } = evaluateTrace(fixture, trace);
    assert.ok(violations.some(v => v.includes('Generic content mutation bypasses Dreaming')));
    assert.ok(!violations.some(v => v.includes('Tool was unavailable')));
  }
});
