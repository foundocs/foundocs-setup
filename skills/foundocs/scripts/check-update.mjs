#!/usr/bin/env node
// Runs locally with Node built-ins; never installs or executes registry code.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DAY = 24 * 60 * 60 * 1000;
const ENDPOINT = 'https://registry.npmjs.org/@foundocs%2ffoundocs-setup/latest';
const PACKAGE = '@foundocs/foundocs-setup';
const stable = value => typeof value === 'string' && value.length <= 64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function newer(a, b) {
  if (!stable(a) || !stable(b)) return false;
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

async function safeDirectory(path) {
  for (let current = path; dirname(current) !== current; current = dirname(current)) {
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function readState(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Unsafe cache');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function latestRelease(fetcher) {
  const response = await fetcher(ENDPOINT, {
    headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body) throw new Error('Registry unavailable');
  const reader = response.body.getReader();
  let bytes = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new Error('Registry response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (data.name !== PACKAGE || !stable(data.version)) throw new Error('Invalid release');
  const summary = typeof data.foundocsRelease?.summary === 'string'
    ? data.foundocsRelease.summary.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) : null;
  return { version: data.version, summary: summary || null };
}

export async function checkUpdate(rootPath, options = {}) {
  // All errors are advisory and deliberately exclude raw responses and paths.
  try {
    if (!isAbsolute(rootPath)) throw new Error('Absolute root required');
    const root = await realpath(rootPath);
    const installed = options.installedVersion ?? JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8')).version;
    if (!stable(installed)) throw new Error('Invalid installed release');
    const base = options.stateDirectory ?? join(process.env.FOUNDOCS_SETUP_HOME ?? join(homedir(), '.local', 'share', 'foundocs', 'setup'), 'update-checks');
    if (!isAbsolute(base)) throw new Error('Absolute cache required');
    const rel = relative(root, base);
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('Cache must be outside project');
    await safeDirectory(base);
    const path = join(base, `${createHash('sha256').update(root).digest('hex')}.json`);
    const lock = `${path}.lock`;
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch { return { ok: true, status: 'unavailable', shouldPrompt: false }; }
    try {
      let state = await readState(path);
      if (state && (state.schemaVersion !== 1 || state.root !== root)) throw new Error('Invalid cache identity');
      const now = options.now ?? Date.now();
      if (!Number.isFinite(now)) throw new Error('Invalid clock');
      state ??= { schemaVersion: 1, root };
      if (options.defer !== undefined) {
        if (!stable(options.defer) || options.defer !== state.latestVersion || !newer(options.defer, installed)) throw new Error('No matching offered version');
        state.deferredVersion = options.defer; state.deferredUntil = now + 7 * DAY;
        await saveState(path, state);
        return { ok: true, status: 'deferred', shouldPrompt: false, latestVersion: options.defer, deferredUntil: state.deferredUntil };
      }
      const fresh = Number.isFinite(state.checkedAt) && now >= state.checkedAt && now - state.checkedAt < DAY;
      if (!fresh) {
        try {
          const release = await latestRelease(options.fetch ?? globalThis.fetch);
          state.latestVersion = release.version; state.summary = release.summary; state.available = true;
        } catch { state.available = false; }
        state.checkedAt = now;
      }
      const result = { ok: true, status: 'unavailable', shouldPrompt: false, installedVersion: installed, cached: fresh };
      if (state.available && stable(state.latestVersion)) {
        result.latestVersion = state.latestVersion;
        result.status = 'up_to_date';
        if (newer(state.latestVersion, installed)) {
          const deferred = state.deferredVersion === state.latestVersion && Number.isFinite(state.deferredUntil) && state.deferredUntil > now && state.deferredUntil <= now + 7 * DAY;
          const notified = state.notifiedVersion === state.latestVersion && Number.isFinite(state.notifiedAt) && now >= state.notifiedAt && now - state.notifiedAt < DAY;
          result.status = deferred ? 'deferred' : 'update_available';
          result.summary = typeof state.summary === 'string' ? state.summary.slice(0, 500) : null;
          result.shouldPrompt = !deferred && !notified;
          if (result.shouldPrompt) { state.notifiedVersion = state.latestVersion; state.notifiedAt = now; }
        }
      }
      await saveState(path, state);
      return result;
    } finally { await handle.close(); await rm(lock, { force: true }); }
  } catch { return { ok: true, status: 'unavailable', shouldPrompt: false }; }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  let result = { ok: true, status: 'unavailable', shouldPrompt: false };
  if (args[0] === '--root' && (args.length === 2 || (args.length === 4 && args[2] === '--defer'))) {
    // A copied checker must belong to exactly the governing root, not another project.
    const root = await realpath(args[1]).catch(() => null);
    const script = fileURLToPath(import.meta.url);
    if (root && ['.agents', '.claude'].some(client => script === join(root, client, 'skills/foundocs/scripts/check-update.mjs'))) {
      result = await checkUpdate(root, { defer: args[3] });
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
