'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Skel, SkeletonWave } from '@/components/ui/skeleton';

/**
 * The candidate profile's shape while it loads: shown by the placeholder
 * drawer the moment a candidate is clicked, then behind the real drawer's
 * content until the profile crossfades over it (globals.css).
 *
 * Every unit of the profile is there and filled: the header card with its
 * controls and tags; candidate match, interviews, email and notes on the
 * left; applications, recruiter, contact, background, tasks and activity on
 * the right. White cards sit where the profile has them, so when it lands
 * the surfaces stay and mostly the content fades in. It fills the drawer
 * and fades off at the bottom.
 */

const bar = 'rounded-full';

/** A section label (optionally with an action pill on the right) over its content. */
function Section({ label, action, children }: { label: string; action?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex min-h-5 items-center justify-between">
        <Skel className={cn('h-2.5', bar, label)} />
        {action ? <Skel className={cn('h-7', bar, action)} /> : null}
      </div>
      {children}
    </div>
  );
}

function Card({ children, divided = false }: { children: ReactNode; divided?: boolean }) {
  return (
    <div className={cn('rounded-card bg-surface', divided ? 'divide-y divide-line' : 'flex flex-col gap-3 p-5')}>
      {children}
    </div>
  );
}

function Lines({ widths }: { widths: string[] }) {
  return widths.map((w, i) => <Skel key={i} className={cn('h-2.5', bar, w)} />);
}

/** Two lines of text, a title and its meta. */
function TwoLines({ a, b }: { a: string; b: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <Skel className={cn('h-2.5', bar, a)} />
      <Skel className={cn('h-2', bar, b)} />
    </div>
  );
}

export function ProfileSkeleton() {
  return (
    <SkeletonWave className="mx-auto h-[calc(100dvh-16px)] max-w-6xl overflow-hidden px-6 py-6">
      {/* ← Pipeline */}
      <div className="mb-4 flex h-8 items-center gap-2">
        <Skel className="size-3.5 rounded-sm" />
        <Skel className={cn('h-2.5 w-16', bar)} />
      </div>

      {/* Header: avatar, name, subtitle, Presentation; then stage, snooze, archive | origin, tags */}
      <div className="rounded-card bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Skel className="size-14 rounded-full" />
            <div className="flex flex-col gap-2.5">
              <Skel className={cn('h-4 w-44', bar)} />
              <Skel className={cn('h-2.5 w-72', bar)} />
            </div>
          </div>
          <Skel className={cn('h-8 w-28', bar)} />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {['w-28', 'w-20', 'w-24'].map((w) => (
            <Skel key={w} className={cn('h-6', bar, w)} />
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          {['w-16', 'w-24', 'w-14'].map((w) => (
            <Skel key={w} className={cn('h-6', bar, w)} />
          ))}
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-8">
          {/* Candidate match */}
          <Section label="w-32">
            <Card>
              <div className="flex items-center justify-between">
                <Skel className={cn('h-5 w-32', bar)} />
                <Skel className={cn('h-2.5 w-20', bar)} />
              </div>
              <Lines widths={['w-full', 'w-11/12', 'w-3/4']} />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {['w-28', 'w-24', 'w-32', 'w-20'].map((w) => (
                  <Skel key={w} className={cn('h-6', bar, w)} />
                ))}
              </div>
            </Card>
          </Section>

          {/* Interviews */}
          <Section label="w-24" action="w-44">
            <Card divided>
              {[0, 1].map((i) => (
                <div key={i} className="flex flex-col gap-3 px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <TwoLines a="w-40" b="w-64" />
                    <Skel className={cn('h-6 w-20', bar)} />
                  </div>
                  <div className="flex gap-2">
                    <Skel className={cn('h-8 w-32', bar)} />
                    <Skel className={cn('h-8 w-36', bar)} />
                  </div>
                </div>
              ))}
            </Card>
          </Section>

          {/* Email */}
          <Section label="w-12" action="w-24">
            <Card divided>
              {['w-56', 'w-48', 'w-60'].map((w) => (
                <div key={w} className="flex items-center justify-between gap-4 px-5 py-4">
                  <TwoLines a={w} b="w-40" />
                  <Skel className={cn('h-5 w-12', bar)} />
                </div>
              ))}
            </Card>
          </Section>

          {/* Notes */}
          <Section label="w-14">
            <Card>
              <Skel className="h-16 w-full rounded-field" />
              <div className="flex justify-end">
                <Skel className={cn('h-8 w-24', bar)} />
              </div>
            </Card>
          </Section>
        </div>

        <div className="hidden flex-col gap-8 lg:flex">
          {/* Applications */}
          <Section label="w-24">
            <div className="flex flex-col gap-1 rounded-card bg-surface p-1.5">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                  <Skel className="size-6 rounded-full" />
                  <TwoLines a="w-2/3" b="w-1/3" />
                  {i === 0 ? <Skel className={cn('h-6 w-24', bar)} /> : null}
                </div>
              ))}
            </div>
          </Section>

          {/* Recruiter */}
          <Section label="w-20">
            <div className="flex items-center gap-3 rounded-card bg-surface p-1.5">
              <div className="flex flex-1 items-center gap-3 px-3 py-2.5">
                <Skel className="size-6 rounded-full" />
                <TwoLines a="w-1/2" b="w-3/4" />
                <Skel className={cn('h-6 w-20', bar)} />
              </div>
            </div>
          </Section>

          {/* Contact */}
          <Section label="w-16">
            <Card divided>
              {['w-3/4', 'w-1/2', 'w-2/5', 'w-2/3'].map((w) => (
                <div key={w} className="flex items-center gap-2.5 px-4 py-3">
                  <Skel className="size-3.5 rounded-sm" />
                  <Skel className={cn('h-2.5', bar, w)} />
                </div>
              ))}
            </Card>
          </Section>

          {/* Background */}
          <Section label="w-24">
            <Card>
              <Lines widths={['w-full', 'w-11/12', 'w-full', 'w-4/5', 'w-2/3']} />
            </Card>
          </Section>

          {/* Tasks */}
          <Section label="w-12" action="w-20">
            <Card divided>
              {['w-3/4', 'w-2/3'].map((w) => (
                <div key={w} className="flex items-center gap-3 px-4 py-3">
                  <Skel className="size-4 rounded-box" />
                  <TwoLines a={w} b="w-1/3" />
                </div>
              ))}
            </Card>
          </Section>

          {/* Activity */}
          <Section label="w-16">
            <div className="flex flex-col gap-4 pl-1">
              {['w-3/4', 'w-2/3', 'w-4/5', 'w-1/2'].map((w) => (
                <div key={w} className="flex items-start gap-3">
                  <Skel className="mt-1 size-2 rounded-full" />
                  <TwoLines a={w} b="w-1/4" />
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </SkeletonWave>
  );
}
