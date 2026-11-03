import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readCredential } from './auth.mjs';
import { EffectError } from './effect-core.mjs';
export async function connectEffectRemote(manifest) {
  const url = new URL(manifest.mcpUrl);
  const key = await readCredential(manifest.credentialPath, manifest.projectId, manifest.workspaceId);
  const client = new Client({ name: 'foundocs-effect-coordinator', version: '1' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
    fetch: (target, init) => {
      if (new URL(typeof target === 'string' || target instanceof URL ? target : target.url).origin !== url.origin) throw new EffectError('origin_changed');
      return fetch(target, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    },
  });
  try { await client.connect(transport, { timeout: 5000 }); await client.listTools(); } catch { await client.close().catch(() => {}); throw new EffectError('connection_unavailable'); }
  return {
    close: () => client.close(),
    async call(name, args) {
      let result;
      try { result = await client.callTool({ name, arguments: { ...args, project_id: manifest.projectId } }, undefined, { timeout: 5000 }); }
      catch { throw new EffectError('transport_uncertain', 'Request outcome is uncertain; no inference will be repeated.', true); }
      const body = result.structuredContent ?? (() => { try { return JSON.parse(result.content?.find(c => c.type === 'text')?.text); } catch { return null; } })();
      if (!body || typeof body.ok !== 'boolean') throw new EffectError('invalid_response', 'Request outcome is uncertain.', true);
      if (!body.ok || result.isError) throw new EffectError(body.error?.code ?? 'request_failed', 'Server rejected the measurement request.');
      return body.data;
    },
  };
}
