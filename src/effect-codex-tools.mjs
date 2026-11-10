import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from './effect-core.mjs';

// The model has no environment. These host tools are its only source access;
// exact manifest membership, canonical path and hash checks precede every read.
export async function snapshotTool(name, args, cwd, files) {
  const paths = new Map(files.map(f => [f.path, f]));
  const str = s => typeof s === 'string' && s.length <= 500 && !s.includes('\0');
  async function read(path) {
    if (!str(path) || !paths.has(path) || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes('\\')) throw new Error('unavailable source');
    const target = join(cwd, path);
    if (relative(await realpath(cwd), await realpath(target)) !== path) throw new Error('unavailable source');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat(), expected = paths.get(path);
      if (!st.isFile() || st.nlink !== 1 || st.size !== expected.bytes || st.size > 1024 * 1024) throw new Error('unavailable source');
      const bytes = await handle.readFile();
      if (sha256(bytes) !== expected.sha256) throw new Error('changed source');
      return bytes.toString('utf8');
    } finally { await handle.close(); }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid tool input');
  let result;
  if (name === 'Glob' && str(args.query)) result = [...paths.keys()].filter(p => p.includes(args.query)).slice(0, 200).join('\n');
  else if (name === 'Read' && Number.isSafeInteger(args.offset) && args.offset >= 1 && Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 200) {
    result = (await read(args.path)).split('\n').slice(args.offset - 1, args.offset - 1 + args.limit).map((line, i) => `${args.offset + i}: ${line}`).join('\n');
  } else if (name === 'Grep' && str(args.query) && args.query && str(args.path)) {
    if (args.path && !paths.has(args.path)) throw new Error('unavailable source');
    const matches = [];
    for (const path of args.path ? [args.path] : paths.keys()) {
      for (const [i, line] of (await read(path)).split('\n').entries()) if (line.includes(args.query)) {
        matches.push(`${path}:${i + 1}: ${line}`); if (matches.length >= 100) break;
      }
      if (matches.length >= 100) break;
    }
    result = matches.join('\n');
  } else throw new Error('unsupported tool');
  return result.slice(0, 16000);
}
