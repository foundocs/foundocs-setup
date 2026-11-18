import { join } from 'node:path';
import { readJson, saveJson } from './effect-storage.mjs';
import { EffectError } from './effect-core.mjs';
export function validateAutomaticConsent(input) {
  if (input?.enabled === false && Object.keys(input).length === 1) return { enabled: false };
  if (!input || input.enabled !== true || input.consentVersion !== 1 || input.shareProjectDataWithWorkingModel !== true || input.additionalModelUsage !== true) throw new EffectError('consent_required');
  const paths = value => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(p => typeof p === 'string' && p.length <= 500 && p !== '.' && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => !s || s === '..' || s === '.'));
  if (!paths(input.allowlist) || !Array.isArray(input.excludePaths) || (input.excludePaths.length && !paths(input.excludePaths))) throw new EffectError('snapshot_unavailable');
  return { enabled: true, consentVersion: 1, shareProjectDataWithWorkingModel: true, additionalModelUsage: true, allowlist: input.allowlist, excludePaths: input.excludePaths };
}
export async function saveAutomaticConsent(directory, input) {
  const config = validateAutomaticConsent(input);
  await saveJson(join(directory, 'measurement-consent.json'), { ...config, acceptedAt: new Date().toISOString() });
  return { status: config.enabled ? 'consent_saved' : 'disabled', hostPermissions: 'unchanged', reconnectRequired: false };
}
export async function readAutomaticConsent(directory) {
  try { const value = await readJson(join(directory, 'measurement-consent.json')); return validateAutomaticConsent(value.enabled ? value : { enabled: false }); }
  catch (e) { if (e.code === 'ENOENT') return { enabled: false }; throw e; }
}

/** Readiness is a non-inference check, not proof that a later provider request will succeed. */
export async function automaticReadiness({ config, checkCli, checkConnection, identify }) {
  const issues = [];
  if (!config.enabled) issues.push('consent_required');
  try { await checkCli(); } catch { issues.push('unsupported_runner'); }
  try { await checkConnection(); } catch { issues.push('connection_unavailable'); }
  try { if ((await identify()).status !== 'identified') issues.push('working_model_unavailable'); }
  catch { issues.push('working_model_unavailable'); }
  return { config, ready: issues.length === 0, issues, hostPermissions: 'unchanged', inferenceExecuted: false,
    note: 'Checks installation storage, supported CLI/login, current model metadata and Foundocs connectivity. Host approval and provider inference permissions remain independent.' };
}
