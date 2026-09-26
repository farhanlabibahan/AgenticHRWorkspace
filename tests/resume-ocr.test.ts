import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { OcrStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { createOrg } from './fixtures';
import { db } from '@/lib/db';
import type { OcrEngine, OcrResult } from '@/server/ocr';
import { MAX_OCR_ATTEMPTS, OCR_VERSION } from '@/server/ocr/status';
import { processResumeOcr } from '@/server/resume-ocr';
import { processResumeText } from '@/server/resume-text';
import { storeFile } from '@/server/storage';
import { EXTRACTOR_VERSION } from '@/server/text';

/**
 * The OCR cron against the database, with OCR itself stubbed (and once for
 * real): which files it claims, when it retries, and what it refuses to
 * write.
 */

const MIN = 60_000;
const engine: OcrEngine = { langs: 'eng', recognize: async () => ({ text: '', confidence: 0 }), close: async () => {} };
const okSelfTest = async () => ({ ok: true });

/** A stand-in for ocrDocument that records which files it read. The text names the file. */
function fakeOcr(status: OcrStatus = 'OK', opts: { onCall?: (fileId: string) => Promise<void>; delayMs?: number } = {}) {
  const calls: string[] = [];
  const ocr = async (_data: Uint8Array, { fileId }: { fileId: string }): Promise<Omit<OcrResult, 'ms'>> => {
    calls.push(fileId);
    await opts.onCall?.(fileId);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return {
      status,
      text: status === 'OK' ? `Scanned résumé of ${fileId}` : null,
      confidence: status === 'OK' ? 92 : status === 'LOW_CONFIDENCE' ? 33 : null,
      pages: status === 'OK' || status === 'LOW_CONFIDENCE' ? 1 : 0,
      error: status === 'FAILED' ? 'OcrTimeoutError: No OCR result after 60000 ms' : status === 'LOW_CONFIDENCE' ? 'low_confidence' : undefined,
    };
  };
  return { ocr, calls };
}

/** A contact whose resume is a scan: stored, and text extraction found nothing in it. */
async function scanned(
  orgId: string,
  opts: { anonymized?: boolean; textStatus?: 'EMPTY' | 'UNSUPPORTED' | 'OK' | 'ENCRYPTED' | 'FAILED' | null; textVersion?: number; data?: Buffer; parse?: 'QUEUED' } = {},
) {
  const file = await storeFile({ orgId, filename: 'resume.pdf', mime: 'application/pdf', data: opts.data ?? Buffer.from('%PDF-1.4 synthetic scan') });
  await db.storedFile.update({
    where: { id: file.id },
    data: {
      textStatus: opts.textStatus === undefined ? 'EMPTY' : opts.textStatus,
      textVersion: opts.textVersion ?? EXTRACTOR_VERSION,
      textAttempts: 1,
      ...(opts.parse ? { parseStatus: opts.parse, parseQueuedAt: new Date() } : {}),
    },
  });
  const contact = await db.contact.create({
    data: { orgId, name: 'Rowan Q. Testperson', emails: [`rowan-${randomUUID().slice(0, 6)}@example.test`], resumeFileId: file.id, isAnonymized: opts.anonymized ?? false },
  });
  return { file, contact };
}

const fileState = (id: string) =>
  db.storedFile.findUniqueOrThrow({
    where: { id },
    select: { ocrStatus: true, ocrVersion: true, ocrAttempts: true, ocrConfidence: true, ocrError: true, parseStatus: true },
  });
const textOf = async (contactId: string) => (await db.contact.findUniqueOrThrow({ where: { id: contactId } })).resumeText;

describe.skipIf(!hasDb)('resume OCR cron', () => {
  const env = { ...process.env };
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {}); // per-file and per-run lines
  });
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it('reads a scan and gives its contact the text', async () => {
    const { org } = await createOrg();
    const { file, contact } = await scanned(org.id);
    const selfTest = vi.fn(okSelfTest);
    const { ocr, calls } = fakeOcr();

    const run = await processResumeOcr({ orgId: org.id, engine, ocr, selfTest });

    expect(run).toMatchObject({ selfTest: 'ok', claimed: 1, written: 1, pages: 1, lost: 0, more: false, byStatus: { OK: 1 } });
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([file.id]);
    expect(await textOf(contact.id)).toBe(`Scanned résumé of ${file.id}`);
    expect(await fileState(file.id)).toEqual({ ocrStatus: 'OK', ocrVersion: OCR_VERSION, ocrAttempts: 1, ocrConfidence: 92, ocrError: null, parseStatus: null });

    // Nothing left: no self-test, no claims.
    expect(await processResumeOcr({ orgId: org.id, engine, ocr, selfTest })).toMatchObject({ selfTest: 'skipped', claimed: 0 });
    expect(selfTest).toHaveBeenCalledTimes(1);
  });

  it('reads a stored scan with real OCR, end to end', async () => {
    const { org } = await createOrg();
    const data = readFileSync(path.join(__dirname, '../src/server/ocr/__tests__/fixtures/scan-letter.pdf'));
    const { file, contact } = await scanned(org.id, { data });

    const run = await processResumeOcr({ orgId: org.id });
    expect(run).toMatchObject({ selfTest: 'ok', claimed: 1, written: 1, byStatus: { OK: 1 } });
    expect(await textOf(contact.id)).toContain('rowan.testperson@example.com');
    expect((await fileState(file.id)).ocrConfidence).toBeGreaterThanOrEqual(80);
  });

  it('only takes scans: settled text extraction with EMPTY or UNSUPPORTED, and no text on the contact', async () => {
    const { org } = await createOrg();
    const empty = await scanned(org.id);
    const image = await scanned(org.id, { textStatus: 'UNSUPPORTED' });
    const withText = await scanned(org.id, { textStatus: 'OK' });
    await db.contact.update({ where: { id: withText.contact.id }, data: { resumeText: 'Typed resume text' } });
    const encrypted = await scanned(org.id, { textStatus: 'ENCRYPTED' });
    const textFailing = await scanned(org.id, { textStatus: 'FAILED' });
    const notRead = await scanned(org.id, { textStatus: null, textVersion: EXTRACTOR_VERSION - 1 });
    const erased = await scanned(org.id, { anonymized: true });
    const { ocr, calls } = fakeOcr();

    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest });

    expect(calls.sort()).toEqual([empty.file.id, image.file.id].sort());
    for (const f of [withText, encrypted, textFailing, notRead, erased]) expect((await fileState(f.file.id)).ocrVersion).toBeNull();
    expect(await textOf(withText.contact.id)).toBe('Typed resume text');
  });

  it('keeps LOW_CONFIDENCE and SKIPPED final until the OCR version changes', async () => {
    const { org } = await createOrg();
    const { file, contact } = await scanned(org.id);
    const low = fakeOcr('LOW_CONFIDENCE');

    await processResumeOcr({ orgId: org.id, engine, ocr: low.ocr, selfTest: okSelfTest });
    await processResumeOcr({ orgId: org.id, engine, ocr: low.ocr, selfTest: okSelfTest, now: () => new Date(Date.now() + 60 * MIN) });
    expect(low.calls).toEqual([file.id]);
    expect(await fileState(file.id)).toMatchObject({ ocrStatus: 'LOW_CONFIDENCE', ocrConfidence: 33, ocrError: 'low_confidence', ocrAttempts: 1 });
    expect(await textOf(contact.id)).toBeNull();

    const upgraded = fakeOcr();
    const run = await processResumeOcr({ orgId: org.id, version: OCR_VERSION + 1, engine, ocr: upgraded.ocr, selfTest: okSelfTest });
    expect(run.written).toBe(1);
    expect(await fileState(file.id)).toMatchObject({ ocrStatus: 'OK', ocrVersion: OCR_VERSION + 1, ocrAttempts: 1 });
  });

  it('retries a FAILED scan after 15 minutes, at most 3 times', async () => {
    const { org } = await createOrg();
    const { file } = await scanned(org.id);
    const { ocr, calls } = fakeOcr('FAILED');
    const t0 = Date.now();
    const at = (minutes: number) => () => new Date(t0 + minutes * MIN);

    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest, now: at(0) });
    expect(await fileState(file.id)).toMatchObject({ ocrStatus: 'FAILED', ocrAttempts: 1, ocrError: 'OcrTimeoutError: No OCR result after 60000 ms' });

    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest, now: at(10) });
    expect(calls).toHaveLength(1);

    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest, now: at(16) });
    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest, now: at(32) });
    expect(await fileState(file.id)).toMatchObject({ ocrStatus: 'FAILED', ocrAttempts: MAX_OCR_ATTEMPTS });

    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest, now: at(120) });
    expect(calls).toHaveLength(MAX_OCR_ATTEMPTS);
  });

  it('retries a claim that never finished (a crash mid-file) like a failure', async () => {
    const { org } = await createOrg();
    const { file } = await scanned(org.id);
    const t0 = Date.now();
    await db.storedFile.update({ where: { id: file.id }, data: { ocrVersion: OCR_VERSION, ocrAttempts: 1, ocrStatus: null, ocrCheckedAt: new Date(t0) } });
    const { ocr, calls } = fakeOcr();

    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest, now: () => new Date(t0 + 5 * MIN) });
    expect(calls).toHaveLength(0);
    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest, now: () => new Date(t0 + 16 * MIN) });
    expect(await fileState(file.id)).toMatchObject({ ocrStatus: 'OK', ocrAttempts: 2 });
  });

  it('never overwrites text: a contact that got text, or a file that stopped being the resume, is SKIPPED', async () => {
    const { org } = await createOrg();
    const typed = await scanned(org.id);
    const swapped = await scanned(org.id);
    const erased = await scanned(org.id);
    const replacement = await storeFile({ orgId: org.id, filename: 'new.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 new') });
    const { ocr } = fakeOcr('OK', {
      onCall: async (fileId) => {
        if (fileId === typed.file.id) await db.contact.update({ where: { id: typed.contact.id }, data: { resumeText: 'Text from somewhere else' } });
        if (fileId === swapped.file.id) await db.contact.update({ where: { id: swapped.contact.id }, data: { resumeFileId: replacement.id } });
        if (fileId === erased.file.id) await db.contact.update({ where: { id: erased.contact.id }, data: { isAnonymized: true } });
      },
    });

    const run = await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest });

    expect(run).toMatchObject({ claimed: 3, written: 0, byStatus: { SKIPPED: 3 } });
    expect(await textOf(typed.contact.id)).toBe('Text from somewhere else');
    expect(await textOf(swapped.contact.id)).toBeNull();
    expect(await textOf(erased.contact.id)).toBeNull();
    // OK would say the contact's text came from this scan.
    for (const f of [typed, swapped, erased]) expect(await fileState(f.file.id)).toMatchObject({ ocrStatus: 'SKIPPED', ocrError: 'has_text' });
  });

  it('writes nothing when another run re-claimed the file meanwhile', async () => {
    const { org } = await createOrg();
    const { file, contact } = await scanned(org.id);
    const { ocr } = fakeOcr('OK', {
      onCall: async (fileId) => {
        await db.storedFile.update({ where: { id: fileId }, data: { ocrCheckedAt: new Date(Date.now() + 1_000) } });
      },
    });
    const run = await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest });
    expect(run).toMatchObject({ claimed: 1, lost: 1, written: 0, byStatus: {} });
    expect(await textOf(contact.id)).toBeNull();
    expect((await fileState(file.id)).ocrStatus).toBeNull();
  });

  it('runs one at a time: a run that starts while another is going does nothing', async () => {
    const { org } = await createOrg();
    const files = [];
    for (let i = 0; i < 4; i++) files.push((await scanned(org.id)).file.id);
    const { ocr, calls } = fakeOcr('OK', { delayMs: 20 });

    const runs = await Promise.all([
      processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest }),
      processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest }),
    ]);

    expect(calls.sort()).toEqual(files.sort());
    expect(runs.map((r) => r.busy ?? false).sort()).toEqual([false, true]);
    expect(runs[0].written + runs[1].written).toBe(4);
  });

  it('stops when the budget runs out and asks to be run again', async () => {
    const { org } = await createOrg();
    for (let i = 0; i < 3; i++) await scanned(org.id);
    const { ocr } = fakeOcr('OK', { delayMs: 600 });

    const first = await processResumeOcr({ orgId: org.id, budgetMs: 1_000, engine, ocr, selfTest: okSelfTest });
    expect(first.more).toBe(true);
    expect(first.claimed).toBeGreaterThan(0);
    expect(first.claimed).toBeLessThan(3);
    const rest = await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest });
    expect(rest).toMatchObject({ more: false, claimed: 3 - first.claimed });
  });

  it('claims nothing when the self-test fails', async () => {
    const { org } = await createOrg();
    const { file } = await scanned(org.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ocr, calls } = fakeOcr();
    const broken = async () => ({ ok: false, status: 'FAILED', error: 'Error: OCR is not installed completely: tesseract-core-relaxedsimd.wasm is missing' });

    const run = await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: broken });
    expect(run).toMatchObject({ selfTest: 'failed', claimed: 0 });
    expect(run.error).toContain('relaxedsimd.wasm is missing');
    expect(calls).toEqual([]);
    expect((await fileState(file.id)).ocrVersion).toBeNull();
  });

  it('marks missing and oversized files SKIPPED without reading them', async () => {
    const { org } = await createOrg();
    const gone = await db.storedFile.create({
      data: { orgId: org.id, key: `${org.id}/gone-${randomUUID()}.pdf`, filename: 'resume.pdf', mime: 'application/pdf', size: 2_000, textStatus: 'EMPTY', textVersion: EXTRACTOR_VERSION },
    });
    const big = await db.storedFile.create({
      data: { orgId: org.id, key: `${org.id}/big-${randomUUID()}.pdf`, filename: 'resume.pdf', mime: 'application/pdf', size: 10 * 1024 * 1024 + 1, textStatus: 'EMPTY', textVersion: EXTRACTOR_VERSION },
    });
    for (const f of [gone, big]) await db.contact.create({ data: { orgId: org.id, name: 'Rowan Q. Testperson', resumeFileId: f.id } });
    const { ocr, calls } = fakeOcr();

    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest });
    expect(calls).toEqual([]);
    expect(await fileState(gone.id)).toMatchObject({ ocrStatus: 'SKIPPED', ocrError: 'missing' });
    expect(await fileState(big.id)).toMatchObject({ ocrStatus: 'SKIPPED', ocrError: 'too_large' });
  });

  it("queues a careers application's parse again when it gave up waiting for text", async () => {
    const { org } = await createOrg();
    const gaveUp = await scanned(org.id, { parse: 'QUEUED' });
    await db.storedFile.update({ where: { id: gaveUp.file.id }, data: { parseStatus: 'SKIPPED', parseError: 'no_text', parseAttempts: 0 } });
    const imported = await scanned(org.id);
    const { ocr } = fakeOcr();

    await processResumeOcr({ orgId: org.id, engine, ocr, selfTest: okSelfTest });

    expect(await db.storedFile.findUniqueOrThrow({ where: { id: gaveUp.file.id } })).toMatchObject({ parseStatus: 'QUEUED', parseError: null, parseAttempts: 0 });
    // An import was never queued for parsing, and text arriving doesn't queue it.
    expect((await fileState(imported.file.id)).parseStatus).toBeNull();
  });

  it("leaves the resume-text backfill's files alone, and the backfill leaves OCR's", async () => {
    const { org } = await createOrg();
    const { file } = await scanned(org.id);
    const extract = vi.fn();
    const run = await processResumeText({ orgId: org.id, extract, selfTest: async () => ({ ok: true, worker: 'in-process' as const, results: [] }) });
    expect(run.claimed).toBe(0);
    expect(extract).not.toHaveBeenCalled();
    expect((await fileState(file.id)).ocrVersion).toBeNull();
  });
});
