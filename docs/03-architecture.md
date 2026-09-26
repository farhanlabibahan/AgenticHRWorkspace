# Architecture

## Goals that drive the design

1. Ship fast on a modern, zero-ops stack: **Next.js on Vercel with Neon Postgres**.
2. Multi-tenant, API-first, integration-heavy (email, calendars, job boards, e-sign).
3. Stay open source friendly: everything must also run outside Vercel (Docker + any Postgres) even if Vercel is the primary path.

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15 (App Router, React 19, TypeScript)** — one app | UI, server actions, and API route handlers in a single deployable; same stack as B150 so patterns/components transfer |
| Hosting | **Vercel** | Zero-ops deploys, preview envs per PR, edge caching for careers pages |
| Database | **Neon (serverless Postgres)** | Postgres semantics with serverless scaling, branching for preview envs (pairs with Vercel previews) |
| ORM | **Prisma** | Proven with Neon (`@prisma/adapter-neon` / pooled connection string), same as B150 |
| Auth | **NextAuth (Auth.js)** | Email/password + Google/Microsoft OAuth; SSO (SAML/OIDC) later via provider |
| Styling | **Tailwind CSS v4 + shadcn/ui**, B150 design tokens | Shared look and feel with B150 (cream light theme, #121212 dark theme, Geist + Fragment Mono) |
| Background jobs | **Vercel Cron + Inngest** (or QStash) behind a thin job abstraction | Vercel has no long-lived workers; the abstraction keeps a self-host path (pg-boss on plain Postgres) open |
| File storage | **Any S3-compatible bucket** (Cloudflare R2 recommended: no egress fees), or Vercel Blob, or local disk — one adapter in `src/server/storage.ts` | Resumes, attachments, offer PDFs |
| Search | **Postgres full-text search** (Neon) first; Meilisearch optional later | No extra infra for MVP; FTS covers names/emails/notes/resume text |
| Email out | Provider adapter: **Resend** default, SMTP fallback | Templates + merge tokens rendered server-side (React Email) |
| Email sync | Gmail API + Microsoft Graph adapters (job-driven) | Two-way threading onto profiles (Phase 3) |
| Calendar | Google Calendar API + Microsoft Graph | Free/busy, event CRUD, sync webhooks (Phase 3) |
| Resume parsing | In-process text extraction with open-source libraries, in a worker thread (`src/server/text`): PDF via unpdf's bundled pdf.js, legacy .doc via word-extractor, built-in readers for DOCX, ODT, RTF, TXT and HTML; heuristic signals (links, phones). Optional field parsing: an OpenAI-compatible chat model with your own key (`src/server/resume-parse`), run in the background after apply, filling only empty fields; off by default | Reading text needs no paid service and has no per-file cost (field parsing costs what your provider charges); the format is sniffed from the bytes, never the upload's MIME type |
| OCR for scanned resumes | **Tesseract** via tesseract.js 7 (Apache-2.0, WebAssembly, in-process; English `4.0.0_best_int` data from `@tesseract.js-data/eng`), in the background only (`/api/cron/ocr`, `src/server/resume-ocr.ts`). A PDF's page images come from pdfjs-dist's own build, without rendering: its WebAssembly decoders read the CCITT, JBIG2 and JPEG 2000 images scanners and faxes write, which unpdf's bundled pdf.js can't. Image files (PNG, JPEG, WebP, GIF, TIFF, BMP), which imports bring, go to Tesseract directly. Text is kept only when Tesseract's confidence is at least 50 and there are at least 100 characters | No model service, no key, no per-page cost, and identical for self-hosters: about 1-3 s of CPU a page. Not a Chinese-developed model and not an AI API. OCR only reads resumes with no text at all (EMPTY, or an image); a PDF with a small text layer keeps the text it has, because OCR never overwrites a contact's text |
| Realtime | Polling/SWR first; Pusher/Ably adapter or SSE later | Vercel-friendly |
| Observability | Vercel Analytics + Sentry, structured logs | Same setup as B150 |

## System diagram

```
 candidates ──▶  /careers/[org]  (public, edge-cached, SSR)
 recruiters ──▶  /(app)/…        (authed app: pipeline, profiles, postings…)
 3rd parties ─▶  /api/v1/…       (public REST API, key-scoped)
                      │
        ┌─────────────┴──────────────┐
        │   Next.js on Vercel        │
        │  server actions + route    │
        │  handlers + RSC            │
        └───┬────────┬──────────┬────┘
            │        │          │
            ▼        ▼          ▼
        Neon      Vercel     Inngest / Vercel Cron
      (Postgres)   Blob      (email sends, syncs, webhooks,
            │              newsletters, parsing, retention)
            ▼
   Prisma schema = single source of truth
```

One Next.js app, three surfaces:

- **`/(app)`** — the authed recruiter/admin product.
- **`/careers/[orgSlug]`** — hosted careers pages + apply flow (public, cacheable; also exposed as JSON for embeds).
- **`/api/v1`** — the public REST API + webhooks (route handlers), documented via OpenAPI.

## Repo layout

```
/
├── prisma/
│   ├── schema.prisma        # single source of truth for the data model
│   └── seed.ts
├── public/fonts/            # Geist + Fragment Mono (same as B150)
├── src/
│   ├── app/
│   │   ├── (app)/           # authed product: pipeline, contacts, postings, interviews, settings…
│   │   ├── careers/[org]/   # public careers site + apply
│   │   ├── api/v1/          # public REST API route handlers
│   │   ├── api/auth/        # NextAuth
│   │   ├── layout.tsx       # fonts + theme (B150 tokens)
│   │   └── globals.css      # Tailwind v4 @theme — B150 design tokens
│   ├── components/          # shared UI (shadcn + app components)
│   ├── lib/                 # db client, auth, storage/email/job adapters, api helpers
│   ├── server/              # domain services (the only layer that mutates data; emits events)
│   └── jobs/                # Inngest functions / cron handlers
├── docs/                    # planning + ADRs
└── e2e/                     # Playwright
```

## Key design decisions

### Vercel + Neon specifics
- **Connection handling:** Prisma with Neon's pooled connection string (PgBouncer) for serverless functions; `directUrl` for migrations.
- **Preview environments:** each PR gets a Vercel preview + a Neon branch — full-stack previews with real (branched) data.
- **Job execution:** anything slow, retryable, or scheduled (email sync, newsletters, webhook delivery, retention sweeps, parsing) runs via Inngest functions triggered by events/cron — not in request handlers. A thin `enqueue(event)` abstraction keeps us portable.
- **Resume text:** read inline when a candidate applies (milliseconds for a typical resume, capped at 5 s including any wait behind other extractions) because recruiters want it on the profile right away. Each file records a text status. The `/api/cron/resume-text` cron (every 10 minutes, self-chaining while work is left) fills in text for resumes that have none: a file that fails gets up to 3 attempts, 15 minutes apart, and bumping `EXTRACTOR_VERSION` retries everything still empty. Extraction runs in a worker thread, so a malicious or huge PDF is killed on a timeout or memory limit instead of stalling the server.
- **Scanned resumes (OCR):** never at apply time, which must stay fast. The `/api/cron/ocr` cron (every 10 minutes, self-chaining, one run at a time, a 230 s budget and 60 s a file) takes resumes whose text extraction settled with nothing (EMPTY, or UNSUPPORTED for an image) and whose contact has no text. A PDF page is OCR'd when its text layer has fewer than 50 non-whitespace characters and it paints one image that covers at least half the page with a short side of 600 px or more; at most 3 pages, averaged down toward 300 dpi, turned upright from the page's /Rotate and the image's transform, and tried upside down and sideways when it reads badly. A document with 200 or more characters of text layer isn't a scan. Page images are found in a worker thread of their own; Tesseract runs in the worker thread tesseract.js starts. Each file records `ocrStatus`: OK (the contact's text came from OCR, and the profile says "Read from a scan — may contain errors"), LOW_CONFIDENCE and SKIPPED (final until `OCR_VERSION` is bumped), or FAILED (a crash or timeout, up to 3 attempts, 15 minutes apart). A careers application whose resume is a scan is queued for parsing and waits there for OCR's text. `?selftest=1` OCRs a built-in scan without touching the database (Vercel previews allow it without the secret). Only this function carries OCR's files, about 42 MB (see `next.config.ts`).
- **OCR languages:** `OCR_LANGS` (default `eng`; `eng+fra` for two). Each language is its own package: `npm install @tesseract.js-data/fra@1.0.0`, then set `OCR_LANGS` before building, so the build traces its data for the OCR function.
- **Meeting notetakers (MCP):** each person connects their own Fireflies, Fathom, Metaview, Granola, Otter or Circleback account in Settings → Integrations, by signing in (OAuth with PKCE; dynamic registration, or a client ID metadata document at `/oauth/mcp-client.json` where the authorization server takes one) or with a personal API key (Fireflies, Metaview). Source is the MCP client (`@modelcontextprotocol/client`, streamable HTTP; `src/server/notetakers`). The `/api/cron/transcripts` cron (every 10 minutes, one run at a time, a 240 s budget) lists each connection's meetings since its last sync, less two hours, and keeps only those starting within 30 minutes of an interview the person sits on or owns: with a candidate email among the attendees the transcript is attached (`addTranscript`, then the usual insights step when AI is configured); with only the candidate's full name (notetakers that know names only, like Walkie) or only the time lining up, it waits on the Interviews page for that person to say who it was with, since two candidates can share a name. That review card is worked out when the page renders (`review.ts`): the person's interviews within two hours with why each is offered, candidates anywhere in the org with a participant's name, a same-name warning, and a search. From a candidate's side, "Attach a recording" on an interview lists the person's meetings 12 hours either side live from each notetaker (`picker.ts`) and stores nothing until one is chosen. Every other meeting is dropped in memory, never stored. The provider isn't called at all while the person has no interview in the window. Credentials are sealed with AES-256-GCM (as import keys are); a token or key that stops working marks the connection "needs reconnecting" rather than failing quietly.
- **Self-host escape hatch (OSS promise):** Dockerfile + docker-compose (Next.js standalone, plain Postgres, pg-boss job runner, S3/MinIO storage adapter). Vercel/Neon/Blob/Inngest are defaults, not hard dependencies. CI builds the Docker image to keep this path honest.

### Multi-tenancy
- Single Neon database, `orgId` on every tenant-scoped table; enforced in the data-access layer (all queries go through org-scoped helpers) with cross-tenant access tests. Postgres RLS as a later hardening step.
- Files stored under per-org prefixes; signed URLs only.

### Domain model: Contact vs Opportunity
Lever's split (see [04-data-model.md](04-data-model.md)): a **Contact** is a person; an **Opportunity** is that person in a hiring context. This enables CRM/nurture, talent pools, re-discovery, and simultaneous processes per person.

### Event-sourced activity, not event-sourced state
State lives in normal tables, but **every domain mutation (in `src/server/` services) also appends an immutable `Event` row** (actor, verb, entity, payload, org, timestamp). This one stream powers: profile activity feeds, audit log, webhook fan-out, analytics stage-transition facts, automation triggers, and Inngest event delivery. Cheap now, impossible to retrofit later.

### Automation engine
Rules = trigger (event type + filter) → conditions → actions (send template, move stage, create task, request feedback, call webhook), executed as Inngest functions consuming the event stream. Ships P3; the event stream ships P1.

### Long lists (pipeline, contacts)
- **Keyset pages, never OFFSET.** Rows come 100 at a time after an opaque cursor (the last row's sort key), from `src/server/lists`; the first page renders with the page, later ones come from `GET /api/lists/{pipeline,contacts}`. Every page costs what the first does, and inserts or archives between pages can't skip or repeat a row. One SQL WHERE builder serves the pipeline's rows (both sorts) and its stage counts, so they never disagree.
- **Cached per-org data.** The pipeline's meta (stages, postings, clients, archive reasons, org kind; 5 min), its tile counts (keyed by scope, never by stage; 20 s), and the contacts' pool counts and totals (1-2 min) sit in Next's data cache under `list-meta:<org>`, `pipeline-counts:<org>` and `contact-counts:<org>`. Every server-layer write that changes them expires the tag, so you always see your own edits. Writes that can't (another instance's in-memory cache on a multi-node self-host, the CLI importers) show up within the TTL.
- **Sorting by name** picks its plan from the tile's real size in the same statement: a tile of up to 5,000 opportunities (100 matches when searching) is read whole and sorted; a bigger one walks `Contact_name_sort_idx`. Walking names for a tile with few candidates would visit every contact in the org.
- **Instant switching.** Stage tiles and filters are optimistic; the browser keeps a small row cache of first pages filled on hover, focus, in idle time and at the click, so a switch usually paints its rows at once while the server render confirms it. A page is fresh for 30 s; after that it can still be shown for a pending switch for 5 minutes (the server's render replaces it within a round trip), and while someone is using the page (pointer, keys, scrolling) the warmed tiles that went stale load again — an idle tab sends nothing. Any edit clears it. Tiles counting no one get an empty page without a request. `NEXT_PUBLIC_LIST_PREFETCH=off` turns the background prefetching off.
- **Bounded DOM, short tasks.** Past 300 loaded rows the tables are windowed; below that, a new list mounts 30 rows in its first frame and the rest 25 per task, as does each appended page, so no mount holds the main thread for long. Scrolling loads pages automatically up to 5,000 rows, then the Load more button carries on.

### Feedback forms / custom fields
Versioned JSON definitions; submissions store `{definitionVersion, answers}` in JSONB. Reporting interprets definitions — org config changes never require schema migrations.

### Scheduling
`CalendarProvider` interface (freeBusy, createEvent, updateEvent, watch); Google + Microsoft implementations. Slot computation and panel logic are pure TS in `src/server/scheduling` — provider-agnostic and heavily unit-tested. Manual scheduling always remains a fallback.

### Email
- Outbound: React Email templates + merge tokens → provider adapter (Resend default, SMTP fallback) → logged as Events; open/click tracking org-toggleable.
- Two-way sync: per-user OAuth to Gmail/Microsoft; Inngest jobs poll/subscribe and thread messages onto profiles by address matching. Sync state machine isolated in jobs; failures never block the UI.

### Public API & webhooks
- REST under `/api/v1`, OpenAPI spec, cursor pagination, scoped API keys; shape intentionally close to Lever's API v1 ([05-api-design.md](05-api-design.md)).
- Webhooks: HMAC-signed, at-least-once via Inngest with exponential backoff, delivery log UI.

### Compliance plumbing
- EEO/self-ID answers in a separate restricted table; only aggregate reporting reads them.
- Retention: scheduled job anonymizes/deletes contacts past their basis window; consent state machine on the contact.
- Column-level encryption for provider tokens and sensitive fields.

## Design system (from B150)

Shared visual language with the B150 project:

- **Fonts:** Geist (sans, local woff2) + Fragment Mono (mono), loaded via `next/font/local`.
- **Light theme:** warm cream — `--color-primary: #F2EFE9` (page bg), `#F7F5F1` secondary, white cards, `#E6E3DD` borders/inputs, black text, `#6d6d6d` muted.
- **Dark theme:** `#121212` bg, `#1e1e1e/#242424` surfaces, `#404040` borders, white text.
- **Accents:** blue `#59A0E2`, green `#769447`, red `#E25F59`, purple `#A259E2`, coral `#FA725A`, amber `#B38600` (dark variants per B150).
- **Motion:** Apple iOS easing `cubic-bezier(0.25, 0.1, 0.25, 1)`, 150–400ms fades/slides.
- Tokens live in `src/app/globals.css` as a Tailwind v4 `@theme` block (utilities like `bg-primary`, `text-text-muted`, `border-border` come straight from the tokens); shadcn/ui components themed on top.

## Open technical decisions

| Decision | Leading option | Alternative |
|---|---|---|
| Job runner | Inngest | QStash + Vercel Cron; pg-boss for self-host |
| Blob storage | Cloudflare R2 (S3 API) | Vercel Blob, S3, B2, MinIO (same adapter) |
| Realtime | SWR polling → SSE | Pusher/Ably |
| SAML SSO (P3) | WorkOS or BoxyHQ SAML Jackson (OSS) | Custom samlify integration |
