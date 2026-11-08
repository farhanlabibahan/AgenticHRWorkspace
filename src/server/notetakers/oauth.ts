import { randomBytes } from 'node:crypto';
import {
  registerClient,
  resolveClientMetadata,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { notetakerProvider } from '@/lib/notetaker-providers';
import { openJson, sealJson } from '@/server/imports/crypto';
import { lockInTransaction } from '@/server/notetakers/locks';

/**
 * OAuth for notetaker connections: Source is the MCP client and each
 * connection is one "session" in the SDK's sense. The SDK's auth() runs
 * discovery, registration, PKCE, the code exchange and refreshes; this
 * provider decides where each piece is kept:
 *
 *  - client registrations: McpOAuthClient, shared by every org, keyed by
 *    issuer + redirect URI; the first registration per key is serialised
 *    with an advisory lock so two sign-ins can't register twice. When the
 *    authorization server accepts client ID metadata documents (CIMD) and
 *    this deployment is on https, the client id is our metadata URL instead.
 *  - tokens: sealed on the TranscriptConnection.
 *  - PKCE verifier, state and discovery: in memory while starting, then on
 *    an McpOAuthFlow row for the callback (see connections.ts).
 *
 * The provider works in three modes. `start` captures the authorization URL
 * instead of redirecting. `callback` finishes the code exchange with what the
 * flow row kept. `background` (the cron) can refresh but never ask a person:
 * when the SDK wants to send someone to sign in, the connection is marked
 * NEEDS_RECONNECT and the sync stops with ReconnectRequiredError.
 */

export const CALLBACK_PATH = '/api/integrations/mcp/callback';
export const CLIENT_METADATA_PATH = '/oauth/mcp-client.json';

/** Issuers are compared without a trailing slash: some servers publish one, some don't. */
export function normalizeIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

export function redirectUriFor(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${CALLBACK_PATH}`;
}

/** Our client metadata: what we register, and what the CIMD document serves. */
export function clientMetadataFor(origin: string, scope?: string): OAuthClientMetadata {
  const base = origin.replace(/\/+$/, '');
  return {
    client_name: 'Orqestra',
    client_uri: base,
    redirect_uris: [redirectUriFor(base)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    ...(scope ? { scope } : {}),
  };
}

/** The sealed credentials on a connection. */
export type ConnectionSecrets =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'oauth'; tokens: StoredOAuthTokens; savedAt: number };

export function sealSecrets(secrets: ConnectionSecrets): string {
  return sealJson(secrets, 'notetaker-credentials');
}

export function openSecrets(sealed: string | null | undefined): ConnectionSecrets | null {
  return openJson<ConnectionSecrets>(sealed, 'notetaker-credentials');
}

/** The connection can't sync until its owner connects again. Its message is for them. */
export class ReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconnectRequiredError';
  }
}

/** A disconnected connection stays disconnected, whatever a run in flight concludes. */
/**
 * A refresh that failed for a reason other than a refused grant (the token
 * endpoint down, a 5xx): the saved tokens may still be good, so the next run
 * tries again rather than asking the owner to sign in.
 */
export class RefreshFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshFailedError';
  }
}

export async function markNeedsReconnect(connectionId: string, reason: string) {
  await db.transcriptConnection.updateMany({
    where: { id: connectionId, status: { not: 'DISCONNECTED' } },
    data: { status: 'NEEDS_RECONNECT', lastError: reason },
  });
}

export type ProviderMode =
  | { kind: 'start' }
  | { kind: 'callback'; codeVerifier: string; discoveryState: OAuthDiscoveryState }
  | { kind: 'background' };

type ConnectionRef = { id: string; provider: string; credentials: string | null };

function toClientInformation(
  row: { clientId: string; clientSecret: string | null; metadata: Prisma.JsonValue },
  issuer: string,
): StoredOAuthClientInformation {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const secret = row.clientSecret ? openJson<string>(row.clientSecret, 'notetaker-credentials') : null;
  return {
    ...(meta as object),
    client_id: row.clientId,
    ...(secret ? { client_secret: secret } : {}),
    issuer,
  } as StoredOAuthClientInformation;
}

export class NotetakerOAuthProvider implements OAuthClientProvider {
  /** Where `start` would have sent the browser. */
  authorizationUrl: URL | null = null;
  private stateValue: string | null = null;
  private verifier: string | null = null;
  private discovery: OAuthDiscoveryState | undefined;
  private issuer: string | null = null;
  private secrets: ConnectionSecrets | null;
  private readonly providerName: string;

  constructor(
    private readonly connection: ConnectionRef,
    readonly redirectUri: string,
    private readonly mode: ProviderMode,
    private readonly opts: { scope?: string; fetchFn?: FetchLike } = {},
  ) {
    this.secrets = openSecrets(connection.credentials);
    if (mode.kind === 'callback') this.discovery = mode.discoveryState;
    this.providerName = notetakerProvider(connection.provider)?.name ?? connection.provider;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  /** CIMD needs a public https URL the authorization server can fetch. */
  get clientMetadataUrl(): string | undefined {
    const origin = new URL(this.redirectUri).origin;
    return origin.startsWith('https://') ? `${origin}${CLIENT_METADATA_PATH}` : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadataFor(new URL(this.redirectUri).origin, this.opts.scope);
  }

  state(): string {
    this.stateValue ??= randomBytes(32).toString('base64url');
    return this.stateValue;
  }

  /** What `start` has to keep for the callback. */
  pendingFlow(): { state: string; codeVerifier: string; discoveryState: OAuthDiscoveryState } | null {
    if (!this.stateValue || !this.verifier || !this.discovery) return null;
    return { state: this.stateValue, codeVerifier: this.verifier, discoveryState: this.discovery };
  }

  private clientKey(issuer: string) {
    return { issuer: normalizeIssuer(issuer), redirectUri: this.redirectUri };
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = ctx?.issuer ?? this.discovery?.authorizationServerMetadata?.issuer ?? this.discovery?.authorizationServerUrl;
    if (!issuer) return undefined;
    this.issuer = issuer;
    const row = await db.mcpOAuthClient.findUnique({ where: { issuer_redirectUri: this.clientKey(issuer) } });
    if (row) return toClientInformation(row, issuer);
    if (this.mode.kind === 'start') return this.register(issuer);
    if (this.mode.kind === 'background') await this.reconnect();
    return undefined;
  }

  /**
   * First registration for this issuer and redirect URI, under a lock: a
   * second sign-in racing this one waits, then reuses what this one saved.
   */
  private async register(issuer: string): Promise<StoredOAuthClientInformation> {
    const key = this.clientKey(issuer);
    const discovery = this.discovery;
    return db.$transaction(
      async (tx) => {
        await lockInTransaction(tx, 'registration', `${key.issuer} ${key.redirectUri}`);
        const existing = await tx.mcpOAuthClient.findUnique({ where: { issuer_redirectUri: key } });
        if (existing) return toClientInformation(existing, issuer);
        const metadata = discovery?.authorizationServerMetadata;
        let info: StoredOAuthClientInformation;
        if (metadata?.client_id_metadata_document_supported === true && this.clientMetadataUrl) {
          info = { client_id: this.clientMetadataUrl };
        } else {
          info = await registerClient(discovery?.authorizationServerUrl ?? issuer, {
            metadata,
            clientMetadata: resolveClientMetadata(this),
            scope: this.registrationScope(),
            fetchFn: this.opts.fetchFn,
          });
        }
        await this.storeClient(tx, key, info);
        return { ...info, issuer };
      },
      { timeout: 30_000, maxWait: 20_000 },
    );
  }

  /** The scope the SDK will ask for (its determineScope), so the registration allows it. */
  private registrationScope(): string | undefined {
    const resource = this.discovery?.resourceMetadata?.scopes_supported?.join(' ');
    let scope = resource || this.opts.scope;
    const as = this.discovery?.authorizationServerMetadata?.scopes_supported;
    if (scope && as?.includes('offline_access') && !scope.split(' ').includes('offline_access')) scope = `${scope} offline_access`;
    return scope;
  }

  private async storeClient(
    tx: Prisma.TransactionClient,
    key: { issuer: string; redirectUri: string },
    info: StoredOAuthClientInformation,
  ) {
    const { client_secret: secret, issuer: _issuer, ...rest } = info as StoredOAuthClientInformation & { client_secret?: string };
    const data = {
      clientId: info.client_id,
      clientSecret: secret ? sealJson(secret, 'notetaker-credentials') : null,
      metadata: rest as Prisma.InputJsonValue,
    };
    await tx.mcpOAuthClient.upsert({
      where: { issuer_redirectUri: key },
      create: { ...key, ...data },
      update: data,
    });
  }

  /** The SDK saves here when it registered or stamped a client itself. */
  async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext) {
    const issuer = ctx?.issuer ?? info.issuer ?? this.issuer;
    if (!issuer) return;
    await db.$transaction((tx) => this.storeClient(tx, this.clientKey(issuer), info));
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.secrets?.kind === 'oauth' ? this.secrets.tokens : undefined;
  }

  /** Saved the moment they arrive: a rotated refresh token must never be lost. */
  async saveTokens(tokens: StoredOAuthTokens) {
    if (this.mode.kind === 'start') return;
    this.secrets = { kind: 'oauth', tokens, savedAt: Date.now() };
    const credentials = sealSecrets(this.secrets);
    if (this.mode.kind === 'callback') {
      await db.transcriptConnection.update({
        where: { id: this.connection.id },
        data: { credentials, status: 'ACTIVE', authType: 'OAUTH', redirectUri: this.redirectUri, lastError: null },
      });
    } else {
      // A refresh racing a disconnect must not bring the credentials back.
      await db.transcriptConnection.updateMany({
        where: { id: this.connection.id, status: { in: ['ACTIVE', 'ERROR'] } },
        data: { credentials },
      });
    }
  }

  /** True when the saved access token has (nearly) expired. */
  accessTokenExpired(now = Date.now()): boolean {
    if (this.secrets?.kind !== 'oauth') return false;
    const ttl = this.secrets.tokens.expires_in;
    return typeof ttl === 'number' && this.secrets.savedAt + ttl * 1000 - 60_000 < now;
  }

  hasRefreshToken(): boolean {
    return this.secrets?.kind === 'oauth' && Boolean(this.secrets.tokens.refresh_token);
  }

  private async reconnect(): Promise<never> {
    const message = `${this.providerName} needs you to sign in again`;
    await markNeedsReconnect(this.connection.id, message);
    throw new ReconnectRequiredError(message);
  }

  async redirectToAuthorization(url: URL) {
    if (this.mode.kind === 'start') {
      this.authorizationUrl = url;
      return;
    }
    // The SDK falls back to a new sign-in when a refresh fails in any way.
    // A refused grant has already dropped the tokens (invalidateCredentials);
    // with a refresh token still here, the failure was the server's.
    if (this.mode.kind === 'background' && this.hasRefreshToken()) {
      throw new RefreshFailedError(`Couldn't refresh the ${this.providerName} sign-in. Orqestra will try again.`);
    }
    // Never silently: in the background nobody is there to sign in.
    await this.reconnect();
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (this.mode.kind === 'callback') return this.mode.codeVerifier;
    if (this.verifier) return this.verifier;
    throw new Error('No PKCE verifier for this sign-in');
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    // Only the cron drops saved tokens (a refused refresh): a sign-in that
    // fails to finish leaves the connection's current credentials alone.
    if ((scope === 'all' || scope === 'tokens') && this.mode.kind === 'background' && this.secrets?.kind === 'oauth') {
      this.secrets = null;
      await db.transcriptConnection.update({ where: { id: this.connection.id }, data: { credentials: null } });
    }
    if ((scope === 'all' || scope === 'client') && this.issuer) {
      // The authorization server no longer knows this client: nobody can use it.
      await db.mcpOAuthClient.deleteMany({ where: this.clientKey(this.issuer) });
    }
    if (scope === 'all' || scope === 'discovery') {
      if (this.mode.kind !== 'callback') this.discovery = undefined;
    }
  }
}
