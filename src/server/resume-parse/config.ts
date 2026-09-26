/**
 * Resume parsing configuration, read from the environment at call time (so
 * tests can pass their own). Parsing is off until a key or an endpoint is
 * set; see docs/resume-parsing.md.
 *
 *   1. RESUME_PARSER=off turns it off, whatever else is set.
 *   2. RESUME_PARSER_BASE_URL: any OpenAI-compatible endpoint. The key is
 *      RESUME_PARSER_API_KEY (or GROQ_API_KEY for api.groq.com). Known hosted
 *      providers need a key; a server of your own (Ollama) may not.
 *   3. Otherwise RESUME_PARSER_API_KEY or GROQ_API_KEY: Groq.
 *   4. Otherwise off.
 *
 * The key never leaves this module except as the Authorization header built
 * in client.ts: it is a non-enumerable property of the config, so logging or
 * serializing a config never shows it, and describeResumeParser() omits it.
 */

type Env = Record<string, string | undefined>;

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_MODEL = 'openai/gpt-oss-20b';

/** Request shape differences by host. `generic` covers Ollama, vLLM, LM Studio and the rest. */
export type ParserProfile = 'groq' | 'deepinfra' | 'openrouter' | 'generic';
export type MisconfiguredReason = 'bad_base_url' | 'key_required' | 'model_required';

export type ResumeParserConfig = {
  state: 'on';
  /** No trailing slash; requests go to `${baseUrl}/chat/completions`. */
  baseUrl: string;
  /** hostname[:port], for Settings and logs. */
  host: string;
  profile: ParserProfile;
  model: string;
  /** "Groq", "DeepInfra", "OpenRouter", "Your own server", or the hostname. */
  providerLabel: string;
  /** False for loopback, private-network and single-label hosts. */
  thirdParty: boolean;
  /** Resumes per organization per UTC day; 0 pauses parsing. */
  dailyLimit: number;
  /** Resumes per UTC day across every organization; null = no limit. */
  globalDailyLimit: number | null;
  /** Per HTTP attempt. */
  timeoutMs: number;
  /** Resume text sent, in UTF-8 bytes (characters, for plain English). */
  maxChars: number;
  /** Organization ids or slugs never parsed (RESUME_PARSER_EXCLUDE_ORGS). */
  excludedOrgs: string[];
  readonly apiKey: string | null;
};

export type ResumeParserState =
  | ResumeParserConfig
  | { state: 'off' }
  | { state: 'misconfigured'; reason: MisconfiguredReason; host: string | null; providerLabel: string | null };

export type ResumeParserDescription = {
  state: 'on' | 'off' | 'misconfigured';
  providerLabel: string | null;
  model: string | null;
  host: string | null;
  thirdParty: boolean;
  reason: MisconfiguredReason | null;
  dailyLimit: number;
  globalDailyLimit: number | null;
};

const LIMITS = {
  dailyLimit: { def: 500, min: 0, max: 1_000_000 },
  globalDailyLimit: { min: 0, max: 10_000_000 },
  // A run has 240 s; one attempt has to fit in it with room to write.
  timeoutMs: { def: 20_000, min: 1_000, max: 200_000 },
  maxChars: { def: 12_000, min: 2_000, max: 100_000 },
} as const;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function profileFor(hostname: string): ParserProfile {
  if (hostname === 'api.groq.com') return 'groq';
  if (hostname === 'api.deepinfra.com') return 'deepinfra';
  if (hostname === 'openrouter.ai') return 'openrouter';
  return 'generic';
}

const PROFILE_LABEL: Record<Exclude<ParserProfile, 'generic'>, string> = {
  groq: 'Groq',
  deepinfra: 'DeepInfra',
  openrouter: 'OpenRouter',
};

/**
 * A host on this machine or this network: loopback, RFC 1918 and link-local
 * addresses, IPv6 unique-local, *.local / *.internal names (host.docker.internal),
 * and single-label names (a Compose service such as "ollama").
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(':')) {
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return !host.includes('.');
}

function withKey<T extends object>(config: T, apiKey: string | null): T & { readonly apiKey: string | null } {
  return Object.defineProperty(config, 'apiKey', { value: apiKey, enumerable: false, writable: false }) as T & {
    readonly apiKey: string | null;
  };
}

/** RESUME_PARSER_EXCLUDE_ORGS: organization ids or slugs, separated by commas or spaces. */
function excludedOrgs(env: Env): string[] {
  return [...new Set((read(env, 'RESUME_PARSER_EXCLUDE_ORGS') ?? '').split(/[\s,]+/).filter(Boolean))].slice(0, 1_000);
}

/**
 * Whether an organization is left out of parsing on this server, by id or
 * slug: for a customer who objects to the provider (a new subprocessor)
 * while everyone else keeps it.
 */
export function orgExcluded(org: { id: string; slug?: string | null }, env: Env = process.env): boolean {
  const excluded = excludedOrgs(env);
  return excluded.includes(org.id) || (!!org.slug && excluded.includes(org.slug));
}

function tuning(env: Env) {
  const globalRaw = read(env, 'RESUME_PARSER_GLOBAL_DAILY_LIMIT');
  return {
    excludedOrgs: excludedOrgs(env),
    dailyLimit: clampInt(read(env, 'RESUME_PARSER_DAILY_LIMIT'), LIMITS.dailyLimit.def, LIMITS.dailyLimit.min, LIMITS.dailyLimit.max),
    globalDailyLimit:
      globalRaw === undefined || !Number.isFinite(Number.parseInt(globalRaw, 10))
        ? null
        : clampInt(globalRaw, 0, LIMITS.globalDailyLimit.min, LIMITS.globalDailyLimit.max),
    timeoutMs: clampInt(read(env, 'RESUME_PARSER_TIMEOUT_MS'), LIMITS.timeoutMs.def, LIMITS.timeoutMs.min, LIMITS.timeoutMs.max),
    maxChars: clampInt(read(env, 'RESUME_PARSER_MAX_CHARS'), LIMITS.maxChars.def, LIMITS.maxChars.min, LIMITS.maxChars.max),
  };
}

/** Parse an admin-set base URL: http(s), no credentials, no query or fragment. */
function parseBaseUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
  return url;
}

export function resumeParserConfig(env: Env = process.env): ResumeParserState {
  const switch_ = read(env, 'RESUME_PARSER')?.toLowerCase();
  if (switch_ === 'off' || switch_ === '0' || switch_ === 'false') return { state: 'off' };

  const explicitKey = read(env, 'RESUME_PARSER_API_KEY') ?? null;
  const groqKey = read(env, 'GROQ_API_KEY') ?? null;
  const model = read(env, 'RESUME_PARSER_MODEL');
  const rawBase = read(env, 'RESUME_PARSER_BASE_URL');

  if (rawBase) {
    const url = parseBaseUrl(rawBase);
    if (!url) return { state: 'misconfigured', reason: 'bad_base_url', host: null, providerLabel: null };
    const hostname = url.hostname.toLowerCase();
    const host = url.host.toLowerCase();
    const profile = profileFor(hostname);
    const local = isPrivateHost(hostname);
    const providerLabel = profile !== 'generic' ? PROFILE_LABEL[profile] : local ? 'Your own server' : hostname;
    const apiKey = explicitKey ?? (profile === 'groq' ? groqKey : null);
    if (profile !== 'generic' && !apiKey) return { state: 'misconfigured', reason: 'key_required', host, providerLabel };
    const chosenModel = model ?? (profile !== 'generic' ? DEFAULT_MODEL : undefined);
    if (!chosenModel) return { state: 'misconfigured', reason: 'model_required', host, providerLabel };
    return withKey(
      {
        state: 'on' as const,
        baseUrl: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`,
        host,
        profile,
        model: chosenModel,
        providerLabel,
        thirdParty: !local,
        ...tuning(env),
      },
      apiKey,
    );
  }

  const apiKey = explicitKey ?? groqKey;
  if (!apiKey) return { state: 'off' };
  return withKey(
    {
      state: 'on' as const,
      baseUrl: GROQ_BASE_URL,
      host: 'api.groq.com',
      profile: 'groq' as const,
      model: model ?? DEFAULT_MODEL,
      providerLabel: 'Groq',
      thirdParty: true,
      ...tuning(env),
    },
    apiKey,
  );
}

/** Whether new applications should be queued for parsing. Never throws. */
export function resumeParsingOn(env: Env = process.env): boolean {
  try {
    return resumeParserConfig(env).state === 'on';
  } catch {
    return false;
  }
}

/** What Settings shows. Never includes the key. */
export function describeResumeParser(env: Env = process.env): ResumeParserDescription {
  const cfg = resumeParserConfig(env);
  const { dailyLimit, globalDailyLimit } = tuning(env);
  if (cfg.state === 'on') {
    return {
      state: 'on',
      providerLabel: cfg.providerLabel,
      model: cfg.model,
      host: cfg.host,
      thirdParty: cfg.thirdParty,
      reason: null,
      dailyLimit,
      globalDailyLimit,
    };
  }
  if (cfg.state === 'misconfigured') {
    return {
      state: 'misconfigured',
      providerLabel: cfg.providerLabel,
      model: null,
      host: cfg.host,
      thirdParty: false,
      reason: cfg.reason,
      dailyLimit,
      globalDailyLimit,
    };
  }
  return { state: 'off', providerLabel: null, model: null, host: null, thirdParty: false, reason: null, dailyLimit, globalDailyLimit };
}
