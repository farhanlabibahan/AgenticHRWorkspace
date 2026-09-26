import { host } from './host';
import { extractText } from './index';
import { SELFTEST_FIXTURES } from './selftest-fixtures';
import type { TextFormat, TextStatus } from './types';

/**
 * Extracts one small built-in document per format and checks the text. It
 * proves the deployed environment works (worker bundled, pdf.js character
 * maps traced, native-free libraries loadable) without touching the database:
 * the backfill runs it before claiming files, so a broken deploy doesn't burn
 * retry attempts.
 */
export async function runSelfTest(): Promise<{
  ok: boolean;
  worker: 'thread' | 'in-process';
  results: { format: TextFormat; status: TextStatus; ms: number; match: boolean }[];
}> {
  const results = [];
  for (const fixture of SELFTEST_FIXTURES) {
    const r = await extractText({ data: Buffer.from(fixture.base64, 'base64'), source: 'selftest' });
    const match = r.format === fixture.format && (r.text?.includes(fixture.expect) ?? false);
    results.push({ format: fixture.format, status: r.status, ms: r.ms, match });
  }
  return { ok: results.every((r) => r.status === 'OK' && r.match), worker: host.mode(), results };
}
