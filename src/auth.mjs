// This dependency-free file is copied out of npm's cache into private storage.
import { readFile, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { legacyCredential } from './legacy-compat.mjs';

export async function windowsPrivateAcl(path, { directory = false, apply = false, execute = promisify(execFile) } = {}) {
  const target = Buffer.from(path, 'utf16le').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${target}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; ${apply ? `$acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }; $acl.SetOwner($sid); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','${directory ? 'ContainerInherit,ObjectInherit' : 'None'}','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl; $acl=Get-Acl -LiteralPath $p;` : ''} if(!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsafe owner or inheritance' }; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if($rules.Count -eq 0) { throw 'Missing private access' }; foreach($rule in $rules) { if($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unsafe access rule' } };`;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true, maxBuffer: 65536 });
}

export async function readCredential(path, projectId, workspaceId) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Credential permissions are unsafe.');
  if (process.platform === 'win32') await windowsPrivateAcl(path);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  if (saved.projectId !== projectId || saved.workspaceId !== workspaceId || typeof saved.value !== 'string' || !saved.value || /[\r\n]/.test(saved.value)) throw new Error('Credential identity is invalid.');
  // Environment compatibility is explicit and scoped. A shell's unrelated key
  // must never silently override this installation's saved workspace key.
  const envMatches = process.env.FOUNDOCS_PROJECT_ID === projectId && process.env.FOUNDOCS_WORKSPACE_ID === workspaceId;
  const hasCurrentScope = ['FOUNDOCS_API_KEY', 'FOUNDOCS_PROJECT_ID', 'FOUNDOCS_WORKSPACE_ID'].some(name => process.env[name] !== undefined);
  const override = hasCurrentScope ? (envMatches ? process.env.FOUNDOCS_API_KEY : undefined) : legacyCredential(process.env, projectId, workspaceId);
  const value = override || saved.value;
  if (/[\r\n]/.test(value)) throw new Error('Credential is invalid.');
  return value;
}

if (process.argv[1] && process.argv[2] === '--headers' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [path, projectId, workspaceId] = process.argv.slice(3);
    const key = await readCredential(path, projectId, workspaceId);
    process.stdout.write(JSON.stringify({ Authorization: `Bearer ${key}` }));
  } catch {
    process.stderr.write('Foundocs authentication unavailable. Run foundocs-setup doctor.\n');
    process.exitCode = 1;
  }
}
