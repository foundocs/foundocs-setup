import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { legacy } from './legacy-compat.mjs';
import { readCredential, windowsPrivateAcl } from './auth.mjs';
import { loadInstallation, textFile, parseJson, validateUrl, SetupError } from './setup.mjs';
import { cleanExpired } from './effect-storage.mjs';
import { runBridge } from './bridge.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new SetupError('runtime', 'Foundocs is not configured safely for this project and local user. Run the Foundocs integration install for this clone, or foundocs-setup doctor --root with the governing project root. No other installation was used.');

async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())))) throw unavailable();
  if (process.platform === 'win32') await windowsPrivateAcl(path);
  let parent = dirname(path);
  while (dirname(parent) !== parent) {
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw unavailable();
    parent = dirname(parent);
  }
}

export async function validateInstallation(root, directory, manifest) {
  const base = dirname(dirname(directory));
  await privateFile(join(directory, 'installation.json'));
  if (manifest.version !== 1 || !['codex', 'claude'].includes(manifest.client) || manifest.root !== root || !UUID.test(manifest.projectId) || !UUID.test(manifest.workspaceId) || !UUID.test(manifest.attemptId)) throw unavailable();
  validateUrl(manifest.mcpUrl);
  const expected = join(base, 'credentials', manifest.workspaceId, manifest.projectId, digest(root), 'key.json');
  if (!isAbsolute(manifest.credentialPath) || manifest.credentialPath !== expected) throw unavailable();
  await privateFile(expected);
  const saved = parseJson(await textFile(expected), 'private credential');
  if (saved.projectId !== manifest.projectId || saved.workspaceId !== manifest.workspaceId || saved.mcpUrl !== manifest.mcpUrl || saved.attemptId !== manifest.attemptId) throw unavailable();
  await readCredential(expected, manifest.projectId, manifest.workspaceId);
  return manifest;
}

export async function resolveRuntime(projectId, options = {}) {
  try {
    if (!UUID.test(projectId)) throw unavailable();
    let root = await realpath(options.cwd ?? process.cwd());
    while (true) {
      const text = await textFile(join(root, 'foundocs.json'));
      const historical = await textFile(join(root, legacy.config));
      if (historical !== null && text === null) throw unavailable();
      if (text !== null) {
        const config = parseJson(text, 'foundocs.json');
        if (!UUID.test(config.project_id) || config.project_id !== projectId) throw unavailable();
        if (historical !== null && !isDeepStrictEqual(config, parseJson(historical, legacy.config))) throw unavailable();
        break;
      }
      let boundary = false;
      try { await lstat(join(root, '.git')); boundary = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (boundary || dirname(root) === root) throw unavailable();
      root = dirname(root);
    }
    const { directory, manifest } = await loadInstallation(root, options);
    if (manifest.projectId !== projectId) throw unavailable();
    return await validateInstallation(root, directory, manifest);
  } catch { throw unavailable(); }
}

export async function startRuntime(projectId, options = {}) {
  const manifest = await resolveRuntime(projectId, options);
  try {
    const { directory } = await loadInstallation(manifest.root, options);
    await cleanExpired(join(directory, 'effects'));
  } catch {
    // Optional measurement cleanup must not disable ordinary authenticated MCP.
    process.stderr.write('Foundocs measurement cleanup unavailable; ordinary MCP continues. Run measure diagnostics before another sample.\n');
  }
  const { directory } = await loadInstallation(manifest.root, options);
  await runBridge({ ...manifest, automaticBase: join(directory, 'effects'), automaticFactory: async ({ recovery = false } = {}) => {
    const { EffectCoordinator } = await import('./effect.mjs');
    const { readAutomaticConsent } = await import('./effect-config.mjs');
    const { connectEffectRemote } = await import('./effect-remote.mjs');
    // A fresh remote is scoped to this installation. Coordinator run owns its lifetime.
    const config = await readAutomaticConsent(directory);
    if (!config.enabled && !recovery) return { config };
    const remote = await connectEffectRemote(manifest);
    const scopedRemote = { call: async (name, args) => {
      if (name === 'control_effect_measurement' && ['start_arm', 'heartbeat'].includes(args.action)) {
        const current = await readAutomaticConsent(directory);
        if (!current.enabled || JSON.stringify(current) !== JSON.stringify(config)) return { action: 'stop', policyRevision: args.policyRevision, reason: 'cancelled' };
      }
      return remote.call(name, args);
    } };
    const coordinator = new EffectCoordinator({ root: manifest.root, base: join(directory, 'effects'), remote: scopedRemote });
    return { config, coordinator: {
      async prepare(input) { try { return await coordinator.prepare(input); } finally { await remote.close(); } },
      async flush(taskId) { try { return await coordinator.flush(taskId); } finally { await remote.close(); } },
      async run(input) { try { return await coordinator.run(input); } finally { await remote.close(); } },
    } };
  } });
}
