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
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const rpc = JSON.parse(text);
    if (rpc.method.startsWith('notifications/')) { response.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'error-fixture', version: '1' } };
    if (rpc.method === 'tools/list') result = { tools: [tool] };
    if (rpc.method === 'tools/call') {
      if (options.status) { response.writeHead(options.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `${key} ${privateValue}` })); return; }
      result = options.result ?? { content: [{ type: 'text', text: privateValue }], structuredContent: { ok: true, data: { count: 1, unexpected: `${key} ${privateValue}` } } };
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
  await client.listTools();
  return { client, call: () => options.raw ? client.request({ method: 'tools/call', params: { name: 'get_doc', arguments: { project_id: projectId } } }) : client.callTool({ name: 'get_doc', arguments: { project_id: projectId } }), server, get stderr() { return stderr; } };
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
