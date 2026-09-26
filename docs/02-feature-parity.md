# Lever Feature Parity Matrix

The checklist that defines "done" for the project. Features are grouped by module. **Phase** refers to the delivery phases in [06-roadmap.md](06-roadmap.md) (P1 = MVP core … P5 = full parity & beyond). Status will be updated as modules ship.

Legend: ☐ not started · ◐ in progress · ☑ shipped

---

## 1. Candidate & Contact Management (LeverTRM core)

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Unified contact profiles | One person record; multiple opportunities (jobs considered for) hang off it | P1 | ☑ |
| Opportunities model | Candidate-in-process is an Opportunity with its own stage, owner, posting, source | P1 | ☑ |
| Resume parsing | Auto-extract name, contact info, links, work history from uploaded resume (PDF/DOCX) — Source reads text, links and phones from PDF, Word (.docx, .doc), ODT, RTF and TXT; with a model key set, new applications also fill in headline, location, phones and profile links and keep a structured profile ([resume-parsing.md](resume-parsing.md)); scanned PDFs and image resumes are read with OCR (Tesseract, in the background) | P1 | ◐ |
| Deduplication | Detect/merge duplicate contacts by email, phone, links | P2 | ☑ |
| Tags | Free-form tags on contacts/opportunities, bulk taggable | P1 | ☑ |
| Sources & origins | Track where every candidate came from (sourced, applied, referred, agency, university, internal) | P1 | ☑ |
| Notes & @-mentions | Threaded notes on profiles, @-mention teammates with notification | P1 | ◐ |
| Followers | Users follow a candidate to get activity notifications | P2 | ☐ |
| Activity feed / audit trail | Full chronological history of every action on a profile | P1 | ☑ |
| Custom fields | Admin-defined fields (text, number, date, dropdown) on opportunities | P2 | ☑ |
| Bulk actions | Bulk stage move, archive, email, tag | P2 | ◐ |
| Full-text search | Instant search across contacts, resumes, notes, emails; filterable | P1 (basic) / P3 (resume FTS) | ☑ |
| Saved views / filters | Persist filter combinations as shareable views | P2 | ☐ |
| Confidential candidates/postings | Restrict visibility of sensitive searches (e.g. exec hires) | P3 | ☐ |
| Talent pools / communities | Long-term pools of prospects independent of an active process | P4 | ☐ |
| GDPR consent tracking | Consent status, expiry, re-consent requests per contact | P2 | ☑ |
| Data retention & anonymization | Policy-driven auto-anonymize/delete after N months | P2 | ☑ |
| Candidate data export/portability | Export a candidate's full record (GDPR SAR) | P2 | ☑ |

## 2. Pipeline & Workflow

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Standard pipeline stages | Leads (New lead → Reached out → Responded), Applicants (New applicant), then the interview process (Phone screen → On-site → Offer → Hired), plus Archived with reasons. Drag to reorder within a group | P1 | ☑ |
| Customizable stages | Org-level stage configuration | P1 | ☑ |
| Kanban pipeline view | Drag-and-drop board per posting/all postings | P1 | ◐ |
| List view with columns | Sortable/filterable table of opportunities | P1 | ◐ |
| Archive reasons | Configurable reasons (underqualified, withdrew, hired elsewhere, offer declined…) with reporting | P1 | ☑ |
| Snooze / follow-up reminders | Snooze a candidate until a date; task appears when due | P2 | ☑ |
| Stage-change automations | Trigger emails, tasks, feedback requests on stage transitions | P3 | ◐ |
| Workflow rules engine | If/then rules: on event X with conditions Y do Z (Lever "Automation Hub") | P3 | ☐ |
| Task management | Assignable to-dos tied to candidates with due dates | P2 | ☑ |
| SLA / time-in-stage alerts | Flag candidates stuck in a stage beyond a threshold | P3 | ◐ |

## 3. Job Postings, Careers Site & Apply Flow

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Posting editor | Rich-text description, lists (requirements etc.), location, team, commitment, workplace type (on-site/hybrid/remote), salary ranges | P1 | ◐ |
| Posting states | Draft → pending approval → published → internal-only → closed | P1 | ☑ |
| Posting approval chains | Sequential/parallel approvers before publish | P3 | ☐ |
| Hosted careers page | Branded job list + posting pages served by the platform | P1 | ☑ |
| Embeddable postings | JSON/JS embed of open roles for a company's own site | P1 | ☑ |
| Application forms | Configurable questions per posting (required/optional, file uploads, custom questions) | P1 | ◐ |
| EEO/OFCCP questions | Standard voluntary self-ID block, stored segregated from the profile | P2 | ☑ |
| Diversity survey | Anonymous candidate survey pipeline (Lever's diversity survey) | P4 | ☐ |
| Apply with resume parse | Autofill application from uploaded resume — fields are filled after applying when a parsing key is set; the apply form itself does not autofill | P2 | ◐ |
| Internal job board | Employee-only postings view | P3 | ◐ |
| Job board distribution | Push to free aggregators (Indeed, LinkedIn Limited Listings via XML feeds), paid boards via integrations | P3 | ◐ |
| UTM/source capture | Attribute applications to campaigns/boards automatically | P2 | ☑ |
| Multi-language postings | Localized posting content | P5 | ☐ |

## 4. Sourcing, Referrals & CRM / Nurture

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Browser extension | Capture profiles from LinkedIn/GitHub into the ATS (Lever Chrome extension) | P4 | ☐ |
| Referral portal | Employees submit referrals, track status | P3 | ☐ |
| Email nurture campaigns | Multi-step drip sequences with delays, personalization tokens, auto-stop on reply (Lever Nurture). The core sends one-off newsletters to every candidate; multi-step sequences are part of the hosted Source ATS | P4 | ◐ |
| Bulk import | CSV import of contacts with mapping UI | P2 | ◐ |
| Agency submission portal | External agencies submit candidates against postings with dedup + ownership rules | P5 | ☐ |
| Re-discovery | Surface past candidates matching a new posting | P5 | ☐ |

## 5. Email, Communication & Collaboration

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Send email from ATS | Compose/send to candidates from the profile, logged to activity | P1 | ☑ |
| Email templates | Org + personal templates with merge tokens (candidate name, job, links) | P1 | ☑ |
| Two-way email sync | Gmail / Microsoft 365 sync so replies (from anywhere) thread onto the profile | P3 | ☐ |
| Shared team inboxes | e.g. careers@ inbox mapped into the ATS | P4 | ☐ |
| Scheduled send & send-on-behalf | Delay sending; coordinators send as hiring managers | P3 | ◐ |
| SMS / candidate texting | Two-way SMS via provider (Twilio et al.) | P5 | ☐ |
| In-app + email + Slack notifications | Notification fan-out with per-user preferences | P2 (in-app/email) / P3 (Slack) | ◐ |
| Mentions & permissions-aware sharing | @-mentions respect profile visibility | P2 | ☐ |

## 6. Interview Scheduling

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Manual scheduling | Create interview events, invite panel, notify candidate | P1 | ☑ |
| Google Calendar integration | Free/busy lookup, event creation, updates sync both ways | P3 | ☐ |
| Microsoft 365 calendar integration | Same for Outlook | P3 | ☐ |
| Availability-based booking | Coordinator sees combined panel availability and books in-app | P3 | ☐ |
| Candidate self-scheduling links | Candidate picks a slot from offered windows (Lever "Easy Book") | P3 | ☐ |
| Multi-block onsite scheduling | Compose back-to-back panels with rooms, breaks, interviewer rotation | P4 | ☐ |
| Interviewer load balancing | Distribute interviews across trained interviewers; track load | P5 | ☐ |
| Video conferencing links | Auto-attach Zoom/Meet/Teams links | P3 | ☐ |
| Timezone handling | Candidate-local times everywhere; DST-safe | P1 | ◐ |
| Reschedule/cancel flows | Propagate changes to calendars + candidate comms | P3 | ◐ |

## 7. Structured Hiring: Interview Kits, Feedback & Decisions

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Feedback forms (scorecards) | Configurable templates: ratings scale (1–4 + skip), rubric sections, free text | P1 | ◐ |
| Interview plans per posting | Define stages → interviews → which form + focus areas each panelist gets | P2 | ☑ |
| Interview kits | Interviewer sees candidate context, focus areas, form in one place (incl. calendar-event deep link) | P2 | ☑ |
| Feedback visibility rules | Hide others' feedback until own is submitted (bias control), configurable | P2 | ☑ |
| Feedback reminders | Auto-nag for missing feedback | P2 | ☑ |
| Hiring decision workflow | Debrief support, decision recording, reject-with-reason | P2 | ◐ |
| Anonymized review options | Hide names/photos in early review (bias mitigation) | P5 | ☐ |

## 8. Offers, Approvals & Requisitions

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Requisitions | Headcount records: req code, team, location, compensation band, openings count, backfill vs new | P2 | ☑ |
| Req ↔ posting ↔ hire linkage | Openings decrement on hire; req states (open/on-hold/closed) | P2 | ☑ |
| Requisition approval chains | Configurable approver sequences with delegation | P3 | ☐ |
| HRIS req import | Sync requisitions from Workday/BambooHR/etc. | P5 | ☐ |
| Offer creation | Generate offer from templates with fields (comp, start date, manager…) validated against req | P2 | ◐ |
| Offer approval chains | Approvals before the candidate sees anything | P3 | ☐ |
| Offer letter documents | Templated document generation (PDF/DOCX) with merge fields | P2 | ☐ |
| E-signature | Native simple e-sign + DocuSign/Dropbox Sign integrations | P3 (native) / P4 (integrations) | ☐ |
| Offer analytics | Offer acceptance rate, time-to-offer reporting | P3 | ◐ |

## 9. Analytics & Reporting (Visual Insights parity)

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Pipeline conversion funnel | Pass-through rates per stage, per posting/team/recruiter | P2 | ◐ |
| Time-to-hire / time-in-stage | Velocity metrics with breakdowns | P2 | ◐ |
| Source effectiveness | Hires & conversion by source/origin/campaign | P2 | ◐ |
| Interviewer analytics | Load, feedback completion rate, rating distributions | P4 | ☐ |
| Offer & archive reporting | Acceptance rates, archive reason breakdowns | P3 | ☑ |
| DEI reporting | EEO pipeline representation, survey results (aggregated, access-controlled) | P4 | ◐ |
| Dashboards | Prebuilt dashboards + custom report builder with filters/grouping | P2 (prebuilt) / P4 (builder) | ☑ |
| Scheduled report delivery | Email/Slack digest of reports | P4 | ☐ |
| Data export / warehouse sync | CSV export everywhere; documented schema + CDC-friendly export for BI tools | P2 | ☑ |
| Goals & KPI tracking | Targets vs actuals for recruiting teams | P5 | ☐ |

## 10. Platform: API, Webhooks, Integrations

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Public REST API | Full CRUD over contacts, opportunities, postings, interviews, feedback, offers, reqs (Lever API v1 parity) | P1→ongoing | ◐ |
| API keys & OAuth | Per-org keys with scopes; OAuth 2.0 for third-party apps | P2 | ◐ |
| Webhooks | Signed webhooks for candidate/stage/interview/offer/hire events with retries | P2 | ☑ |
| Postings API | Public unauthenticated endpoints powering careers embeds + apply | P1 | ☑ |
| Integration framework | First-class connector model (settings UI, credential vault, sync jobs) | P3 | ☐ |
| Key integrations | Slack, Zoom/Meet/Teams, DocuSign, background checks (Checkr), assessments, HRIS export on hire | P3–P5 | ☐ |
| Zapier/Make support | Via API + webhooks docs and official app | P4 | ☐ |
| Data import from other ATSs | In-app API importers (Lever, Greenhouse v3, Ashby, Workable, Teamtailor, Recruitee, BambooHR, JazzHR, SmartRecruiters, Pinpoint, Merge for 50+ more) with stage-mapping review, resumable jobs, and idempotent re-runs | P4 | ☑ |

## 11. Administration, Security & Compliance

| Feature | Lever behavior | Phase | Status |
|---|---|---|---|
| Role-based access | Lever's four tiers (Super Admin / Admin / Team Member / Limited Team Member) + interviewer-level access, plus per-posting visibility | P1 (basic) / P2 (full) | ◐ |
| SSO (SAML/OIDC) | Okta, Azure AD, Google Workspace | P3 | ☐ |
| SCIM provisioning | Auto user lifecycle from IdP | P4 | ☐ |
| 2FA | TOTP for password accounts | P2 | ☐ |
| Audit log | Org-wide admin-visible audit trail, exportable | P2 | ☑ |
| Org settings | Departments/teams, locations, stages, archive reasons, templates, branding | P1 | ☑ |
| Multi-tenancy | Isolated orgs on one deployment | P1 | ☑ |
| Rate limiting & API quotas | Protect the platform | P2 | ◐ |
| Encryption & secrets handling | At-rest encryption for tokens/PII columns, KMS-pluggable | P2 | ◐ |

## Beyond parity (open source advantages)

Not required for parity but planned because OSS makes them natural:

- **Plugin system** — server-side extension points so forks aren't needed for custom logic.
- **Full data ownership** — direct SQL access to your own data; documented schema.
- **AI provider abstraction** — optional resume matching/summarization/drafting against any LLM (incl. local models), off by default.
- **Headless mode** — run the API + careers endpoints without the web app for custom frontends.
