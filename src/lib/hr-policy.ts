/**
 * HR attendance and leave policy, as pure functions. No database, no clock
 * reads: callers pass the instant. Everything the HR agents decide with comes
 * from here, so it can be unit-tested and read in one place.
 */

export const HR_POLICY = {
  /** IANA zone the work day and the start time are measured in. */
  timezone: 'Asia/Dhaka',
  /** Local start of the working day, HH:MM. */
  workStart: '09:30',
  /** Minutes after workStart before a check-in counts as late. */
  graceMinutes: 15,
  /** Standard paid hours in a work day. */
  standardHours: 8,
  /** Day-of-week numbers (0 = Sunday) that are off by default. */
  weekendDays: [5, 6],
} as const;

export type AttendanceStatus =
  | 'OFF_DAY'
  | 'NOT_CHECKED_IN'
  | 'CHECKED_IN'
  | 'LATE'
  | 'CHECKED_OUT'
  | 'INCOMPLETE';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: HR_POLICY.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: HR_POLICY.timezone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The work day (YYYY-MM-DD) an instant falls on, in the policy timezone. */
export function workDateOf(instant: Date): string {
  return dateFmt.format(instant);
}

/** Minutes past local midnight for an instant, in the policy timezone. */
export function localMinutesOf(instant: Date): number {
  const [hh, mm] = timeFmt.format(instant).split(':').map(Number);
  return hh * 60 + mm;
}

export function parseHHMM(value: string): number {
  const [hh, mm] = value.split(':').map(Number);
  return hh * 60 + mm;
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD work date. Calendar math, no timezone. */
export function weekdayOf(workDate: string): number {
  const [y, m, d] = workDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWorkday(workDate: string): boolean {
  return !(HR_POLICY.weekendDays as readonly number[]).includes(weekdayOf(workDate));
}

/** Minutes after the start time (negative = early). */
export function minutesFromStart(checkIn: Date): number {
  return localMinutesOf(checkIn) - parseHHMM(HR_POLICY.workStart);
}

export function isLate(checkIn: Date): boolean {
  return minutesFromStart(checkIn) > HR_POLICY.graceMinutes;
}

/** Hours between two instants, two decimals. Zero when the times are reversed. */
export function hoursBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return 0;
  return Math.round((ms / 3_600_000) * 100) / 100;
}

export type AttendanceRecord = {
  workDate: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
};

/**
 * Where a person stands on one work day. `now` decides whether a missing
 * check-in is final (the day is over) or just not yet due.
 */
export function attendanceStatus(
  record: AttendanceRecord | null,
  now: Date,
  today: string,
): AttendanceStatus {
  if (!isWorkday(record?.workDate ?? today)) return 'OFF_DAY';
  if (!record?.checkInAt) return 'NOT_CHECKED_IN';
  if (record.checkOutAt) return 'CHECKED_OUT';
  if (record.workDate < today) return 'INCOMPLETE';
  return isLate(record.checkInAt) ? 'LATE' : 'CHECKED_IN';
}

/** True once the day's start-plus-grace has passed, so a missing check-in is an exception. */
export function checkInIsDue(now: Date): boolean {
  return localMinutesOf(now) > parseHHMM(HR_POLICY.workStart) + HR_POLICY.graceMinutes;
}

/** Inclusive calendar days from start to end (YYYY-MM-DD), weekends excluded. */
export function leaveDays(startDate: string, endDate: string): number {
  if (endDate < startDate) return 0;
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  let cursor = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  let count = 0;
  while (cursor <= end) {
    const weekday = new Date(cursor).getUTCDay();
    if (!(HR_POLICY.weekendDays as readonly number[]).includes(weekday)) count += 1;
    cursor += 86_400_000;
  }
  return count;
}

export function leaveBalance(annualDays: number, usedDays: number): number {
  return Math.max(0, annualDays - usedDays);
}

/** Two inclusive YYYY-MM-DD ranges overlap. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
