// Explicit live smoke: small synthetic sources, never project/user conversation.
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { runProbe } from '../src/effect-runner.mjs';
import { CODEX_RUNNER, CODEX_VERSION, codexCapabilities } from '../src/effect-codex.mjs';
import { freezeSnapshot } from '../src/effect-storage.mjs';
import { missingObservation } from '../src/effect-core.mjs';
if (process.env.FOUNDOCS_EFFECT_CODEX_LIVE !== '1') throw new Error('Set FOUNDOCS_EFFECT_CODEX_LIVE=1 for paid synthetic inference.');
const model = process.env.FOUNDOCS_EFFECT_CODEX_MODEL;
if (!model) throw new Error('Supply the observed working model in FOUNDOCS_EFFECT_CODEX_MODEL.');
await codexCapabilities();
const dir = await realpath(await mkdtemp(join(tmpdir(), 'effect-codex-check-')));
try {
  await writeFile(join(dir, 'source.txt'), 'The launch color is cobalt.');
  const snapshot = await freezeSnapshot(dir, join(dir, 'snapshot'), ['source.txt']);
  const brief = { taskId: randomUUID(), question: 'What is the launch color?', knownContext: '', criteria: [{ id: 'color', description: 'Find the launch color with a source quote.' }] };
  const policy = { runner: CODEX_RUNNER, model, reasoningEffort: 'high', perProbeTimeoutMs: 60000, perProbeMaxTurns: 4, perProbeEstimatedUsdLimit: .05 };
  const probe = { arm: 'without_foundocs', runner: CODEX_RUNNER, runnerVersion: CODEX_VERSION, provider: 'openai', model, startedAt: new Date().toISOString(), finishedAt: null, observation: missingObservation(), output: null };
  const result = await runProbe({ cwd: join(dir, 'snapshot'), brief, snapshot, context: [], policy, probe, heartbeat: async () => true });
  console.log(JSON.stringify({ status: result.status, isolationVerified: result.isolationVerified, evidenceVerified: result.evidenceVerified, observation: result.observation, output: result.output }));
  assert.equal(result.status, 'completed'); assert.equal(result.output.outcome, 'acquired'); assert.equal(result.observation.completeness, 'complete'); assert.equal(result.observation.estimatedCostUsd, null);
} finally { await rm(dir, { recursive: true, force: true }); }
