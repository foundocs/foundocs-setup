// Bundled once at publication, copied into private storage at installation.
// Codex reserves Authorization in http_headers_helper. Its stdio transport
// therefore uses this local adapter to authenticate to the unchanged remote MCP.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readCredential } from './auth.mjs';

const [credentialPath, projectId, workspaceId, endpoint] = process.argv.slice(2);
let remote, local;
async function close() {
  await remote?.close().catch(() => {});
  await local?.close().catch(() => {});
}
try {
  const url = new URL(endpoint);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error();
  const key = await readCredential(credentialPath, projectId, workspaceId);
  remote = new Client({ name: 'foundocs-local-auth', version: '0.2.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
    fetch: (target, init) => {
      if (new URL(typeof target === 'string' || target instanceof URL ? target : target.url).origin !== url.origin) throw new Error('Origin changed');
      return fetch(target, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    },
  });
  await remote.connect(transport, { timeout: 20000 });
  local = new Server({ name: 'foundocs', version: '0.2.0' }, { capabilities: { tools: {} }, instructions: remote.getInstructions() });
  local.setRequestHandler('tools/list', async (request) => {
    try { return await remote.listTools(request.params); }
    catch { throw new ProtocolError(ProtocolErrorCode.InternalError, 'Foundocs tool discovery failed. Run foundocs-setup doctor.'); }
  });
  local.setRequestHandler('tools/call', async (request) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.arguments?.project_id)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Read and pass the explicit project_id from the governing foundocs.json.');
    try { return await remote.callTool(request.params); }
    catch { throw new ProtocolError(ProtocolErrorCode.InternalError, 'Foundocs request failed. Check authentication and connectivity. Retry writes only with the same requestId and input.'); }
  });
  local.onerror = () => process.stderr.write('Foundocs local MCP transport error.\n');
  remote.onerror = () => process.stderr.write('Foundocs remote MCP transport error.\n');
  process.stdin.on('end', () => { void close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close().finally(() => process.exit(0)); });
  await local.connect(new StdioServerTransport());
} catch {
  process.stderr.write('Foundocs authentication bridge unavailable. Run foundocs-setup doctor.\n');
  await close(); process.exitCode = 1;
}
