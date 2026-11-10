#!/usr/bin/env node
// Local metadata/outbox only. Never reads a prompt, transcript, key, or remote endpoint.
import { constants } from 'node:fs';
import { open, mkdir, lstat, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL = 14 * 86400000, MAX_CHECKPOINTS = 128, MAX_OUTBOX = 32, MAX_BYTES = 64 * 1024;
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const unavailable = () => { throw new Error('unavailable'); };
async function privateDirectory(path) {
  // Fail closed on Windows until equivalent ACL verification is available here.
  if (process.platform === 'win32') unavailable();
  let ancestor = path;
  while (dirname(ancestor) !== ancestor) {
    const st = await lstat(ancestor).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (st && (!st.isDirectory() || st.isSymbolicLink())) unavailable();
    ancestor = dirname(ancestor);
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (st.mode & 0o077 || st.uid !== process.getuid()) unavailable();
}
async function readState(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || st.mode & 0o077 || st.uid !== process.getuid() || st.size > 3 * 1024 * 1024) unavailable();
    return JSON.parse(await file.readFile('utf8'));
  } catch (e) { if (e.code === 'ENOENT') return { checkpoints: [], outbox: [] }; throw e; }
  finally { await file?.close(); }
}
async function writeState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close(); file = null;
    await rename(temporary, path);
  } finally { await file?.close(); await rm(temporary, { force: true }); }
}
async function locked(directory, action) {
  const lock = join(directory, 'checkpoint.lock');
  const file = await open(lock, 'wx', 0o600); // Contention/crash: soft failure, never steal a live lock.
  try { await file.writeFile(String(process.pid)); return await action(); } finally { await file.close(); await rm(lock, { force: true }); }
}
function prune(state, now) {
  state.outbox = state.outbox.filter(c => Number.isFinite(c.createdAt) && c.createdAt + TTL > now).slice(-MAX_OUTBOX);
  const needed = new Set(state.outbox.map(e => e.checkpoint));
  const valid = state.checkpoints.filter(c => Number.isFinite(c.createdAt) && c.createdAt + TTL > now);
  const kept = valid.filter(c => needed.has(c.id));
  state.checkpoints = [...kept, ...valid.filter(c => !needed.has(c.id)).slice(-(MAX_CHECKPOINTS - kept.length))].sort((a, b) => a.createdAt - b.createdAt);

}
function reminder(checkpoint, client, fallback = false) {
  const prefix = client === 'codex' ? '.agents' : '.claude';
  return `${fallback ? 'One bounded Foundocs checkpoint follow-up. ' : ''}Foundocs episode checkpoint: ${checkpoint.id}. Read ${prefix}/skills/foundocs-capture-episode/SKILL.md. During this task, retain only confirmed important decisions, verified results/discoveries, concrete blockers or milestones. Routine lookup/no new fact: local skip only. Before the final response, acknowledge via local MCP episode_checkpoint (operation skip for routine) or the installed episode-checkpoint.mjs helper; do not upload prompts/transcripts or start another model. Missing tools, opt-out or failure must not delay the user task. ${fallback ? 'Do this once; do not repeat the user answer or continue just for bookkeeping.' : ''}`;
}
function captureInput(input, checkpoint, slot, projectId, now) {
  const capture = structuredClone(input);
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) unavailable();
  // Preserve only the public capture contract. Unknown fields never enter a private journal.
  const allowed = ['event', 'candidateId', 'sourceChangeId', 'judgment', 'episode', 'expectedEpisodeVersion', 'expectedCandidateVersion', 'correction'];
  if (Object.keys(capture).some(key => !allowed.includes(key))) unavailable();
  if (Boolean(capture.event) === Boolean(capture.candidateId)) unavailable();
  if (!Number.isInteger(capture.expectedEpisodeVersion) || capture.expectedEpisodeVersion < 0) unavailable();
  if (capture.event) {
    if (!safeId(capture.event.taskKey) || !safeId(capture.event.boundaryKey)) unavailable();
    const eventAllowed = ['taskKey', 'boundaryKey', 'kind', 'observation', 'occurredAt', 'evidence', 'links'];
    if (Object.keys(capture.event).some(key => !eventAllowed.includes(key))) unavailable();
    capture.event.sourceEventId = `host:${checkpoint.id}:${slot}`;
    capture.event.sessionId = checkpoint.sessionId;
    capture.event.occurredAt ??= new Date(now).toISOString();
    if (typeof capture.event.observation !== 'string' || capture.event.observation.length > 3000 || !Array.isArray(capture.event.evidence) || capture.event.evidence.length > 20 || !Array.isArray(capture.event.links) || capture.event.links.length > 20) unavailable();
    if (capture.event.evidence.some(e => typeof e.detail !== 'string' || e.detail.length > 1000)) unavailable();
  }
  return { ...capture, project_id: projectId, requestId: randomUUID() };
}

/** Read-only operational status. Never returns payloads, prompts or credentials. */
export async function episodeDiagnostics(rootPath, options = {}) {
  try {
    const root = await realpath(rootPath), config = JSON.parse(await readFile(join(root, 'foundocs.json'), 'utf8'));
    if (config.episodes?.enabled === false || process.env.FOUNDOCS_EPISODES === 'off') return { status: 'disabled' };
    if (process.platform === 'win32') return { status: 'unsupported_platform' };
    const base = options.storageDir ?? process.env.FOUNDOCS_SETUP_HOME ?? join(homedir(), '.local/share/foundocs/setup');
    const directory = join(base, 'episodes', hash(root)), lockPath = join(directory, 'checkpoint.lock');
    const lock = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (lock) {
      let pid;
      try { const st = await lock.stat(); if (!st.isFile() || st.size > 32 || st.mode & 0o077 || st.uid !== process.getuid()) unavailable(); pid = Number(await lock.readFile('utf8')); } finally { await lock.close(); }
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; } }
      return { status: alive ? 'busy' : 'stale_lock', lockPath, next: alive ? 'A helper may be running. Do not remove its lock.' : 'After confirming no episode helper is running, remove only this stale lock and retry. Preserve checkpoints.json and credentials.' };
    }
    const state = await readState(join(directory, 'checkpoints.json'));
    return { status: 'ready', pendingCount: state.outbox?.length ?? 0, hostVerification: 'required' };
  } catch { return { status: 'unavailable', next: 'Inspect private storage permissions without changing host approvals. Primary work may continue.' }; }
}

/** Host hooks and agent commands share a bounded private journal; no network/model work. */
export async function episodeCheckpoint(command, rootPath, input, options = {}) {
  if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) unavailable();
  const root = await realpath(rootPath);
  if (!isAbsolute(rootPath)) unavailable();
  const config = JSON.parse(await readFile(join(root, 'foundocs.json'), 'utf8'));
  if (!UUID.test(config.project_id) || (options.projectId && config.project_id !== options.projectId)) unavailable();
  if (config.episodes?.enabled === false || process.env.FOUNDOCS_EPISODES === 'off') return { status: 'disabled' };
  const client = options.client;
  if (!['codex', 'claude'].includes(client)) return { status: 'unsupported_host' };
  const base = options.storageDir ?? process.env.FOUNDOCS_SETUP_HOME ?? join(homedir(), '.local/share/foundocs/setup');
  if (!isAbsolute(base)) unavailable();
  const directory = join(base, 'episodes', hash(root));
  await privateDirectory(directory);
  return locked(directory, async () => {
    const path = join(directory, 'checkpoints.json'), state = await readState(path), now = options.now ?? Date.now();
    if (!Array.isArray(state.checkpoints) || !Array.isArray(state.outbox)) unavailable();
    const counts = [state.checkpoints.length, state.outbox.length];
    prune(state, now);
    if (state.checkpoints.length !== counts[0] || state.outbox.length !== counts[1]) await writeState(path, state);
    let output;
    if (command === 'hook') {
      if (!safeId(input.session_id) || input.agent_id || input.agent_type || input.stop_hook_active) return null;
      if (!['UserPromptSubmit', 'Stop'].includes(input.hook_event_name)) return null;
      let checkpoint = state.checkpoints.findLast(c => c.sessionId === input.session_id);
      if (input.hook_event_name === 'UserPromptSubmit') {
        // Codex's own Stop continuation is a synthetic UserPromptSubmit. Keep the
        // original checkpoint and guard instead of creating a bookkeeping loop.
        if (checkpoint?.fallbackIssued && typeof input.prompt === 'string' && input.prompt.startsWith('One bounded Foundocs checkpoint follow-up. ')) return null;
        const id = client === 'codex' && safeId(input.turn_id) ? hash(`${input.session_id}:${input.turn_id}`).slice(0, 40) : randomUUID();
        checkpoint = state.checkpoints.find(c => c.id === id);
        if (!checkpoint) {
          checkpoint = { id, sessionId: input.session_id, ...(safeId(input.turn_id) ? { turnId: input.turn_id } : {}), client, createdAt: now, acknowledged: false, fallbackIssued: false };
          state.checkpoints.push(checkpoint);
        }
        output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: reminder(checkpoint, client) } };
      } else {
        if (!checkpoint || checkpoint.acknowledged || checkpoint.fallbackIssued || (client === 'codex' && checkpoint.turnId !== input.turn_id)) return null;
        checkpoint.fallbackIssued = true;
        const context = reminder(checkpoint, client, true);
        output = client === 'claude' ? { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: context } } : { decision: 'block', reason: context };
      }
    } else {
      const checkpoint = state.checkpoints.find(c => c.id === input.checkpoint);
      if (!checkpoint) return { status: 'checkpoint_unavailable' };
      if (command === 'skip') {
        checkpoint.acknowledged = true;
        output = { status: 'acknowledged', pending: state.outbox.filter(e => e.checkpoint === checkpoint.id).length };
      } else if (command === 'prepare') {
        if (typeof input.slot !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(input.slot)) unavailable();
        const settled = checkpoint.settled?.find(entry => entry.slot === input.slot);
        if (settled) return { status: settled.inputHash === hash(JSON.stringify(input.capture)) ? 'already_acknowledged' : 'payload_conflict', requestId: settled.requestId, disposition: settled.disposition };
        if ((checkpoint.settled ?? []).length >= 32) return { status: 'checkpoint_full' };
        const previous = state.outbox.find(e => e.checkpoint === checkpoint.id && e.slot === input.slot);
        if (previous) {
          if (previous.inputHash !== hash(JSON.stringify(input.capture))) return { status: 'payload_conflict', requestId: previous.payload.requestId };
          output = { status: 'prepared', payload: previous.payload };
        } else {
          if (state.outbox.length >= MAX_OUTBOX) return { status: 'outbox_full' };
          const payload = captureInput(input.capture, checkpoint, input.slot, config.project_id, now);
          if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) unavailable();
          state.outbox.push({ checkpoint: checkpoint.id, slot: input.slot, inputHash: hash(JSON.stringify(input.capture)), payload, createdAt: now });
          output = { status: 'prepared', payload };
        }
        // A transport failure cannot induce repeated Stop continuations. Pending
        // payload stays available for exact replay on a later ordinary task.
        checkpoint.acknowledged = true;
      } else if (command === 'ack') {
        const entry = state.outbox.find(e => e.checkpoint === checkpoint.id && e.payload.requestId === input.requestId);
        if (!entry) return { status: 'request_unavailable' };
        if (!['created', 'updated', 'corrected', 'deferred', 'skipped', 'unchanged'].includes(input.result?.disposition) || !UUID.test(input.result?.candidate?.id)) unavailable();
        checkpoint.settled ??= [];
        checkpoint.settled.push({ slot: entry.slot, inputHash: entry.inputHash, requestId: entry.payload.requestId, disposition: input.result.disposition });
        state.outbox = state.outbox.filter(e => e !== entry); checkpoint.acknowledged = true;
        output = { status: 'acknowledged', disposition: input.result.disposition };
      } else if (command === 'pending') {
        output = { status: 'pending', items: state.outbox.slice(0, 3).map(e => ({ checkpoint: e.checkpoint, slot: e.slot, payload: e.payload })) };
      } else if (command === 'discard') {
        // Only for a definitive rejection after reconciliation; never after an uncertain response.
        state.outbox = state.outbox.filter(e => e.payload.requestId !== input.requestId || e.checkpoint !== checkpoint.id);
        checkpoint.acknowledged = true; output = { status: 'discarded' };
      } else unavailable();
    }
    prune(state, now); await writeState(path, state); return output;
  });
}

if (process.argv[1]?.endsWith('episode-checkpoint.mjs') && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [command, flag, root] = process.argv.slice(2);
  let output;
  try {
    if (flag !== '--root' || !isAbsolute(root)) unavailable();
    const script = await realpath(process.argv[1]), canonical = await realpath(root);
    const client = ['codex', 'claude'].find(c => script === join(canonical, c === 'codex' ? '.agents' : '.claude', 'skills/foundocs/scripts/episode-checkpoint.mjs'));
    let text = '';
    for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) unavailable(); }
    output = await episodeCheckpoint(command, root, JSON.parse(text), { client });
  } catch { output = command === 'hook' ? null : { status: 'unavailable' }; }
  if (command === 'hook' && !output?.hookSpecificOutput && !output?.decision) output = null;
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}
