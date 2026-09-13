# Implementation plan

Source of truth for scope: [`product-handoff.md`](./product-handoff.md). Choices made along the way are in
[`decisions.md`](./decisions.md).

## Smallest vertical slice

The thin-slice demo (§7) is: connect repo → pick a PR → see mapped concepts → take a lesson → mastery changes.
Its irreducible core is the **learning loop**:

```text
mapped concepts + learner state ──▶ ranked lesson + reasons ──▶ assessed evidence ──▶ mastery event ──▶ new learner state
```

Milestones 0–1 build and test that loop end to end with fixture mappings in place of GitHub and the LLM.
Later milestones replace the fixture inputs one at a time without changing the core:

| Slice input          | Milestones 0–1 (now)       | Replaced by                          |
| -------------------- | -------------------------- | ------------------------------------ |
| Concept mappings     | Hand-written fixture       | Milestone 3 concept mapper           |
| Assessment evidence  | Direct calls in tests      | Milestone 4 lesson player and grader |
| PR and code evidence | Fixture paths and excerpts | Milestone 2 GitHub ingestion         |

## Milestone 0: foundation (done)

- [x] Monorepo with the brief's module boundaries; npm workspaces
- [x] TypeScript (strict), ESLint (flat config, rule that forbids provider SDKs outside `@academy/ai`), Prettier
- [x] Vitest across packages; PGlite-backed DB tests
- [x] Environment validation (`@academy/shared/env`); structured logger with content redaction
- [x] Postgres via docker compose; Drizzle schema and migrations; migrate script
- [x] Web app shell (Next.js 16, Tailwind 4) with `/api/health`
- [x] Worker process that boots, checks the DB, and shuts down gracefully
- [x] README, decisions log, this plan

## Milestone 1: curriculum and learner core (done)

- [x] Curriculum schema (Zod) and graph validation (IDs, references, cycles, authoring warnings)
- [x] Seed curriculum: 53 concepts across 7 domains, with real prerequisites
- [x] Independent review of the seed (144 findings, [`reviews/`](./reviews/)); applied as curriculum v2: 60 concepts, `related` boundaries, redundant-edge warning, novice prerequisite-penalty fix
- [x] Versioned, immutable curriculum import keyed by content hash
- [x] Starting-level priors by difficulty (configurable)
- [x] Beta mastery update with evidence weights and grader-confidence handling
- [x] Status labels that separate the mastery estimate from evidence strength
- [x] Append-only mastery events plus a transactional projection; replay from stored deltas
- [x] Deterministic lesson ranking with score breakdown, penalties, exclusions, honest empty states, depth selection, and plain-language reasons
- [x] Fixture-driven demo (`npm run demo:select`, `/dev/selection`)

**Exit criterion met:** given mappings and a learner state, the system selects a lesson and explains why
(`selection.test.ts`, "payment-retry fixture").

## Milestone 2: GitHub ingestion (next)

1. Auth.js with the GitHub provider, using the GitHub App's OAuth client. Adds `accounts` and `sessions` tables.
2. Onboarding: choose a starting level, which calls `initializeLearner`.
3. GitHub App installation callback and webhook (signature verification). Tables: `github_installations`, `repositories`.
4. Short-lived installation tokens on demand; nothing long-lived stored.
5. List repositories and open PRs.
6. `pr_analyses` keyed by `(repository, PR number, head SHA, analyzer version)`, plus a durable job queue behind `JobQueue`.
7. Context builder: patches, bounded surrounding lines, manifest files, token budgets, skip lists for generated, lock, vendored, and binary files, and secret redaction.
8. Tenant scoping on every repository-derived lookup, with tests.

### Credentials and configuration needed for Milestone 2

| Needed                                      | Where it comes from                                                                       | Env var                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| A GitHub App (development instance)         | github.com → Settings → Developer settings → GitHub Apps → New                            | —                                      |
| App ID and slug                             | App settings page                                                                         | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`     |
| Private key (PEM)                           | App settings → Generate a private key                                                     | `GITHUB_APP_PRIVATE_KEY`               |
| Webhook secret                              | A random string you set on the app                                                        | `GITHUB_APP_WEBHOOK_SECRET`            |
| OAuth client ID and secret (for sign-in)    | Same app → Client ID / Generate a new client secret                                       | `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` |
| Session secret                              | `openssl rand -base64 33`                                                                 | `AUTH_SECRET`                          |
| Public base URL for callbacks and webhooks  | `http://localhost:3000` for OAuth; a tunnel (smee.io, ngrok, or cloudflared) for webhooks | `APP_BASE_URL`                         |
| A test repository with at least one open PR | Any repository you can install the app on                                                 | —                                      |
| A reachable Postgres                        | `npm run db:up` (needs Docker access) or a local install                                  | `DATABASE_URL`                         |

GitHub App settings:

- **Callback URL:** `http://localhost:3000/api/auth/callback/github`
- **Webhook URL:** `<tunnel>/api/github/webhook`
- **Repository permissions** (least privilege, read-only):
  - Metadata: Read
  - Contents: Read
  - Pull requests: Read
- **Account permissions:** Email addresses: Read
- **Subscribe to events:** Pull request (installation events are delivered by default)
- **Where can this app be installed:** Only on this account, for development.

## Open questions for the product owner

1. **Mastery calibration.** Under the brief's priors and 0.90 threshold, Mastered takes about nine perfect
   engineering defenses on a difficulty-4 concept (D8). Is that the intended bar, or should Milestone 4
   start with a lower threshold or lighter priors?
2. **Lesson catalogue.** `docs/curriculum/` holds draft lesson outlines (four depths per concept). They
   are AI-drafted and unreviewed: they guide Milestone 4 but are not canonical curriculum data until reviewed.

## Carried into Milestone 4

- **Rubric criteria per concept** (review finding graph-13): brief §9 puts rubric templates in the
  curriculum layer. Author them alongside the grader rather than before its shape is known.
