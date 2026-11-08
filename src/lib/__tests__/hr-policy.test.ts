import { describe, expect, it } from 'vitest';
import {
  attendanceStatus,
  checkInIsDue,
  hoursBetween,
  isLate,
  isWorkday,
  leaveBalance,
  leaveDays,
  rangesOverlap,
  workDateOf,
} from '@/lib/hr-policy';

// Asia/Dhaka is UTC+06:00 with no DST, so these instants are unambiguous.
const dhaka = (iso: string) => new Date(`${iso}+06:00`);

describe('work day and lateness (Asia/Dhaka)', () => {
  it('takes the work date from the policy timezone, not UTC', () => {
    // 01:00 Dhaka on the 10th is still the 9th in UTC.
    expect(workDateOf(dhaka('2026-11-10T01:00:00'))).toBe('2026-11-10');
    expect(workDateOf(new Date('2026-11-09T20:00:00Z'))).toBe('2026-11-10');
  });

  it('allows the 15-minute grace after 09:30', () => {
    expect(isLate(dhaka('2026-11-10T09:45:00'))).toBe(false);
    expect(isLate(dhaka('2026-11-10T09:46:00'))).toBe(true);
    expect(isLate(dhaka('2026-11-10T08:50:00'))).toBe(false);
  });

  it('treats Friday and Saturday as off days', () => {
    expect(isWorkday('2026-11-08')).toBe(true); // Sunday
    expect(isWorkday('2026-11-13')).toBe(false); // Friday
    expect(isWorkday('2026-11-14')).toBe(false); // Saturday
  });

  it('only calls a missing check-in due after start plus grace', () => {
    expect(checkInIsDue(dhaka('2026-11-10T09:45:00'))).toBe(false);
    expect(checkInIsDue(dhaka('2026-11-10T09:46:00'))).toBe(true);
  });
});

describe('attendance status', () => {
  const today = '2026-11-10';
  it('reports a missing check-in as NOT_CHECKED_IN', () => {
    expect(attendanceStatus(null, dhaka('2026-11-10T11:00:00'), today)).toBe('NOT_CHECKED_IN');
  });
  it('flags an open record from an earlier day as INCOMPLETE', () => {
    const open = { workDate: '2026-11-09', checkInAt: dhaka('2026-11-09T09:00:00'), checkOutAt: null };
    expect(attendanceStatus(open, dhaka('2026-11-10T10:00:00'), today)).toBe('INCOMPLETE');
  });
  it('marks a late check-in today as LATE, an on-time one as CHECKED_IN', () => {
    const late = { workDate: today, checkInAt: dhaka('2026-11-10T10:30:00'), checkOutAt: null };
    const onTime = { workDate: today, checkInAt: dhaka('2026-11-10T09:20:00'), checkOutAt: null };
    expect(attendanceStatus(late, dhaka('2026-11-10T11:00:00'), today)).toBe('LATE');
    expect(attendanceStatus(onTime, dhaka('2026-11-10T11:00:00'), today)).toBe('CHECKED_IN');
  });
  it('is OFF_DAY on a weekend regardless of records', () => {
    expect(attendanceStatus(null, dhaka('2026-11-13T11:00:00'), '2026-11-13')).toBe('OFF_DAY');
  });
});

describe('hours and leave math', () => {
  it('computes worked hours to two decimals and never negative', () => {
    expect(hoursBetween(dhaka('2026-11-10T09:00:00'), dhaka('2026-11-10T17:20:00'))).toBe(8.33);
    expect(hoursBetween(dhaka('2026-11-10T17:00:00'), dhaka('2026-11-10T09:00:00'))).toBe(0);
  });

  it('counts leave days inclusively and skips Fri/Sat', () => {
    // Mon 9 → Mon 16 Nov 2026: 6 weekdays, Sat and Fri out.
    expect(leaveDays('2026-11-09', '2026-11-16')).toBe(6);
    expect(leaveDays('2026-11-13', '2026-11-14')).toBe(0);
    expect(leaveDays('2026-11-10', '2026-11-10')).toBe(1);
    expect(leaveDays('2026-11-12', '2026-11-10')).toBe(0);
  });

  it('never returns a negative balance', () => {
    expect(leaveBalance(20, 7)).toBe(13);
    expect(leaveBalance(5, 9)).toBe(0);
  });

  it('detects overlapping inclusive date ranges', () => {
    expect(rangesOverlap('2026-11-10', '2026-11-12', '2026-11-12', '2026-11-15')).toBe(true);
    expect(rangesOverlap('2026-11-10', '2026-11-11', '2026-11-12', '2026-11-15')).toBe(false);
  });
});
