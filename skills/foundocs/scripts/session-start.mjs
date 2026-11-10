#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { checkUpdate, newer } from './check-update.mjs';

const execute = promisify(execFile);
const PACKAGE = '@foundocs/foundocs-setup';

export function updateCommand(root, version, platform = process.platform) {
  const args = ['--yes', `${PACKAGE}@${version}`, 'update-skills', '--root', root];
  if (platform !== 'win32') return ['npx', args];
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `& npx.cmd ${args.map(quote).join(' ')}; exit $LASTEXITCODE`;
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
}

async function runUpdate(root, version) {
  const [command, args] = updateCommand(root, version);
  const { stdout } = await execute(command, args, {
    cwd: root, timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '15000' },
  });
  return JSON.parse(stdout);
}

export async function autoUpdate(root, options = {}) {
  try {
    const check = await checkUpdate(root, { ...options, force: true });
    if (!newer(check.latestVersion, check.installedVersion)) return { status: check.status };
    // A second session may have updated the files during the public lookup.
    const current = options.readInstalledVersion ? await options.readInstalledVersion()
      : JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8')).version;
    if (typeof current !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(current)) return { status: 'unavailable' };
    if (!newer(check.latestVersion, current)) return { status: 'up_to_date' };
    const result = await (options.runUpdate ?? runUpdate)(root, check.latestVersion);
    if (result.ok !== true || result.skills?.status !== 'installed') return { status: 'unavailable' };
    return { status: 'updated', version: check.latestVersion };
  } catch {
    // Never expose child stderr, registry responses, credentials or local paths.
    return { status: 'unavailable' };
  }
}

export async function sessionStart(args, hookInput = {}) {
  try {
    if (args.length !== 2 || args[0] !== '--root' || !isAbsolute(args[1])) return null;
    const root = await realpath(args[1]);
    const script = fileURLToPath(import.meta.url);
    if (!['.agents', '.claude'].some(client => script === join(root, client, 'skills/foundocs/scripts/session-start.mjs'))) return null;
    const result = await autoUpdate(root);
    const isClaude = script.includes('/.claude/') || script.includes('\\.claude\\');
    const host = isClaude && typeof hookInput.session_id === 'string' && /^[0-9a-f-]{36}$/.test(hookInput.session_id) && typeof hookInput.transcript_path === 'string' && isAbsolute(hookInput.transcript_path)
      ? { client: 'claude_code', sessionId: hookInput.session_id, transcriptPath: hookInput.transcript_path } : null;
    if (result.status !== 'updated' && !host) return null;
    const context = [result.status === 'updated' ? `Foundocs skills updated to ${result.version}. Read the installed SKILL.md before using Foundocs; already loaded instructions may need a host reload.` : '', host ? `Foundocs effect measurement host session: ${JSON.stringify(host)}. Pass this host object to measure prepare; the installer reads only current model metadata. Never supply a guessed model.` : ''].filter(Boolean).join('\n');
    return { hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
      ...(isClaude && result.status === 'updated' ? { reloadSkills: true } : {}),
    } };
  } catch { return null; }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let hookInput = {};
  if (!process.stdin.isTTY) {
    const timer = setTimeout(() => process.stdin.destroy(), 500);
    try { let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) { process.stdin.destroy(); throw new Error(); } } hookInput = JSON.parse(raw); } catch { /* No host metadata: update still works. */ }
    finally { clearTimeout(timer); }
  }
  const output = await sessionStart(process.argv.slice(2), hookInput);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}
