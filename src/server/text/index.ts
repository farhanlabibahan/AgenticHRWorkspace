import { host, type JobResult } from './host';
import { sniffFormat } from './sniff';
import { EXTRACTOR_VERSION } from './status';
import type { TextFormat, TextStatus } from './types';

/**
 * Document text extraction: the one entry point for resumes from the careers
 * page, imports and the backfill. It sniffs the real format from the bytes
 * (never the declared MIME or the filename), runs the adapter in a worker
 * thread (host.ts), and reports a status instead of throwing, so a bad file
 * never blocks an application. Failures are logged, never swallowed.
 */

export { EXTRACTOR_VERSION };
/** Larger files are TOO_LARGE without being parsed. */
export const MAX_EXTRACT_BYTES = 10 * 1024 * 1024;

export const RESUME_UPLOAD_FORMATS: readonly TextFormat[] = ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt'];

export const FORMAT_MIME: Record<TextFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain',
  html: 'text/html',
};

export const FORMAT_EXT: Record<TextFormat, string> = {
  pdf: '.pdf',
  docx: '.docx',
  doc: '.doc',
  odt: '.odt',
  rtf: '.rtf',
  txt: '.txt',
  html: '.html',
};

export type ExtractResult = {
  status: TextStatus;
  /** Sniffed from the bytes. */
  format: TextFormat | null;
  /** Normalized text; non-null exactly when status is OK. */
  text: string | null;
  /** Link targets hidden behind link text: http(s) and mailto, at most 10. */
  links: string[];
  pages?: number;
  /** "<Name>: <message>", at most 300 characters, email addresses redacted. */
  error?: string;
  ms: number;
  version: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Error text is stored and logged, so it must not carry the applicant's address. */
function describeError(name: string, message: string): string {
  return `${name}: ${message}`.slice(0, 2000).replace(EMAIL, '[email]').replace(/\s+/g, ' ').slice(0, 300);
}

/** Adapter errors that are final for this file; anything else is FAILED and retried. */
function errorStatus(result: Extract<JobResult, { ok: false }>): TextStatus {
  if (result.kind !== 'error') return 'FAILED';
  if (result.name === 'EncryptedDocumentError') return 'ENCRYPTED';
  // A bomb that trips a safety limit will trip it again on retry.
  if (result.name === 'DocumentLimitError') return 'TOO_LARGE';
  return 'FAILED';
}

type Outcome = Pick<ExtractResult, 'status' | 'text' | 'links' | 'pages' | 'error'>;

export async function extractText(input: {
  data: Uint8Array;
  source: 'apply' | 'import' | 'backfill' | 'selftest';
  timeoutMs?: number;
  /** For logs only. */
  fileId?: string;
}): Promise<ExtractResult> {
  const { data, source, timeoutMs = DEFAULT_TIMEOUT_MS, fileId } = input;
  const started = performance.now();
  let format: TextFormat | null = null;
  let kind: Extract<JobResult, { ok: false }>['kind'] | undefined;
  const none = { text: null, links: [] };

  let outcome: Outcome;
  try {
    if (data.byteLength > MAX_EXTRACT_BYTES) {
      outcome = { status: 'TOO_LARGE', ...none };
    } else {
      const sniffed = sniffFormat(data);
      format = sniffed.format;
      if (!format) {
        const status = sniffed.reason === 'empty' ? 'EMPTY' : sniffed.reason === 'encrypted' ? 'ENCRYPTED' : 'UNSUPPORTED';
        outcome = { status, ...none };
      } else {
        const result = await host.run(format, data, timeoutMs);
        if (result.ok) {
          outcome = { status: result.text ? 'OK' : 'EMPTY', text: result.text, links: result.links, pages: result.pages };
        } else {
          kind = result.kind;
          outcome = { status: errorStatus(result), ...none, error: describeError(result.name, result.message) };
        }
      }
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    outcome = { status: 'FAILED', ...none, error: describeError(e.name, e.message) };
  }

  const result: ExtractResult = { ...outcome, format, ms: Math.round(performance.now() - started), version: EXTRACTOR_VERSION };
  if (result.status === 'FAILED') {
    // Never filenames or text: only what's needed to find the file and the cause.
    const line = JSON.stringify({ source, fileId, format, status: result.status, error: result.error, ms: result.ms, bytes: data.byteLength });
    if (kind === 'timeout' || kind === 'memory') console.warn(`[text-extract] ${kind}`, line);
    else console.error('[text-extract] failed', line);
  }
  return result;
}

/** The StoredFile columns for a first extraction attempt (apply and import). */
export function textFields(
  r: ExtractResult,
  at: Date,
): { textStatus: TextStatus; textVersion: number; textAttempts: number; textCheckedAt: Date; textError: string | null } {
  return {
    textStatus: r.status,
    textVersion: r.version,
    textAttempts: 1,
    textCheckedAt: at,
    textError: r.error ?? null,
  };
}

export { sniffFormat } from './sniff';
export { runSelfTest } from './selftest';
