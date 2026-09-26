// Defaults seeded into every new organization (signup and demo mode).
// Kept out of the 'use server' actions file so non-action code can import them.

// Leads (sourced) and applicants (inbound) arrive separately; the interview
// process after them is the part each team makes its own.
export const DEFAULT_STAGES = [
  { name: 'New lead', type: 'LEAD', order: 0 },
  { name: 'Reached out', type: 'LEAD', order: 1 },
  { name: 'Responded', type: 'LEAD', order: 2 },
  { name: 'New applicant', type: 'APPLICANT', order: 3 },
  { name: 'Phone screen', type: 'SCREEN', order: 4 },
  { name: 'On-site', type: 'ONSITE', order: 5 },
  { name: 'Offer', type: 'OFFER', order: 6 },
  { name: 'Hired', type: 'HIRED', order: 7 },
] as const;

export const DEFAULT_ARCHIVE_REASONS = [
  { name: 'Underqualified', countsAsRejection: true },
  { name: 'Culture / values mismatch', countsAsRejection: true },
  { name: 'Timing', countsAsRejection: false },
  { name: 'Withdrew', countsAsRejection: false },
  { name: 'Offer declined', countsAsRejection: false },
  { name: 'Position filled', countsAsRejection: false },
];
