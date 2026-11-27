import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { install } from '../src/setup.mjs';

const key = 'sd_private_bridge_error_test_key';
const privateValue = 'private_response_sentinel';
const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' }, data: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } }, required: ['ok', 'data'], additionalProperties: false };

async function bridge(t, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'foundocs-bridge-errors-')));
  const root = join(base, 'project'), storageDir = join(base, 'private');
  await mkdir(root);
  const projectId = randomUUID(), workspaceId = randomUUID();
  const tool = { name: 'get_doc', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] }, outputSchema: options.schema ?? outputSchema };
  const calls = [];
  const extraTools = options.automatic ? ['get_effect_measurement_policy', 'prepare_effect_measurement', 'report_effect_diagnostic', 'report_retrieval_evaluation'].map(name => ({ name, inputSchema: { type: 'object' } })) : [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const rpc = JSON.parse(text);
    if (rpc.method.startsWith('notifications/')) { response.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'error-fixture', version: '1' } };
    if (rpc.method === 'tools/list') {
      const pages = options.pages ?? [[tool, ...extraTools]];
      const page = Number(rpc.params?.cursor ?? 0);
      result = { tools: pages[page], ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}) };
    }
    if (rpc.method === 'tools/call') {
      calls.push(rpc.params);
      if (options.status) { response.writeHead(options.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `${key} ${privateValue}` })); return; }
      result = options.result ?? { content: [{ type: 'text', text: privateValue }], structuredContent: { ok: true, data: { count: 1, unexpected: `${key} ${privateValue}` } } };
    }
    if (rpc.method === 'tools/call' && options.automatic && rpc.params.name !== 'get_doc') {
      const data = rpc.params.name === 'get_effect_measurement_policy' ? { enabled: true } : { recorded: true };
      result = { structuredContent: { ok: true, data }, content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  const client = new Client({ name: 'bridge-error-test', version: '1' });
  t.after(async () => { await client.close(); if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(base, { recursive: true, force: true }); });
  await install(root, { version: 1, client: 'codex', projectId, workspaceId, attemptId: randomUUID(), code: 'one_time_bridge_error_code', exchangeUrl: 'https://api.example.test/exchange', mcpUrl }, {
    storageDir, probeClient: async () => ({ client: 'codex', version: 'fixture', helper: 'supported' }),
    fetch: async () => Response.json({ value: key, projectId, workspaceId, key: { id: randomUUID() } }),
    diagnose: async () => ({ status: 'diagnostic_passed', hostVerification: 'required' }),
  });
  let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../src/cli.mjs', import.meta.url).pathname, 'mcp', '--project-id', projectId], cwd: root, env: { ...process.env, FOUNDOCS_SETUP_HOME: storageDir }, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  await client.connect(transport);
  if (!options.skipDiscovery) await client.listTools();
  const call = (name = 'get_doc', args = {}) => {
    const params = { name, arguments: { project_id: projectId, ...args } };
    return options.raw ? client.request({ method: 'tools/call', params }) : client.callTool(params);
  };
  return { client, call, calls, projectId, server, get stderr() { return stderr; } };
}

for (const scenario of ['extra field', 'missing structured content', 'invalid output schema']) test(`stdio bridge identifies ${scenario} as output validation failure without exposing response data`, async t => {
  const options = scenario === 'missing structured content' ? { result: { content: [{ type: 'text', text: `${key} ${privateValue}` }] } }
    : scenario === 'invalid output schema' ? { raw: true, schema: { type: 'object', properties: { count: { type: 'invalid-schema-type' } } } } : {};
  const f = await bridge(t, options);
  await assert.rejects(f.call(), error => {
    assert.equal(error.data.code, 'OUTPUT_VALIDATION_ERROR');
    assert.equal(error.data.tool, 'get_doc');
    assert.equal(error.data.retryable, false);
    assert.match(error.message, /output schema/);
    assert.match(error.message, /same requestId and input/);
    assert.doesNotMatch(JSON.stringify(error) + error.message + f.stderr, new RegExp(`${key}|${privateValue}|invalid-schema-type`));
    return true;
  });
});

for (const [status, code, retryable] of [[401, 'UNAUTHENTICATED', false], [403, 'FORBIDDEN', false], [429, 'RATE_LIMITED', true], [503, 'REMOTE_HTTP_ERROR', true]]) test(`stdio bridge distinguishes HTTP ${status} from schema failures`, async t => {
  const f = await bridge(t, { status });
  await assert.rejects(f.call(), error => {
    assert.equal(error.data.code, code);
    assert.equal(error.data.httpStatus, status);
    assert.equal(error.data.retryable, retryable);
    assert.doesNotMatch(JSON.stringify(error) + error.message + f.stderr, new RegExp(`${key}|${privateValue}`));
    return true;
  });
});

test('stdio bridge identifies a failed connection without claiming authentication failed', async t => {
  const f = await bridge(t);
  await new Promise(resolve => f.server.close(resolve));
  await assert.rejects(f.call(), error => {
    assert.equal(error.data.code, 'CONNECTION_ERROR');
    assert.equal(error.data.retryable, true);
    assert.doesNotMatch(error.message, /Authentication failed/);
    return true;
  });
});

test('stdio bridge preserves structured server output validation errors', async t => {
  const structuredContent = { ok: false, error: { code: 'OUTPUT_VALIDATION_ERROR', message: 'Tool response contract mismatch', retryable: false, details: { tool: 'get_doc', issues: [{ path: 'data.relations.0', code: 'unrecognized_keys' }] } } };
  const f = await bridge(t, { result: { isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } });
  const reply = await f.call();
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.structuredContent, structuredContent);
});

test('installed bridge advertises automatic metadata, keeps it local, and reports missing installation consent without inference', async t => {
  const f = await bridge(t, { automatic: true, result: { content: [], structuredContent: { ok: true, data: { count: 1 } } } });
  const tools = await f.client.listTools();
  assert(tools.tools.find(t => t.name === 'get_doc').inputSchema.properties.effectTask);
  const taskId = randomUUID();
  const result = await f.client.callTool({ name: 'get_doc', arguments: { project_id: f.projectId,
    effectTask: { taskId, question: 'Locate retry config', knownContext: '', criteria: [{ id: 'retry', description: 'Locate it' }] } } });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(f.calls.find(c => c.name === 'report_effect_diagnostic').arguments.reason, 'consent_required');
  const read = f.calls.find(c => c.name === 'get_doc');
  assert.equal(read.arguments.taskId, taskId); assert(!('effectTask' in read.arguments));
  assert(!f.calls.some(c => c.name === 'prepare_effect_measurement'));
});

function scopeTool(name, scopes = ['project', 'shared', 'all']) {
  return { name, inputSchema: { type: 'object', properties: {
    project_id: { type: 'string' }, ...(scopes ? { scope: { type: 'string', enum: scopes } } : {}),
  }, required: ['project_id'] } };
}

test('stdio bridge defaults only supported reads to all, through paged discovery and continuations', async t => {
  const names = ['get_project_context', 'search_docs', 'explore_docs', 'get_doc', 'get_docs'];
  const readTools = names.map(name => scopeTool(name));
  const pages = [[scopeTool('create_doc'), scopeTool('unrecognized_read')], readTools];
  const f = await bridge(t, { pages, result: { content: [] } });
  assert.deepEqual((await f.client.listTools()).tools, pages.flat());
  for (const name of names) {
    await f.call(name);
    assert.deepEqual(f.calls.at(-1), { name, arguments: { project_id: f.projectId, scope: 'all' } });
  }
  const readId = randomUUID();
  await f.call('search_docs', { cursor: 'opaque', query: 'matching', readId });
  assert.deepEqual(f.calls.at(-1).arguments, { project_id: f.projectId, cursor: 'opaque', query: 'matching', readId, scope: 'all' });
  for (const scope of ['project', 'shared', 'all']) {
    await f.call('get_docs', { scope });
    assert.equal(f.calls.at(-1).arguments.scope, scope);
  }
  for (const name of ['create_doc', 'mutate_shared_content', 'unrecognized_read']) {
    await f.call(name);
    assert.deepEqual(f.calls.at(-1), { name, arguments: { project_id: f.projectId } });
  }
});

test('stdio bridge checks the server even for a cached host and refreshes capability on rediscovery', async t => {
  const options = { pages: [[scopeTool('get_doc')]], raw: true, skipDiscovery: true, result: { content: [] } };
  const f = await bridge(t, options);
  await f.call();
  assert.equal(f.calls.at(-1).arguments.scope, 'all');

  options.pages = [[scopeTool('get_doc', null), scopeTool('search_docs', ['project', 'shared'])]];
  await f.client.listTools(undefined, { cacheMode: 'refresh' });
  await f.call();
  await f.call('search_docs', { cursor: 'old-project-cursor' });
  assert.deepEqual(f.calls.slice(-2).map(call => call.arguments), [
    { project_id: f.projectId }, { project_id: f.projectId, cursor: 'old-project-cursor' },
  ]);
});

test('stdio bridge negotiates the unified tree per tool and retains explicit arguments', async t => {
  const tree = { const: 'unified' };
  const branch = { type: 'object', properties: { tree } };
  const tool = (name, schema) => ({ name, inputSchema: { type: 'object', ...schema } });
  const read = scopeTool('get_doc');
  read.inputSchema.properties.tree = { enum: ['legacy', 'unified'] };
  const options = { raw: true, skipDiscovery: true, result: { content: [] }, pages: [
    [read, tool('move_docs', branch), tool('get_dream', branch), tool('set_content_status', branch)],
    [tool('mutate_discussion', { oneOf: [branch, branch] }), tool('ambiguous_option', { anyOf: [branch, { type: 'object' }] })],
  ] };
  const f = await bridge(t, options);
  for (const name of ['move_docs', 'get_dream', 'mutate_discussion', 'set_content_status']) {
    await f.call(name);
    assert.deepEqual(f.calls.at(-1).arguments, { tree: 'unified', project_id: f.projectId });
  }
  await f.call('get_doc');
  assert.deepEqual(f.calls.at(-1).arguments, { project_id: f.projectId, tree: 'unified', scope: 'all' });
  await f.call('get_doc', { tree: 'legacy', scope: 'project' });
  assert.deepEqual(f.calls.at(-1).arguments, { project_id: f.projectId, tree: 'legacy', scope: 'project' });
  await f.call('ambiguous_option');
  assert.deepEqual(f.calls.at(-1).arguments, { project_id: f.projectId });
  // Canonical-default (and older) servers may omit the transitional parameter.
  options.pages = [[scopeTool('get_doc'), scopeTool('move_docs', null)]];
  await f.client.listTools(undefined, { cacheMode: 'refresh' });
  await f.call('move_docs');
  assert.deepEqual(f.calls.at(-1).arguments, { project_id: f.projectId });
});
