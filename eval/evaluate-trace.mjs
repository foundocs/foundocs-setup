import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const writes = new Set(['create_doc', 'update_doc', 'delete_doc', 'set_knowledge_status', 'undo_content_move']);
const stages = [3, 4, 5, 6, 7, 8];
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const unwrap = result => {
  const payload = result?.structuredContent ?? result;
  return payload?.ok === true ? payload.data : payload;
};

function pathOnlyKnowledgeMove(source, after) {
  const fields = ['kind', 'category', 'title', 'bodyMarkdown', 'tldr', 'tags', 'created'];
  if (!source || !after || source.kind !== 'knowledge' || !['rules', 'learnings', 'decisions'].includes(source.category)) return false;
  if (Object.keys(after).some(key => ![...fields, 'path', 'reason'].includes(key))) return false;
  if (!fields.every(key => source[key] !== undefined && stable(source[key]) === stable(after[key]))) return false;
  if (typeof source.path !== 'string' || typeof after.path !== 'string' || source.path === after.path) return false;
  if (!after.path.startsWith(`knowledge/${source.category}/`) || !after.path.endsWith('.md') || /[\\\u0000-\u001f\u007f]/u.test(after.path)) return false;
  return after.path.split('/').every(part => part && part !== '.' && part !== '..') && !['INDEX.md', '.md'].includes(after.path.split('/').at(-1));
}

// Deterministic protocol checks over captured tool calls. Semantic rubrics still
// require an independent reviewer and actual Codex/Claude execution.
export function evaluateTrace(fixture, trace) {
  const violations = [];
  const check = (condition, message) => { if (!condition) violations.push(message); };
  const constraints = fixture.constraints ?? {};
  const steps = trace.steps ?? [];
  const requests = new Map();
  const targets = new Map((fixture.knowledge ?? []).map(item => [item.id, item]));
  const seenMutations = [];
  const proposedPathMoves = new Set();
  const inspectedSources = new Map();
  const frozenTargets = new Map();
  let run, persistedReport, finished = false, candidateCount = 0;
  const successfulRequests = new Set();
  if (constraints.noCalls) check(steps.length === 0, 'No project calls are allowed before project resolution.');
  for (const [index, step] of steps.entries()) {
    const prefix = `Step ${index + 1}: `;
    const args = step.arguments ?? {};
    const result = unwrap(step.result);
    const rejected = step.result?.isError || step.result?.ok === false || step.result?.structuredContent?.ok === false;
    check(!writes.has(step.tool), `${prefix}Generic content mutation bypasses Dreaming.`);
    if (fixture.projectId) check(args.project_id === fixture.projectId, `${prefix}Missing or foreign project_id.`);
    check((fixture.availableTools ?? []).includes(step.tool), `${prefix}Tool was unavailable.`);
    if (!rejected && step.tool === 'get_doc' && typeof result?.bodyMarkdown === 'string') {
      inspectedSources.set(result.id, result.versionToken);
      // Relations and moves advance versions. A complete reread also refreshes
      // path/metadata; a partial body must not replace the full fixture snapshot.
      if (targets.has(result.id)) targets.set(result.id, { ...targets.get(result.id), ...(!result.nextOffset && !result.offset ? result : { versionToken: result.versionToken }) });
    }
    if (!rejected && step.tool === 'explore_docs' && /^(cat|sed|head|tail)\b/.test(args.command ?? '')) for (const source of result?.sources ?? []) inspectedSources.set(source.id, source.versionToken);
    if (!rejected && result?.run) for (const target of result.run.targets ?? []) frozenTargets.set(target.contentId, target.versionToken);
    if (step.tool === 'get_dream' && result?.run) { persistedReport = result; run = result.run; }
    if (step.tool !== 'dream_memory') continue;
    check(!constraints.noRun, `${prefix}Run was not authorized or unavailable.`);
    check(typeof args.requestId === 'string' && args.requestId.length > 0, `${prefix}requestId is missing.`);
    if (requests.has(args.requestId)) check(requests.get(args.requestId) === stable(args), `${prefix}Changed payload reused requestId.`);
    else requests.set(args.requestId, stable(args));
    if (!['begin', 'resume'].includes(args.action)) {
      check(Boolean(run) && args.runId === run?.id, `${prefix}Unknown run.`);
      check(args.leaseGeneration === run?.leaseGeneration, `${prefix}Stale lease generation.`);
    }
    if (args.action === 'resume') check(trace.explicitResume === true, `${prefix}Resume lacked an explicit user request.`);
    if (args.action === 'checkpoint') {
      check(new Set(args.inspectedIds ?? []).size === (args.inspectedIds ?? []).length, `${prefix}Duplicate inspected IDs.`);
      for (const id of args.inspectedIds ?? []) {
        check(frozenTargets.has(id), `${prefix}Inspected ID outside frozen targets.`);
        check(inspectedSources.has(id), `${prefix}Claimed inspection without a captured source read.`);
      }
    }
    if (args.action === 'submit') {
      for (const candidate of args.candidates ?? []) {
        if (!successfulRequests.has(args.requestId)) candidateCount++;
        for (const field of ['title', 'reason', 'impact']) check(typeof candidate[field] === 'string' && candidate[field].length > 0, `${prefix}Missing candidate ${field}.`);
        for (const field of ['targets', 'evidence', 'mutations', 'dependsOn', 'alternatives', 'uncertainty']) check(Array.isArray(candidate[field]), `${prefix}Missing candidate ${field}.`);
        for (const evidence of candidate.evidence ?? []) {
          const source = targets.get(evidence.contentId) ?? (fixture.documents ?? []).find(item => item.id === evidence.contentId);
          check(Boolean(source), `${prefix}Evidence is outside fixture sources.`);
          if (source) {
            check(inspectedSources.get(evidence.contentId) === evidence.versionToken, `${prefix}Evidence was not read at its claimed version.`);
            check(source.versionToken === evidence.versionToken, `${prefix}Evidence version differs from inspected source.`);
            check(typeof evidence.excerpt === 'string' && evidence.excerpt.length > 0 && source.bodyMarkdown.includes(evidence.excerpt), `${prefix}Evidence excerpt was fabricated.`);
          }
        }
        for (const mutation of candidate.mutations ?? []) {
          seenMutations.push(mutation);
          if (!rejected && mutation.type === 'update' && pathOnlyKnowledgeMove(targets.get(mutation.contentId), mutation.after)) proposedPathMoves.add(mutation.contentId);
          check(!(constraints.forbiddenMutations ?? []).includes(mutation.type), `${prefix}Fixture forbids ${mutation.type}.`);
          if (candidate.requestedDisposition === 'observation') check(false, `${prefix}Observation contains a mutation.`);
          if (candidate.requestedDisposition === 'auto_candidate') {
            const relation = mutation.type === 'relation' && ['duplicate_of', 'related_to'].includes(mutation.relation);
            const move = mutation.type === 'update' && fixture.capabilities?.autoPathOnlyKnowledgeMoves === true
              && pathOnlyKnowledgeMove(targets.get(mutation.contentId), mutation.after);
            check(relation || move, `${prefix}Meaningful mutation requested automatic application.`);
            if (mutation.type === 'update') check(fixture.capabilities?.autoPathOnlyKnowledgeMoves === true, `${prefix}Automatic path moves are not supported by this server fixture.`);
            if (relation && constraints.allowedAutoRelations) check(constraints.allowedAutoRelations.includes(mutation.relation), `${prefix}Automatic relation is not supported by this fixture.`);
          }
          for (const id of [mutation.contentId, mutation.fromId, mutation.toId].filter(Boolean)) {
            check(targets.has(id), `${prefix}Mutation is outside project knowledge.`);
            check(candidate.targets?.some(target => target.contentId === id && target.versionToken === targets.get(id)?.versionToken), `${prefix}Mutation target lacks its version precondition.`);
          }
          if (mutation.type === 'relation') {
            check(mutation.fromId !== mutation.toId, `${prefix}Self-link.`);
            check(!(constraints.forbiddenRelations ?? []).includes(mutation.relation), `${prefix}Fixture forbids ${mutation.relation}.`);
          }
        }
      }
    }
    if (args.action === 'finish') {
      if (constraints.expectedFinish) check(args.status === constraints.expectedFinish, `${prefix}Incorrect finish status.`);
      if (args.status === 'completed') {
        check((run?.targetTotal ?? frozenTargets.size) === (run?.inspectedCount ?? new Set(run?.inspectedIds ?? []).size), `${prefix}Completed without full coverage.`);
        check(stages.every(stage => run?.stages?.some(value => value.stage === stage && ['completed', 'not_applicable'].includes(value.status))), `${prefix}Completed without all six stage results.`);
      }
      if (!rejected && result?.run && ['completed', 'partial', 'failed', 'cancelled'].includes(result.run.status)) finished = true;
    }
    if (!rejected && result?.run) { run = result.run; persistedReport = result; successfulRequests.add(args.requestId); }
  }
  if (constraints.requiredMutation) check(seenMutations.some(m => `${m.type}:${m.relation}` === constraints.requiredMutation), 'Required supported mutation was not proposed.');
  for (const index of constraints.requiredPathMoveIndexes ?? []) {
    const id = fixture.knowledge?.[index]?.id;
    check(Boolean(id) && proposedPathMoves.has(id), `Required path-only move for source ${index} was not proposed.`);
  }
  if (constraints.maxCandidates !== undefined) check(candidateCount <= constraints.maxCandidates, 'Proposal count was inflated.');
  if (!constraints.noCalls && !constraints.noRun) check(finished, 'No server-confirmed finish.');
  if (trace.final) {
    check(Boolean(persistedReport?.run), 'Final report has no persisted server result.');
    for (const name of ['status', 'appliedCount', 'pendingReviewCount', 'observationCount']) check(trace.final[name] === persistedReport?.run?.[name], `Final ${name} differs from saved result.`);
    check(trace.final.reportUrl === persistedReport?.reportUrl, 'Final report URL differs from saved result.');
    check(trace.final.inspectedCount === (persistedReport?.run?.inspectedCount ?? new Set(persistedReport?.run?.inspectedIds ?? []).size), 'Final coverage differs from saved result.');
  } else if (finished) check(false, 'A finished run lacks structured final-report evidence.');
  return { fixtureId: fixture.id, protocolPassed: violations.length === 0, violations, semanticReviewRequired: fixture.rubric, modelQualityVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [fixtureId, tracePath] = process.argv.slice(2);
  if (!fixtureId || !tracePath) throw new Error('Usage: node eval/evaluate-trace.mjs <fixture-id-or-json-path> <captured-trace.json>');
  const fixtures = JSON.parse(await readFile(new URL('./dreaming-cases.json', import.meta.url), 'utf8'));
  const fixture = fixtureId.endsWith('.json') ? JSON.parse(await readFile(fixtureId, 'utf8')) : fixtures.find(item => item.id === fixtureId);
  if (!fixture) throw new Error('Unknown fixture.');
  const result = evaluateTrace(fixture, JSON.parse(await readFile(tracePath, 'utf8')));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.protocolPassed) process.exitCode = 1;
}
