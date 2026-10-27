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

test('a known folder-consolidation case cannot be satisfied by an empty candidate or semantic rewrite', () => {
  for (const disposition of ['auto_candidate', 'review_candidate']) {
    const { fixture, trace } = folderMove({ disposition });
    fixture.constraints.requiredPathMoveIndexes = [0];
    assert.deepEqual(evaluateTrace(fixture, trace).violations, []);
    trace.steps[2].arguments.candidates[0].mutations = [];
    assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('Required path-only move')));
  }
  const { fixture, trace } = folderMove({ disposition: 'review_candidate', patch: { bodyMarkdown: 'A rewritten lesson.' } });
  fixture.constraints.requiredPathMoveIndexes = [0];
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('Required path-only move')));
});

function archiveTrace() {
  const fixture = structuredClone(fixtures.find(f => f.id === 'documents-only-obsolete'));
  const source = fixture.documents[0], target = { contentId: source.id, versionToken: source.versionToken };
  const running = { ...baseRun, targets: [target], inspectedIds: [], inspectedCount: 0, stages };
  const candidate = { candidateId: 'archive', title: 'Retired preview', reason: 'The experiment ended', impact: 'Excluded from default retrieval; links and restoration remain', targets: [target], evidence: [{ ...target, location: 'body', excerpt: source.bodyMarkdown }], mutations: [{ type: 'archive', contentId: source.id }], dependsOn: [], alternatives: ['Keep for historical recovery'], uncertainty: [], stages: [6], requestedDisposition: 'review_candidate' };
  const finished = { ...running, inspectedIds: [source.id], inspectedCount: 1, status: 'completed', pendingReviewCount: 1 };
  const trace = { steps: [step('begin', {}, running), { tool: 'get_docs', arguments: { project_id: fixture.projectId, items: [{ id: source.id }] }, result: { ok: true, data: { items: [{ index: 0, ok: true, data: source }] } } }, step('checkpoint', { stages, inspectedIds: [source.id] }, { ...finished, status: 'running' }), step('submit', { candidates: [candidate] }, { ...finished, status: 'running' }), step('finish', { status: 'completed', summary: 'One archive proposal; human review pending' }, finished)], final: { ...valid().final, pendingReviewCount: 1, inspectedCount: 1 } };
  return { fixture, trace, candidate, source, finished };
}

test('document-only traces allow reviewed archival without retrieval counts and preserve batch inspection', () => {
  const { fixture, trace } = archiveTrace();
  assert.deepEqual(evaluateTrace(fixture, trace).violations, []);
  trace.steps[1].result.data.items[0].ok = false;
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('without a captured source read')));
});

test('document permission does not expand to update, importance, relation or automatic archival', () => {
  for (const mutation of [{ type: 'update', contentId: 'source', after: {} }, { type: 'importance', contentId: 'source', importance: 'low' }, { type: 'relation', fromId: 'source', toId: 'other', relation: 'related_to' }]) {
    const { fixture, trace, candidate, source } = archiveTrace();
    candidate.mutations = [JSON.parse(JSON.stringify(mutation).replaceAll('source', source.id))];
    assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('Documents permit archive proposals only')));
  }
  const { fixture, trace, candidate } = archiveTrace();
  candidate.requestedDisposition = 'auto_candidate';
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('Meaningful mutation')));
});

test('both status tools and direct batch moves remain forbidden Dreaming bypasses', () => {
  for (const tool of ['set_content_status', 'set_knowledge_status', 'move_knowledge']) {
    const { fixture, trace } = archiveTrace();
    fixture.availableTools.push(tool);
    trace.steps.splice(2, 0, { tool, arguments: { project_id: fixture.projectId } });
    assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('Generic content mutation')));
  }
});

test('retrieval references must have been delivered and assessed against the current read body', () => {
  const { fixture, trace, candidate, source } = archiveTrace();
  const retrieval = { retrievalId: 'read', version: 1, evaluation: { id: 'eval', verdict: 'not_beneficial', reason: 'preview ended' } };
  trace.steps.splice(2, 0, { tool: 'get_archive_candidates', arguments: { project_id: fixture.projectId, runId: 'run' }, result: { ok: true, data: { items: [{ contentId: source.id, versionToken: source.versionToken, retrievals: [retrieval] }] } } });
  candidate.retrievalEvidence = [{ contentId: source.id, versionToken: source.versionToken, retrievalId: 'read', evaluationId: 'eval', currentContentReason: 'The current document confirms the experiment ended.' }];
  assert.deepEqual(evaluateTrace(fixture, trace).violations, []);
  candidate.retrievalEvidence[0].evaluationId = 'invented';
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('was not delivered')));
  candidate.retrievalEvidence[0].evaluationId = 'eval';
  candidate.retrievalEvidence[0].versionToken = 'old';
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('current body version')));
  trace.steps[2].arguments.runId = 'other';
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('current runId')));
});

function approvedArchive() {
  const value = archiveTrace(), { fixture, trace, candidate, finished } = value;
  const change = { id: 'change', revision: 1, hash: 'hash', mutations: candidate.mutations };
  trace.steps.push({ tool: 'get_dream', arguments: { project_id: fixture.projectId, runId: 'run' }, result: { ok: true, data: { run: finished, changes: [change], reportUrl: '/report/run' } } });
  const args = { project_id: fixture.projectId, runId: 'run', changeId: change.id, revision: 1, hash: 'hash', requestId: 'approval', approval: { source: 'human_chat', text: 'Approve the retired preview archive proposal.' } };
  trace.humanApprovals = [{ beforeStep: trace.steps.length + 1, runId: 'run', changeId: change.id, revision: 1, hash: 'hash', text: args.approval.text }];
  trace.steps.push({ tool: 'approve_archive_proposal', arguments: args, result: { ok: true, data: {} } });
  return { ...value, args, change };
}

test('only exact human events authorize an observed archive-only proposal, never general or ambiguous consent', () => {
  const validApproval = approvedArchive();
  assert.deepEqual(evaluateTrace(validApproval.fixture, validApproval.trace).violations, []);
  for (const fault of ['missing', 'stale', 'mixed', 'transcript']) {
    const { fixture, trace, args, change } = approvedArchive();
    if (fault === 'missing') delete trace.humanApprovals;
    if (fault === 'stale') args.hash = 'new-hash';
    if (fault === 'mixed') change.mutations.push({ type: 'importance', contentId: 'other', importance: 'low' });
    if (fault === 'transcript') args.approval.text = 'x'.repeat(501);
    assert.equal(evaluateTrace(fixture, trace).protocolPassed, false, fault);
  }
});


test('evaluation corrections invalidate delivered retrieval references until the fresh snapshot is read', () => {
  const { fixture, trace, candidate, source } = archiveTrace();
  const ref = { contentId: source.id, versionToken: source.versionToken, retrievalId: 'read', evaluationId: 'old-eval', currentContentReason: 'The experiment ended.' };
  candidate.retrievalEvidence = [ref];
  const read = { tool: 'get_archive_candidates', arguments: { project_id: fixture.projectId, runId: 'run', contentId: source.id }, result: { ok: true, data: { items: [{ contentId: source.id, versionToken: source.versionToken, evidenceVersion: 'first', retrievals: [{ retrievalId: 'read', evaluation: { id: 'old-eval', verdict: 'not_beneficial' } }] }] } } };
  trace.steps.splice(2, 0, read);
  assert.deepEqual(evaluateTrace(fixture, trace).violations, []);
  trace.steps.splice(3, 0, { ...read, result: { ok: false, error: { code: 'VERSION_CONFLICT' } } });
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('was not delivered')));
  trace.steps.splice(4, 0, { ...read, result: { ok: true, data: { items: [{ contentId: source.id, versionToken: source.versionToken, evidenceVersion: 'second', retrievals: [{ retrievalId: 'read', evaluation: { id: 'new-eval', verdict: 'beneficial' } }] }] } } });
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('was not delivered')));
  ref.evaluationId = 'new-eval';
  assert.deepEqual(evaluateTrace(fixture, trace).violations, []);
});

test('an identical approval retry reuses the existing human event, but a changed retry does not', () => {
  const { fixture, trace } = approvedArchive();
  trace.steps.push(structuredClone(trace.steps.at(-1)));
  assert.deepEqual(evaluateTrace(fixture, trace).violations, []);
  trace.steps.at(-1).arguments.hash = 'different';
  assert.ok(evaluateTrace(fixture, trace).violations.some(v => v.includes('Changed archive approval reused')));
});


test('archive approval bounds match server-trimmed UTF-16 length for Unicode and whitespace', () => {
  for (const [text, accepted] of [
    ['👍'.repeat(250), true],
    ['👍'.repeat(251), false],
    [' \t\n' + '👍'.repeat(250) + '\n ', true],
    [' \t\n' + '👍'.repeat(251) + '\n ', false],
    [' ' + 'a'.repeat(500) + ' ', true],
    [' \t\n ', false],
  ]) {
    const { fixture, trace, args } = approvedArchive();
    args.approval.text = text;
    trace.humanApprovals[0].text = text;
    const evaluation = evaluateTrace(fixture, trace);
    assert.equal(evaluation.protocolPassed, accepted, `Trimmed UTF-16 length: ${text.trim().length}`);
    if (accepted) assert.deepEqual(evaluation.violations, []);
    else assert.ok(evaluation.violations.some(v => v.includes('Invalid archive approval excerpt')));
  }
});
