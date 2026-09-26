# Source

**An open source Applicant Tracking System built to match commercial tools like Lever, feature for feature.**

Source is a full-featured recruiting platform: candidate relationship management, pipeline tracking, job postings and career sites, interview scheduling, structured feedback, offers and requisitions, tasks, analytics, AI evaluations, and a public API with signed webhooks — self-hostable and owned by the community.

## What ships today

- **Full hiring loop** — postings (draft → publish → close) with departments or agency clients, hosted careers pages, apply flow with resume upload (PDF, Word, ODT, RTF or TXT) and text extraction, kanban pipeline with customizable stages, bulk actions, interviews with `.ics` invites, 1–4 scorecards with an optional "independent scorecards" bias control, offers with a state machine, requisitions with openings that fill on hire, hire/archive with configurable reasons.
- **CRM** — one contact, many opportunities (the Lever model); tags, full-text search across profiles/resumes/notes, duplicate detection + merge, CSV import, snooze, tasks, notes, and a complete per-candidate activity feed.
- **Email** — templates with merge tokens, scheduled sends, and automation (application confirmations, interview confirmations with calendar invites, delayed rejections, feedback reminders) over any SMTP provider.
- **Candidate experience** — application status portal via magic links, consent records (application + optional talent-network opt-in), withdrawable at any time.
- **Platform** — REST API v1 (hashed bearer keys, cursor pagination, rate limits), signed webhooks with retries and per-endpoint ordering, public postings JSON for embeds, UTM source capture, append-only event stream powering the activity feeds, audit log UI, and CSV/JSON export everywhere.
- **Compliance in core, never paywalled** — GDPR consent tracking, SAR export per candidate, policy-driven retention/anonymization, full-org data export.
- **Migration** — Settings → Import pulls your full history straight from **Lever, Greenhouse, Ashby, Workable, Teamtailor, Recruitee, BambooHR, JazzHR, SmartRecruiters, and Pinpoint** through their APIs, and from 50+ more (Workday, iCIMS, SuccessFactors, Taleo, Jobvite, Breezy…) through **Merge**. It's resumable, safe to re-run, and has you review the stage mapping before anything lands. There's also a lossless org export/import for moving between self-hosted and managed deployments.
- **Interview intelligence** — meeting transcripts attach to candidates and specific interviews (paste in-app, or have Otter/Tactiq/Fireflies-style tools push via `POST /api/v1/transcripts`); the whole corpus is keyword-searchable, and **Ask AI** answers questions across every transcript, resume, and note with cited candidates.
- **Client share views** — short, expiring, read-only links per posting or per client company showing pipeline progress (stages, counts, days in process) with nothing internal: no notes, scorecards, emails, comp, or sources.
- **Resume parsing (bring your own key)** — new applicants' resumes fill in empty profile fields (headline, location, phone, links) in the background after they apply, and a structured profile of their experience, education and skills is kept with the resume. Off until you set `GROQ_API_KEY` (OpenAI's open-weight gpt-oss-20b on Groq, well under a tenth of a cent per resume at September 2026 prices) or point `RESUME_PARSER_BASE_URL` at any OpenAI-compatible endpoint, including a local Ollama. See [docs/resume-parsing.md](docs/resume-parsing.md).
- **AI (Source ATS)** — candidate evaluations against the resume, application, scorecards, and transcripts (advisory only), role criteria, Ask AI, and interview insights. The core has no prompts and calls no model: it sends the material to an AI provider over an open protocol ([docs/ai-protocol.md](docs/ai-protocol.md)). Connect to Source ATS's provider, or run your own with any model (`AI_SERVICE_URL`, `AI_SERVICE_TOKEN`). The app never asks anyone for a key, and the features simply don't appear when it's off.

See [docs/02-feature-parity.md](docs/02-feature-parity.md) for the full Lever parity matrix with per-feature status.

## Self-host in one command

```bash
docker compose up
# → http://localhost:3000/signup
```

Postgres is the only hard dependency. Resume files land in a Docker volume (or any S3-compatible bucket: R2, B2, MinIO — see `.env.example`); set `SMTP_URL` to send real email (unset = emails are logged, dev mode). Resume text is extracted in-process with open-source libraries, so reading files costs nothing; filling in profile fields from that text is optional and uses your own model key ([docs/resume-parsing.md](docs/resume-parsing.md)). The `/api/cron/resume-text` cron fills in text for any resume that doesn't have it yet, and `/api/cron/ocr` reads scanned (image-only) PDFs and image resumes with Tesseract, in-process and without any key (`OCR_LANGS` picks the languages; English by default). See [docs/07-migration.md](docs/07-migration.md) for moving an organization between a self-hosted install and the hosted service.

## Development

```bash
npm install
cp .env.example .env   # DATABASE_URL/DIRECT_URL + AUTH_SECRET (openssl rand -base64 32)
npm run db:deploy      # apply migrations (baselines db-push-era databases once)
npm run dev
```

Tests: `npm test` runs the unit tests. To include the database suites (CSV import, analytics, paging, export → import), point them at a throwaway local database — it's wiped on every run:

```bash
createdb source_test
TEST_DATABASE_URL=postgresql://localhost/source_test npm test
```

Changing the schema? Edit `prisma/schema.prisma`, then `npm run db:migrate -- --name what_changed` to generate a migration — commit it with your change. Self-hosters get it applied on their next upgrade.

Sign up at `/signup` — this creates your organization with a default pipeline and makes you super admin. Auth is NextAuth (Auth.js) credentials + JWT; no external auth service required. Deploys cleanly to Vercel + Neon (crons in `vercel.json`).

### Sign in with Google (optional)

Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` and the sign-in and sign-up pages get a **Continue with Google** button. Leave them unset and nothing mentions Google. Each deployment uses its own Google OAuth client:

1. In the [Google Cloud Console](https://console.cloud.google.com/), pick or create a project, then open **Google Auth Platform** (formerly *APIs & Services → OAuth consent screen*) and click **Get started**. Give the app a name (e.g. "Source") and a support email, choose the audience (**External** lets any Google account sign in; **Internal** limits it to your Google Workspace organization), add a contact email, and create it. Source asks only for `openid`, `email` and `profile`, which Google doesn't review. Skip the logo, which makes Google verify your brand first.
2. An External app starts in *Testing*, where only the test users you list can sign in. Under **Audience**, click **Publish app** when you're ready for everyone.
3. Under **Clients**, click **Create client** and choose **Web application**. Add:
   - Authorized JavaScript origins: your domain, e.g. `https://ats.example.com`, and `http://localhost:3000`
   - Authorized redirect URIs: `https://ats.example.com/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`

   Keep the `localhost` pair only if you also develop against this client.
4. Click **Create** and copy the client ID and the client secret right away: Google shows the secret only once. Put them in `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` (on Vercel: Project → Settings → Environment Variables, then redeploy). Outside Vercel, also set `AUTH_TRUST_HOST=true` (or `AUTH_URL`) so the callback uses your public address.

Only addresses Google has verified are accepted. An existing account (an invited teammate, or a password user) is linked to a Google account on its first Google sign-in only when Google speaks for the address: a Gmail address, or a Google Workspace account on the address's own domain. A personal Google account made with a work address is refused for existing accounts, because Google checked that mailbox only once, when the account was made. Those people sign in with their password. Once linked, that Google account always signs in, and a different Google account with the same address is refused. Someone whose address is in several workspaces picks one. A new address, from any verified Google account, gets the same short "create your workspace" step as a password sign-up.

### Migrating from another ATS

Sign up, then go to **Settings → Import from another ATS**. Paste an API key and pick what to bring over: candidates, applications with stage history, jobs, notes, scorecards, interviews, offers, and resumes. Confirm how the other system's stages map to yours, and the import runs in the background. The job page drives it while it's open, and the `/api/cron/imports` cron runs it every minute when nobody is watching. See [docs/07-migration.md](docs/07-migration.md#migrating-from-another-ats) for what each provider brings over.

```bash
npm run import-org -- export.json --slug new-slug   # Source ↔ Source
```

## Documentation

| Doc | Purpose |
|-----|---------|
| [docs/01-vision.md](docs/01-vision.md) | Goals, target users, licensing, guiding principles |
| [docs/02-feature-parity.md](docs/02-feature-parity.md) | Feature-for-feature parity matrix against Lever, with status |
| [docs/03-architecture.md](docs/03-architecture.md) | Tech stack, system design, deployment |
| [docs/04-data-model.md](docs/04-data-model.md) | Core entities and relationships |
| [docs/05-api-design.md](docs/05-api-design.md) | Public REST API and webhooks |
| [docs/06-roadmap.md](docs/06-roadmap.md) | Phased delivery plan to full parity |
| [docs/07-migration.md](docs/07-migration.md) | Moving between deployments, and importing from another ATS |
| [docs/ai-protocol.md](docs/ai-protocol.md) | The AI provider protocol: run your own model behind Source's AI features |

## Stack

Next.js 16 (App Router, TypeScript) · Prisma + Postgres (Neon serverless or any Postgres) · NextAuth · Tailwind v4 with the B150 design system (Geist/Fragment Mono, warm cream light theme, `#121212` dark) · Vercel Cron or any crontab for background work · an S3-compatible bucket (Cloudflare R2 recommended), Vercel Blob, or local disk for files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). High-value contributions right now: production feedback from people who have run Lever/Greenhouse/Ashby, calendar-sync design review, and importer coverage for more source systems. Security reports go through [SECURITY.md](SECURITY.md), never a public issue.

## License

Source is free software under the [GNU Affero General Public License v3.0](LICENSE). You can run, study, change and share it; if you run a modified version as a service for others, you share your changes under the same license. Contributions come in under the [contributor license agreement](CLA.md).
