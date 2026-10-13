import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkUpdate, newer } from '../skills/foundocs/scripts/check-update.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13);
const PACKAGE = '@foundocs/foundocs-setup';
const ENDPOINT = 'https://registry.npmjs.org/@foundocs%2ffoundocs-setup/latest';
const checkerUrl = new URL('../skills/foundocs/scripts/check-update.mjs', import.meta.url);
const execute = promisify(execFile);
const release = (version = '1.1.0', extra = {}) => Response.json({ name: PACKAGE, version, ...extra });
const forbiddenFetch = async () => { throw new Error('Unexpected registry request'); };

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'foundocs-update-')));
  const root = join(base, "project 비밀 '#%"), stateDirectory = join(base, 'private', 'update-checks');
  const protectedFiles = {
    'AGENTS.md': '# Keep unrelated rules\n',
    'foundocs.json': '{"projectId":"private_project_identifier"}',
    '.codex/config.toml': 'token = "private_configuration_token"\n',
    '.agents/skills/foundocs/SKILL.md': 'User-edited installed skill\n',
    '.claude/skills/foundocs/SKILL.md': 'User-edited Claude skill\n',
    '../credentials.json': '{"apiKey":"private_credential_value"}',
  };
  for (const [name, value] of Object.entries(protectedFiles)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), value);
  }
  t.after(async () => {
    try {
      for (const [name, value] of Object.entries(protectedFiles)) {
        assert.equal(await readFile(join(root, name), 'utf8'), value, `${name} must remain unchanged`);
      }
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  const options = { installedVersion: '1.0.0', stateDirectory, now: NOW, fetch: async () => release() };
  const statePath = join(stateDirectory, `${createHash('sha256').update(root).digest('hex')}.json`);
  return { base, root, stateDirectory, statePath, options, check: extra => checkUpdate(root, { ...options, ...extra }) };
}

test('AC-34: stable release comparisons use numeric components and reject non-stable/malformed versions', () => {
  for (const [candidate, installed, expected] of [
    ['1.10.0', '1.9.0', true], ['1.9.0', '1.10.0', false],
    ['2.0.0', '1.99.99', true], ['1.0.10', '1.0.9', true],
    ['1.0.0', '1.0.0', false], ['0.9.9', '1.0.0', false],
    ['9007199254740993.0.0', '9007199254740992.0.0', true],
    ['2.0.0-beta.1', '1.0.0', false], ['2.0.0+build', '1.0.0', false],
    ['02.0.0', '1.0.0', false], ['v2.0.0', '1.0.0', false],
    ['2.0', '1.0.0', false], [' 2.0.0', '1.0.0', false],
    ['2.0.0', 'invalid', false], [null, '1.0.0', false],
  ]) assert.equal(newer(candidate, installed), expected, `${candidate} compared with ${installed}`);
});

test('AC-34/36: newer release exposes a bounded published summary and only sends anonymous public metadata', async t => {
  const f = await fixture(t);
  const requests = [];
  const result = await f.check({ fetch: async (url, options) => {
    requests.push({ url, options });
    return release('1.10.0', { foundocsRelease: { summary: 'Published\nfixes\u0000 and improvements' } });
  } });
  assert.equal(result.status, 'update_available');
  assert.equal(result.shouldPrompt, true);
  assert.equal(result.installedVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.10.0');
  assert.equal(result.summary, 'Published fixes  and improvements');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, ENDPOINT);
  assert.deepEqual(requests[0].options.headers, { Accept: 'application/json' });
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(requests[0].options.body, undefined);
  const serialized = JSON.stringify(requests);
  for (const secret of [f.root, 'private_project_identifier', 'private_configuration_token', 'private_credential_value']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('AC-34: missing summary stays absent; untrusted display text is bounded without executing it', async t => {
  const f = await fixture(t);
  assert.equal((await f.check()).summary, null);
  const result = await f.check({ now: NOW + DAY, fetch: async () => release('1.2.0', {
    foundocsRelease: { summary: '$(touch should-not-exist) '.repeat(100) },
  }) });
  assert.equal(result.summary.length, 500);
  assert.match(result.summary, /^\$\(touch should-not-exist\)/);
  await assert.rejects(lstat(join(f.root, 'should-not-exist')), { code: 'ENOENT' });
});

for (const version of ['1.0.0', '0.99.0', '1.1.0-beta.1', '1.1', 'v1.1.0', '01.1.0', null]) {
  test(`AC-34: ${JSON.stringify(version)} never offers an update`, async t => {
    const f = await fixture(t);
    const result = await f.check({ fetch: async () => release(version) });
    assert.equal(result.shouldPrompt, false);
    assert.equal(result.status, ['1.0.0', '0.99.0'].includes(version) ? 'up_to_date' : 'unavailable');
  });
}

test('AC-34: both registry cache and repeat prompt suppression expire at exactly 24 hours', async t => {
  const f = await fixture(t);
  let calls = 0;
  const fetch = async () => { calls++; return release(); };
  assert.equal((await f.check({ fetch })).shouldPrompt, true);
  for (const elapsed of [0, 1, DAY - 1]) {
    const result = await f.check({ now: NOW + elapsed, fetch });
    assert.equal(result.status, 'update_available');
    assert.equal(result.shouldPrompt, false);
    assert.equal(result.cached, true);
  }
  assert.equal(calls, 1);
  const expired = await f.check({ now: NOW + DAY, fetch });
  assert.equal(expired.shouldPrompt, true);
  assert.equal(expired.cached, false);
  assert.equal(calls, 2);
});

test('AC-35/37: deferral persists across Node processes, performs no fetch and expires after seven days', async t => {
  const f = await fixture(t);
  await f.check();
  const deferredAt = NOW + 1234;
  const source = `import { checkUpdate } from ${JSON.stringify(checkerUrl.href)};
    const [root, options] = JSON.parse(process.argv[1]);
    const result = await checkUpdate(root, { ...options, fetch: async () => { process.exit(91); } });
    process.stdout.write(JSON.stringify(result));`;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', source, JSON.stringify([
    f.root, { ...f.options, now: deferredAt, defer: '1.1.0' },
  ])], { env: { ...process.env, PATH: '' } });
  const deferred = JSON.parse(stdout);
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.deferredUntil, deferredAt + 7 * DAY);
  const suppressed = await f.check({ now: deferredAt + 7 * DAY - 1 });
  assert.equal(suppressed.status, 'deferred');
  assert.equal(suppressed.shouldPrompt, false);
  const expired = await f.check({ now: deferredAt + 7 * DAY, fetch: forbiddenFetch });
  assert.equal(expired.status, 'update_available');
  assert.equal(expired.shouldPrompt, true);
});

test('AC-35: a different newer version bypasses version-specific deferral once the check cache expires', async t => {
  const f = await fixture(t);
  await f.check();
  await f.check({ defer: '1.1.0', fetch: forbiddenFetch });
  let calls = 0;
  const fetch = async () => { calls++; return release('1.2.0'); };
  assert.equal((await f.check({ now: NOW + DAY - 1, fetch })).status, 'deferred');
  assert.equal(calls, 0);
  const next = await f.check({ now: NOW + DAY, fetch });
  assert.equal(next.latestVersion, '1.2.0');
  assert.equal(next.shouldPrompt, true);
  assert.equal(calls, 1);
});

test('AC-35: decisions remain separate for different project roots and use canonical root identity', async t => {
  const f = await fixture(t);
  await f.check();
  await f.check({ defer: '1.1.0' });
  const second = join(f.base, 'second-project');
  await mkdir(second);
  assert.equal((await checkUpdate(second, f.options)).shouldPrompt, true);
  const alias = join(f.base, 'project-alias');
  await symlink(f.root, alias, 'dir');
  assert.equal((await checkUpdate(alias, { ...f.options, fetch: forbiddenFetch })).status, 'deferred');
  assert.equal((await readdir(f.stateDirectory)).filter(name => name.endsWith('.json')).length, 2);
});

test('AC-35/37: deferral accepts only a previously offered newer stable release', async t => {
  const f = await fixture(t);
  assert.equal((await f.check({ defer: '1.1.0', fetch: forbiddenFetch })).status, 'unavailable');
  await f.check();
  for (const defer of ['1.2.0', '1.0.0', '1.1.0-beta.1']) {
    assert.equal((await f.check({ defer, fetch: forbiddenFetch })).status, 'unavailable');
  }
  assert.equal((await f.check({ defer: '1.1.0', fetch: forbiddenFetch })).status, 'deferred');
});

for (const [name, response] of [
  ['network rejection', () => { throw new Error('private transport details'); }],
  ['HTTP failure', () => new Response('private server details', { status: 503 })],
  ['malformed JSON', () => new Response('{not json')],
  ['wrong package', () => release('1.1.0', { name: '@someone/else' })],
  ['oversized response', () => new Response('x'.repeat(256 * 1024 + 1))],
]) {
  test(`AC-36: ${name} is quiet and failure is cached for 24 hours`, async t => {
    const f = await fixture(t);
    let calls = 0;
    const fetch = async () => { calls++; return response(); };
    const first = await f.check({ fetch });
    assert.equal(first.status, 'unavailable');
    assert.equal(first.shouldPrompt, false);
    assert.doesNotMatch(JSON.stringify(first), /private transport|private server|not json/);
    assert.equal((await f.check({ now: NOW + DAY - 1, fetch })).status, 'unavailable');
    assert.equal(calls, 1);
    assert.equal((await f.check({ now: NOW + DAY, fetch: async () => release() })).shouldPrompt, true);
  });
}

test('AC-36: registry timeout aborts the request and is cached without blocking ordinary work', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const started = Date.now();
  let aborted = false;
  // Keep the event loop alive because AbortSignal.timeout itself is unrefed by Node.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await f.check({ fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) });
    assert.equal(aborted, true);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.shouldPrompt, false);
    assert.ok(Date.now() - started < 7500);
    assert.equal((await f.check({ fetch: forbiddenFetch })).cached, true);
  } finally { clearInterval(keepAlive); }
});

test('AC-36: corrupt cache is unavailable without overwriting its contents or accessing the registry', async t => {
  const f = await fixture(t);
  await mkdir(f.stateDirectory, { recursive: true });
  await writeFile(f.statePath, '{broken cache');
  let calls = 0;
  const result = await f.check({ fetch: async () => { calls++; return release(); } });
  assert.equal(result.status, 'unavailable');
  assert.equal(calls, 0);
  assert.equal(await readFile(f.statePath, 'utf8'), '{broken cache');
});

test('AC-36: read-only state directory fails quietly without changing installed files', async t => {
  if (process.getuid?.() === 0) return t.skip('Root bypasses Unix write permissions');
  const f = await fixture(t);
  await mkdir(f.stateDirectory, { recursive: true });
  await chmod(f.stateDirectory, 0o500);
  try {
    const result = await f.check({ fetch: forbiddenFetch });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.shouldPrompt, false);
    assert.deepEqual(await readdir(f.stateDirectory), []);
  } finally { await chmod(f.stateDirectory, 0o700); }
});

test('AC-36: state files, directories and lock symlinks cannot overwrite their targets', async t => {
  for (const kind of ['state', 'directory', 'lock']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const target = join(f.base, `keep-${kind}`);
      if (kind === 'directory') {
        await mkdir(target);
        await mkdir(dirname(f.stateDirectory), { recursive: true });
        await symlink(target, f.stateDirectory, 'dir');
      } else {
        await mkdir(f.stateDirectory, { recursive: true });
        await writeFile(target, 'Do not overwrite or remove');
        await symlink(target, kind === 'state' ? f.statePath : `${f.statePath}.lock`);
      }
      assert.equal((await f.check({ fetch: forbiddenFetch })).status, 'unavailable');
      if (kind === 'directory') assert.deepEqual(await readdir(target), []);
      else assert.equal(await readFile(target, 'utf8'), 'Do not overwrite or remove');
      assert.equal((await lstat(kind === 'directory' ? f.stateDirectory : kind === 'state' ? f.statePath : `${f.statePath}.lock`)).isSymbolicLink(), true);
    });
  }
});

test('AC-36: a cache directory inside the project is rejected before creating files', async t => {
  const f = await fixture(t);
  const forbidden = join(f.root, 'update-cache');
  assert.equal((await f.check({ stateDirectory: forbidden, fetch: forbiddenFetch })).status, 'unavailable');
  await assert.rejects(lstat(forbidden), { code: 'ENOENT' });
});

test('AC-34/36: simultaneous checks produce only one request and one prompt', async t => {
  const f = await fixture(t);
  let calls = 0;
  const fetch = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return release(); };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.check({ fetch })));
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.shouldPrompt).length, 1);
  assert.equal((await f.check({ fetch: forbiddenFetch })).shouldPrompt, false);
  assert.deepEqual((await readdir(f.stateDirectory)).filter(name => !name.endsWith('.json')), []);
});

for (const client of ['.agents', '.claude']) {
  test(`AC-33/37/38: copied ${client} checker CLI uses installed metadata, persists deferral and rejects another root`, async t => {
    const f = await fixture(t);
    const skill = join(f.root, client, 'skills/foundocs');
    const script = join(skill, 'scripts/check-update.mjs');
    await mkdir(dirname(script), { recursive: true });
    await copyFile(checkerUrl, script);
    await writeFile(join(skill, 'release.json'), JSON.stringify({ version: '1.0.0' }));
    // Seed a current public lookup; subprocesses must use disk state without network or npm.
    await f.check({ now: Date.now() });
    const options = { env: { ...process.env, FOUNDOCS_SETUP_HOME: dirname(f.stateDirectory), PATH: '' }, timeout: 2500 };
    const run = async args => JSON.parse((await execute(process.execPath, [script, ...args], options)).stdout);
    assert.equal((await run(['--root', f.root])).installedVersion, '1.0.0');
    assert.equal((await run(['--root', f.root, '--defer', '1.1.0'])).status, 'deferred');
    assert.equal((await run(['--root', f.root])).status, 'deferred');
    const other = join(f.base, 'another-project');
    await mkdir(other);
    assert.equal((await run(['--root', other])).status, 'unavailable');
    assert.equal((await run(['--root', f.root, '--unknown'])).shouldPrompt, false);
    assert.equal(await readFile(script, 'utf8'), await readFile(checkerUrl, 'utf8'));
    assert.deepEqual(JSON.parse(await readFile(join(skill, 'release.json'), 'utf8')), { version: '1.0.0' });
  });
}


test('AC-34/37: another session upgrading the installation makes a cached old offer ineligible', async t => {
  const f = await fixture(t);
  assert.equal((await f.check()).shouldPrompt, true);
  for (const installedVersion of ['1.1.0', '1.2.0']) {
    const result = await f.check({ installedVersion, fetch: forbiddenFetch });
    assert.equal(result.status, 'up_to_date');
    assert.equal(result.shouldPrompt, false);
    assert.equal(result.installedVersion, installedVersion);
    assert.equal((await f.check({ installedVersion, defer: '1.1.0', fetch: forbiddenFetch })).status, 'unavailable');
  }
});
