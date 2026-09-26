import { saveAutomationAction } from '@/app/org-actions';
import { Field, btnPrimary, inputClass, noAutofill } from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';

/** Server component — plain form posting to a server action. */
export function AutomationSettings({
  templates,
  settings,
}: {
  templates: { id: string; name: string }[];
  settings: {
    autoConfirmTemplateId: string | null;
    autoRejectTemplateId: string | null;
    autoInterviewTemplateId: string | null;
    autoRejectDelayHours: number;
  };
}) {
  const templateSelect = (name: string, current: string | null) => (
    <FormSelect
      name={name}
      defaultValue={current ?? ''}
      options={[
        { value: '', label: 'Off' },
        ...templates.map((t) => ({ value: t.id, label: `Send “${t.name}”` })),
      ]}
    />
  );

  return (
    <form action={saveAutomationAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="When an application arrives">
          {templateSelect('autoConfirmTemplateId', settings.autoConfirmTemplateId)}
        </Field>
        <Field label="When an interview is scheduled">
          {templateSelect('autoInterviewTemplateId', settings.autoInterviewTemplateId)}
        </Field>
        <Field label="When a candidate is archived as a rejection">
          {templateSelect('autoRejectTemplateId', settings.autoRejectTemplateId)}
        </Field>
        <Field label="Rejection delay (hours)">
          <input {...noAutofill}
            name="autoRejectDelayHours"
            type="number"
            min={0}
            defaultValue={settings.autoRejectDelayHours}
            className={inputClass}
          />
        </Field>
      </div>
      <p className="text-xs text-ink-2">
        The rejection delay gives you a window to unarchive before the email goes out — scheduled
        sends appear on the candidate profile and can be canceled.
      </p>
      <div className="flex justify-end">
        <button type="submit" className={btnPrimary}>
          Save automation
        </button>
      </div>
    </form>
  );
}
