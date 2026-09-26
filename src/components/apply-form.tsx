'use client';

import { useActionState } from 'react';
import { applyAction, type ApplyFormState } from '@/app/careers/actions';
import { Field, inputLgClass, selectClass, textareaClass } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { TextSwap } from '@/components/ui/motion';
import { Checkbox } from '@/components/ui/checkbox';

const EEO_QUESTIONS: { name: string; label: string; options: string[] }[] = [
  { name: 'eeo_gender', label: 'Gender', options: ['Female', 'Male', 'Non-binary'] },
  {
    name: 'eeo_race',
    label: 'Race / ethnicity',
    options: [
      'American Indian or Alaska Native',
      'Asian',
      'Black or African American',
      'Hispanic or Latino',
      'Native Hawaiian or Other Pacific Islander',
      'White',
      'Two or more races',
    ],
  },
  { name: 'eeo_veteran', label: 'Veteran status', options: ['Protected veteran', 'Not a protected veteran'] },
  { name: 'eeo_disability', label: 'Disability status', options: ['Yes, I have a disability', 'No, I do not have a disability'] },
];

export function ApplyForm({
  orgSlug,
  postingSlug,
  networkOptIn,
  collectEeo = false,
  utm,
}: {
  orgSlug: string;
  postingSlug: string;
  networkOptIn: boolean;
  collectEeo?: boolean;
  utm?: { source?: string; medium?: string; campaign?: string };
}) {
  const [state, formAction, pending] = useActionState<ApplyFormState, FormData>(
    applyAction,
    undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="postingSlug" value={postingSlug} />
      {utm?.source ? <input type="hidden" name="utm_source" value={utm.source} /> : null}
      {utm?.medium ? <input type="hidden" name="utm_medium" value={utm.medium} /> : null}
      {utm?.campaign ? <input type="hidden" name="utm_campaign" value={utm.campaign} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <input name="name" required autoComplete="name" className={inputLgClass} />
        </Field>
        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" className={inputLgClass} />
        </Field>
        <Field label="Location">
          <input name="location" placeholder="City, Country" className={inputLgClass} />
        </Field>
        <Field label="LinkedIn / portfolio">
          <input name="linkedin" type="url" placeholder="https://…" className={inputLgClass} />
        </Field>
      </div>

      <Field label="Resume (PDF, Word, ODT, RTF or TXT — max 5 MB)">
        <input
          name="resume"
          type="file"
          accept=".pdf,.doc,.docx,.odt,.rtf,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text,application/rtf,text/rtf,text/plain"
          className="text-sm text-ink-2 file:mr-3 file:h-8 file:cursor-pointer file:rounded-full file:border-0 file:bg-muted file:px-3 file:text-sm file:font-medium file:text-ink file:transition-colors hover:file:bg-recessed"
        />
      </Field>

      <Field label="Anything you'd like to share?">
        <textarea
          name="coverNote"
          rows={4}
          placeholder="A short note about why you're a great fit…"
          className={textareaClass}
        />
      </Field>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-field bg-muted p-3">
        <Checkbox name="storeProfile" defaultChecked className="mt-0.5" />
        <span className="text-xs text-ink-2">
          <span className="font-medium text-ink">
            Save my profile to make future applications faster.
          </span>{' '}
          Your details and resume stay on file so applying to other roles here is one click.
          Uncheck it and everything you submit is erased automatically once this process ends.
        </span>
      </label>

      {networkOptIn ? (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-field bg-muted p-3">
          <Checkbox name="networkOptIn" className="mt-0.5" />
          <span className="text-xs text-ink-2">
            <span className="font-medium text-ink">
              Make my profile discoverable by other employers hiring on Source.
            </span>{' '}
            Optional — does not affect this application. Only the details you submit here are
            shared, never interview notes or feedback. You can withdraw at any time from your
            application status page.
          </span>
        </label>
      ) : null}

      {collectEeo ? (
        <div className="pt-2">
          <p className="text-sm font-medium text-ink">Voluntary self-identification (EEO)</p>
          <p className="mt-1 text-xs text-ink-2">
            Entirely optional and never shown alongside your application — responses are stored
            separately with no link to your profile and reported only in aggregate. Answering (or
            declining) has no effect on your application.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {EEO_QUESTIONS.map((q) => (
              <label key={q.name} className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-ink-2">{q.label}</span>
                <select name={q.name} defaultValue="declined" className={selectClass}>
                  <option value="declined">Decline to self-identify</option>
                  {q.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {state?.error ? (
        <p className="rounded-field bg-critical/10 px-3 py-2 text-sm text-critical">{state.error}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className={buttonClass({ variant: 'primary', size: 'lg', className: 'mt-2 w-full' })}
      >
        <TextSwap>{pending ? 'Submitting…' : 'Submit application'}</TextSwap>
      </button>
    </form>
  );
}
