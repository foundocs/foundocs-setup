import { open, realpath, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, relative, join } from 'node:path';
import { UUID } from './effect-core.mjs';

const exactModel = /^claude-(haiku|sonnet|opus)-\d+(?:-\d+)*$/;
const maxTail = 1024 * 1024;
const within = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/** Read only model metadata from the current host transcript; never return/persist conversation text. */
export async function workingSessionModel(host, root, now = Date.now()) {
  if (host?.client === 'codex' || (!host && process.env.CODEX_THREAD_ID)) return codexSessionModel(host ?? { client: 'codex', sessionId: process.env.CODEX_THREAD_ID }, root, now);
  if (!host || host.client !== 'claude_code') return { status: 'skipped', reason: host?.client ? 'unsupported_runner' : 'working_model_unavailable' };
  if (typeof host.sessionId !== 'string' || !UUID.test(host.sessionId) || typeof host.transcriptPath !== 'string' || !isAbsolute(host.transcriptPath) || basename(host.transcriptPath) !== `${host.sessionId}.jsonl`) return { status: 'skipped', reason: 'working_model_unavailable' };
  let file;
  try {
    file = await open(host.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || now - stat.mtimeMs > 5 * 60_000 || stat.mtimeMs > now + 60_000) throw new Error();
    const start = Math.max(0, stat.size - maxTail), buffer = Buffer.alloc(Math.min(stat.size, maxTail));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift(); // Never parse a truncated leading record.
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { throw new Error(); } // An incomplete latest record must not select an older model.
      if (event.type !== 'assistant' || event.isSidechain || event.parent_tool_use_id) continue;
      // Stop at the latest assistant record; never fall back to an older/different model.
      if (event.sessionId !== host.sessionId || typeof event.cwd !== 'string' || !within(await realpath(root), await realpath(event.cwd))) throw new Error();
      const timestamp = Date.parse(event.timestamp);
      if (!Number.isFinite(timestamp) || now - timestamp > 5 * 60_000 || timestamp > now + 60_000 || !exactModel.test(event.message?.model ?? '')) throw new Error();
      return { status: 'identified', model: event.message.model, modelSource: 'working_session' };
    }
  } catch { /* Missing, stale, inaccessible or unsupported metadata never chooses a default. */ }
  finally { await file?.close(); }
  return { status: 'skipped', reason: 'working_model_unavailable' };
}


/** Resolve only this host's exact thread ID, never another thread's contents. */
export async function codexSessionModel(host, root, now = Date.now(), env = process.env) {
  if (!UUID.test(host.sessionId ?? '') || (env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== host.sessionId)) return { status: 'skipped', reason: 'working_model_unavailable' };
  let file;
  try {
    let path = host.transcriptPath;
    if (!path) {
      const base = join(env.CODEX_HOME || join(env.HOME, '.codex'), 'sessions');
      const matches = [];
      async function find(dir, depth = 0) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) await find(join(dir, entry.name), depth + 1);
          else if (entry.isFile() && entry.name.endsWith(`-${host.sessionId}.jsonl`)) matches.push(join(dir, entry.name));
        }
      }
      await find(base); if (matches.length !== 1) throw new Error(); path = matches[0];
    }
    if (typeof path !== 'string' || !isAbsolute(path) || !basename(path).endsWith(`-${host.sessionId}.jsonl`)) throw new Error();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || now - stat.mtimeMs > 5 * 60_000 || stat.mtimeMs > now + 60_000) throw new Error();
    // Identity is in the first record. A long active Codex turn can emit several
    // MiB after turn_context; inspect a bounded 16 MiB tail, returning metadata only.
    const head = Buffer.alloc(Math.min(stat.size, 64 * 1024)); await file.read(head, 0, head.length, 0);
    const meta = JSON.parse(head.toString('utf8').split('\n')[0]);
    if (meta.type !== 'session_meta' || meta.payload.id !== host.sessionId || meta.payload.model_provider !== 'openai') throw new Error();
    const canonicalRoot = await realpath(root);
    if (!within(canonicalRoot, await realpath(meta.payload.cwd))) throw new Error();
    const start = Math.max(0, stat.size - 16 * maxTail), buffer = Buffer.alloc(Math.min(stat.size, 16 * maxTail));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n'); if (start) lines.shift();
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type !== 'turn_context') continue;
      const p = event.payload;
      if (!within(canonicalRoot, await realpath(p.cwd)) || !/^gpt-\d[\w.-]{0,150}$/.test(p.model) || /(?:latest|auto)$/.test(p.model)) throw new Error();
      const timestamp = Date.parse(event.timestamp);
      if (!Number.isFinite(timestamp) || timestamp > now + 60_000) throw new Error();
      // A long active turn can outlive five minutes. Freshness is the current
      // transcript's mtime; never select an older turn after malformed metadata.
      return { status: 'identified', model: p.model, modelSource: 'working_session', runner: 'codex_read_tools_v1', ...(typeof p.effort === 'string' && ['none','minimal','low','medium','high','xhigh','max','ultra'].includes(p.effort) ? { reasoningEffort: p.effort } : {}) };
    }
  } catch { /* Never infer a model from config/defaults or another thread. */ }
  finally { await file?.close(); }
  return { status: 'skipped', reason: 'working_model_unavailable' };
}
