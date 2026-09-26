# Contributing to Source

Thanks for helping build Source, the open-source ATS. It's licensed under
[AGPL-3.0](LICENSE). Bug reports, fixes, importers for more ATSs,
translations and docs are all welcome.

## Before you start

- **Small fixes:** open a pull request directly.
- **Anything bigger** (a new feature, a schema change, a new dependency):
  open an issue first, so we can agree on the approach before you spend the
  time.
- **Security issues:** never file a public issue. See [SECURITY.md](SECURITY.md).

## The contributor license agreement

Before we can merge your first pull request, you sign the
[contributor license agreement](CLA.md) once. A bot comments on the pull
request with a sentence to paste back. You keep the copyright in your work.
The CLA lets the project offer Source under other licenses too, such as the
hosted Source ATS and commercial licenses, which is what funds the open
core.

## Setting up

The [README](README.md#development) covers setting up a development copy. Then:

```sh
npm test                                     # unit tests
TEST_DATABASE_URL=postgresql://… npm test    # plus the database suites (a throwaway database)
npm run typecheck
```

CI runs the typecheck, the tests (with a Postgres) and a production build
on every pull request.

## What belongs in the core

- **Everything works self-hosted** with Postgres as the only hard
  dependency. Email (`SMTP_URL`), file storage and resume parsing are
  optional, and a missing one degrades gracefully: never a crash, and never
  a feature that's half there.
- **No AI prompts or model calls.** The AI features talk to a provider over
  [the AI provider protocol](docs/ai-protocol.md). Improve the protocol or
  the code on either side of it, not by adding a model call. Resume parsing
  is the one exception: it runs in the core with the operator's own key.
- **No plan or tier checks.** Everything in this repository is available to
  everyone who runs it.
- **Fair by design.** Nothing may score, filter or sort candidates on
  protected characteristics, or on anything that stands in for one.

## Writing code here

- TypeScript throughout, and match the code around you: its naming, its
  comment density, its idioms. Comments explain *why*, not what.
- Tests come with changes: Vitest for logic, and a database suite for
  anything that reads or writes Postgres.
- Every change to data goes through the server and records an event (see
  [docs/04-data-model.md](docs/04-data-model.md)).
- Commit messages follow the log: a short `Area: what changed` subject,
  then a body that explains why.

## Database changes

- Change `prisma/schema.prisma`, then `npm run db:migrate -- --name what_changed` and commit the generated migration. Never edit a migration that has shipped. Self-hosters and production have already applied it.
- Migrations run before the new code serves traffic, while the current version is still live against the same database. Keep them backward compatible: add columns as nullable or with defaults, and backfill in a later step.
- **Indexes on big tables** (Contact, Opportunity, StageTransition, Event, Note, Transcript): a plain `CREATE INDEX` blocks writes for as long as the build takes. Put each one in its own migration as a single `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` statement. Prisma runs a one-statement migration outside a transaction, so this works. Declare the same index in `schema.prisma` so there's no drift. If such a build is interrupted, Postgres keeps an INVALID index that `IF NOT EXISTS` would skip forever. So `scripts/migrate.mjs` runs `scripts/check-indexes.mjs` around `migrate deploy`: before it, it drops an INVALID index that one of our migrations builds (so the migration builds it again) and rebuilds any such index an applied migration should have made; after it, it fails the deploy on anything still INVALID or missing and prints the fix. If the interrupted build failed its migration (P3009), run `npx prisma migrate resolve --rolled-back <migration>` and `npm run db:deploy` again. A migration that drops an index a new one replaces goes after a guard migration that raises unless the replacement is valid (see `20260925100350_check_replacement_indexes`), so even a bare `prisma migrate deploy` can't leave the table with neither. A concurrent build also waits for every older transaction (a long export or import), so deploy index migrations when none is running.
- Never run `prisma format` (it rewrites the whole schema); edit `schema.prisma` by hand.
- Test against realistic data: `npm run seed:scale` builds a 50k-contact org in a local database, and `TEST_DATABASE_URL=… npm test` runs the database suites.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind,
assume good intent, and keep reviews about the code.
