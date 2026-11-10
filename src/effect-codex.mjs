import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { EffectError, missingObservation, SYSTEM } from './effect-core.mjs';

export const CODEX_RUNNER = 'codex_read_tools_v1';
export const CODEX_VERSION = '0.166.0';
export const CODEX_FEATURES = ['shell_tool', 'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'view_image', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode', 'skill_search', 'shell_snapshot', 'sleep_tool'];
export const CODEX_CONFIG = `web_search = "disabled"\nproject_doc_max_bytes = 0\n[features]\n${CODEX_FEATURES.map(k => `${k} = false`).join('\n')}\n`;
export const CODEX_TOOLS = [{
  type: 'function', name: 'Read', description: 'Read lines from a frozen source file. Only exact snapshot paths are accepted.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['path', 'offset', 'limit'], additionalProperties: false },
}, {
  type: 'function', name: 'Grep', description: 'Search literal text in frozen sources. Returns at most 100 matching lines.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Exact snapshot path, or empty string for all snapshot files.' } }, required: ['query', 'path'], additionalProperties: false },
}, {
  type: 'function', name: 'Glob', description: 'List frozen source paths containing a literal substring (empty string lists all).',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
}];
export const codexToolPolicy = policy => ({ system: SYSTEM, tools: CODEX_TOOLS, config: CODEX_CONFIG, environments: [], model: policy.model, reasoningEffort: policy.reasoningEffort ?? null, timeoutMs: policy.perProbeTimeoutMs, maxTurns: policy.perProbeMaxTurns, outputVersion: 1 });
export function codexEnvironment(env = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME', 'OPENAI_API_KEY'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
}
export async function codexCapabilities({ execute = promisify(execFile), env = codexEnvironment(), platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new EffectError('unsupported_runner');
  try {
    if ((await execute('codex', ['--version'], { env, timeout: 10000 })).stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw new Error();
    const auth = await execute('codex', ['login', 'status'], { env, timeout: 10000 });
    if (!/Logged in/.test(auth.stdout + auth.stderr)) throw new Error();
    return CODEX_VERSION;
  } catch { throw new EffectError('unsupported_runner', 'Install and authenticate Codex CLI 0.166.0; no fallback model is used.'); }
}
export function spawnCodex(_file, _args, options) {
  const child = fork(new URL('./effect-codex-worker.mjs', import.meta.url), [JSON.stringify(options.effectPolicy)], { cwd: options.cwd, env: codexEnvironment(), execArgv: [], stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.effectSupervised = true;
  return child;
}
export class CodexObservation {
  observed = missingObservation();
  accept(event) { if (event.type === 'effect_observation') this.observed = event.observation; }
  value() { return this.observed; }
}
export function codexUsage(value) {
  if (!value || !['inputTokens', 'outputTokens', 'cachedInputTokens'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0) || value.cachedInputTokens > value.inputTokens || !Number.isSafeInteger(value.inputTokens + value.outputTokens)) return null;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, cacheReadInputTokens: value.cachedInputTokens, cacheCreationInputTokens: null, totalTokens: value.inputTokens + value.outputTokens };
}
