'use client';

import { useRef, useState, useTransition } from 'react';
import { Upload } from 'lucide-react';
import { importContactRowsAction } from '@/app/(app)/actions';
import { parseCsv } from '@/lib/csv';
import { btnGhost } from '@/components/form-controls';
import { TextSwap } from '@/components/ui/motion';

/** Must match CSV_BATCH_ROWS on the server (src/server/contacts.ts). */
const BATCH_ROWS = 1_000;

export function CsvImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);

  // Parse here, send rows in batches: any file size, visible progress, and
  // a failure mid-way keeps everything imported before it.
  const importCsv = (csv: string) =>
    startTransition(async () => {
      setSummary(null);
      setErrors([]);
      const rows = parseCsv(csv);
      if (rows.length < 2) {
        setErrors(['No data rows found.']);
        return;
      }
      const [header, ...data] = rows;
      let created = 0;
      let skipped = 0;
      const errs: string[] = [];
      try {
        for (let i = 0; i < data.length; i += BATCH_ROWS) {
          setProgress(
            `Importing ${Math.min(i + BATCH_ROWS, data.length).toLocaleString()} of ${data.length.toLocaleString()}…`,
          );
          const last = i + BATCH_ROWS >= data.length;
          const r = await importContactRowsAction(header, data.slice(i, i + BATCH_ROWS), i + 2, last);
          created += r.created;
          skipped += r.skipped;
          errs.push(...r.errors);
          if (r.errors[0]?.startsWith('Missing required')) break;
        }
      } catch {
        errs.unshift('Import stopped partway — rows before this point were saved. Retry to continue; existing emails are skipped.');
      } finally {
        setProgress(null);
      }
      setSummary(`${created} contact(s) created, ${skipped} skipped (email already exists).`);
      setErrors(errs.slice(0, 5));
    });

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => importCsv(String(reader.result ?? ''));
          reader.readAsText(file);
          e.target.value = '';
        }}
      />
      <div>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={pending}
          className={btnGhost}
        >
          <Upload /> <TextSwap>{pending ? (progress ?? 'Importing…') : 'Import CSV'}</TextSwap>
        </button>
      </div>
      {summary ? <p className="text-sm text-positive">{summary}</p> : null}
      {errors.map((e, i) => (
        <p key={i} className="text-sm text-critical">
          {e}
        </p>
      ))}
    </div>
  );
}
