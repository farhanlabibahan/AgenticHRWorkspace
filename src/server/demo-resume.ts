import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { fileStorageAvailable, storeFile } from '@/server/storage';
import { EXTRACTOR_VERSION } from '@/server/text/status';

/**
 * Resumes for the demo's filled-out candidates: a one-page PDF behind the
 * Resume link, and the parsed profile (experience, education, skills) the
 * profile page shows, as resume parsing would have left it. Seeded once per
 * demo org, outside the seed's transaction because it writes to storage.
 */

/** WinAnsi for the few characters outside Latin-1 the resumes use. */
const WIN_ANSI: Record<string, string> = { '—': '\x97', '–': '\x96', '’': '\x92', '‘': '\x91', '“': '\x93', '”': '\x94', '•': '\x95', '…': '\x85' };

function pdfString(text: string): string {
  const mapped = [...text].map((c) => WIN_ANSI[c] ?? (c.charCodeAt(0) <= 0xff ? c : '?')).join('');
  return `(${mapped.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A one-page, text-only PDF: the name in bold, a contact line, then the
 * resume's paragraphs. Built by hand (Helvetica needs no embedding), so the
 * demo carries no PDF library. Latin-1 strings throughout, so string length
 * is byte length for the xref offsets.
 */
export function resumePdf(name: string, contactLine: string, body: string): Buffer {
  const ops: string[] = ['BT', '/F2 20 Tf', '56 728 Td', `${pdfString(name)} Tj`, '/F1 9 Tf', '0 -18 Td', `${pdfString(contactLine)} Tj`, '/F1 10 Tf', '14 TL', '0 -12 Td'];
  for (const paragraph of body.split('\n')) {
    ops.push('T*');
    for (const line of wrap(paragraph, 96)) ops.push(`${pdfString(line)} Tj`, 'T*');
  }
  ops.push('ET');
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export type DemoResume = {
  email: string;
  resume: string;
  parsed: {
    summary: string;
    skills: string[];
    experience: { title: string; company: string; location: string | null; start: string; end: string }[];
    education: { school: string; degree: string; field: string | null; start: string; end: string }[];
  };
};

const PARSE_MODEL = 'Sample';

/**
 * Whether every filled-out candidate has a resume. A failed upload leaves
 * one without, and the next demo login tries it again.
 */
export async function demoResumesSeeded(orgId: string, emails: string[]): Promise<boolean> {
  const missing = await db.contact.count({ where: { orgId, resumeFileId: null, emails: { hasSome: emails } } });
  return missing === 0;
}

/** One upload, tried once more if storage turns it down. */
async function storeWithRetry(input: Parameters<typeof storeFile>[0]) {
  try {
    return await storeFile(input);
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    return storeFile(input);
  }
}

/**
 * A resume file for each profile whose contact has none yet, one upload at
 * a time. Contacts the shared demo already gave a resume are left alone; a
 * profile whose upload fails is skipped and tried on the next login.
 */
export async function seedDemoResumes(orgId: string, profiles: DemoResume[]): Promise<void> {
  if (!fileStorageAvailable()) return;
  for (const p of profiles) {
    try {
      await seedOne(orgId, p);
    } catch (error) {
      console.error('[demo] resume', p.email, error instanceof Error ? error.message : error);
    }
  }
}

async function seedOne(orgId: string, p: DemoResume): Promise<void> {
  const contact = await db.contact.findFirst({
    where: { orgId, emails: { has: p.email }, resumeFileId: null },
    select: { id: true, name: true, emails: true, phones: true, location: true, links: true },
  });
  if (!contact) return;
  const contactLine = [contact.emails[0], contact.phones?.[0], contact.location, ...(contact.links ?? []).map((l) => l.replace(/^https?:\/\/(www\.)?/, ''))]
    .filter(Boolean)
    .join('  ·  ');
  const file = await storeWithRetry({
    orgId,
    filename: `${contact.name.replace(/\s+/g, '-')}-Resume.pdf`,
    mime: 'application/pdf',
    data: resumePdf(contact.name, contactLine, p.resume),
  });
  const now = new Date();
  await db.$transaction([
    db.storedFile.update({
      where: { id: file.id },
      data: {
        contactId: contact.id,
        textStatus: 'OK',
        textVersion: EXTRACTOR_VERSION,
        textCheckedAt: now,
        // No parseCheckedAt: the daily parse limits count that stamp.
        parseStatus: 'OK',
        parseModel: PARSE_MODEL,
        parsed: p.parsed as Prisma.InputJsonValue,
      },
    }),
    db.contact.update({ where: { id: contact.id }, data: { resumeFileId: file.id, resumeText: p.resume } }),
  ]);
}
