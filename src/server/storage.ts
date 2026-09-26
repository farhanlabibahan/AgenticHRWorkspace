import { createReadStream } from 'fs';
import { access, mkdir, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { AwsClient } from 'aws4fetch';
import { db } from '@/lib/db';

/**
 * File storage adapter, chosen by environment:
 *   - S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3, MinIO)
 *     when S3_BUCKET, S3_ENDPOINT and S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY
 *     are set. The recommended setup: private bucket, no egress fees, and
 *     the same code for the managed deployment and self-hosters.
 *   - Vercel Blob when BLOB_READ_WRITE_TOKEN is set.
 *   - Local disk otherwise (dev + Docker — mount .data as a volume). Not
 *     on Vercel, whose filesystem doesn't persist.
 * Downloads always go through /api/files/[id], which enforces org scoping,
 * so buckets stay private whichever backend is in use.
 */

const LOCAL_ROOT = path.join(process.cwd(), '.data', 'uploads');

type S3Config = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };

/** S3_* rather than AWS_*: Vercel reserves and injects the AWS_ names. */
function s3Config(): S3Config | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = process.env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: S3_ENDPOINT.replace(/\/+$/, ''),
    bucket: S3_BUCKET,
    region: S3_REGION || 'auto', // R2 wants "auto"
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  };
}

function backend(): 's3' | 'blob' | 'local' | 'none' {
  if (s3Config()) return 's3';
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob';
  return process.env.VERCEL === '1' ? 'none' : 'local';
}

let s3: { key: string; client: AwsClient } | null = null;

/** aws4fetch: a 3 KB SigV4 signer over fetch, with retries on 5xx/429 built in. */
function s3Client(cfg: S3Config): AwsClient {
  const cacheKey = `${cfg.accessKeyId}:${cfg.region}`;
  if (s3?.key !== cacheKey) {
    s3 = {
      key: cacheKey,
      client: new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: cfg.region }),
    };
  }
  return s3.client;
}

/** Path-style object URL (every S3-compatible service accepts it). */
function objectUrl(cfg: S3Config, key: string): string {
  return `${cfg.endpoint}/${encodeURIComponent(cfg.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export class StoredFileMissingError extends Error {
  constructor(key: string) {
    super(`Stored file not found: ${key}`);
    this.name = 'StoredFileMissingError';
  }
}

/** Whether uploads can be persisted here. Vercel with no bucket or Blob store can't keep files. */
export function fileStorageAvailable(): boolean {
  return backend() !== 'none';
}

async function putBytes(key: string, data: Buffer, mime: string) {
  switch (backend()) {
    case 's3': {
      const cfg = s3Config()!;
      const res = await s3Client(cfg).fetch(objectUrl(cfg, key), {
        method: 'PUT',
        body: new Uint8Array(data),
        headers: { 'content-type': mime },
      });
      if (!res.ok) throw new Error(`File storage rejected the upload (HTTP ${res.status})`);
      return;
    }
    case 'blob': {
      const { put } = await import('@vercel/blob');
      await put(key, data, { access: 'public', contentType: mime, addRandomSuffix: false, allowOverwrite: true });
      return;
    }
    case 'local': {
      const filePath = path.join(LOCAL_ROOT, key);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
      return;
    }
    default:
      throw new Error('File storage is not configured on this deployment');
  }
}

export type StoreFileInput = {
  orgId: string;
  filename: string;
  mime: string;
  data: Buffer;
};

/**
 * Write bytes under an exact key, replacing whatever is there. For callers
 * that record the StoredFile row themselves (the importer does it in the
 * same transaction as its bookkeeping, and a replay reuses the same key).
 */
export async function putFileBytes(key: string, data: Buffer, mime: string) {
  await putBytes(key, data, mime);
}

export async function storeFile(input: StoreFileInput) {
  const safeName = input.filename.replace(/[^\w.\-]+/g, '_').slice(0, 120);
  const key = `${input.orgId}/${crypto.randomUUID()}-${safeName}`;
  await putBytes(key, input.data, input.mime);
  return db.storedFile.create({
    data: {
      orgId: input.orgId,
      key,
      filename: input.filename,
      mime: input.mime,
      size: input.data.byteLength,
    },
  });
}

/** Types a browser may render in place. Everything else downloads. */
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Response headers for serving a stored file. Uploads and imports can carry
 * any Content-Type, and a file served inline from our origin as text/html or
 * SVG would run script with the viewer's session — so only PDFs and raster
 * images render in place; everything else is an octet-stream download.
 * Non-PDF responses are also sandboxed (Chrome's PDF viewer won't render
 * under a sandbox CSP, and a PDF's type alone doesn't execute page script).
 */
export function fileResponseHeaders(
  file: { mime: string; filename: string },
  cache: string,
  { allowSvg = false }: { allowSvg?: boolean } = {},
): Record<string, string> {
  const mime = file.mime.toLowerCase().split(';')[0].trim();
  const inline = INLINE_TYPES.has(mime) || (allowSvg && mime === 'image/svg+xml');
  const ascii = file.filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '');
  return {
    'Content-Type': inline ? mime : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    ...(mime === 'application/pdf'
      ? {}
      : { 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" }),
    'Cache-Control': cache,
  };
}

/**
 * Open a stored file as a stream (org check happens at the route). Routes
 * stream it straight through, so large files never sit in memory and aren't
 * held to Vercel's 4.5 MB limit on buffered function responses.
 */
export async function openStoredFile(key: string): Promise<ReadableStream<Uint8Array>> {
  switch (backend()) {
    case 's3': {
      const cfg = s3Config()!;
      const res = await s3Client(cfg).fetch(objectUrl(cfg, key));
      if (res.status === 404) throw new StoredFileMissingError(key);
      if (!res.ok || !res.body) throw new Error(`File storage returned HTTP ${res.status}`);
      return res.body;
    }
    case 'blob': {
      const { BlobNotFoundError, head } = await import('@vercel/blob');
      // Only "not found" means missing: a rate limit or an outage is an error worth retrying.
      const meta = await head(key).catch((err: unknown) => {
        if (err instanceof BlobNotFoundError) return null;
        throw err;
      });
      if (!meta) throw new StoredFileMissingError(key);
      const res = await fetch(meta.url);
      if (!res.ok || !res.body) throw new Error(`File storage returned HTTP ${res.status}`);
      return res.body;
    }
    default: {
      const filePath = path.join(LOCAL_ROOT, key);
      await access(filePath).catch(() => {
        throw new StoredFileMissingError(key);
      });
      return Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
    }
  }
}

/** Read a whole stored file into memory. */
export async function readStoredFile(key: string): Promise<Buffer> {
  return Buffer.from(await new Response(await openStoredFile(key)).arrayBuffer());
}

/** Delete a file's bytes. A file that's already gone counts as deleted. */
export async function deleteStoredFileBytes(key: string): Promise<void> {
  switch (backend()) {
    case 's3': {
      const cfg = s3Config()!;
      const res = await s3Client(cfg).fetch(objectUrl(cfg, key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`File storage returned HTTP ${res.status}`);
      return;
    }
    case 'blob': {
      const { del } = await import('@vercel/blob');
      await del(key);
      return;
    }
    default:
      await unlink(path.join(LOCAL_ROOT, key)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
  }
}
