# Codebase Academy

Software-engineering lessons taught from your own pull requests. A canonical curriculum and a learner
model decide _what_ you should learn next. Your current code supplies the examples.

> Working title. Product brief: [`docs/product-handoff.md`](docs/product-handoff.md)

**Status:** Milestones 0–1 are complete. The foundation, the curriculum, the learner model, and lesson
ranking are built and tested. GitHub ingestion (Milestone 2) is next; see
[`docs/implementation-plan.md`](docs/implementation-plan.md).

## Requirements

- Node.js ≥ 22.12 (developed on 26)
- npm ≥ 10
- Postgres 16+ for running the app and worker, via Docker (`docker compose`) or a local install.
  **Tests do not need Postgres**: they use in-process PGlite.

## Setup

```sh
npm install
cp .env.example .env              # DATABASE_URL defaults to the compose database
npm run db:up                     # start Postgres in Docker (or point DATABASE_URL elsewhere)
npm run db:migrate
npm run curriculum:import
```

Run things:

```sh
npm run dev                       # web app → http://localhost:3000
npm run worker                    # background worker (no jobs registered until Milestone 2)
curl localhost:3000/api/health    # {"status":"ok","database":"ok"}
```

## Commands

| Command                                 | What it does                                                             |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `npm test`                              | All tests: curriculum, learner model, ranking, DB (PGlite), shared       |
| `npm run check`                         | Format check, lint, typecheck, and tests                                 |
| `npm run curriculum:validate`           | Validate curriculum JSON: schema, references, prerequisite graph         |
| `npm run curriculum:import`             | Import the curriculum into Postgres (idempotent; versions are immutable) |
| `npm run demo:select -- --level novice` | Rank the fixture PR's concepts and explain the recommendation            |
| `npm run db:generate`                   | Generate a migration after editing `packages/db/src/schema.ts`           |
| `npm run db:migrate`                    | Apply migrations to `DATABASE_URL`                                       |
| `npm run build`                         | Production build of the web app                                          |

## Layout

```text
apps/
  web/          Next.js UI + HTTP routes (/, /curriculum, /dev/selection, /api/health)
  worker/       Background jobs (boots, checks DB; handlers from Milestone 2)
packages/
  curriculum/   Curriculum schema, graph validation, seed data (data/*.json)
  learning/     Mastery model, status labels, lesson ranking. Pure functions.
  db/           Drizzle schema, migrations, repositories, PGlite test harness
  shared/       Env validation, redacting logger, job interface
  github/       GitHub App boundary (Milestone 2)
  ai/           Model-provider boundary (Milestone 3)
docs/
  product-handoff.md      The product brief
  implementation-plan.md  Milestone status, next steps, required credentials
  decisions.md            Architecture decisions and tunable parameters
  reviews/                Curriculum review findings (the record behind curriculum v2)
  curriculum/             Lesson catalogue by mastery level (draft)
```

## Principles the code enforces

- **Curriculum is canonical.** Concepts are reviewed data in source control. Importing changed content
  under a published version is refused.
- **Mastery requires evidence.** Priors from your starting level never count as evidence, and a high
  estimate built on thin evidence is labeled as such.
- **History is auditable.** `mastery_events` is append-only (a database trigger enforces it), and the
  current learner state can be rebuilt exactly from the event log.
- **Deterministic ranking.** Every recommendation carries its score breakdown and plain-language reasons.
- **No private code in logs.** The logger redacts code-, answer-, and secret-shaped fields.
- **Shipping is never blocked.**

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm run check`. The product brief
([`docs/product-handoff.md`](docs/product-handoff.md)) explains what the project is and is not trying to be,
and [`docs/decisions.md`](docs/decisions.md) records why things are built the way they are. Curriculum
changes go through the JSON in `packages/curriculum/data/` and must pass `npm run curriculum:validate`.

## License

[Apache License 2.0](LICENSE)
