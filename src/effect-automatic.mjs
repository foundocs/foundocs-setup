import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, saveJson, privateDir } from './effect-storage.mjs';
import { UUID, hash, validateBrief } from './effect-core.mjs';

export const effectReads = new Set(['get_project_context', 'lookup_evidence', 'search_docs', 'explore_docs', 'get_doc', 'get_docs']);
const reasons = new Set(['consent_required', 'missing_preparation', 'late_preparation', 'working_model_unavailable', 'unsupported_runner', 'runner_not_configured', 'isolation_unavailable', 'connection_unavailable', 'permission_denied', 'snapshot_unavailable', 'context_unavailable', 'budget_admission_denied', 'concurrency_limit', 'daily_run_limit', 'not_sampled', 'disabled', 'no_beneficial_retrieval', 'expired_preparation', 'duplicate_task', 'report_pending', 'local_failure', 'incomplete_evaluation']);
const safeReason = e => reasons.has(e?.reason ?? e?.code?.toLowerCase()) ? (e.reason ?? e.code.toLowerCase()) : ['EACCES', 'EPERM'].includes(e?.code) ? 'permission_denied' : 'local_failure';
const dataOf = r => r?.structuredContent ?? (() => { try { return JSON.parse(r?.content?.find(c => c.type === 'text')?.text); } catch { return null; } })();
function retrievalIds(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value.retrievals)) for (const r of value.retrievals) if (UUID.test(r?.retrievalId)) found.add(r.retrievalId);
  for (const [key, child] of Object.entries(value)) if (key !== 'retrievals' && child && typeof child === 'object') retrievalIds(child, found);
  return found;
}
export function automaticTool(tool) {
  if (!effectReads.has(tool.name) && tool.name !== 'report_retrieval_evaluation') return tool;
  const properties = { ...tool.inputSchema.properties };
  if (effectReads.has(tool.name)) properties.effectTask = { type: 'object', additionalProperties: false,
    description: 'Local automatic measurement. First read: pre-exposure brief and current trusted host identity; following reads: same taskId only. Never reconstruct a brief after exposure. Source allowlist and consent come from installation, not this call.',
    required: ['taskId'], properties: { taskId: { type: 'string', format: 'uuid' },
      question: { type: 'string', minLength: 1, maxLength: 2000 }, knownContext: { type: 'string', maxLength: 4000 },
      criteria: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['id', 'description'], properties: { id: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 500 } } } },
      host: { type: 'object', additionalProperties: false, required: ['client', 'sessionId'], properties: { client: { type: 'string', enum: ['codex', 'claude_code'] }, sessionId: { type: 'string', format: 'uuid' }, transcriptPath: { type: 'string' } } },
    } };
  else {
    properties.effectTaskId = { type: 'string', format: 'uuid', description: 'Same automatic information task identity.' };
    properties.effectTaskComplete = { type: 'boolean', description: 'True only on the final evaluation after ALL information reads and evaluations for this question. The installer starts at most one comparison automatically, after saved consent. Do not issue measure run.' };
  }
  return { ...tool, description: tool.description + ' Installed automatic measurement accepts local task metadata; no shell prepare/run is needed.', inputSchema: { ...tool.inputSchema, properties },
    annotations: { ...tool.annotations, readOnlyHint: false, openWorldHint: true } };
}

/** Serializes calls for this bridge; persistent coordinator locks prevent duplicate probes across bridges/restarts. */
export class AutomaticMeasurement {
  constructor({ projectId, remote, factory, store, warn = () => {} }) { Object.assign(this, { projectId, remote, factory, store, warn }); this.queue = Promise.resolve(); this.jobs = new Set(); }
  call(params) {
    const next = this.queue.then(() => this.handle(params));
    this.queue = next.catch(() => {}); return next;
  }
  async recover() {
    for (const state of await this.store.list?.() ?? []) {
      if (state.diagnostic) {
        try { await this.remote('report_effect_diagnostic', state.diagnostic); state.diagnostic = null; await this.store.save(state); }
        catch { this.warn('Foundocs measurement status is pending; no inference was repeated.'); }
      }
      if (!state.closed || state.settled || !state.preparationId) continue;
      try {
        const { coordinator } = await this.factory({ recovery: true });
        const result = await coordinator.flush(state.taskId);
        if (result.reason === 'coordinator_active') continue;
        if (result.status === 'report_pending') {
          await this.diagnostic(state, 'failed', 'report_pending');
          continue;
        }
        state.settled = true;
        if (['reported', 'already_reported'].includes(result.status)) {
          const failed = result.result && result.result.status !== 'completed';
          await this.diagnostic(state, failed ? 'failed' : 'completed', failed ? 'local_failure' : null);
        }
        else await this.diagnostic(state, 'failed', result.status === 'nothing_pending' ? 'local_failure' : safeReason(result));
      } catch { this.warn('Foundocs measurement recovery pending; no inference was repeated.'); }
    }
  }
  async diagnostic(state, status, reason = null) {
    state.sequence = (state.sequence ?? 0) + 1;
    state.diagnostic = { requestId: randomUUID(), taskId: state.taskId, sequence: state.sequence, status, reason };
    try { await this.store.save(state); } catch { this.warn('Foundocs measurement status could not be saved locally.'); }
    try { await this.remote('report_effect_diagnostic', state.diagnostic); state.diagnostic = null; await this.store.save(state); }
    catch { this.warn('Foundocs measurement status could not be delivered; local status retained.'); }
  }
  async handle(params) {
    const { effectTask, effectTaskId, effectTaskComplete, ...args } = params.arguments ?? {};
    const forward = () => this.remote(params.name, args, true);
    if (args.project_id !== this.projectId) {
      if (effectTask || effectTaskId || effectTaskComplete) throw new Error('Automatic measurement project mismatch');
      return forward();
    }
    if (effectReads.has(params.name)) {
      // Explicit legacy tracking stays under its existing coordinator. Never attach two tasks.
      if (!effectTask) return forward();
      const taskId = effectTask?.taskId ?? (UUID.test(args.taskId ?? '') ? args.taskId : UUID.test(args.readId ?? '') ? args.readId : randomUUID());
      if (!UUID.test(taskId) || (args.taskId && args.taskId !== taskId) || (effectTask && args.effectPreparationId)) throw new Error('Conflicting measurement task');
      let state;
      try { state = await this.store.load(taskId); }
      catch (e) {
        args.taskId = taskId;
        try { await this.remote('report_effect_diagnostic', { requestId: randomUUID(), taskId, sequence: 0, status: 'skipped', reason: safeReason(e) }); } catch { this.warn('Foundocs measurement storage unavailable.'); }
        return forward();
      }
      if (!state) {
        state = { taskId, retrievals: [], evaluated: [], exposed: false, closed: false, expiresAt: new Date(Date.now() + 86400000).toISOString() };
        // Persist before preparation; a crash must never create a new baseline after exposure.
        try { await this.store.save(state); }
        catch (e) {
          args.taskId = taskId;
          try { await this.remote('report_effect_diagnostic', { requestId: randomUUID(), taskId, sequence: 0, status: 'skipped', reason: safeReason(e) }); } catch { this.warn('Foundocs measurement storage unavailable.'); }
          return forward();
        }
        try {
          const policy = await this.remote('get_effect_measurement_policy', {});
          if (!policy.enabled) state.skipped = 'disabled';
          else if (!effectTask?.question || !effectTask?.criteria) state.skipped = 'missing_preparation';
          else {
            const brief = { taskId, question: effectTask.question, knownContext: effectTask.knownContext ?? '', criteria: effectTask.criteria };
            validateBrief(brief); state.briefHash = hash(brief);
            const { coordinator, config } = await this.factory();
            if (!config?.enabled) state.skipped = 'consent_required';
            else {
              const result = await coordinator.prepare({ policy, brief, allowlist: config.allowlist, excludePaths: config.excludePaths, host: effectTask.host });
              if (result.status === 'prepared') { state.preparationId = result.effectPreparationId; state.consentHash = hash(config); }
              else state.skipped = safeReason(result);
            }
          }
        } catch (e) { state.skipped = safeReason(e); }
        await this.diagnostic(state, state.preparationId ? 'prepared' : 'skipped', state.preparationId ? null : state.skipped);
      } else if (effectTask?.question && state.briefHash !== hash({ taskId, question: effectTask.question, knownContext: effectTask.knownContext ?? '', criteria: effectTask.criteria })) {
        throw new Error('Do not change a frozen information task');
      }
      if (!state.preparationId && !state.skipped) state.skipped = 'missing_preparation'; // interrupted preparation stays unmeasured
      if (state.closed && effectTask) throw new Error('Information task is closed; never add later context or relabel the same question.');
      if (state.closed || Date.parse(state.expiresAt) <= Date.now()) {
        // Continue ordinary reads, but never silently add post-completion context to an existing sample.
        delete args.effectPreparationId; args.taskId = taskId;
        return forward();
      }
      args.taskId = taskId;
      if (state.preparationId) args.effectPreparationId = state.preparationId;
      // Mark exposure before the remote request: a lost reply must not re-prepare.
      state.exposed = true;
      try { await this.store.save(state); }
      catch (e) { delete args.effectPreparationId; await this.diagnostic(state, 'skipped', safeReason(e)); return forward(); }
      const result = await forward(), body = dataOf(result);
      if (body?.ok) {
        state.retrievals = [...new Set([...state.retrievals, ...retrievalIds(body.data)])];
        try { await this.store.save(state); } catch { this.warn('Foundocs retrieval tracking could not be saved; no extra reads were requested.'); }
      }
      return result;
    }
    const result = await forward();
    if (params.name !== 'report_retrieval_evaluation' || !effectTaskId || !dataOf(result)?.ok) return result;
    if (!UUID.test(effectTaskId)) return result;
    let state;
    try { state = await this.store.load(effectTaskId); } catch { this.warn('Foundocs evaluation tracking unavailable.'); return result; }
    if (!state || state.closed || !state.retrievals.includes(args.retrievalId)) return result;
    state.evaluated = [...new Set([...state.evaluated, args.retrievalId])];
    if (args.verdict === 'beneficial') state.beneficial = true;
    try { await this.store.save(state); } catch { this.warn('Foundocs evaluation tracking could not be saved; no comparison started.'); return result; }
    if (!effectTaskComplete) return result;
    if (state.retrievals.some(id => !state.evaluated.includes(id))) {
      await this.diagnostic(state, 'skipped', 'incomplete_evaluation'); return result;
    }
    state.closed = true;
    try { await this.store.save(state); } catch { this.warn('Foundocs task closure could not be saved; no comparison started.'); return result; }
    if (!state.preparationId || !state.beneficial) { state.settled = true; await this.diagnostic(state, 'skipped', state.skipped ?? 'no_beneficial_retrieval'); return result; }
    // No long-running model call inside the MCP response timeout. The bridge owns and settles the task.
    const job = this.run(state).catch(() => this.warn('Foundocs automatic measurement failed; ordinary work continues.'));
    this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
    return result;
  }
  async run(state) {
    try {
      const { coordinator, config } = await this.factory();
      if (!config?.enabled || state.consentHash !== hash(config)) { state.settled = true; await this.diagnostic(state, 'skipped', 'consent_required'); return; }
      await this.diagnostic(state, 'running');
      const result = await coordinator.run({ taskId: state.taskId, retrievalIds: state.retrievals });
      state.settled = !['report_pending'].includes(result.status);
      if (result.status === 'reported' || result.status === 'already_reported') {
        const failed = result.result && result.result.status !== 'completed';
        await this.diagnostic(state, failed ? 'failed' : 'completed', failed ? 'local_failure' : null);
      } else await this.diagnostic(state, result.status === 'report_pending' ? 'failed' : 'skipped', result.status === 'report_pending' ? 'report_pending' : safeReason(result));
    } catch (e) { await this.diagnostic(state, 'failed', safeReason(e)); }
  }
  async drain() { await this.queue; await Promise.allSettled([...this.jobs]); }
}
export function automaticStore(base) {
  const path = taskId => { if (!UUID.test(taskId)) throw new Error('Invalid task'); return join(base, taskId, 'automatic.json'); };
  return {
    async list() { await privateDir(base); const result = []; for (const id of await readdir(base)) if (UUID.test(id)) { const state = await this.load(id); if (state) result.push(state); } return result; },
    async load(taskId) { try { return await readJson(path(taskId)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async save(state) { await privateDir(join(base, state.taskId)); await saveJson(path(state.taskId), state); },
  };
}
