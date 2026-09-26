/**
 * Where the homepage's sample pages live (seeded by server/sample-boards.ts
 * on first visit). Kept here, free of server imports, so client components
 * can link to them.
 */
export const SAMPLE_BOARD_SLUGS = { employer: 'sample-northwind', agency: 'sample-harbor-talent' } as const;

export const SAMPLE_BOARD_URL = {
  employer: `/careers/${SAMPLE_BOARD_SLUGS.employer}`,
  agency: `/careers/${SAMPLE_BOARD_SLUGS.agency}`,
} as const;

/** A fixed share code in the share-links alphabet; never expires. */
export const SAMPLE_PRESENTATION_CODE = 'harbrpresent';
export const SAMPLE_PRESENTATION_URL = `/share/${SAMPLE_PRESENTATION_CODE}`;
