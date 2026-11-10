// Scripted contract verification, explicitly separate from actual-host inference.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { episodeCheckpoint } from '../skills/foundocs/scripts/episode-checkpoint.mjs';
if (process.env.FOUNDOCS_EPISODE_LIVE !== '1') throw new Error('Explicit live fixture opt-in required.');
const fixture = JSON.parse(await readFile(process.env.FOUNDOCS_EPISODE_FIXTURE_INFO ?? '/tmp/foundocs-episode-fixture.json', 'utf8'));
const { root, projectId, client: host } = fixture.clients.find(c => c.client === (process.env.FOUNDOCS_EPISODE_CLIENT ?? 'codex'));
const c = new Client({ name: 'episode-package-contract-check', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'node_modules/@foundocs/foundocs-setup/src/cli.mjs'), 'mcp', '--project-id', projectId], cwd: root, env: { ...process.env, FOUNDOCS_SETUP_HOME: fixture.storageDir }, stderr: 'ignore' }));
const call = async (name, input) => {
  const wire = await c.callTool({ name, arguments: { ...input, project_id: projectId } });
  assert.equal(wire.isError, false); assert.equal(wire.structuredContent?.ok, true, JSON.stringify(wire.structuredContent?.error)); return wire.structuredContent.data;
};
try {
  assert.ok((await c.listTools()).tools.some(t => t.name === 'episode_checkpoint'));
  const hook = await episodeCheckpoint('hook', root, { hook_event_name: 'UserPromptSubmit', session_id: randomUUID(), turn_id: randomUUID() }, { client: host, storageDir: fixture.storageDir });
  const checkpoint = hook.hookSpecificOutput.additionalContext.match(/checkpoint: ([^.]+)\./)[1], taskKey = `package-contract:${randomUUID()}`;
  const checks = [];
  function input(boundaryKey, kind = 'milestone', status = 'in_progress') {
    const ref = `verification:${randomUUID()}`;
    return { event: { taskKey, boundaryKey, kind, observation: 'Synthetic fixture check confirmed the expected state.', evidence: [{ kind: 'verification', sourceRef: ref, label: 'Fixture assertion', detail: 'The synthetic assertion passed.' }], links: [] }, judgment: { significance: 'important', novelty: 'new', grounding: 'confirmed', outcome: status === 'completed' ? 'succeeded' : 'partial', reason: 'Confirmed fixture milestone', evidenceRefs: [ref] }, episode: { title: 'Synthetic package milestone', summary: ['The fixture assertion passed.', status === 'completed' ? 'This phase is complete.' : 'Final review remains.'], kind, status, tags: [], remainingWork: status === 'completed' ? null : 'Review' }, expectedEpisodeVersion: 0 };
  }
  async function capture(slot, value) {
    const prepared = await call('episode_checkpoint', { operation: 'prepare', checkpoint, slot, capture: value }); assert.equal(prepared.status, 'prepared');
    const result = await call('capture_episode', prepared.payload);
    assert.deepEqual(await call('capture_episode', prepared.payload), result, 'lost-response replay stays exact');
    await call('episode_checkpoint', { operation: 'ack', checkpoint, requestId: prepared.payload.requestId, result }); return result;
  }
  const first = await capture('milestone', input('implementation')); assert.equal(first.disposition, 'created'); checks.push('milestone/exact replay');
  const completed = input('implementation', 'milestone', 'completed'); completed.expectedEpisodeVersion = first.episode.version;
  const updated = await capture('completion', completed); assert.equal(updated.disposition, 'updated'); assert.equal(updated.episode.id, first.episode.id); checks.push('same-task completion update');
  const later = input('release'); later.episode.previousEpisodeId = first.episode.id;
  assert.equal((await capture('later', later)).disposition, 'created'); checks.push('closed-phase successor');
  const correction = input('implementation', 'milestone', 'completed'); correction.expectedEpisodeVersion = updated.episode.version; correction.correction = true; correction.episode.title = 'Corrected synthetic title';
  const before = await call('get_episode', { id: updated.episode.id });
  assert.equal((await capture('correction', correction)).disposition, 'corrected');
  const after = await call('get_episode', { id: updated.episode.id }); assert.equal(after.occurredAt, before.occurredAt); assert.equal(after.status, before.status); checks.push('explicit correction preserves time/status');
  const duplicate = input('implementation'); duplicate.expectedEpisodeVersion = after.version; duplicate.judgment.novelty = 'duplicate';
  assert.equal((await capture('duplicate', duplicate)).disposition, 'skipped'); checks.push('duplicate skipped');
  const decision = input('decision', 'decision', 'completed'); decision.event.evidence[0].kind = 'user_statement';
  assert.equal((await capture('decision', decision)).disposition, 'created'); checks.push('confirmed decision');
  const blocker = input('blocker', 'blocker', 'blocked'); blocker.event.evidence[0].kind = 'observation'; blocker.judgment.outcome = 'unknown';
  assert.equal((await capture('blocker', blocker)).episode.status, 'blocked'); checks.push('concrete blocker');
  const uncertain = input('verify', 'result', 'completed'); uncertain.judgment = null;
  const deferred = await capture('defer', uncertain); assert.equal(deferred.disposition, 'deferred');
  const candidate = await call('get_episode_candidate', { id: deferred.candidate.id });
  const reassess = input('verify', 'result', 'completed'); reassess.judgment.evidenceRefs = candidate.evidence.map(e => e.sourceRef); delete reassess.event;
  reassess.candidateId = candidate.id; reassess.expectedCandidateVersion = candidate.version;
  assert.equal((await capture('reassess', reassess)).disposition, 'created'); checks.push('defer/original candidate reassessment');
  const pending = await call('episode_checkpoint', { operation: 'pending', checkpoint }); assert.equal(pending.items.length, 0); checks.push('outbox settled');
  const episodes = await call('search_episodes', { taskKey, limit: 20 }); assert.equal(episodes.items.length, 5); checks.push('bounded recall');
  console.log(JSON.stringify({ status: 'passed', host, checks, episodes: episodes.items.length }));
} finally { await c.close(); }
