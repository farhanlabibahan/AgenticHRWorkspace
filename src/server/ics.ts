/**
 * Minimal iCalendar (RFC 5545) event builder for interview invitations.
 * No calendar *sync* here — this is the P1 ".ics attached to the
 * confirmation email" flow; two-way calendar integration is Phase 3.
 */

function icsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function buildInterviewIcs(input: {
  uid: string;
  title: string;
  startAt: Date;
  durationMins: number;
  location?: string | null;
  organizerName: string;
  description?: string;
}): string {
  const endAt = new Date(input.startAt.getTime() + input.durationMins * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Source//Interview//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${input.uid}@source`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(input.startAt)}`,
    `DTEND:${icsDate(endAt)}`,
    `SUMMARY:${escapeText(input.title)}`,
    ...(input.location ? [`LOCATION:${escapeText(input.location)}`] : []),
    ...(input.description ? [`DESCRIPTION:${escapeText(input.description)}`] : []),
    `ORGANIZER;CN=${escapeText(input.organizerName)}:mailto:no-reply@source.local`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // RFC 5545 wants CRLF line endings
  return lines.join('\r\n');
}
