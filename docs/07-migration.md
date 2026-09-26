# Deployment and migration

Source runs the same way wherever it's deployed: your own server, or the
hosted service, Source ATS. This covers what that means for the codebase,
how an organization moves between deployments, and how to bring your data
over from another ATS.

## One codebase, any deployment

- **Multi-tenant by design** — every table is org-scoped, so a hosted service is one deployment with many orgs, and a self-hosted install is the same code with one (or many — agencies can host clients).
- **Adapter-based externals** — email is `SMTP_URL` (any provider) with a dev fallback; scheduled work is a plain HTTP cron endpoint (`/api/cron/emails`) driven by Vercel Cron or any crontab.
- **No proprietary services in the request path** — Postgres is the only hard dependency; Neon is just Postgres.

## Moving an organization between deployments

The unit of migration is the **organization export**: Settings → Data export downloads a single versioned JSON file (`exportVersion: 1`) containing the org, users (no credentials), departments/clients, stages, archive reasons, contacts, postings, opportunities, full stage-transition history, interviews, feedback, notes, email templates/messages, and the complete event stream.

- **Self-hosted → hosted**: export from your instance, import into a fresh org on the hosted service (Source ATS). Because both run the same Prisma schema, the import is a mechanical ID-remapping load, not a lossy translation.
- **Hosted → self-hosted** (no lock-in): the same export is available on Source ATS; import into your own instance. For large orgs, a raw Postgres dump path can also be offered on request — it is literally the same schema.

**Status:** both halves ship now. Export (v2 — includes tasks, offers, requisitions, transcripts, custom fields, plan steps, saved reports, and aggregate EEO data) from Settings → Data export; import with `npm run import-org -- export.json --slug new-slug` against the target deployment's DATABASE_URL (v1 files still import). IDs are remapped mechanically; teammates reset passwords after import (credentials never migrate); file binaries move separately from blob/disk storage.

## Migrating from another ATS

Switching cost is the moat incumbents rely on, so the importers ship in core. An admin goes to **Settings → Import from another ATS**, picks a provider, and pastes an API key. The key is sealed with AES-256-GCM (derived from `IMPORT_ENCRYPTION_KEY`, falling back to `AUTH_SECRET`) and deleted when the job ends. Then Source:

1. **Reads the setup** — users, pipeline stages, and archive/rejection reasons. Nothing is written yet.
2. **Asks you to review the mapping.** Stages are grouped by name, so fifty jobs' "Phone Screen" become one row. Each group either maps to one of your stages or creates a new one with an inferred type. Reasons work the same way. Teammates are matched by email. Notes and scorecards by people who aren't on your team are credited to the importing admin, with the original author's name kept in the text.
3. **Loads the data** in dependency order: requisitions, jobs, candidates, applications with full stage history, interviews, scorecards, notes, offers, then resumes (with text extraction for PDF, Word, ODT, RTF and TXT, so they're searchable; `/api/cron/resume-text` retries any that fail).

How it behaves:

- **Resumable.** The job runs in bounded slices and checkpoints after every page. The job page drives it while it's open; `/api/cron/imports` drives it every minute otherwise. A lease makes sure only one worker runs a job at a time, so a timeout or deploy mid-import just resumes.
- **Safe to re-run.** Every imported record is recorded in `ImportRef` (provider + vendor id → Source id). Running an import again adds what's new since last time, and for Lever also updates what changed there (a candidate moved, rejected or hired, an edited note, a new resume) while keeping any change the team made in Source, so you can import early, keep working in the old system, and run it again at cutover. Other importers add new records only, for now. A candidate who was erased or anonymized in Source stays erased: re-imports never bring them back.
- **Quiet.** Imports write history directly. They don't send confirmation emails, mint scheduling links, fill requisitions, or fan thousands of events out to your webhooks. The audit log gets `import.started`, `import.completed`, `import.failed`, and `import.canceled`.
- **Nothing goes live by accident.** Open jobs arrive as drafts, and closed jobs arrive closed.
- **Candidates are deduplicated** against your existing contacts by email, so someone who already applied through Source is linked, not duplicated.
- **Your retention policy applies.** If the org anonymizes archived candidates after N months, imported candidates archived longer ago than that are anonymized on the next nightly run. Their stage history stays for reporting.

| Provider | Credentials | What comes across | Gaps in the vendor's API |
|---|---|---|---|
| Lever | Data API key (Super Admin, "Select all read") | Jobs, requisitions, candidates, applications and stage history, notes, feedback, interviews, offers, resumes and files | No account name or departments as entities |
| Greenhouse | Harvest **v3** OAuth client ID + secret (v1/v2 were shut off on Aug 31, 2026) | Jobs, openings, candidates, applications and stage history, notes, scorecards, interviews, offers, attachments | Stage-change actor not exposed |
| Ashby | API key with Read on Candidates, Jobs, Interviews, Hiring Process, Organization, Offers | Jobs, candidates, applications and history, notes, feedback, interviews, offers, resumes | EEO not exposed |
| Workable | Account token (`r_jobs`, `r_candidates`) + subdomain | Jobs, candidates, applications and stage moves, comments, ratings, offers, resumes | Rate limit is 10 requests per 10 s, so large accounts take hours |
| Teamtailor | Admin-scope Read key + region | Jobs, candidates, applications and stage moves, notes, scorecards, offers, resumes | No scheduled-interview endpoint |
| Recruitee, BambooHR, JazzHR, SmartRecruiters, Pinpoint | See the in-app steps | Candidates, applications, and jobs, plus whatever each API exposes | Shown as caveats in the app before you start |
| Merge (50+ systems: Workday, iCIMS, SuccessFactors, Taleo, Jobvite, Breezy…) | Your Merge API key + linked-account token | Whatever Merge's common model carries for that system | Varies by source system; needs your own Merge account |

The older file-based scripts still work for offline dumps, but they don't share the in-app importer's ledger, so use one or the other for a given account (mixing them duplicates records): `npm run import-lever` for a [lever-export](https://github.com/theck01/lever-export) directory, and `npm run import-greenhouse` for Harvest v1 JSON dumps you already have. Harvest v1 no longer serves live data.
