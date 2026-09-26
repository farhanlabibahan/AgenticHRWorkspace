# Vision & Principles

## What we are building

A fully open source Applicant Tracking System (ATS) with functional parity to Lever — including its talent-CRM ("TRM") capabilities — that any company can self-host, extend, and own. Where Lever is a closed SaaS with per-seat pricing and a gated API, Source is open source (AGPL-3.0), API-first, and portable.

## Why

1. **Recruiting data is strategic and sensitive.** Candidate PII, compensation data, interview feedback, and hiring decisions live in the ATS. Companies in regulated industries, the EU (GDPR), and the public sector have strong reasons to self-host.
2. **The category is mature and well-understood.** Lever, Greenhouse, and Ashby have converged on a common feature set. There is no comparably complete open source option — existing OSS ATS projects cover applicant tracking basics but not scheduling automation, structured interviews, offer approvals, CRM/nurture, or analytics at commercial depth.
3. **API-first unlocks an ecosystem.** An open core with a stable public API and webhooks lets the community build the long tail of integrations (job boards, assessments, background checks, HRIS) that commercial vendors gate behind partnership programs.

## Target users

- **Primary:** In-house recruiting teams at 10–2,000 employee companies (Lever's core market) — recruiters, coordinators, hiring managers, interviewers, and executives.
- **Secondary:** Staffing agencies, dev shops embedding hiring flows, and vendors offering hosted Source.
- **Personas and their surfaces:**
  - *Recruiter / sourcer* — pipeline board, candidate profiles, email, bulk actions, sourcing extension.
  - *Coordinator* — scheduling, interview logistics, candidate comms.
  - *Hiring manager* — requisitions, pipeline visibility, feedback review, offer approvals.
  - *Interviewer* — interview kits, feedback forms, calendar integration; minimal UI footprint.
  - *Candidate* — careers site, application flow, scheduling links, status comms (email/SMS).
  - *Admin / IT* — SSO, roles, compliance settings, API keys, webhooks, data retention.

## Guiding principles

1. **Feature parity is the roadmap, not the philosophy.** We match Lever's capabilities (docs/02-feature-parity.md is the checklist) but we are free to exceed it where open source gives leverage: better API, better self-serve config, no artificial tier gating.
2. **API-first.** Every UI capability is backed by a documented API. The public API ships with the feature, not after it.
3. **Self-hosting must be genuinely easy.** `docker compose up` gives a working system with sane defaults. Anything that requires a third-party service (email sending, calendar sync, e-signature) degrades gracefully or has an OSS fallback.
4. **Multi-tenant from day one.** A single deployment can serve many organizations. This keeps the door open for hosted offerings and agency use without a rewrite.
5. **Compliance is core, not enterprise upsell.** GDPR consent/retention/anonymization, EEO/OFCCP data collection, and audit logs ship in the open source core.
6. **Boring, proven technology.** PostgreSQL, Redis, TypeScript. Innovation budget goes to product completeness, not infrastructure novelty.

## Licensing

The core application is **AGPL-3.0** ([LICENSE](../LICENSE)); public API client SDKs, when they ship, will be MIT.

- AGPL keeps the project genuinely open while preventing closed-source hosted resale without contribution — the model proven by Cal.com, Plausible, and Grafana-adjacent projects. It does **not** restrict companies from self-hosting for their own hiring (the overwhelmingly common case).
- Contributors sign a [contributor license agreement](../CLA.md), so the project can also be offered under other terms (the hosted Source ATS, commercial licenses).

## What "parity with Lever" means

Lever's product is organized around a small set of pillars. Parity means each pillar exists and is production-usable, not that every micro-interaction is cloned:

| Lever pillar | Source equivalent |
|---|---|
| LeverTRM (candidate/contact CRM, opportunities, pipeline) | Core ATS + CRM module |
| Job postings, careers site, apply flow | Postings module + hostable careers site + embeddable postings API |
| Sourcing (extension, referrals, nurture campaigns) | Browser extension, referral portal, newsletters to every candidate |
| Interview scheduling (calendar sync, self-scheduling, Easy Book) | Scheduling module with Google/Microsoft calendar integrations |
| Structured hiring (interview kits, feedback forms/scorecards) | Interview plans + configurable feedback forms |
| Offers & approvals (offer letters, approval chains, e-signature) | Offers module + document generation + e-sign integrations |
| Requisitions & headcount | Requisition module with HRIS import |
| Visual Insights / Advanced Analytics | Reporting module + warehouse-friendly data export |
| Automation (workflows, triggers) | Rules/automation engine |
| Integrations marketplace, API, webhooks | Public REST API, webhooks, integration framework |
| Compliance (GDPR, EEO/OFCCP), Diversity surveys | Compliance module |
| Roles/permissions, SSO/SCIM, audit | AuthN/AuthZ module |

The detailed, feature-by-feature checklist lives in [02-feature-parity.md](02-feature-parity.md).

## Non-goals (for now)

- **Payroll/HRIS functionality.** We integrate with HRIS systems; we do not become one.
- **AI resume screening as a core dependency.** AI features (matching, drafting, summarization) are planned as optional modules behind a provider abstraction — the system must be fully functional without any LLM configured.
- **Per-pixel cloning of Lever's UI.** We match workflows and capability, with our own design system.
