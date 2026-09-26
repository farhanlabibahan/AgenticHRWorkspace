import { surface } from '@/components/form-controls';
import { CompanyMark, LogoAttribution } from '@/components/company-mark';
import { Badge, SectionHeader } from '@/components/ui/primitives';
import { ShowMore } from '@/components/ui/show-more';
import {
  formatDuration,
  formatSpan,
  groupByCompany,
  yearsOfExperience,
  type ProfileJob,
  type ResumeView,
} from '@/lib/resume-profile';

/**
 * Experience, education and skills from the parsed resume
 * (src/lib/resume-profile.ts). Companies and schools show their logo where
 * one can be found by name, else an orb from the name (company-mark.tsx).
 */

function Dates({ start, end, withDuration = true }: { start: string | null; end: string | null; withDuration?: boolean }) {
  const span = formatSpan(start, end);
  const duration = withDuration ? formatDuration(start, end) : null;
  if (!span && !duration) return null;
  return (
    <p className="text-xs tabular-nums text-ink-3">
      {[span, duration].filter(Boolean).join(' · ')}
    </p>
  );
}

function Role({ job, showCompany, showLocation = true }: { job: ProfileJob; showCompany: boolean; showLocation?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium text-ink">{job.title ?? job.company}</p>
      {showCompany && job.title && job.company ? <p className="text-xs text-ink-2">{job.company}</p> : null}
      <Dates start={job.start} end={job.end} />
      {showLocation && job.location ? <p className="text-xs text-ink-3">{job.location}</p> : null}
    </div>
  );
}

/** One company, several titles: a promotion reads as a path. A shared location shows once. */
function Stint({ stint }: { stint: ReturnType<typeof groupByCompany>[number] }) {
  const places = new Set(stint.roles.map((r) => r.location));
  const shared = places.size === 1 ? stint.roles[0].location : null;
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-ink">{stint.company}</p>
      <Dates start={stint.start} end={stint.end} />
      {shared ? <p className="text-xs text-ink-3">{shared}</p> : null}
      <ol className="mt-2.5 flex flex-col gap-2.5 border-l border-line pl-3">
        {stint.roles.map((role, j) => (
          <li key={j}>
            <Role job={role} showCompany={false} showLocation={!shared} />
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ExperienceSection({ experience }: { experience: ProfileJob[] }) {
  if (!experience.length) return null;
  const years = yearsOfExperience(experience);
  const stints = groupByCompany(experience);
  return (
    <section>
      <SectionHeader
        title="Experience"
        action={years ? <span className="text-xs tabular-nums text-ink-2">{years}+ years</span> : null}
      />
      <div className={`${surface} overflow-hidden`}>
        <ShowMore limit={4} noun={stints.length - 4 === 1 ? 'more company' : 'more companies'} className="divide-y divide-line" buttonClassName="mb-3 ml-3">
          {stints.map((stint, i) => (
            <div key={i} className="flex gap-3 px-4 py-3.5">
              <CompanyMark name={stint.company ?? stint.roles[0].title ?? String(i)} size={28} className="mt-0.5" />
              {stint.roles.length === 1 ? (
                <Role job={stint.roles[0]} showCompany />
              ) : (
                <Stint stint={stint} />
              )}
            </div>
          ))}
        </ShowMore>
      </div>
    </section>
  );
}

export function EducationSection({ education }: { education: ResumeView['education'] }) {
  if (!education.length) return null;
  return (
    <section>
      <SectionHeader title="Education" action={<LogoAttribution />} />
      <div className={`${surface} divide-y divide-line overflow-hidden`}>
        {education.map((e, i) => (
          <div key={i} className="flex gap-3 px-4 py-3.5">
            <CompanyMark name={e.school ?? e.degree ?? String(i)} size={28} className="mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{e.school ?? e.degree}</p>
              {e.school && (e.degree || e.field) ? (
                <p className="text-xs text-ink-2">{[e.degree, e.field].filter(Boolean).join(', ')}</p>
              ) : null}
              <Dates start={e.start} end={e.end} withDuration={false} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SkillsSection({ skills }: { skills: string[] }) {
  if (!skills.length) return null;
  return (
    <section>
      <SectionHeader title="Skills" />
      <div className={`${surface} p-4`}>
        <ShowMore limit={14} className="flex flex-wrap gap-1.5" buttonClassName="mt-2.5 -ml-2.5">
          {skills.map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
        </ShowMore>
      </div>
    </section>
  );
}
