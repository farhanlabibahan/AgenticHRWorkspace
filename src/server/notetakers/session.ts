import {
  Client,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type FetchLike,
  type OAuthClientProvider,
  type Tool,
} from '@modelcontextprotocol/client';
import type { ToolCaller } from '@/server/notetakers/adapters';
import { toolPayload } from '@/server/notetakers/parse';

/**
 * One MCP client session against a notetaker's server: connect over
 * streamable HTTP, read tools/list, run `fn`, and always close. On Vercel a
 * function instance may be frozen or dropped between invocations, so a
 * session never outlives the request that opened it: every cron run and
 * every attach makes its own.
 */

export type McpSession = { tools: Tool[]; call: ToolCaller };

const CLIENT_INFO = { name: 'orqestra', title: 'Orqestra', version: '1.0.0' };

export async function withMcpSession<T>(
  serverUrl: string,
  authProvider: AuthProvider | OAuthClientProvider,
  fn: (session: McpSession) => Promise<T>,
  opts: { timeoutMs?: number; fetchFn?: FetchLike } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 60_000;
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    authProvider,
    ...(opts.fetchFn ? { fetch: opts.fetchFn } : {}),
  });
  // The default 'legacy' version negotiation: the plain initialize handshake
  // every one of these servers speaks today.
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport, { timeout });
    const { tools } = await client.listTools(undefined, { timeout });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const call: ToolCaller = async (name, args) => {
      const def = byName.get(name);
      // Our parsers read whatever comes back; don't let a server whose
      // output drifted from its own declared schema fail the call.
      const toolDefinition = def ? { ...def, outputSchema: undefined } : undefined;
      const result = await client.callTool({ name, arguments: args }, { timeout, ...(toolDefinition ? { toolDefinition } : {}) });
      return toolPayload(name, result);
    };
    return await fn({ tools, call });
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
