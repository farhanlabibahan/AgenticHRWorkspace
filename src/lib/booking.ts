/**
 * A recruiter's own booking page (Calendly, Cal.com, a Google Calendar
 * appointment schedule, or anything else with a URL), offered to candidates
 * as an alternative to Source's built-in self-schedule link. Pure helpers,
 * shared by the server action and the interview panel.
 */

export type BookingProvider = 'calendly' | 'cal' | 'google' | 'other';

export const BOOKING_PROVIDER_LABEL: Record<BookingProvider, string> = {
  calendly: 'Calendly',
  cal: 'Cal.com',
  google: 'Google Calendar',
  other: 'Booking page',
};

export function bookingProvider(url: string): BookingProvider {
  let host: string;
  let path: string;
  try {
    ({ hostname: host, pathname: path } = new URL(url));
  } catch {
    return 'other';
  }
  host = host.replace(/^www\./, '');
  if (host === 'calendly.com') return 'calendly';
  if (host === 'cal.com' || host === 'app.cal.com') return 'cal';
  if (host === 'calendar.app.google' || (host === 'calendar.google.com' && path.includes('/appointments')))
    return 'google';
  return 'other';
}

/** A pasted link as a clean https URL, or null if it isn't one. */
export function normalizeBookingUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The link to send one candidate. Calendly and Cal.com fill in the booking
 * form from `name` and `email` in the query, so the candidate only picks a
 * time; other pages get the link as saved.
 */
export function bookingLinkFor(url: string, candidate: { name: string; email: string | null }): string {
  const provider = bookingProvider(url);
  if (provider !== 'calendly' && provider !== 'cal') return url;
  const out = new URL(url);
  out.searchParams.set('name', candidate.name);
  if (candidate.email) out.searchParams.set('email', candidate.email);
  return out.href;
}
