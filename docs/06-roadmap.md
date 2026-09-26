# Roadmap

Phased plan from empty repo to Lever parity. Each phase ends in a shippable, self-hostable release. Phase numbers are referenced by the parity matrix ([02-feature-parity.md](02-feature-parity.md)).

Durations assume a small core team (2–4 engineers) plus community contributions; treat them as sequencing, not commitments.

---

## Phase 0 — Foundation (repo scaffold) · ~2–4 weeks

**Goal: a contributor can clone, run, and ship a PR with CI green.**

- Settle open decisions: license (default AGPL-3.0), ORM (Prisma vs Drizzle), REST-vs-tRPC for first-party app.
- Monorepo scaffold per [03-architecture.md](03-architecture.md): pnpm + Turborepo, `apps/{api,web,careers,worker}`, `packages/{db,core,ui,sdk,config}`.
- Docker Compose dev stack (Postgres, Redis, Meilisearch, MinIO, Mailpit) + first-run seed.
- CI: lint, typecheck, unit + e2e smoke, Docker build.
- Auth skeleton: org signup, email/password + TOTP, sessions, base roles.
- Multi-tenancy plumbing: `org_id` scoping in the data layer + RLS backstop + cross-tenant tests.
- **Event stream table + emit helper** (everything later depends on it).
- CONTRIBUTING, code of conduct, ADR (architecture decision record) process.

**Exit criteria:** `docker compose up` → sign up → log in → empty dashboard; CI enforced on PRs.

## Phase 1 — Usable core ATS (MVP) · ~2–3 months

**Goal: a small company can actually run hiring on it.**

- Contacts + Opportunities + resume upload/parse (text extraction + basic field extraction; field extraction shipped as optional parsing with your own model key).
- Configurable pipeline stages + archive reasons; kanban + list views; stage history.
- Postings CRUD (rich content, teams/locations/commitment/salary), publish flow.
- Hosted careers page + configurable application forms + apply endpoint (+ postings JSON embed API).
- Applications create opportunities; source/origin capture.
- Outbound email from profiles with org/personal templates + merge tokens (SMTP adapter).
- Feedback form definitions + submissions (1–4 scale), basic visibility rule.
- Manual interview creation (panel, times, candidate notification email, .ics attachments).
- Notes with @-mentions, tags, activity feed (from event stream), basic search (Postgres FTS).
- Public API v1 for everything above + API keys; OpenAPI docs.
- Roles: super admin/admin/team member/interviewer (coarse).

**Exit criteria:** end-to-end hire — post job → candidate applies → screen → interview + feedback → manual offer note → hired — all through the UI, all visible via API.

## Phase 2 — Team-scale completeness · ~2–3 months

- Requisitions (+ posting linkage, openings countdown on hire).
- Offers: templated fields, document generation (PDF), state machine (no approvals yet).
- Interview plans per posting + interview kits for interviewers + feedback reminders + full visibility rules.
- Custom fields; saved views; bulk actions; CSV import; dedup detection/merge.
- Tasks & snooze; followers; notification system (in-app + email).
- Full role parity incl. limited team member + per-posting confidential access (basic).
- Webhooks + delivery log; OAuth for third-party apps; rate limiting.
- Meilisearch: instant candidate/resume search.
- Analytics v1: pipeline funnel, time-in-stage/time-to-hire, source effectiveness, archive reasons; CSV export everywhere.
- Compliance v1: GDPR consent tracking, retention/anonymization jobs, SAR export; EEO question block (segregated storage); audit log UI; 2FA.

**Exit criteria:** a 50-person company with a recruiting team of 3–5 can replace a commercial ATS for core workflows.

## Phase 3 — The hard integrations · ~3–4 months

*This is the phase that separates real Lever competitors from CRUD apps.*

- **Calendar sync** (Google + Microsoft): free/busy, availability-based booking, event CRUD, reschedule/cancel propagation, video links (Zoom/Meet/Teams).
- **Candidate self-scheduling links** (Easy Book parity).
- **Two-way email sync** (Gmail + Microsoft Graph): replies thread onto profiles; scheduled send; send-on-behalf.
- **Approval chains** (generic engine) applied to postings, requisitions, offers.
- **Native simple e-signature** for offer letters (draw/type-to-sign, audit trail).
- **Automation rules engine** (triggers/conditions/actions) + stage-change automations + SLA alerts.
- Referral portal; internal job board; job board XML feeds (Indeed et al.).
- SSO (SAML + OIDC); Slack notifications; integration framework (credential vault, connector settings UI).
- Offer analytics; offer acceptance reporting.

**Exit criteria:** scheduling + email workflows match daily-driver expectations of recruiters coming from Lever.

## Phase 4 — CRM, sourcing & analytics depth · ~3–4 months

- Newsletters about open roles to every candidate, with one-click unsubscribe and bounce handling. (Multi-step nurture sequences are part of the hosted Source ATS.)
- Browser extension (capture from LinkedIn/GitHub → contact + opportunity).
- Talent pools/communities; shared team inboxes.
- Custom report builder + dashboards; scheduled report delivery; interviewer analytics; DEI reporting (aggregate, access-controlled); diversity survey.
- Multi-block onsite scheduling (rooms, breaks, rotation).
- E-sign integrations (DocuSign, Dropbox Sign); background check (Checkr) + assessment integrations; HRIS export-on-hire; Zapier app; SCIM.
- Importers from other ATSs — shipped as in-app API imports (Settings → Import) for Lever, Greenhouse, Ashby and eight more.

**Exit criteria:** feature-parity matrix ≥90% ☑; migration path from Lever demonstrated end-to-end.

## Phase 5 — Full parity & differentiation · ongoing

- Agency portal; candidate SMS; interviewer load balancing & training paths; re-discovery; anonymized review; multi-language postings; goals/KPIs; HRIS req import.
- Beyond-parity: plugin system, headless mode, AI provider abstraction (optional matching/summarization/drafting), warehouse-native export.

---

## Workstream view (what can run in parallel)

| Workstream | P0 | P1 | P2 | P3 | P4 |
|---|---|---|---|---|---|
| Platform (auth, tenancy, events, API, webhooks) | ██ | ██ | ██ | █ | █ |
| Pipeline & candidates | | ██ | ██ | █ | █ |
| Postings & careers | | ██ | █ | █ | █ |
| Interviews & scheduling | | █ | ██ | ███ | ██ |
| Email & newsletters | | █ | █ | ███ | ██ |
| Offers/reqs/approvals | | | ██ | ██ | █ |
| Analytics & compliance | | | ██ | █ | ██ |
| Integrations ecosystem | | | █ | ██ | ███ |

## Biggest risks & mitigations

1. **Scheduling/calendar sync complexity** — the classic ATS tarpit. *Mitigation:* provider-agnostic core in `packages/core` with exhaustive unit tests; Google first, Microsoft second; manual scheduling always remains a fallback.
2. **Email deliverability & sync edge cases.** *Mitigation:* adapter model, no hard provider dependency, sync isolated in workers with replayable state.
3. **Scope sprawl before MVP ships.** *Mitigation:* parity matrix is a checklist, not a Phase-1 spec; Phase 1 exit criteria are frozen.
4. **Community trust in an ATS handling PII.** *Mitigation:* security policy + disclosure process from day one; compliance features in core, not paywalled.
5. **Resume parsing quality.** *Mitigation:* ship "good enough" OSS parsing early, pluggable commercial adapters for those who need better. (Shipped: open-source text extraction, plus field parsing through any OpenAI-compatible endpoint with your own key, open-weight gpt-oss-20b by default.)

## Immediate next actions

1. Confirm license choice (default: AGPL-3.0 core, MIT SDK).
2. Confirm stack decisions flagged "open" in [03-architecture.md](03-architecture.md).
3. Scaffold Phase 0 (monorepo, compose stack, CI, auth skeleton).
4. Convert the parity matrix into GitHub issues/milestones (one milestone per phase, one issue per matrix row).
