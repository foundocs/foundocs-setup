import { join, dirname, isAbsolute } from 'node:path';
import { readFile, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadInstallation } from './setup.mjs';
import { validateInstallation } from './runtime.mjs';
import { RUNNER, CLI_VERSION, UUID, EffectError, hash, missingObservation, normalizeProbe, toolPolicy, validateBrief } from './effect-core.mjs';
import { privateDir, readJson, saveJson, cleanExpired, purgeRaw, freezeSnapshot, copySnapshot } from './effect-storage.mjs';
import { capabilities, runProbe } from './effect-runner.mjs';
import { workingSessionModel } from './effect-host.mjs';
import { connectEffectRemote } from './effect-remote.mjs';

export async function measurementInstallation(rootPath, options = {}) {
  if (!isAbsolute(rootPath)) throw new EffectError('invalid_root');
  const { root, directory, manifest } = await loadInstallation(rootPath, options);
  // Exact governing file; no ancestor/alternate config fallback.
  const config = JSON.parse(await readFile(join(root, 'foundocs.json'), 'utf8'));
  if (config.project_id !== manifest.projectId) throw new EffectError('project_mismatch');
  await validateInstallation(root, directory, manifest);
  return { root, base: join(directory, 'effects'), manifest };
}
// Unobserved crash: finite upper allowance for two timeout/grace windows, never renewed by recovery.
export const crashSettlementDeadline = (policy, now = Date.now()) => new Date(now + 2 * (policy.perProbeTimeoutMs + 5000) + 86400000).toISOString();

export class EffectCoordinator {
  constructor({ root, base, remote, probe = runProbe, check = capabilities, identify = workingSessionModel }) { Object.assign(this, { root, base, remote, probe, check, identify }); }
  async initialize() { await cleanExpired(this.base); }
  path(taskId) { if (!UUID.test(taskId)) throw new EffectError('invalid_task_id'); return join(this.base, taskId); }
  async state(taskId) {
    const dir = this.path(taskId); await privateDir(dir);
    const s = await readJson(join(dir, 'state.json'));
    if (Date.parse(s.settlementExpiresAt ?? s.expiresAt) <= Date.now()) throw new EffectError('expired_preparation');
    return s;
  }
  async prepare({ policy, brief, allowlist, excludePaths = [], host }) {
    // Host fetched policy exactly once, before any exposure. OFF must not inspect/spawn CLI.
    if (policy?.enabled === false) return { status: 'skipped', reason: 'disabled' };
    if (policy?.enabled !== true || policy.runner !== RUNNER) return { status: 'skipped', reason: 'unsupported_runner' };
    const workingModel = await this.identify(host, this.root);
    if (workingModel.status !== 'identified') return workingModel;
    validateBrief(brief);
    const dir = this.path(brief.taskId); await privateDir(dir);
    let state = await readJson(join(dir, 'state.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (state) {
      if (state.workingModel?.model !== workingModel.model || state.workingModel?.modelSource !== 'working_session') throw new EffectError('task_conflict');
      if (state.briefSha256 !== hash(brief) || state.sourceSelectionHash !== hash({ allowlist, excludePaths })) throw new EffectError('task_conflict');
      if (Date.parse(state.expiresAt) <= Date.now()) throw new EffectError('expired_preparation');
      if (state.prepared) return { status: 'prepared', ...state.prepared, effectPreparationId: state.prepared.id };
      if (!state.prepareInput) throw new EffectError('incomplete_preparation', 'A prior snapshot attempt was interrupted. Do not recreate this task after exposure.');
    } else {
      let runnerVersion;
      try { runnerVersion = await this.check(); } catch (e) { if (e.code === 'unsupported_runner') return { status: 'skipped', reason: e.code }; throw e; }
      state = { taskId: brief.taskId, criterionIds: brief.criteria.map(c => c.id), brief, briefSha256: hash(brief), sourceSelectionHash: hash({ allowlist, excludePaths }), policy: { ...policy, model: workingModel.model }, workingModel, runnerVersion, expiresAt: new Date(Date.now() + 86400000).toISOString() };
      await saveJson(join(dir, 'state.json'), state, true);
      state.snapshot = await freezeSnapshot(this.root, join(dir, 'snapshot'), allowlist, excludePaths);
      state.prepareInput = { requestId: randomUUID(), brief, briefSha256: state.briefSha256, snapshot: state.snapshot, runner: RUNNER, runnerVersion, model: workingModel.model, modelSource: workingModel.modelSource };
      await saveJson(join(dir, 'state.json'), state);
    }
    state.prepared = await this.remote.call('prepare_effect_measurement', state.prepareInput);
    state.expiresAt = state.prepared.expiresAt;
    await saveJson(join(dir, 'state.json'), state);
    return { status: 'prepared', ...state.prepared, effectPreparationId: state.prepared.id };
  }
  baseProbe(state, arm) {
    return { arm, status: 'not_started', runner: RUNNER, runnerVersion: state.runnerVersion, provider: 'anthropic', model: state.policy.model, tokenUnit: 'provider_input_output_tokens', briefSha256: state.briefSha256, snapshotSha256: state.snapshot.sha256, criteriaSha256: hash(state.brief.criteria), toolPolicySha256: hash(toolPolicy(state.policy)), protocolVersion: 1, contextSha256: arm === 'with_foundocs' ? state.reservation.deliveredContextSha256 : null, isolationVerified: false, evidenceVerified: false, startedAt: null, finishedAt: null, observation: missingObservation(), output: null };
  }
  async flush(taskId) {
    const dir = this.path(taskId); const state = await this.state(taskId);
    const outbox = await readJson(join(dir, 'outbox.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (!outbox) {
      const receipt = await readJson(join(dir, 'receipt.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (receipt) return { status: 'already_reported', requestId: receipt.requestId };
      if (state.reservation && state.probes) {
        const owner = await readJson(join(dir, 'run-lock.json'));
        let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) return { status: 'report_pending', reason: 'coordinator_active' };
        state.recovered = true;
        for (const probe of Object.values(state.probes)) if (probe.startedAt && !probe.finishedAt) { probe.status = 'failed'; probe.finishedAt = new Date().toISOString(); }
        return this.report(state, dir);
      }
      return { status: 'nothing_pending' };
    }
    if (outbox.rejected) return { status: 'report_rejected', reason: outbox.rejected };
    try {
      const result = await this.remote.call('report_effect_measurement', outbox.payload);
      await saveJson(join(dir, 'receipt.json'), { reportedAt: new Date().toISOString(), requestId: outbox.payload.requestId });
      await rm(join(dir, 'outbox.json'));
      // Raw sources/context/brief are no longer needed after settlement.
      await rm(join(dir, 'snapshot'), { recursive: true, force: true });
      for (const arm of ['with_foundocs', 'without_foundocs']) await rm(join(dir, arm), { recursive: true, force: true });
      return { status: 'reported', result };
    } catch (e) {
      if (!e.uncertain) { outbox.rejected = e.code ?? 'request_failed'; await saveJson(join(dir, 'outbox.json'), outbox); return { status: 'report_rejected', reason: outbox.rejected }; }
      return { status: 'report_pending', reason: 'transport_uncertain' };
    }
  }
  async report(state, dir) {
    const payload = { requestId: randomUUID(), runId: state.reservation.runId, leaseToken: state.reservation.leaseToken, withFoundocs: normalizeProbe(state.probes.with_foundocs, { criteria: state.criterionIds.map(id => ({ id })) }), withoutFoundocs: normalizeProbe(state.probes.without_foundocs, { criteria: state.criterionIds.map(id => ({ id })) }) };
    if (Buffer.byteLength(JSON.stringify(payload)) > 96 * 1024) throw new EffectError('report_too_large');
    // This outbox has report fields only: never snapshot bytes, delivered context, API keys or raw transcript.
    if (!state.recovered) state.settlementExpiresAt = new Date(Math.max(Date.now(), ...Object.values(state.probes).map(p => Date.parse(p.finishedAt ?? p.startedAt)).filter(Number.isFinite)) + 86400000).toISOString();
    await saveJson(join(dir, 'state.json'), state);
    await saveJson(join(dir, 'outbox.json'), { payload }, true);
    return this.flush(state.taskId);
  }
  async run({ taskId, retrievalIds }) {
    if (!Array.isArray(retrievalIds) || !retrievalIds.every(v => UUID.test(v))) throw new EffectError('invalid_retrieval_ids');
    const dir = this.path(taskId); let state = await this.state(taskId);
    if (!state.prepared) throw new EffectError('missing_preparation');
    if (state.policy.enabled !== true) return { status: 'skipped', reason: 'disabled' };
    if (state.workingModel?.modelSource !== 'working_session') return { status: 'skipped', reason: 'working_model_unavailable' };
    const receipt = await readJson(join(dir, 'receipt.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (receipt) return { status: 'already_reported', requestId: receipt.requestId };
    const lock = join(dir, 'run-lock.json');
    try { await saveJson(lock, { pid: process.pid, attemptId: randomUUID() }, true); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = await readJson(lock);
      let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      // Existing owner (or PID reuse) is conservatively treated as active.
      if (alive) return { status: 'skipped', reason: 'duplicate_task' };
      const pending = await this.flush(taskId);
      if (pending.status !== 'nothing_pending') return pending;
      if (state.reservation && state.probes) {
        state.recovered = true;
        for (const p of Object.values(state.probes)) if (p.startedAt && !p.finishedAt) { p.status = 'failed'; p.finishedAt = new Date().toISOString(); }
        return this.report(state, dir);
      }
      return { status: 'skipped', reason: 'duplicate_task' }; // Never recreate an uncertain reservation/spawn.
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    let purging = Promise.resolve();
    const expiration = setTimeout(() => { controller.abort(); purging = purgeRaw(dir, state); }, Math.max(1, Date.parse(state.expiresAt) - Date.now()));
    let stopped = false;
    try {
      if (state.rawExpired) throw new EffectError('expired_preparation');
      const version = await this.check();
      if (version !== state.runnerVersion || version !== CLI_VERSION) throw new EffectError('unsupported_runner');
      const { sha256: ignored, ...manifest } = state.snapshot;
      if (hash(manifest) !== state.snapshot.sha256 || hash(state.brief) !== state.briefSha256) throw new EffectError('unsafe_snapshot');
      state.reserveInput = { requestId: randomUUID(), preparationId: state.prepared.id, retrievalIds: [...new Set(retrievalIds)] };
      await saveJson(join(dir, 'state.json'), state);
      const reserved = await this.remote.call('reserve_effect_measurement', state.reserveInput);
      if (reserved.status !== 'reserved') return reserved;
      state.reservation = reserved.reservation;
      if (state.reservation.policy.revision !== state.prepared.policyRevision || hash(state.reservation.policy) !== hash(state.policy)) throw new EffectError('policy_changed');
      state.probes = Object.fromEntries(['with_foundocs', 'without_foundocs'].map(arm => [arm, this.baseProbe(state, arm)]));
      state.settlementExpiresAt = crashSettlementDeadline(state.policy);
      await saveJson(join(dir, 'state.json'), state);
      const control = async (action, arm, probe) => {
        const args = { requestId: randomUUID(), runId: state.reservation.runId, leaseToken: state.reservation.leaseToken, policyRevision: state.policy.revision, action, ...(arm ? { arm } : {}), ...(probe ? { probe } : {}) };
        if (action === 'start_arm') { state.lastStart = args; await saveJson(join(dir, 'state.json'), state); }
        try { const result = await this.remote.call('control_effect_measurement', args); if (result.action !== 'continue' || result.policyRevision !== state.policy.revision) stopped = true; }
        catch { stopped = true; }
        return !stopped;
      };
      const first = state.reservation.firstArm;
      if (!['with_foundocs', 'without_foundocs'].includes(first)) throw new EffectError('invalid_response');
      for (const arm of [first, first === 'with_foundocs' ? 'without_foundocs' : 'with_foundocs']) {
        if (stopped || controller.signal.aborted) break;
        const cwd = join(dir, arm);
        await copySnapshot(join(dir, 'snapshot'), cwd, state.snapshot);
        // Durable consumed marker BEFORE start_arm request: even a lost grant must not re-spawn.
        await saveJson(join(dir, `${arm}.consumed.json`), { consumedAt: new Date().toISOString() }, true);
        if (!(await control('start_arm', arm)) || controller.signal.aborted) break;
        const probe = state.probes[arm]; probe.startedAt = new Date().toISOString(); probe.status = 'failed';
        await saveJson(join(dir, 'state.json'), state);
        state.probes[arm] = await this.probe({ cwd, brief: state.brief, snapshot: state.snapshot, context: arm === 'with_foundocs' ? state.reservation.deliveredContext : [], policy: state.policy, probe, signal: controller.signal, heartbeat: () => control('heartbeat'), observe: async observation => { probe.observation = observation; state.settlementExpiresAt = crashSettlementDeadline(state.policy); await saveJson(join(dir, 'state.json'), state); } });
        state.probes[arm] = normalizeProbe(state.probes[arm], { criteria: state.criterionIds.map(id => ({ id })) });
        await saveJson(join(dir, 'state.json'), state);
        if (!(await control('heartbeat', undefined, state.probes[arm]))) break;
      }
      await purging;
      return await this.report(state, dir);
    } catch (e) {
      if (state.reservation && state.probes) {
        for (const p of Object.values(state.probes)) if (p.startedAt && !p.finishedAt) { p.status = 'failed'; p.finishedAt = new Date().toISOString(); }
        await purging;
      return await this.report(state, dir);
      }
      throw e;
    } finally { clearTimeout(expiration); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
}
export async function measure(action, rootPath, input) {
  const installation = await measurementInstallation(rootPath);
  await cleanExpired(installation.base);
  if (action === 'prepare' && input.policy?.enabled === false) return { status: 'skipped', reason: 'disabled' };
  const remote = await connectEffectRemote(installation.manifest);
  try {
    const coordinator = new EffectCoordinator({ ...installation, remote });
    if (action === 'prepare') return await coordinator.prepare(input);
    if (action === 'run') return await coordinator.run(input);
    if (action === 'flush') return await coordinator.flush(input.taskId);
    throw new EffectError('invalid_command');
  } finally { await remote.close(); }
}
