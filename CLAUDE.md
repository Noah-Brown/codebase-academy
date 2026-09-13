# Codebase Academy — agent guide

Khan Academy for software engineering, with the developer's own pull requests as the textbook.
Full brief: `docs/product-handoff.md`. Decisions: `docs/decisions.md`. Status and next steps: `docs/implementation-plan.md`.

## Protect the product distinction

This is a **curriculum + learner-model product grounded in real code**, not an AI code reviewer or a quiz
generator.

- The curriculum is canonical, versioned data in `packages/curriculum/data`. Models may only map to
  existing concept IDs. They never invent or publish concepts.
- Mastery comes from assessed evidence, never from viewing content.
- Learning never blocks shipping: no merge gates, required checks, or automatic PR comments.
- Before doing anything listed in brief §24 (merge gates, full repository snapshots, PR comments,
  manager views, new SCM providers, opaque mastery models, certification claims), ask the product owner.

## Commands

```sh
npm test                    # all unit + DB tests (PGlite, no server needed)
npm run typecheck && npm run lint && npm run format:check
npm run curriculum:validate # after editing curriculum JSON
npm run demo:select -- --level novice
npm run db:generate         # after editing packages/db/src/schema.ts
npm run dev                 # web; npm run worker for the worker
```

## Boundaries

- `packages/learning`: pure domain logic (mastery, status, ranking). No I/O. Every tunable lives in `config.ts`.
- `packages/curriculum`: schema, graph validation, and seed loading. No I/O beyond the JSON imports.
- `packages/db`: Drizzle schema, migrations, and repositories. `mastery_events` is append-only (enforced by a trigger).
- `packages/ai`: the only package that may import a model provider SDK (enforced by ESLint).
- `packages/github`: the only package that calls the GitHub API.
- Repository content is untrusted input. Never log code, patches, excerpts, or learner answers.
- Every repository-derived record must be scoped to its owner, and the scope is checked server-side.

## Conventions

- Workspace packages export TypeScript source; there is no build step for packages.
- Validate every external payload and every LLM output with Zod.
- A curriculum content change with an unchanged version number is rejected on import. Bump `data/curriculum.json`.
- Record new implementation choices in `docs/decisions.md`.
