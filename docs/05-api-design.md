# Public API & Webhooks Design

**Status:** v1 is live — reads (`/api/v1`: postings, opportunities, contacts, stages, events), writes (create opportunities/postings, stage moves, archive/unarchive, publish), and signed webhooks (HMAC `X-Source-Signature`, at-least-once, per-endpoint ordering, managed in Settings). Scopes and OAuth are next.

The API is a first-class product: everything the web app can do is available via documented REST endpoints. We deliberately mirror the *shape* of Lever's API v1 (resources, naming, expand/include patterns) so migration tooling and mental models transfer — without copying it verbatim.

## Conventions

- Base path: `/api/v1` (versioned; additive changes only within a version).
- Auth: `Authorization: Bearer <api-key>` (org-scoped keys with scopes) or OAuth 2.0 access tokens for third-party apps. Session cookies for the first-party web app hit the same endpoints.
- JSON bodies; `snake_case` fields; RFC 3339 timestamps in UTC; IDs are UUIDv7.
- Cursor pagination: `?limit=50&cursor=...` → `{ data: [...], next_cursor, has_more }`.
- Expansion: `?expand=contact,posting` inlines related objects (bounded whitelist per endpoint).
- Errors: RFC 9457 problem+json with stable `code` strings.
- Rate limits per key with standard `RateLimit-*` headers.
- Full OpenAPI 3.1 spec generated from code; published docs + generated TS SDK (`packages/sdk`, MIT).

## Resource map (Lever parity)

| Resource | Endpoints (summary) | Lever analog |
|---|---|---|
| `contacts` | CRUD, merge, `GET /contacts/:id/opportunities` | Contacts |
| `opportunities` | CRUD, `POST :id/stage`, `POST :id/archive`, `POST :id/unarchive`, notes/tags/followers subresources | Opportunities |
| `postings` | CRUD, `POST :id/publish`, apply-form subresource | Postings |
| `requisitions` | CRUD, approval actions | Requisitions |
| `interviews` | CRUD, `POST :id/cancel`, panel subresource | Interviews/Panels |
| `feedback` | List/create submissions, form-definition endpoints | Feedback |
| `offers` | CRUD, approval actions, `POST :id/send`, document download | Offers |
| `users` | CRUD, deactivate | Users |
| `stages`, `archive_reasons`, `sources`, `tags` | List/config | Same |
| `files` | Upload (multipart), download via signed URL | Files/Resumes |
| `notes`, `tasks`, `referrals` | CRUD | Same |
| `events` | `GET /events?since=...` — the audit/activity stream | (beyond Lever) |
| `webhooks` | Endpoint CRUD + delivery log | Webhooks settings |

### Public (unauthenticated) careers endpoints

Powering the hosted careers site, embeds, and custom career pages:

```
GET  /v1/public/orgs/:slug/postings          # published postings, filterable (team, location, commitment)
GET  /v1/public/orgs/:slug/postings/:slug    # single posting content + apply form definition
POST /v1/public/orgs/:slug/postings/:slug/apply   # multipart: answers + resume  (rate-limited, captcha-pluggable)
GET  /v1/public/scheduling-links/:token      # self-scheduling: available slots
POST /v1/public/scheduling-links/:token/book
```

## Example shapes

```jsonc
// GET /api/v1/opportunities/:id?expand=contact
{
  "id": "0197a3…",
  "contact": { "id": "0197a1…", "name": "Dana Reyes", "emails": ["dana@…"] },
  "posting_id": "01979f…",
  "stage_id": "stage_phone_screen",
  "status": "active",
  "origin": "applied",
  "source": "linkedin",
  "owner_id": "user_…",
  "tags": ["senior", "referral-bonus"],
  "custom_fields": { "visa_status": "citizen" },
  "created_at": "2026-07-01T18:03:22Z",
  "stage_changed_at": "2026-07-06T09:15:00Z"
}
```

```
POST /api/v1/opportunities/:id/stage        { "stage_id": "stage_onsite" }
POST /api/v1/opportunities/:id/archive      { "archive_reason_id": "…", "send_rejection_template_id": "…" }
```

## API key scopes

`read:candidates write:candidates read:postings write:postings read:interviews write:interviews read:offers write:offers read:analytics admin:org webhooks:manage` — least-privilege keys per integration; confidential postings require an extra `confidential` scope.

## Webhooks

- **Events** (initial set): `contact.created`, `opportunity.created`, `opportunity.stage_changed`, `opportunity.archived`, `opportunity.hired`, `application.received`, `interview.scheduled`, `interview.canceled`, `feedback.submitted`, `offer.created`, `offer.signed`, `posting.published`, `contact.anonymized`.
- **Delivery**: JSON POST, `X-Source-Signature: t=<ts>, v1=<hmac-sha256>` (timestamped to block replay), at-least-once, exponential backoff (1m→1h, 24h max), auto-disable after sustained failure with admin notification, delivery log with redelivery button.
- **Payload**: envelope `{ id, type, occurred_at, org_id, data: { <resource snapshot> } }` — snapshot included (Lever-style thin payloads considered; snapshots chosen to reduce read-back traffic; sensitive fields excluded by default).

## Non-goals for v1

- GraphQL (may come later; REST + expand covers the 90% case).
- Per-field ACL granularity in API responses beyond role + confidential flags.
