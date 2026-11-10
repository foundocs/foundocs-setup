import { open, mkdir, lstat, readdir, readFile, rename, rm, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EffectError, UUID, sha256, hash } from './effect-core.mjs';

export async function privateDir(path) {
  let current = path;
  while (dirname(current) !== current) {
    const st = await lstat(current).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new EffectError('unsafe_storage');
    current = dirname(current);
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (st.mode & 0o077 || typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new EffectError('unsafe_storage');
}
export async function readJson(path) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const st = await f.stat(); if (!st.isFile() || st.nlink !== 1 || st.mode & 0o077) throw new EffectError('unsafe_storage'); return JSON.parse(await f.readFile('utf8')); } finally { await f.close(); }
}
async function writeJson(path, value, exclusive = false) {
  const temporary = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const f = await open(temporary, 'wx', 0o600);
  try { await f.writeFile(JSON.stringify(value)); await f.sync(); } finally { await f.close(); }
  if (!exclusive) await rename(temporary, path);
  const dir = await open(dirname(path), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
function stripRaw(state) {
  const value = { ...state, rawExpired: true };
  delete value.brief; delete value.prepareInput; delete value.snapshot;
  if (value.reservation) { value.reservation = { ...value.reservation }; delete value.reservation.deliveredContext; }
  return value;
}
async function withStateLock(path, operation) {
  const lock = `${path}.write-lock`; let handle;
  for (let attempt = 0; !handle && attempt < 500; attempt++) {
    try { handle = await open(lock, 'wx', 0o600); await handle.writeFile(String(process.pid)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readFile(lock, 'utf8').catch(() => '');
      let dead = false;
      if (/^\d+$/.test(owner)) { try { process.kill(Number(owner), 0); } catch (e) { dead = e.code === 'ESRCH'; } }
      else { const st = await lstat(lock).catch(() => null); dead = !!st && Date.now() - st.mtimeMs > 10000; }
      if (dead) await rm(lock, { force: true });
      else await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (!handle) throw new EffectError('journal_busy');
  try { return await operation(); } finally { await handle.close(); await rm(lock, { force: true }); }
}
export async function saveJson(path, value, exclusive = false) {
  if (basename(path) !== 'state.json') return writeJson(path, value, exclusive);
  return withStateLock(path, async () => {
    const previous = await readJson(path).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    // A late rename can never restore expired raw fields, including a stale in-memory writer.
    const expired = previous?.rawExpired || value.rawExpired || Date.parse(value.expiresAt) <= Date.now();
    await writeJson(path, expired ? stripRaw(value) : value, exclusive);
  });
}
export async function purgeRaw(path, state) {
  state.rawExpired = true;
  const file = join(path, 'state.json');
  await withStateLock(file, async () => {
    // Reread under the same lock as usage writes: cleanup never overwrites newer observations.
    const latest = await readJson(file);
    await writeJson(file, stripRaw(latest));
    for (const name of ['snapshot', 'with_foundocs', 'without_foundocs', ...(await readdir(path)).filter(name => name.startsWith('codex-runtime-'))]) await rm(join(path, name), { recursive: true, force: true });
  });
}
export async function cleanExpired(base, now = Date.now()) {
  await privateDir(base);
  for (const name of await readdir(base)) {
    if (!UUID.test(name)) continue;
    const path = join(base, name), st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new EffectError('unsafe_storage');
    const state = await readJson(join(path, 'state.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (!state) { if (st.mtimeMs + 86400000 <= now) await rm(path, { recursive: true, force: true }); continue; }
    const retention = Date.parse(state.settlementExpiresAt ?? state.expiresAt);
    if (retention <= now) await rm(path, { recursive: true, force: true });
    else if (Date.parse(state.expiresAt) <= now) await purgeRaw(path, state);
  }
}
const excludedSegment = /^(?:\.git|node_modules|\.env(?:\..*)?|\.foundocs|\.agents|\.codex|\.claude|\.aws|\.ssh|\.config|\.local|\.cache|\.npm|\.venv|venv|dist|build|coverage|AGENTS\.md|CLAUDE\.md|foundocs\.json|steerdocs\.json|\.mcp\.json|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i;
const secretName = /(?:credential|secret|(?:^|[-_.])(?:key|token|session|transcript|export)(?:[-_.]|$))|\.(?:pem|p12|pfx|key)$/i;
function safePath(path) { return typeof path === 'string' && path.length > 0 && path.length <= 500 && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(s => s && s !== '.' && s !== '..'); }
export async function freezeSnapshot(root, destination, allowlist, exclusions = [], limits = {}) {
  if (!Array.isArray(allowlist) || !allowlist.length || !allowlist.every(safePath) || !Array.isArray(exclusions) || !exclusions.every(safePath)) throw new EffectError('snapshot_unavailable');
  root = await realpath(root); await privateDir(destination);
  const files = [], seen = new Set(); let byteCount = 0;
  const max = { files: 5000, bytes: 20 * 1024 * 1024, fileBytes: 1024 * 1024, ...limits };
  const skip = p => p.split('/').some(s => excludedSegment.test(s) || secretName.test(s)) || /^artifacts\/(knowledge|docs|history)(\/|$)/.test(p) || exclusions.some(x => p === x || p.startsWith(`${x}/`));
  async function visit(p) {
    if (seen.has(p) || skip(p)) return; seen.add(p);
    // Check EVERY ancestor: an allowlisted nested file may traverse a symlink.
    let current = root;
    for (const segment of p.split('/')) { current = join(current, segment); if ((await lstat(current)).isSymbolicLink()) return; }
    const st = await lstat(current);
    if (st.isDirectory()) { for (const name of (await readdir(current)).sort()) await visit(`${p}/${name}`); return; }
    if (!st.isFile() || st.nlink !== 1) return;
    if (st.size > max.fileBytes) throw new EffectError('snapshot_unavailable');
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > max.fileBytes) throw new EffectError('snapshot_unavailable'); bytes = await handle.readFile(); } finally { await handle.close(); }
    if (bytes.length > max.fileBytes) throw new EffectError('snapshot_unavailable');
    if (bytes.includes(0)) return;
    let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return; }
    // Recognizable Foundocs exports and key material never become raw sources.
    if (/foundocs:(?:setup|export)|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|(?:FOUNDOCS|STEERCARDS)_API_KEY\s*=|"(?:versionToken|retrievalId)"\s*:/.test(content)) return;
    byteCount += bytes.length;
    if (files.length + 1 > max.files || byteCount > max.bytes) throw new EffectError('snapshot_unavailable');
    await mkdir(dirname(join(destination, p)), { recursive: true, mode: 0o700 });
    const target = await open(join(destination, p), 'wx', 0o400); try { await target.writeFile(bytes); } finally { await target.close(); }
    files.push({ path: p, sha256: sha256(bytes), bytes: bytes.length });
  }
  try { for (const p of allowlist) await visit(p); } catch (e) { await rm(destination, { recursive: true, force: true }); throw new EffectError('snapshot_unavailable'); }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = { capturedAt: new Date().toISOString(), fileCount: files.length, byteCount, exclusionPolicyVersion: 'foundocs_raw_sources_v1', files };
  return { ...manifest, sha256: hash(manifest) };
}
export async function copySnapshot(source, target, manifest) {
  await privateDir(target);
  for (const file of manifest.files) {
    if (!safePath(file.path)) throw new EffectError('unsafe_snapshot');
    const path = join(source, file.path);
    if (relative(source, await realpath(path)) !== file.path) throw new EffectError('unsafe_snapshot');
    const st = await lstat(path); if (!st.isFile() || st.nlink !== 1 || st.isSymbolicLink()) throw new EffectError('unsafe_snapshot');
    const bytes = await readFile(path);
    if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new EffectError('unsafe_snapshot');
    await mkdir(dirname(join(target, file.path)), { recursive: true, mode: 0o700 });
    const f = await open(join(target, file.path), 'wx', 0o400); try { await f.writeFile(bytes); } finally { await f.close(); }
  }
}
