'use client';

import { useState, useTransition } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { deleteTemplateAction, saveTemplateAction } from '@/app/org-actions';
import { Field, btnTonal, inputClass, textareaClass, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';

type Template = { id: string; name: string; subject: string; body: string };

function TemplateEditor({
  template,
  onDone,
}: {
  template: Template | null;
  onDone?: () => void;
}) {
  return (
    <form action={saveTemplateAction} className="flex flex-col gap-3 pt-3">
      <input type="hidden" name="templateId" value={template?.id ?? ''} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input {...noAutofill} name="name" required defaultValue={template?.name} className={inputClass} />
        </Field>
        <Field label="Subject">
          <input {...noAutofill} name="subject" required defaultValue={template?.subject} className={inputClass} />
        </Field>
      </div>
      <Field label="Body">
        <textarea {...noAutofill}
          name="body"
          rows={6}
          required
          defaultValue={template?.body}
          className={textareaClass}
        />
      </Field>
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-ink-2">
          Tokens: {'{{candidate_name}} {{first_name}} {{job_title}} {{company_name}} {{interview_title}} {{interview_time}}'}
        </p>
        <button type="submit" className={btnTonal} onClick={onDone}>
          Save
        </button>
      </div>
    </form>
  );
}

export function TemplateManager({ templates }: { templates: Template[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col divide-y divide-line">
      {templates.map((t) => {
        const open = openId === t.id;
        return (
          <div key={t.id} className="py-3 first:pt-0">
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setOpenId(open ? null : t.id)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
              >
                {open ? (
                  <ChevronDown size={14} className="shrink-0 text-ink-2" />
                ) : (
                  <ChevronRight size={14} className="shrink-0 text-ink-2" />
                )}
                <span className="truncate text-sm font-medium">{t.name}</span>
                <span className="truncate text-xs text-ink-2">{t.subject}</span>
              </button>
              <button
                title={`Delete ${t.name}`}
                aria-label={`Delete ${t.name}`}
                disabled={pending}
                onClick={() => {
                  if (!confirm(`Delete the "${t.name}" template? Automations using it are detached.`)) return;
                  startTransition(() => deleteTemplateAction(t.id));
                }}
                className={buttonClass({ variant: 'ghost', size: 'sm', icon: true, className: 'hover:text-critical' })}
              >
                <Trash2 />
              </button>
            </div>
            {open ? <TemplateEditor template={t} onDone={() => setOpenId(null)} /> : null}
          </div>
        );
      })}

      {adding ? (
        <div className="py-3 first:pt-0">
          <TemplateEditor template={null} onDone={() => setAdding(false)} />
        </div>
      ) : (
        <div className="pt-3 first:pt-0">
          <button onClick={() => setAdding(true)} className={buttonClass({ variant: 'tonal', size: 'sm' })}>
            <Plus /> New template
          </button>
        </div>
      )}
    </div>
  );
}
