// Bundled once at publication, copied into private storage at installation.
// Codex reserves Authorization in http_headers_helper. Its stdio transport
// therefore uses this local adapter to authenticate to the unchanged remote MCP.
import { Client, StreamableHTTPClientTransport, SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError } from '@modelcontextprotocol/client';
import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readCredential } from './auth.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Forward only a stable category and safe context, never raw remote messages or data.
function requestError(error, name) {
  const tool = typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(name) ? name : undefined;
  let code = 'REQUEST_FAILED', retryable = false, message = 'The MCP request failed. Run foundocs-setup doctor for connection diagnostics.';
  let httpStatus, remoteCode;
  const schemaError = error instanceof ProtocolError && (
    (error.code === ProtocolErrorCode.InvalidParams && (
      error.message.startsWith("Structured content does not match the tool's output schema:") ||
      error.message.startsWith('Failed to validate structured content:') ||
      /^Tool '[^']+' has an invalid outputSchema:/.test(error.message)
    )) || (error.code === ProtocolErrorCode.InvalidRequest && /^Tool .+ has an output schema but did not return structured content$/.test(error.message))
  );
  if (schemaError) {
    code = 'OUTPUT_VALIDATION_ERROR';
    message = 'The server response does not match the advertised tool output schema. Update the server tool contract; changing credentials will not fix this error.';
  } else if (error instanceof SdkHttpError || error instanceof UnauthorizedError) {
    httpStatus = error instanceof UnauthorizedError ? 401 : error.status;
    if (httpStatus === 401) { code = 'UNAUTHENTICATED'; message = 'Authentication failed (HTTP 401). Run foundocs-setup doctor and check the configured workspace key.'; }
    else if (httpStatus === 403) { code = 'FORBIDDEN'; message = 'Access was denied (HTTP 403). Check the workspace key permissions for this project.'; }
    else if (httpStatus === 429) { code = 'RATE_LIMITED'; retryable = true; message = 'The server rate limit was reached (HTTP 429). Wait before retrying.'; }
    else { code = 'REMOTE_HTTP_ERROR'; retryable = httpStatus >= 500; message = `The remote MCP server returned HTTP ${httpStatus}. Check the server status.`; }
  } else if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    code = 'REQUEST_TIMEOUT'; retryable = true; message = 'The remote MCP request timed out.';
  } else if ((error instanceof SdkError && [SdkErrorCode.InvalidResult, SdkErrorCode.UnsupportedResultType].includes(error.code))) {
    code = 'INVALID_REMOTE_RESPONSE'; message = 'The remote MCP response is malformed. Check the server protocol and response schema.';
  } else if ((error instanceof SdkError && [SdkErrorCode.NotConnected, SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed].includes(error.code)) ||
    (error instanceof TypeError && error.message === 'fetch failed') || ['AbortError', 'TimeoutError'].includes(error?.name)) {
    code = 'CONNECTION_ERROR'; retryable = true; message = 'The remote MCP connection failed or was interrupted. Check connectivity and the server status.';
  } else if (error instanceof ProtocolError) {
    code = 'REMOTE_PROTOCOL_ERROR'; remoteCode = error.code;
    message = 'The remote MCP server returned a protocol error. Check the requested tool and arguments.';
  }
  return new ProtocolError(ProtocolErrorCode.InternalError,
    `Foundocs ${tool ?? 'request'} [${code}]: ${message} Writes may already have succeeded; retry only with the same requestId and input.`,
    { code, retryable, ...(tool ? { tool } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}), ...(remoteCode !== undefined ? { remoteCode } : {}) });
}

export async function runBridge({ credentialPath, projectId, workspaceId, mcpUrl: endpoint }) {
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
    catch (error) { throw requestError(error, 'tools_list'); }
  });
  local.setRequestHandler('tools/call', async (request) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.arguments?.project_id)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Read and pass the explicit project_id from the governing foundocs.json.');
    try { return await remote.callTool(request.params); }
    catch (error) { throw requestError(error, request.params.name); }
  });
  local.onerror = () => process.stderr.write('Foundocs local MCP transport error.\n');
  remote.onerror = () => process.stderr.write('Foundocs remote MCP transport error.\n');
  process.stdin.on('end', () => { void close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close().finally(() => process.exit(0)); });
  await local.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`Foundocs MCP bridge unavailable. ${requestError(error, 'initialize').message}\n`);
  await close(); process.exitCode = 1;
}

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [credentialPath, projectId, workspaceId, mcpUrl] = process.argv.slice(2);
  await runBridge({ credentialPath, projectId, workspaceId, mcpUrl });
}
