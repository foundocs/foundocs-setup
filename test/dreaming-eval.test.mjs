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

function folderMove({ capability = true, patch = {}, disposition = 'auto_candidate', extraMutations = [] } = {}) {
  const source = { id: 'source', versionToken: 'v1', kind: 'knowledge', category: 'learnings', path: 'knowledge/learnings/session.md', title: 'Session expiry', bodyMarkdown: 'Recheck the session after expiry. See [refresh](./refresh.md).', tldr: 'Recheck expiry', tags: ['auth', 'session'], created: '2026-10-20' };
  const { id: _id, versionToken: _version, ...content } = source;
  const fixture = { ...empty, id: 'folder-move', knowledge: [source], constraints: { maxCandidates: 1 }, capabilities: { autoPathOnlyKnowledgeMoves: capability }, availableTools: [...empty.availableTools, 'get_doc', 'get_content_moves', 'undo_content_move'] };
  const target = { contentId: source.id, versionToken: source.versionToken };
  const running = { ...baseRun, targets: [target], inspectedIds: [source.id], inspectedCount: 1, stages };
  const candidate = { candidateId: 'folder', stages: [3], title: 'Reuse auth folder', reason: 'Related session knowledge already lives here', impact: 'Easier retrieval', targets: [target], evidence: [{ ...target, location: 'body', excerpt: 'Recheck the session after expiry.' }], mutations: [{ type: 'update', contentId: source.id, after: { ...content, path: 'knowledge/learnings/auth/session.md', reason: 'Reuse the existing auth topic', ...patch } }, ...extraMutations], dependsOn: [], alternatives: [], uncertainty: [], requestedDisposition: disposition };
  const applied = disposition === 'auto_candidate' ? 1 : 0;
  const finished = { ...running, status: 'completed', appliedCount: applied, pendingReviewCount: 1 - applied };
  const trace = { steps: [step('begin', {}, { ...running, inspectedIds: [], inspectedCount: 0 }), { tool: 'get_doc', arguments: { project_id: empty.projectId, id: source.id }, result: { ok: true, data: source } }, step('submit', { candidates: [candidate] }, { ...running, appliedCount: applied, pendingReviewCount: 1 - applied }), step('finish', { status: 'completed', summary: 'Folder finding saved' }, finished)], final: { ...valid().final, appliedCount: applied, pendingReviewCount: 1 - applied, inspectedCount: 1 } };
  return { fixture, trace };
}

test('folder trace permits only advertised same-category path-only automatic moves', () => {
  for (const path of ['knowledge/learnings/auth/session.md', 'knowledge/learnings/auth/browser/session.md', 'knowledge/learnings/expiry.md']) {
    const { fixture, trace } = folderMove({ patch: { path } });
    assert.deepEqual(evaluateTrace(fixture, trace).violations, []);
  }
  const { fixture, trace } = folderMove({ capability: false });
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('not supported by this server')));
  const reviewed = folderMove({ capability: false, disposition: 'review_candidate' });
  assert.deepEqual(evaluateTrace(reviewed.fixture, reviewed.trace).violations, []);
});

test('folder trace rejects semantic, cross-category, forged-field, unchanged and escaping automatic updates', () => {
  for (const patch of [
    { bodyMarkdown: 'Edited meaning' }, { title: 'Different' }, { tldr: 'Different' }, { tags: ['session', 'auth'] }, { created: '2026-10-21' },
    { kind: 'document', category: null, path: 'docs/session.md' }, { category: 'rules', path: 'knowledge/rules/auth/session.md' },
    { memoryStatus: 'archived' }, { importance: 'low' }, { linkBasePath: 'docs/fake.md' },
    { path: 'knowledge/learnings/session.md' }, { path: 'knowledge/learnings/../rules/session.md' }, { path: 'knowledge/other/session.md' },
  ]) {
    const { fixture, trace } = folderMove({ patch });
    assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('Meaningful mutation')), JSON.stringify(patch));
    const reviewed = folderMove({ patch, disposition: 'review_candidate' });
    // Schema/path validity belongs to server validation; review cannot authorize an automatic write.
    assert.ok(!evaluateTrace(reviewed.fixture, reviewed.trace).violations.some(v => v.includes('automatic application')));
  }
});

test('a path move mixed with archival or importance reduction requires review in full', () => {
  for (const mutation of [{ type: 'archive', contentId: 'source' }, { type: 'importance', contentId: 'source', importance: 'low' }]) {
    const automatic = folderMove({ extraMutations: [mutation] });
    assert.ok(evaluateTrace(automatic.fixture, automatic.trace).violations.some(v => v.includes('Meaningful mutation')));
    const reviewed = folderMove({ extraMutations: [mutation], disposition: 'review_candidate' });
    assert.deepEqual(evaluateTrace(reviewed.fixture, reviewed.trace).violations, []);
  }
});

test('Dreaming move undo cannot bypass the exact proposal owner review', () => {
  const { fixture, trace } = folderMove();
  trace.steps.splice(3, 0, { tool: 'undo_content_move', arguments: { project_id: empty.projectId, id: 'source', moveId: 'move', versionToken: 'v2', requestId: 'undo', reason: 'Undo the Dreaming move' } });
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('Generic content mutation bypasses Dreaming')));
  const legacy = folderMove({ capability: undefined });
  delete legacy.fixture.capabilities;
  assert.ok(evaluateTrace(legacy.fixture, legacy.trace).violations.some(v => v.includes('not supported by this server')));
});
