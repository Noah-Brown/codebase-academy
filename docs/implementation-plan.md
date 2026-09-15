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
| Concept mappings     | Hand-written fixture       | Milestone 3 concept mapper (built)   |
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

## Milestone 2: GitHub ingestion (done)

Design and contracts: [`milestone-2-design.md`](./milestone-2-design.md).

- [x] Sign-in with GitHub via Better Auth (D19), OAuth tokens encrypted at rest; `/setup` lists missing settings
- [x] Onboarding: choose a starting level, which calls `initializeLearner`
- [x] GitHub App install callback that links only installations GitHub lists for the user; webhook with signature verification
- [x] Short-lived installation tokens on demand, cached in memory only
- [x] Repositories and open pull requests pages
- [x] `pr_analyses` idempotent per `(repository, PR number, head SHA, analyzer version)`; Postgres job queue with leases and backoff (D20)
- [x] Context builder: patches, surrounding lines, manifests, token budgets, skip lists, secret redaction
- [x] Tenant scoping on every repository-derived lookup, with tests
- [x] Live run (2026-09-14): installed the app on a real repository and analyzed a real pull request. It surfaced two
      fixes: `getGitHubUserToken` passed the GitHub user ID where Better Auth expects its account row ID, and
      a webhook secret mismatch between the app and `.env` (every delivery returned 401)

**Exit criterion met:** a real PR becomes a normalized, safely budgeted analysis context. Every step is covered
by tests against GitHub fakes and PGlite, and the live run above analyzed a real pull request.

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
- **Request user authorization (OAuth) during installation:** leave disabled. Users sign in first, and GitHub disables the Setup URL when this is on.
- **Setup URL:** `http://localhost:3000/api/github/install/callback` (with **Redirect on update** enabled)
- **Webhook URL:** `<tunnel>/api/github/webhook`
- **Repository permissions** (least privilege, read-only):
  - Metadata: Read
  - Contents: Read
  - Pull requests: Read
- **Account permissions:** Email addresses: Read
- **Subscribe to events:** Pull request (installation events are delivered by default)
- **Where can this app be installed:** Only on this account, for development.

## Milestone 3: concept mapping (done)

Design and contracts: [`milestone-3-design.md`](./milestone-3-design.md).

- [x] Provider-neutral structured generation in `@academy/ai`, with a Claude CLI adapter (D21) and a Claude API adapter
- [x] Versioned mapper prompt (`mapper-v1`) that carries the curriculum and puts untrusted code in nonce-delimited blocks
- [x] Validation of concept IDs, evidence paths, excerpts, and line numbers (D23), backed by a concept foreign key
- [x] Mapping runs and mappings (D22), scheduled after each analysis, with retry from the analysis page
- [x] PR overview: recommended lesson with reasons and code evidence, other concepts, honest empty and failure states
- [x] Golden fixtures (the brief's five plus a prompt-injection case) and a live evaluation, `npm run eval:mapper -w @academy/ai`
- [x] Live run (2026-09-14): a real pull request mapped end to end, with three concepts and all evidence
      grounded in 16 s. The golden evaluation passed 3 of 6; the failures trace to curriculum signals
      (open question 3, results in the design doc)

**Exit criterion met:** a PR shows credible concepts tied to real code evidence. The product owner reviewed
the concepts mapped from a real pull request on the analysis page and judged them credible (2026-09-15).

To enable mapping, set `CONCEPT_MAPPER_PROVIDER=claude-cli` in `.env`. The worker's user must be signed in
to Claude Code. Then run `npm run db:migrate` and restart the worker.

## Open questions for the product owner

1. **Mastery calibration.** Under the brief's priors and 0.90 threshold, Mastered takes about nine perfect
   engineering defenses on a difficulty-4 concept (D8). Is that the intended bar, or should Milestone 4
   start with a lower threshold or lighter priors?
2. **Lesson catalogue.** `docs/curriculum/` holds draft lesson outlines (four depths per concept). They
   are AI-drafted and unreviewed: they guide Milestone 4 but are not canonical curriculum data until reviewed.
3. **Curriculum signal overlaps found by the mapper evaluation.** Several concepts overlap in ways the
   curriculum doesn't resolve:
   - `systems.concurrency` and `systems.bounded-concurrency` both list `Promise.all` and have no boundary.
   - `db.joins` lists "queries executed per item in a loop", which also matches per-item writes.
   - `dsa.search-and-sort` has no boundary against database sorting.

   Adding `related` boundaries and sharpening those signals would be curriculum v3. Should that go ahead?

## Carried into Milestone 4

- **Rubric criteria per concept** (review finding graph-13): brief §9 puts rubric templates in the
  curriculum layer. Author them alongside the grader rather than before its shape is known.
