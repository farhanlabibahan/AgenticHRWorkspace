# Core Data Model

Entity-level design for the relational schema. Field lists show the important columns, not every column; all tenant-scoped tables carry `org_id`, `created_at`, `updated_at`.

## Entity overview

```
Organization ─┬─ User ── Role/Permissions
              ├─ Department / Team / Location
              ├─ Contact ─┬─ ContactEmail/Phone/Link
              │           ├─ Resume (file + parsed data)
              │           ├─ ConsentRecord
              │           └─ Opportunity ─┬─ StageTransition (history)
              │                           ├─ Application (form answers)
              │                           ├─ Note / Task / Mention
              │                           ├─ EmailMessage (threaded)
              │                           ├─ Interview ── FeedbackSubmission
              │                           ├─ Offer ── OfferDocument/Signature
              │                           └─ Referral
              ├─ Posting ─┬─ ApplicationForm (versioned)
              │           ├─ InterviewPlan ── InterviewTemplate ── FeedbackFormDef
              │           └─ Requisition (n:m via posting_requisitions)
              ├─ PipelineConfig ── Stage / ArchiveReason
              ├─ EmailTemplate / Newsletter ── NewsletterRecipient
              ├─ AutomationRule
              ├─ ApiKey / WebhookEndpoint ── WebhookDelivery
              ├─ EeoResponse (restricted)
              └─ Event (append-only activity/audit stream)
```

## Core entities

### Organization
Multi-tenant root. Branding, locale/timezone defaults, feature flags, retention policy, compliance settings.

### User
`email, name, auth (password_hash? and/or google_sub?, the Google account bound on first "Continue with Google", only for Gmail or same-domain Workspace addresses; unique per workspace), access_role, linked_contact_id?, calendar/email connection state, notification prefs, deactivated_at`.
Access roles at parity with Lever: `super_admin | admin | team_member | limited_team_member | interviewer`, plus per-posting confidential access grants.

### Contact (person)
`name, headline, current_company, location, emails[], phones[], links[] (unique-indexed per org for dedup), tags[], origin, owner_id, is_anonymized`.
A contact exists independently of any job — this is what makes CRM, pools, and re-discovery possible.

### Opportunity (person-in-process) — the workhorse
`contact_id, posting_id?, stage_id, status (active|archived|hired), archive_reason_id?, archived_at, owner_id, source, origin (applied|sourced|referred|agency|internal|university), source_detail, snoozed_until, followers[], custom_fields jsonb, confidential bool`.
One contact ↔ many opportunities (different postings or re-applications over time).

### StageTransition
`opportunity_id, from_stage_id, to_stage_id, actor_id, occurred_at`. Append-only; the fact table for all funnel/velocity analytics.

### Posting
`title, state (draft|pending_approval|published|internal|closed), team_id, department_id, location(s), workplace_type (onsite|hybrid|remote), commitment (full-time|part-time|contract|intern), salary_range {min,max,currency,interval,visible}, content (rich text: description, lists, closing), tags[], owner_id, hiring_manager_id, followers[], distribution_channels[], external_slug`.

### Requisition
`req_code (unique per org), name, team, location, employment_type, backfill bool, openings_total, openings_filled, compensation_band {min,max,currency}, status (open|on_hold|closed), approval_state, custom_fields jsonb`. n:m with postings; hires decrement openings.

### ApplicationForm / Application
Form definitions are versioned JSON (question types: text, textarea, select, multiselect, file, boolean, eeo-block reference). `Application` stores `opportunity_id, form_version, answers jsonb, resume_file_id, utm/source capture`.

### PipelineConfig / Stage / ArchiveReason
Org-configurable ordered stages with `type (lead|applicant|screen|onsite|offer|hired)` so analytics stay comparable across custom pipelines. Archive reasons flagged `counts_as_rejection bool` for reporting.

### Interview & Scheduling
- **InterviewPlan** (per posting): ordered groups of **InterviewTemplate**s (`title, duration, feedback_form_id, focus_areas, default_panel_roles`).
- **Interview** (scheduled instance): `opportunity_id, template_id?, panel: [{user_id, role}], start/end (UTC + candidate_tz), location | video_link, calendar_event_ids jsonb, state (proposed|scheduled|completed|canceled|no_show)`.
- **SchedulingLink**: signed token, `windows[], duration, template_id, expires_at, used_at` — powers candidate self-booking.

### FeedbackFormDef / FeedbackSubmission
Versioned form definitions (rating scales, rubric sections, text blocks). Submission: `interview_id?, opportunity_id, author_id, definition_version, answers jsonb, overall_rating (1-4 scale), submitted_at, visibility_locked_until_own_submission bool` (org policy).

### Offer / OfferDocument
`opportunity_id, requisition_id?, fields jsonb (comp, start_date, manager, level…), state (draft|pending_approval|approved|sent|signed|declined|voided), approval_chain_id`.
OfferDocument: generated file + merge snapshot; Signature: `provider (native|docusign|dropbox_sign), envelope_id, signer events`.

### ApprovalChain / ApprovalStep
Generic, reused by postings, requisitions, and offers: `subject_type+id, steps [{approver_id | role, order, mode (sequential|parallel), state, acted_at, comment}]`.

### Email & newsletters
- **EmailMessage**: `contact_id, opportunity_id?, direction, from/to/cc, subject, body refs, provider_message_id, thread_key, sent_by_user_id?, tracking {opened_at, clicked}`.
- **EmailTemplate**: org/personal scope, merge tokens.
- **Newsletter / NewsletterRecipient**: one email about open roles to every candidate; one recipient row per person, unique per newsletter, so a retry never sends twice. `Contact.emailOptOutAt` / `emailBouncedAt` keep unsubscribed and bounced addresses off every send.

### Tasks, Notes, Referral
- **Note**: rich text, `mentions[], visibility (default|followers_only|private)`.
- **Task**: `assignee, due_at, opportunity_id?, completed_at`.
- **Referral**: `contact_id, referring_user_id, relationship, notes, status` — feeds source attribution and referral portal.

### Event (activity/audit stream)
Append-only: `org_id, actor {user|api_key|system|candidate}, verb, subject_type, subject_id, payload jsonb, occurred_at`. Powers activity feeds, audit log, webhooks, automation triggers, and analytics ETL. Partitioned by month.

### Platform tables
- **ApiKey**: hashed secret, scopes[], last_used_at.
- **WebhookEndpoint**: url, secret, event_types[], active. **WebhookDelivery**: attempt log with response codes for the delivery-debug UI.
- **AutomationRule**: `trigger_event_type, conditions jsonb, actions jsonb, enabled`.
- **AuditLog** is a filtered view over Event (admin-relevant verbs).

### Compliance tables (restricted)
- **EeoResponse**: `application_id, answers jsonb` — separate table, separate access path, aggregate-only queries for reporting; never joined into candidate list queries.
- **ConsentRecord**: `contact_id, basis (application|sourced|referral), granted_at, expires_at, withdrawn_at`.
- **RetentionJobRun**: log of anonymization sweeps.

## Modeling rules

1. **Nothing hard-deletes candidate data**; anonymization replaces PII fields and detaches files, keeping analytics facts intact.
2. **All stage/status changes go through services that emit Events** — no direct column updates from controllers.
3. **Custom fields and form answers are JSONB with versioned definitions** — reporting interprets, schema never migrates for org config changes.
4. **Foreign keys always include org_id** (composite) so cross-tenant references are impossible at the constraint level.
5. **Files** are referenced by a `files` table (`storage_key, sha256, mime, size, scanned_at`) — dedup by hash, virus-scan hook.
