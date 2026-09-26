type FeedEvent = {
  id: string;
  verb: string;
  payload: Record<string, unknown> | null;
  occurredAt: string;
};

function describe(event: FeedEvent): string {
  const p = event.payload ?? {};
  switch (event.verb) {
    case 'opportunity.created':
      return `Added to pipeline in ${p.stageName ?? 'a stage'}`;
    case 'opportunity.stage_changed':
      return `Moved from ${p.from} to ${p.to}`;
    case 'opportunity.hired':
      return `Hired 🎉 (${p.from} → ${p.to})`;
    case 'opportunity.archived':
      return `Archived — ${p.reason}`;
    case 'opportunity.unarchived':
      return 'Restored to pipeline';
    case 'note.added':
      return 'Note added';
    case 'application.received':
      return `Applied to ${p.postingTitle ?? 'a posting'} via careers site`;
    case 'interview.scheduled':
      return `Interview scheduled: ${p.title}${Array.isArray(p.panel) && p.panel.length ? ` with ${(p.panel as string[]).join(', ')}` : ''}`;
    case 'interview.completed':
      return `Interview completed: ${p.title}`;
    case 'interview.canceled':
      return `Interview canceled: ${p.title}`;
    case 'feedback.submitted':
      return `Feedback submitted — ${p.rating}`;
    case 'email.sent':
      return `Email sent: ${p.subject}`;
    case 'email.scheduled':
      return `Email scheduled: ${p.subject}`;
    case 'email.canceled':
      return `Scheduled email canceled: ${p.subject}`;
    case 'ai.evaluation_completed':
      return `AI evaluation completed (${p.model})`;
    case 'task.created':
      return `Task added: ${p.title}`;
    case 'task.completed':
      return `Task completed: ${p.title}`;
    case 'opportunity.snoozed':
      return `Snoozed until ${p.until ? new Date(String(p.until)).toLocaleDateString() : 'later'}`;
    case 'opportunity.unsnoozed':
      return 'Snooze removed';
    case 'offer.created':
      return `Offer drafted: ${p.jobTitle}`;
    case 'offer.approval_requested':
      return `Offer sent for approval: ${p.jobTitle}`;
    case 'offer.pending_approval':
      return `Offer awaiting approval: ${p.jobTitle}`;
    case 'offer.sent':
      return `Offer sent: ${p.jobTitle}`;
    case 'offer.accepted':
      return `Offer accepted 🎉 ${p.jobTitle}`;
    case 'offer.declined':
      return `Offer declined: ${p.jobTitle}`;
    case 'offer.withdrawn':
      return `Offer withdrawn: ${p.jobTitle}`;
    case 'referral.submitted':
      return `Referral submitted by ${p.referrerName ?? 'a teammate'}`;
    case 'scheduling.link_created':
      return `Booking link created: ${p.title}`;
    case 'interview.self_scheduled':
      return `Candidate booked: ${p.title}`;
    case 'contact.merged':
      return `Merged duplicate profile: ${p.mergedName}`;
    case 'contact.tagged':
      return `Tags updated: ${Array.isArray(p.tags) ? (p.tags as string[]).join(', ') : ''}`;
    case 'opportunity.imported':
      return `Imported from ${p.source ?? 'another ATS'}`;
    default:
      return event.verb.replace(/[._]/g, ' ');
  }
}

export function ActivityFeed({ events }: { events: FeedEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-ink-2">No activity yet.</p>;
  }
  return (
    <ol className="flex flex-col">
      {events.map((event) => (
        <li key={event.id} className="group relative pb-4 pl-4 last:pb-0">
          {/* the rail runs from this dot to the next one, so it ends at the last dot */}
          <span aria-hidden className="absolute -bottom-1.5 left-[3.5px] top-3.5 w-px bg-line group-last:hidden" />
          <span aria-hidden className="absolute left-0 top-1.5 size-2 rounded-full bg-ink-3" />
          <p className="text-sm">{describe(event)}</p>
          <p className="mt-0.5 text-xs text-ink-2">
            {new Date(event.occurredAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        </li>
      ))}
    </ol>
  );
}
