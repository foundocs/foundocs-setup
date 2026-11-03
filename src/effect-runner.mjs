import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_VERSION, BASE_ARGS, SYSTEM, Observation, EffectError, normalizeProbe, validOutput } from './effect-core.mjs';

const exec = promisify(execFile);
export function providerEnvironment(env = process.env) {
  // No NODE_OPTIONS, shell hooks, provider routing overrides, or application keys.
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  return Object.fromEntries(allowed.filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
}
export async function capabilities({ execute = exec, env = providerEnvironment(), platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new EffectError('unsupported_runner', 'This runner requires a verified macOS Claude restricted CLI.');
  try {
    const version = (await execute('claude', ['--version'], { env, timeout: 10000 })).stdout.trim();
    const help = (await execute('claude', ['--help'], { env, timeout: 10000 })).stdout;
    if (!version.startsWith(`${CLI_VERSION} `) || !['--safe-mode', '--restricted', '--strict-mcp-config', '--setting-sources', '--no-session-persistence', '--tools', '--allowedTools', '--disable-slash-commands', '--permission-mode', '--max-budget-usd', '--model', '--system-prompt', '--output-format'].every(f => help.includes(f))) throw new Error();
    const auth = JSON.parse((await execute('claude', ['--safe-mode', 'auth', 'status'], { env, timeout: 10000 })).stdout);
    if (auth.loggedIn !== true || !['claude.ai', 'oauth_token', 'api_key'].includes(auth.authMethod)) throw new Error();
    return CLI_VERSION;
  } catch { throw new EffectError('unsupported_runner', 'Install and authenticate Claude Code 2.1.312 with safe-mode/restricted support; no fallback runner is used.'); }
}
export function probeArguments(policy) {
  return [...BASE_ARGS, '--model', policy.model, '--max-turns', String(policy.perProbeMaxTurns), '--max-budget-usd', String(policy.perProbeEstimatedUsdLimit), '--system-prompt', SYSTEM];
}
export function verifiedInit(event, model) {
  return event.type === 'system' && event.subtype === 'init' && event.model === model && Array.isArray(event.tools) && [...event.tools].sort().join(',') === 'Glob,Grep,Read' && Array.isArray(event.mcp_servers) && event.mcp_servers.length === 0 && Array.isArray(event.skills) && event.skills.length === 0;
}
async function verifyEvidence(output, { brief, snapshot, cwd, context }) {
  if (!validOutput(output, brief.criteria.map(c => c.id))) return false;
  for (const c of output.criteria) for (const e of c.evidence) {
    let content;
    if (e.source === 'brief' && ['question', 'knownContext'].includes(e.reference)) content = brief[e.reference];
    if (e.source === 'retrieval') content = context.find(x => x.invocationId === e.reference)?.text;
    if (e.source === 'snapshot' && snapshot.files.some(f => f.path === e.reference)) content = await readFile(join(cwd, e.reference), 'utf8');
    if (typeof content !== 'string' || !content.includes(e.quote)) return false;
  }
  return true;
}
export function spawnSupervised(_file, args, options) {
  const child = fork(new URL('./effect-watchdog.mjs', import.meta.url), [JSON.stringify(args), String(options.effectTimeoutMs)], { cwd: options.cwd, env: options.env, execArgv: [], stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.effectSupervised = true;
  return child;
}
export async function runProbe({ cwd, brief, snapshot, context, policy, probe, heartbeat, observe, signal, spawnChild = spawnSupervised, heartbeatMs = 5000, grace = [3000, 2000] }) {
  if (signal?.aborted) return { ...probe, status: 'not_started', startedAt: null, finishedAt: null };
  const observation = new Observation();
  let child, line = '', init = false, invalid = false, output = null, resultSuccess = false, stopping = false, closed = false, status = null, heartbeating = false;
  const timers = [];
  const kill = sig => { if (closed || !child?.pid) return; try { process.kill(-child.pid, sig); } catch { child.kill(sig); } };
  function stop(reason = 'cancelled') {
    if (stopping || closed) return; stopping = true; status = reason;
    if (child?.effectSupervised) { if (child.connected) child.send({ type: 'stop' }); return; }
    kill('SIGINT');
    timers.push(setTimeout(() => kill('SIGTERM'), grace[0]), setTimeout(() => kill('SIGKILL'), grace[0] + grace[1]));
  }
  async function accept(event) {
    observation.accept(event);
    if (event.type === 'system' && event.subtype === 'init') { init = verifiedInit(event, policy.model); if (!init) { invalid = true; stop('failed'); } }
    if (event.type === 'assistant') {
      for (const b of event.message?.content ?? []) if (b.type === 'tool_use' && !['Read', 'Glob', 'Grep'].includes(b.name)) { invalid = true; stop('failed'); }
    }
    if (event.type === 'result') {
      resultSuccess = event.subtype === 'success' && !event.is_error;
      try { const raw = event.structured_output ?? JSON.parse(event.result); output = Buffer.byteLength(JSON.stringify(raw)) <= 40 * 1024 ? raw : null; } catch { output = null; }
    }
    // Only normalized observations are journaled; no tool text/prompt/transcript.
    if (event.type === 'assistant' || event.type === 'result') await observe?.(observation.value());
  }
  let queue = Promise.resolve();
  const parseLine = text => { try { const event = JSON.parse(text); queue = queue.then(() => accept(event)).catch(() => stop('failed')); } catch { invalid = true; stop('failed'); } };
  const abort = () => stop('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => stop('timed_out'), policy.perProbeTimeoutMs);
  const timer = setInterval(async () => {
    if (heartbeating || stopping || closed) return;
    heartbeating = true;
    try { if (!(await heartbeat())) stop(); } catch { stop(); } finally { heartbeating = false; }
  }, heartbeatMs);
  let exit;
  try {
    if (signal?.aborted) return { ...probe, status: 'not_started', startedAt: null, finishedAt: null };
    child = spawnChild('claude', probeArguments(policy), { cwd, env: providerEnvironment(), detached: true, effectTimeoutMs: policy.perProbeTimeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      line += chunk;
      let newline;
      while ((newline = line.indexOf('\n')) !== -1) { const entry = line.slice(0, newline); line = line.slice(newline + 1); if (entry) parseLine(entry); }
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) { line = ''; invalid = true; stop('failed'); }
    });
    child.stderr.resume(); // Never retain raw provider errors or transcripts.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ brief, snapshotFiles: snapshot.files.map(f => f.path), ...(context.length ? { deliveredContext: context } : {}) }));
    if (signal?.aborted) stop();
    exit = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', code => { closed = true; resolve(code); }); });
    if (line.trim()) parseLine(line);
    await queue;
  } catch { status = 'failed'; } finally {
    clearTimeout(timeout); clearInterval(timer); timers.forEach(clearTimeout); signal?.removeEventListener('abort', abort);
  }
  const evidenceVerified = output !== null && await verifyEvidence(output, { brief, snapshot, cwd, context }).catch(() => false);
  const obs = observation.value();
  const modelVerified = obs.models.length === 1 && obs.models[0] === policy.model;
  return normalizeProbe({ ...probe, status: status ?? (exit === 0 && resultSuccess && init && !invalid && output && evidenceVerified && modelVerified ? 'completed' : 'failed'), finishedAt: new Date().toISOString(), isolationVerified: init && !invalid, evidenceVerified, observation: obs, output }, brief);
}
