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

export async function sessionStart(args) {
  try {
    if (args.length !== 2 || args[0] !== '--root' || !isAbsolute(args[1])) return null;
    const root = await realpath(args[1]);
    const script = fileURLToPath(import.meta.url);
    if (!['.agents', '.claude'].some(client => script === join(root, client, 'skills/foundocs/scripts/session-start.mjs'))) return null;
    const result = await autoUpdate(root);
    if (result.status !== 'updated') return null;
    return { hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `Foundocs skills updated to ${result.version}. Read the installed SKILL.md before using Foundocs; already loaded instructions may need a host reload.`,
      ...(script.includes('/.claude/') || script.includes('\\.claude\\') ? { reloadSkills: true } : {}),
    } };
  } catch { return null; }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const output = await sessionStart(process.argv.slice(2));
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}
