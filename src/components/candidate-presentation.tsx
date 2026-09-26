import { ArrowUpRight, Mail, MapPin, Phone } from 'lucide-react';
import { db } from '@/lib/db';
import { Avatar } from '@/components/ui/orb';
import { SiteIcon } from '@/components/site-icon';
import { sectionLabel } from '@/components/form-controls';
import { WorkThumb } from '@/components/work-thumb';
import { EducationSection, ExperienceSection, SkillsSection } from '@/components/resume-sections';
import { readResumeView } from '@/lib/resume-profile';
import { mergeHighlights, readHighlights, resumeHighlights } from '@/lib/highlights';

/**
 * Public candidate one-pager: the whole resume, read the way a hiring
 * manager or client wants it. Their own summary, what stood out (the
 * evaluation's summary and highlights), their work as thumbnails linking to
 * each case study, then experience, education, skills and where else to
 * find them. Notes, scorecards, compensation, emails, and team identities
 * are structurally excluded: this component never queries them.
 */

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export async function CandidatePresentation({ orgId, opportunityId }: { orgId: string; opportunityId: string }) {
  const opportunity = await db.opportunity.findFirst({
    where: { id: opportunityId, orgId },
    include: {
      contact: {
        include: {
          resumeFile: { select: { parsed: true } },
          caseStudies: { orderBy: { position: 'asc' } },
        },
      },
    },
  });
  if (!opportunity) return null;
  const { contact } = opportunity;

  const spotlight = await db.aiEvaluation.findFirst({
    where: { orgId, opportunityId },
    orderBy: { createdAt: 'desc' },
    select: { summary: true, strengths: true, highlights: true },
  });

  const resume = readResumeView(contact.resumeFile?.parsed);
  const role = contact.headline?.split(' at ')[0] ?? contact.headline;
  // Their own words: the resume's summary, or (with no parsed resume) the start of its text
  const about =
    resume?.summary ??
    (contact.resumeText && !resume?.experience.length
      ? `${contact.resumeText.slice(0, 1200)}${contact.resumeText.length > 1200 ? '…' : ''}`
      : null);
  const highlights = mergeHighlights(resume ? resumeHighlights(resume.experience) : [], readHighlights(spotlight?.highlights));
  const standout = highlights.length ? highlights.map((h) => h.text) : (spotlight?.strengths ?? []);
  const links = contact.links.map((l) => (l.startsWith('http') ? l : `https://${l}`));

  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      {/* Identity */}
      <header className="flex items-center gap-5">
        <Avatar name={contact.name} seed={contact.id} size={72} />
        <div className="min-w-0">
          <h1 className="text-2xl text-ink">{contact.name}</h1>
          {role ? <p className="mt-0.5 text-md text-ink-2">{role}</p> : null}
          <p className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-2">
            {contact.location ? (
              <span className="flex items-center gap-1.5">
                <MapPin size={14} /> {contact.location}
              </span>
            ) : null}
            {contact.emails[0] ? (
              <a href={`mailto:${contact.emails[0]}`} className="flex items-center gap-1.5 transition-colors duration-[120ms] hover:text-ink">
                <Mail size={14} /> {contact.emails[0]}
              </a>
            ) : null}
            {contact.phones[0] ? (
              <span className="flex items-center gap-1.5">
                <Phone size={14} /> {contact.phones[0]}
              </span>
            ) : null}
          </p>
        </div>
      </header>

      {about ? (
        <section className="mt-12">
          <h2 className={`${sectionLabel} mb-3`}>About</h2>
          <p className="max-w-prose whitespace-pre-wrap text-md text-ink">{about}</p>
        </section>
      ) : null}

      {spotlight || standout.length ? (
        <section className="mt-10">
          <h2 className={`${sectionLabel} mb-3`}>What stood out</h2>
          <div className="rounded-card bg-surface p-5">
            {spotlight ? <p className="text-sm text-ink">{spotlight.summary}</p> : null}
            {standout.length ? (
              <div className={`flex flex-wrap gap-1.5 ${spotlight ? 'mt-4' : ''}`}>
                {standout.map((t) => (
                  <span key={t} className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs text-ink">
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Their work, first-class: each case study a thumbnail that opens it */}
      {contact.caseStudies.length ? (
        <section className="mt-10">
          <h2 className={`${sectionLabel} mb-3`}>Selected work</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {contact.caseStudies.map((c) => (
              <li key={c.id}>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block rounded-card bg-surface p-2 transition-shadow duration-200 hover:shadow-lift"
                >
                  <WorkThumb imageUrl={c.imageUrl} seed={c.id} />
                  <div className="px-2 pb-2 pt-3">
                    <p className="text-sm font-medium text-ink">{c.title}</p>
                    {c.summary ? <p className="mt-1 line-clamp-2 text-sm text-ink-2">{c.summary}</p> : null}
                    <p className="mt-2 flex items-center gap-1 text-xs text-ink-3">
                      {host(c.url)} <ArrowUpRight className="t-learn-arrow size-3" />
                    </p>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {resume?.experience.length ? (
        <div className="mt-10">
          <ExperienceSection experience={resume.experience} />
        </div>
      ) : null}
      {resume?.education.length ? (
        <div className="mt-10">
          <EducationSection education={resume.education} />
        </div>
      ) : null}
      {resume?.skills.length ? (
        <div className="mt-10">
          <SkillsSection skills={resume.skills} />
        </div>
      ) : null}

      {links.length ? (
        <section className="mt-10">
          <h2 className={`${sectionLabel} mb-3`}>Elsewhere</h2>
          <div className="flex flex-wrap gap-2">
            {links.map((l) => (
              <a
                key={l}
                href={l}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-2 rounded-full bg-surface px-3.5 text-sm text-ink transition-colors duration-[120ms] hover:bg-muted"
              >
                <SiteIcon url={l} size={14} />
                {host(l)}
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
