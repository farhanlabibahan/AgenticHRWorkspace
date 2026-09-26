import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';

/**
 * A notetaker's MCP server for tests, built with the official server SDK and
 * served over streamable HTTP on a random local port. Tools are whatever the
 * test registers; every call is logged. It guards /mcp with either a static
 * API key or a small OAuth authorization server of its own (discovery,
 * dynamic registration, PKCE code exchange, refresh), so the client side
 * runs exactly the flows it runs against Fireflies or Fathom.
 */

export type FakeToolResult = {
  content?: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type FakeTool = {
  name: string;
  properties?: Record<string, unknown>;
  required?: string[];
  handler: (args: Record<string, unknown>) => FakeToolResult | Promise<FakeToolResult>;
};

export type FakeOAuthOptions = {
  /** What the token endpoint does with a refresh grant. */
  refresh?: 'rotate' | 'invalid_grant' | 'server_error';
};

export type FakeMcp = {
  origin: string;
  url: string;
  calls: { tool: string; args: Record<string, unknown> }[];
  /** OAuth only: clients registered, codes issued, tokens handed out. */
  oauth: {
    registrations: Record<string, unknown>[];
    tokenRequests: URLSearchParams[];
    validTokens: Set<string>;
    /** Simulates the user approving at /authorize: returns the code the AS would redirect back with. */
    approve(authorizationUrl: string): { code: string; state: string | null; redirectUri: string };
  };
  setTools(tools: FakeTool[]): void;
  close(): Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function send(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  }
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function startFakeMcp(opts: { apiKey?: string; oauth?: FakeOAuthOptions; tools?: FakeTool[] }): Promise<FakeMcp> {
  let tools: FakeTool[] = opts.tools ?? [];
  const calls: FakeMcp['calls'] = [];
  const registrations: Record<string, unknown>[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const validTokens = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const refreshTokens = new Set<string>();

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'fake-notetaker', version: '1.0.0' });
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          inputSchema: fromJsonSchema({
            type: 'object',
            properties: tool.properties ?? {},
            required: tool.required ?? [],
          } as Parameters<typeof fromJsonSchema>[0]),
        },
        async (args: unknown) => {
          const a = (args ?? {}) as Record<string, unknown>;
          calls.push({ tool: tool.name, args: a });
          const r = await tool.handler(a);
          return { content: r.content ?? [], ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
        },
      );
    }
    return server;
  });

  let origin = '';
  const issueTokens = () => {
    const access = `at_${randomBytes(12).toString('hex')}`;
    const refresh = `rt_${randomBytes(12).toString('hex')}`;
    validTokens.add(access);
    refreshTokens.add(refresh);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh };
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin);
      const body = await readBody(req);

      if (opts.oauth) {
        if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
          return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['meetings'] });
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          return json(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: ['meetings', 'offline_access'],
          });
        }
        if (url.pathname === '/register' && req.method === 'POST') {
          const meta = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          registrations.push(meta);
          return json(res, 201, { ...meta, client_id: `client_${registrations.length}`, client_id_issued_at: Math.floor(Date.now() / 1000) });
        }
        if (url.pathname === '/token' && req.method === 'POST') {
          const params = new URLSearchParams(body.toString('utf8'));
          tokenRequests.push(params);
          if (params.get('grant_type') === 'authorization_code') {
            const code = codes.get(params.get('code') ?? '');
            const verifier = params.get('code_verifier') ?? '';
            const challenge = createHash('sha256').update(verifier).digest('base64url');
            if (!code || code.challenge !== challenge || code.redirectUri !== params.get('redirect_uri')) {
              return json(res, 400, { error: 'invalid_grant' });
            }
            codes.delete(params.get('code')!);
            return json(res, 200, issueTokens());
          }
          if (params.get('grant_type') === 'refresh_token') {
            const rt = params.get('refresh_token') ?? '';
            if (opts.oauth.refresh === 'server_error') return json(res, 500, { error: 'server_error' });
            if (opts.oauth.refresh === 'invalid_grant' || !refreshTokens.has(rt)) return json(res, 400, { error: 'invalid_grant' });
            refreshTokens.delete(rt); // rotating: each refresh token works once
            return json(res, 200, issueTokens());
          }
          return json(res, 400, { error: 'unsupported_grant_type' });
        }
      }

      if (url.pathname !== '/mcp') return json(res, 404, { error: 'not found' });

      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const allowed = opts.oauth ? Boolean(bearer && validTokens.has(bearer)) : !opts.apiKey || bearer === opts.apiKey;
      if (!allowed) {
        return json(res, 401, { error: 'unauthorized' }, opts.oauth
          ? { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }
          : {});
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const request = new Request(url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' || !body.length ? undefined : new Uint8Array(body),
      });
      await send(res, await handler.fetch(request));
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    url: `${origin}/mcp`,
    calls,
    oauth: {
      registrations,
      tokenRequests,
      validTokens,
      approve(authorizationUrl: string) {
        const u = new URL(authorizationUrl);
        const code = `code_${randomBytes(8).toString('hex')}`;
        const redirectUri = u.searchParams.get('redirect_uri') ?? '';
        codes.set(code, {
          challenge: u.searchParams.get('code_challenge') ?? '',
          redirectUri,
          clientId: u.searchParams.get('client_id') ?? '',
        });
        return { code, state: u.searchParams.get('state'), redirectUri };
      },
    },
    setTools(next) {
      tools = next;
    },
    async close() {
      await handler.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
