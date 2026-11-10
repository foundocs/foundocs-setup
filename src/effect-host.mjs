import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import { UUID } from './effect-core.mjs';

const exactModel = /^claude-(haiku|sonnet|opus)-\d+(?:-\d+)*$/;
const maxTail = 1024 * 1024;
const within = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/** Read only model metadata from the current host transcript; never return/persist conversation text. */
export async function workingSessionModel(host, root, now = Date.now()) {
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
