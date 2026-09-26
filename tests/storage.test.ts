import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  deleteStoredFileBytes,
  fileStorageAvailable,
  openStoredFile,
  putFileBytes,
  readStoredFile,
  StoredFileMissingError,
} from '@/server/storage';

/**
 * The storage adapter against a tiny in-process S3-compatible server (the
 * shape Cloudflare R2, B2 and MinIO speak), plus the local-disk fallback.
 */

// Vercel Blob's head(), which each test below makes fail its own way.
vi.mock('@vercel/blob', async (importOriginal) => ({ ...(await importOriginal<typeof import('@vercel/blob')>()), head: vi.fn() }));

type Seen = { method: string; path: string; auth: string; type: string | undefined; sha: string | undefined };

const objects = new Map<string, { body: Buffer; type: string }>();
const seen: Seen[] = [];
let failPuts = false;
let server: Server;
let endpoint = '';
const saved = { ...process.env };

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    seen.push({
      method: req.method!,
      path,
      auth: String(req.headers.authorization ?? ''),
      type: req.headers['content-type'] as string | undefined,
      sha: req.headers['x-amz-content-sha256'] as string | undefined,
    });
    if (req.method === 'PUT') {
      if (failPuts) return res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
      objects.set(path, { body: await body(req), type: String(req.headers['content-type']) });
      return res.writeHead(200).end();
    }
    if (req.method === 'GET') {
      const obj = objects.get(path);
      if (!obj) return res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      return res.writeHead(200, { 'content-type': obj.type }).end(obj.body);
    }
    if (req.method === 'DELETE') {
      objects.delete(path);
      return res.writeHead(204).end();
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.env = saved;
  await new Promise<void>((r) => server.close(() => r()));
});

function useBucket() {
  Object.assign(process.env, {
    S3_ENDPOINT: `${endpoint}/`,
    S3_BUCKET: 'source-files',
    S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'super-secret-value',
  });
  delete process.env.S3_REGION;
  delete process.env.BLOB_READ_WRITE_TOKEN;
}

function noBucket() {
  for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'BLOB_READ_WRITE_TOKEN']) delete process.env[k];
}

describe('file storage: S3-compatible bucket (R2, B2, MinIO)', () => {
  it('uploads with a SigV4 signature for region "auto", path-style, keeping the content type', async () => {
    useBucket();
    const data = Buffer.from('%PDF-1.4 resume');
    await putFileBytes('org-1/abc-Jane Doe résumé.pdf', data, 'application/pdf');

    const put = seen.at(-1)!;
    expect(put.method).toBe('PUT');
    expect(put.path).toBe('/source-files/org-1/abc-Jane Doe résumé.pdf');
    expect(put.type).toBe('application/pdf');
    expect(put.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[\w;-]+, Signature=[0-9a-f]{64}$/);
    // aws4fetch signs S3 bodies as UNSIGNED-PAYLOAD (R2, B2 and S3 accept it over https) and sends
    // none of the x-amz-checksum-* headers the AWS SDK adds, which B2 rejects.
    expect(put.sha).toMatch(/^(UNSIGNED-PAYLOAD|[0-9a-f]{64})$/);
    expect(objects.get(put.path)!.body.equals(data)).toBe(true);
  });

  it('reads a file back as a stream or a buffer', async () => {
    useBucket();
    await putFileBytes('org-1/cv.docx', Buffer.from('docx bytes'), 'application/octet-stream');
    const stream = await openStoredFile('org-1/cv.docx');
    expect(Buffer.from(await new Response(stream).arrayBuffer()).toString()).toBe('docx bytes');
    expect((await readStoredFile('org-1/cv.docx')).toString()).toBe('docx bytes');
  });

  it('reports a missing file distinctly, and deleting twice is fine', async () => {
    useBucket();
    await putFileBytes('org-1/gone.pdf', Buffer.from('x'), 'application/pdf');
    await deleteStoredFileBytes('org-1/gone.pdf');
    await expect(openStoredFile('org-1/gone.pdf')).rejects.toBeInstanceOf(StoredFileMissingError);
    await expect(deleteStoredFileBytes('org-1/gone.pdf')).resolves.toBeUndefined();
  });

  it('fails an upload the bucket refuses, without leaking the secret', async () => {
    useBucket();
    failPuts = true;
    const err = (await putFileBytes('org-1/x.pdf', Buffer.from('x'), 'application/pdf').catch((e: unknown) => e)) as Error;
    failPuts = false;
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).not.toContain('super-secret-value');
  });

  it('counts as durable storage on Vercel, where local disk does not', () => {
    process.env.VERCEL = '1';
    noBucket();
    expect(fileStorageAvailable()).toBe(false);
    useBucket();
    expect(fileStorageAvailable()).toBe(true);
    delete process.env.VERCEL;
  });
});

describe('file storage: local disk (dev, Docker)', () => {
  it('round-trips and deletes a file', async () => {
    noBucket();
    delete process.env.VERCEL;
    const key = `test-org/${crypto.randomUUID()}-cv.txt`;
    await putFileBytes(key, Buffer.from('local bytes'), 'text/plain');
    expect((await readStoredFile(key)).toString()).toBe('local bytes');
    await deleteStoredFileBytes(key);
    await expect(openStoredFile(key)).rejects.toBeInstanceOf(StoredFileMissingError);
    await expect(deleteStoredFileBytes(key)).resolves.toBeUndefined();
  });
});

describe('file storage: Vercel Blob', () => {
  it('reports a file missing only when Blob says it is not found', async () => {
    noBucket();
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_synthetic';
    const blob = await import('@vercel/blob');
    vi.mocked(blob.head).mockRejectedValueOnce(new blob.BlobNotFoundError());
    await expect(openStoredFile('org-1/gone.pdf')).rejects.toBeInstanceOf(StoredFileMissingError);
    // A rate limit is not a missing file: the backfill retries it instead of giving up for good.
    vi.mocked(blob.head).mockRejectedValueOnce(new blob.BlobServiceRateLimited());
    await expect(openStoredFile('org-1/busy.pdf')).rejects.toBeInstanceOf(blob.BlobServiceRateLimited);
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });
});
