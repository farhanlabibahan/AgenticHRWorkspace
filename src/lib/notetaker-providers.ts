/**
 * The meeting notetakers a person can connect in Settings → Integrations,
 * each through the provider's own remote MCP server (streamable HTTP). Safe
 * for the client: no secrets here. The sync lives in src/server/notetakers.
 *
 * Endpoints and sign-in details were checked against each provider's live
 * server on 2026-09-25. None of them documents its tool output precisely, so
 * the adapters read `tools/list` at run time and parse what comes back
 * defensively (src/server/notetakers/adapters.ts).
 */

export const NOTETAKER_PROVIDER_IDS = ['fireflies', 'fathom', 'metaview', 'granola', 'otter', 'circleback', 'walkie'] as const;

export type NotetakerProviderId = (typeof NOTETAKER_PROVIDER_IDS)[number];

export type NotetakerProvider = {
  id: NotetakerProviderId;
  name: string;
  /** For the favicon. */
  domain: string;
  /** The provider's MCP endpoint. */
  serverUrl: string;
  /**
   * Where the protected-resource metadata lives when the server's 401 doesn't
   * say (Metaview's WWW-Authenticate is renamed by its proxy) or it isn't at
   * the path-aware location (Otter publishes it at the root only).
   */
  resourceMetadataUrl?: string;
  /**
   * Scope to ask for when the server's resource metadata lists none (the
   * SDK then adds offline_access where the authorization server offers it).
   */
  scope?: string;
  /** Present when the provider also takes a personal API key as a bearer token. */
  apiKey?: { where: string };
  /**
   * The least time between two syncs of one connection. Fireflies' free plan
   * allows 50 requests a day, so it's checked hourly; the rest every run.
   */
  minSyncMinutes: number;
};

export const NOTETAKER_PROVIDERS: NotetakerProvider[] = [
  {
    id: 'fireflies',
    name: 'Fireflies',
    domain: 'fireflies.ai',
    serverUrl: 'https://api.fireflies.ai/mcp',
    apiKey: { where: 'In Fireflies, open Settings, then Developer settings, and copy your API key.' },
    minSyncMinutes: 60,
  },
  {
    id: 'fathom',
    name: 'Fathom',
    domain: 'fathom.video',
    serverUrl: 'https://api.fathom.ai/mcp',
    scope: 'mcp',
    minSyncMinutes: 10,
  },
  {
    id: 'metaview',
    name: 'Metaview',
    domain: 'metaview.ai',
    serverUrl: 'https://mcp.metaview.ai/mcp',
    resourceMetadataUrl: 'https://mcp.metaview.ai/.well-known/oauth-protected-resource/mcp',
    // Its resource metadata lists no scopes; without one, no refresh token.
    scope: 'offline_access',
    apiKey: { where: 'In Metaview, create a personal API key in your settings.' },
    minSyncMinutes: 10,
  },
  {
    id: 'granola',
    name: 'Granola',
    domain: 'granola.ai',
    serverUrl: 'https://mcp.granola.ai/mcp',
    minSyncMinutes: 10,
  },
  {
    id: 'otter',
    name: 'Otter',
    domain: 'otter.ai',
    serverUrl: 'https://mcp.otter.ai/mcp',
    resourceMetadataUrl: 'https://mcp.otter.ai/.well-known/oauth-protected-resource',
    minSyncMinutes: 10,
  },
  {
    id: 'circleback',
    name: 'Circleback',
    domain: 'circleback.ai',
    serverUrl: 'https://circleback.ai/api/mcp',
    scope: 'user',
    minSyncMinutes: 10,
  },
  {
    // Walkie's remote endpoint (stt-proxy/src/mcp.ts in the walkie repo):
    // CIMD or DCR, scope meetings:read, Work plan or above. Its tokens last
    // 90 days with no refresh token, so a connection asks to be reconnected
    // once a quarter.
    id: 'walkie',
    name: 'Walkie',
    domain: 'trywalkie.com',
    serverUrl: 'https://mcp.trywalkie.com/mcp',
    scope: 'meetings:read',
    minSyncMinutes: 10,
  },
];

export function notetakerProvider(id: string): NotetakerProvider | null {
  return NOTETAKER_PROVIDERS.find((p) => p.id === id) ?? null;
}
