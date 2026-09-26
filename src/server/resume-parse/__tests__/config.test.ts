import { describe, expect, it } from 'vitest';
import { describeResumeParser, isPrivateHost, resumeParserConfig, resumeParsingOn } from '../config';

const KEY = 'gsk_test_0123456789abcdefghijklmnopqrstuvwxyz';

describe('resume parser configuration', () => {
  it('is off with nothing set', () => {
    expect(resumeParserConfig({})).toEqual({ state: 'off' });
    expect(resumeParsingOn({})).toBe(false);
    expect(describeResumeParser({})).toMatchObject({ state: 'off', providerLabel: null, model: null });
  });

  it('uses Groq and gpt-oss-20b when only GROQ_API_KEY is set', () => {
    const cfg = resumeParserConfig({ GROQ_API_KEY: KEY });
    expect(cfg).toMatchObject({
      state: 'on',
      baseUrl: 'https://api.groq.com/openai/v1',
      host: 'api.groq.com',
      profile: 'groq',
      model: 'openai/gpt-oss-20b',
      providerLabel: 'Groq',
      thirdParty: true,
      dailyLimit: 500,
      globalDailyLimit: null,
      timeoutMs: 20_000,
      maxChars: 12_000,
    });
    expect(cfg.state === 'on' && cfg.apiKey).toBe(KEY);
  });

  it('switches to gpt-oss-120b with one setting', () => {
    expect(resumeParserConfig({ GROQ_API_KEY: KEY, RESUME_PARSER_MODEL: 'openai/gpt-oss-120b' })).toMatchObject({ model: 'openai/gpt-oss-120b' });
  });

  it('prefers RESUME_PARSER_API_KEY over GROQ_API_KEY', () => {
    const cfg = resumeParserConfig({ GROQ_API_KEY: 'groq-key', RESUME_PARSER_API_KEY: 'parser-key' });
    expect(cfg.state === 'on' && cfg.apiKey).toBe('parser-key');
  });

  it('is off when RESUME_PARSER=off, whatever keys are set', () => {
    for (const value of ['off', 'OFF', '0', 'false']) {
      expect(resumeParserConfig({ RESUME_PARSER: value, GROQ_API_KEY: KEY, RESUME_PARSER_API_KEY: KEY, RESUME_PARSER_BASE_URL: 'http://127.0.0.1:11434/v1', RESUME_PARSER_MODEL: 'x' })).toEqual({ state: 'off' });
    }
  });

  it('falls back to GROQ_API_KEY for a base URL on api.groq.com', () => {
    const cfg = resumeParserConfig({ RESUME_PARSER_BASE_URL: 'https://api.groq.com/openai/v1/', GROQ_API_KEY: KEY });
    expect(cfg).toMatchObject({ state: 'on', profile: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b' });
  });

  it('needs a model for a server of your own, and treats it as not third-party', () => {
    expect(resumeParserConfig({ RESUME_PARSER_BASE_URL: 'http://127.0.0.1:11434/v1' })).toMatchObject({
      state: 'misconfigured',
      reason: 'model_required',
    });
    const cfg = resumeParserConfig({ RESUME_PARSER_BASE_URL: 'http://127.0.0.1:11434/v1', RESUME_PARSER_MODEL: 'gpt-oss:20b' });
    expect(cfg).toMatchObject({ state: 'on', profile: 'generic', thirdParty: false, providerLabel: 'Your own server', host: '127.0.0.1:11434', model: 'gpt-oss:20b' });
    expect(cfg.state === 'on' && cfg.apiKey).toBeNull();
  });

  it('needs a key for a known hosted provider', () => {
    expect(resumeParserConfig({ RESUME_PARSER_BASE_URL: 'https://api.deepinfra.com/v1/openai' })).toMatchObject({
      state: 'misconfigured',
      reason: 'key_required',
      host: 'api.deepinfra.com',
      providerLabel: 'DeepInfra',
    });
    // GROQ_API_KEY is Groq's, never sent to another host.
    expect(resumeParserConfig({ RESUME_PARSER_BASE_URL: 'https://openrouter.ai/api/v1', GROQ_API_KEY: KEY })).toMatchObject({
      state: 'misconfigured',
      reason: 'key_required',
    });
    expect(resumeParserConfig({ RESUME_PARSER_BASE_URL: 'https://openrouter.ai/api/v1', RESUME_PARSER_API_KEY: KEY })).toMatchObject({
      state: 'on',
      profile: 'openrouter',
      model: 'openai/gpt-oss-20b',
    });
  });

  it('shows another hosted endpoint by its hostname, as a third party', () => {
    expect(resumeParserConfig({ RESUME_PARSER_BASE_URL: 'https://llm.example.com/v1', RESUME_PARSER_MODEL: 'm' })).toMatchObject({
      state: 'on',
      profile: 'generic',
      providerLabel: 'llm.example.com',
      thirdParty: true,
    });
  });

  it.each(['ftp://example.com/v1', 'http://user:pass@example.com/v1', 'https://example.com/v1?key=abc', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd'])(
    'rejects %s as a base URL',
    (url) => {
      expect(resumeParserConfig({ RESUME_PARSER_BASE_URL: url, RESUME_PARSER_MODEL: 'm', RESUME_PARSER_API_KEY: KEY })).toMatchObject({
        state: 'misconfigured',
        reason: 'bad_base_url',
      });
    },
  );

  it('clamps the tuning values', () => {
    const on = (extra: Record<string, string>) => resumeParserConfig({ GROQ_API_KEY: KEY, ...extra });
    expect(on({ RESUME_PARSER_DAILY_LIMIT: '0' })).toMatchObject({ dailyLimit: 0 });
    expect(on({ RESUME_PARSER_DAILY_LIMIT: '-5' })).toMatchObject({ dailyLimit: 0 });
    expect(on({ RESUME_PARSER_DAILY_LIMIT: 'lots' })).toMatchObject({ dailyLimit: 500 });
    expect(on({ RESUME_PARSER_TIMEOUT_MS: '5' })).toMatchObject({ timeoutMs: 1_000 });
    expect(on({ RESUME_PARSER_TIMEOUT_MS: '99999999' })).toMatchObject({ timeoutMs: 200_000 });
    expect(on({ RESUME_PARSER_MAX_CHARS: '10' })).toMatchObject({ maxChars: 2_000 });
    expect(on({ RESUME_PARSER_MAX_CHARS: '1000000' })).toMatchObject({ maxChars: 100_000 });
    expect(on({ RESUME_PARSER_GLOBAL_DAILY_LIMIT: '3' })).toMatchObject({ globalDailyLimit: 3 });
    expect(on({ RESUME_PARSER_GLOBAL_DAILY_LIMIT: '' })).toMatchObject({ globalDailyLimit: null });
  });

  it('never shows the key: not in the description, not when the config is serialized', () => {
    for (const env of [
      { GROQ_API_KEY: KEY },
      { RESUME_PARSER_API_KEY: KEY, RESUME_PARSER_BASE_URL: 'https://api.deepinfra.com/v1/openai' },
      { RESUME_PARSER_API_KEY: KEY, RESUME_PARSER_BASE_URL: 'ftp://nope' },
    ]) {
      expect(JSON.stringify(describeResumeParser(env))).not.toContain(KEY);
      expect(JSON.stringify(resumeParserConfig(env))).not.toContain(KEY);
      expect(String(Object.keys(resumeParserConfig(env)))).not.toContain('apiKey');
    }
  });

  it('knows which hosts are on your own network', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '[::1]', 'host.docker.internal', 'ollama', 'gpu-box.local', 'fd12:3456::1']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ['api.groq.com', '8.8.8.8', '172.32.0.1', 'example.com', '']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});
