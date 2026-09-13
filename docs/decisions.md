# Decisions

Short architecture decision records. Each one says what was chosen, why, and what would make us revisit it.
Items the brief (§23) left to the implementer are marked **(delegated)**.

---

## D1. Existing repository conventions

The repository was empty and not under git when work began, so nothing conflicted with the recommended
stack. The layout follows brief §8 exactly (`apps/web`, `apps/worker`, `packages/{db,curriculum,github,learning,ai,shared}`).

## D2. npm workspaces

pnpm isn't installed on the development machine, and npm workspaces are enough for seven packages.
Workspace packages export TypeScript source directly (`"exports": "./src/index.ts"`): Next.js compiles
them through `transpilePackages`, scripts run through `tsx`, and Vitest consumes them natively. There is
no per-package build step. **Revisit** if install times or hoisting problems start to hurt.

## D3. TypeScript 6.0, not 7.0

`typescript-eslint@8.70` declares `typescript <6.1`. TypeScript 7 (the native port) is newer than the lint
tooling supports. **Revisit** once typescript-eslint supports 7.x.

## D4. Drizzle ORM **(delegated)**

Chosen over Prisma because:

- The schema is plain TypeScript and the generated SQL is readable. Composite foreign keys, check
  constraints, and hand-written SQL migrations (such as the append-only trigger) are first-class.
- There is no binary query engine or generated client.
- It runs against both `postgres-js` in the app and in-process **PGlite** in tests, so the same schema and
  migrations are exercised against real Postgres semantics without a server.

## D5. Database for development and tests

- **Development:** `docker-compose.yml` runs Postgres 18. A local Postgres works just as well via `DATABASE_URL`.
- **Automated tests:** PGlite (Postgres compiled to WASM) applies the real migrations in-process. Tests
  need no Docker and no server, and triggers, constraints, and transactions still behave as in Postgres.

## D6. Curriculum storage **(delegated: JSON)**

- The seed curriculum is split into one JSON file per domain under `packages/curriculum/data/`, plus a
  `curriculum.json` manifest that holds the version.
- Loading runs three layers of validation:
  1. A strict Zod schema, which rejects unknown keys.
  2. Graph validation: unique IDs, known domains, a domain prefix on every ID, prerequisites that
     exist, no self-references or duplicates, and no cycles (the error reports the cycle path).
  3. Warnings for authoring smells, such as a prerequisite that is harder than its dependent.
- `npm run curriculum:import` stores a version keyed by a canonical content hash:
  - Importing identical content is a no-op.
  - Importing **changed content under an already-published version is refused**, so authors must bump the version.
  - Nothing in the system lets an LLM change the curriculum.

Seed size: v1 had 53 concepts. After the independent review ([`reviews/`](./reviews/)), v2 has 60 in 7
domains, above the brief's "about 30–50". The seven additions each fill a gap the reviewers judged
significant: LLM prompt injection, connection pooling, instance lifecycle, CORS, trustworthy tests,
dates and time zones, and dependency risk. It contains every concept the golden PR fixtures (§20) need,
plus the `functions → async → concurrency → bounded concurrency → backpressure` chain from §10.

## D7. Extension: `operationalImportance` on concepts

The ranking formula (§12 step 4) weights "operational/security importance", but §10's concept fields have
nothing to feed it. Each concept therefore carries an authored `operationalImportance` in 0..1. The
alternative, deriving the value from tags, would be implicit and harder to review.

## D8. Learner model parameters **(delegated: thresholds as configuration)**

All numbers live in `packages/learning/src/config.ts` (`defaultLearningConfig`). Tests assert behavior
relative to that config wherever possible.

- **Priors** are keyed by starting level × concept difficulty. They follow the brief's examples (novice
  fundamentals α=1, β=2; advanced fundamentals α=3, β=2). Prior mastery rises strictly from novice to
  intermediate to advanced at every difficulty. Priors never count as evidence, so every concept starts as **New**.
- **Evidence weights** are exactly as in §11.
- **Grader confidence:**
  - Below 0.4, the grade is recorded but not applied.
  - From 0.4 to 0.7, the evidence weight is scaled by `confidence / 0.7`.
  - At 0.7 or above, the full weight applies.
- **Labels:**
  - **New** while accumulated evidence weight is below 1.0.
  - Mean thresholds of 0.55, 0.75, and 0.90, as in the brief.
  - **Proficient** also needs evidence weight ≥ 2.0.
  - **Mastered** also needs evidence weight ≥ 4.0, plus either two or more sessions or two or more
    demonstrated assessment modes.
  - When the evidence caps the label, `insufficientEvidence` is set and the estimate is reported separately.
- **Calibration note (needs product input):** with β=2 and a 0.90 threshold, α must reach 18. From an
  intermediate difficulty-4 prior, that means nine perfect _engineering defenses_, or about 17 perfect
  short explanations. Any imperfect answer raises the bar further. The spec's numbers produce this, and
  a test pins it (`mastery.test.ts`). It may prove too conservative once real usage data exists.

## D9. Lesson depth

Depth is chosen from the posterior mean (intro below 0.40, applied below 0.55, advanced below 0.85,
otherwise defense), then capped in two ways:

- It never goes deeper than _advanced_ unless the learner is at least Proficient.
- It never goes more than one step beyond the mapper's `suggestedDepth`.

With no evidence, the same concept therefore gets different depths for different starting levels (tested).

## D10. Ranking details

- The priority formula and weights are exactly as in §12.
- **Mastery gap** is `1 − posterior mean`.
- **Prerequisite readiness** is the mean over direct prerequisites of `min(1, mastery / 0.55)`.
- **Novelty** is `1 / (1 + evidenceCount)`.
- **Penalties:**
  - A lesson on the same concept within 72 h: −0.30.
  - Unmet prerequisites (direct prerequisite mastery below 0.25): −0.15 × the unmet fraction. The unmet
    prerequisites are also returned so the UI can say what to cover first. The threshold was 0.35 in v1,
    which sat above the novice priors for difficulty 1–2, so every concept with prerequisites was
    penalized for novices and the two root concepts won almost every ranking (review finding graph-01;
    a regression test pins the fix).
  - Weak evidence (relevance below 0.5): −0.15.
- **Exclusions,** reported with a reason: unknown concept ID, no code evidence, relevance below 0.3,
  and duplicate mappings (the strongest is kept).
- If the best candidate scores below 0.2, nothing is recommended and the result carries an honest reason.
- Ties break by significance, then by concept ID, so the output is fully deterministic.
- Every candidate returns its raw components, weighted terms, penalties, and plain-language reasons.

## D11. Mastery events and projection

- `mastery_events` is append-only, enforced in Postgres: a trigger rejects `UPDATE`. `DELETE` stays
  allowed so user data deletion can cascade.
- Every event stores its inputs (kind, mode, score, confidence), the computed delta, and α/β before and
  after, plus whether it was applied and why not. Low-confidence grades are therefore auditable.
- Writes lock the projection row (`SELECT … FOR UPDATE`) and insert the event and the updated projection
  in one transaction.
- Replay orders by a bigint identity `sequence`, because timestamps tie inside a transaction, and applies
  the **stored** deltas rather than today's config. Changing weights later doesn't rewrite history.
- Mastery events carry the curriculum version and have a composite foreign key to that version's concept.

## D12. Users table shaped for Auth.js

`users` uses text IDs and the column names of the Auth.js Drizzle adapter (`name`, `email`,
`email_verified`, `image`). Milestone 2 can then add `accounts` and `sessions` without reshaping it.
`starting_level` stays null until onboarding.

## D13. Jobs **(delegated, deferred)**

A `JobQueue` interface with idempotency keys lives in `@academy/shared`. Nothing enqueues work before
Milestone 2. The planned implementation is a Postgres-backed queue (pg-boss), which fits the "no extra
infrastructure" goal. The worker already boots, validates its environment, pings Postgres, and shuts down
cleanly on SIGINT and SIGTERM.

## D14. Logging without private code

`createLogger` emits JSON lines and redacts by field name before serialization:

- Keys named exactly `code`, `content`, `prompt`, or `authorization` are redacted.
- Keys whose final word is `patch`, `diff`, `excerpt`, `answer`, `response`, `token`, `secret`, or `password` are redacted.
- Keys ending in `privateKey` or `apiKey` are redacted.

Telemetry such as `statusCode` or `inputTokens` passes through. Logged errors include their `cause`
chain, and any `params:` line is dropped from messages and stacks. Drizzle puts bound query values
there, and those values could be code or learner answers. This is a safety net, not permission to log
content.

## D15. UI components **(delegated, deferred)**

The Milestone 0/1 pages are Tailwind-only server components. shadcn/ui gets adopted when interactive,
accessibility-sensitive components arrive with the lesson player in Milestone 4.

## D16. Environment loading

One `.env` at the repository root serves every process:

- Scripts and the worker load it with `tsx --env-file-if-exists`.
- `next.config.ts` loads it with `process.loadEnvFile`.

Variables already in the environment always win.

## D17. `related` concepts with boundaries

Concepts may list `related: [{ id, boundary }]`: neighbours that are _not_ prerequisites, with one
sentence saying which code belongs where. The review found most overlaps (retries/timeouts/failure
recovery, authorization/request forgery, serialization/validation, concurrency/isolation) were
adjacency, and the only structural link available was a prerequisite edge, which changes ranking.
`related` feeds the concept mapper and lesson generator only. It is validated (exists, not self, no
duplicates, warns if also a prerequisite) and never used in ranking or cycle checks.

## D18. Redundant prerequisite edges are warnings

Readiness is averaged over _direct_ prerequisites, so an edge already implied through another
prerequisite silently re-weights a concept. `validateCurriculum` warns with
`redundant_transitive_prerequisite`, and the seed-curriculum test requires zero warnings.

## Deferred on purpose

- **Playwright:** the thin-slice E2E test belongs to Milestone 5, once there is a flow to drive.
- **Next.js ESLint plugin:** the TypeScript-ESLint rules cover the code so far. Add it with the
  interactive UI in Milestone 4.
