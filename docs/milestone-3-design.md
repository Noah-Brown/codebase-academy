# Milestone 3 design: concept mapping

Status: implemented. Brief sections: §12 step 3, §17 (mapper contract and prompt-injection defense), §19, §20.

## Scope

1. A provider-neutral structured-generation interface in `@academy/ai`, with two adapters:
   the locally signed-in Claude CLI (D21) and the Claude API.
2. A versioned concept-mapping prompt (`MAPPER_VERSION = "mapper-v1"`) and output schema.
3. Validation that rejects unknown concept IDs, uncited or fabricated evidence, and bad scores (D23).
4. Durable, idempotent mapping runs scheduled automatically after an analysis context is built.
5. The PR learning overview: mapped concepts with evidence, and the recommended lesson with its reasons.
6. Golden fixtures (brief §20) with an offline test and an opt-in live evaluation.

Out of scope: lesson generation and grading (Milestone 4), a `model_calls` telemetry table and cost
reporting (Milestone 5), recent-lesson penalties (no lessons exist yet).

## Flow

```text
pr-analysis job ─ context stored ─▶ scheduleConceptMapping ─▶ concept_mapping_runs (queued) + job
                                                                       │
concept-mapping job ─ mapConcepts(model, context, curriculum) ─▶ validate ─▶ concept_mappings
                                                                       │
analysis page ─ getConceptMappingForUser ─▶ selectLesson (M1 ranker) ─▶ recommendation + evidence
```

- The worker schedules mapping only when a mapper is configured. The analysis page offers
  **Map concepts** for analyses without a run (for example, analyzed before mapping was enabled) and
  **Retry mapping** for failed runs.
- A mapping failure never fails the analysis.

## Data model (Contract)

`concept_mapping_runs`: one row per `(analysis_id, mapper_version, curriculum_version)`, the
idempotency key.

- **Status:** `queued | running | succeeded | failed`, with `error_code` as a stable machine code only.
- **Telemetry:** `provider`, `model`, `input_tokens` (every prompt token, cached ones included),
  `output_tokens`, `duration_ms`.
- **`dropped`:** counts of model output discarded by validation, by reason. Never content.
- **Tenancy:** runs reach their owner through `pr_analyses → pull_requests → repositories →
user_installations`.

`concept_mappings`: the validated mappings of a run, ordered by `position`.

- **Shape:** each row stores the brief's `ConceptMapping` fields, with `evidence` as a JSON array of
  `{ path, startLine?, endLine?, excerpt, rationale }`.
- **`(run_id, curriculum_version)` foreign key:** pins each mapping to its run's curriculum.
- **`(curriculum_version, concept_id)` foreign key:** points at `curriculum_concepts`, so an unknown
  concept ID cannot be stored even if validation were bypassed.
- **Checks:** scores are in 0..1, the depth is valid, and evidence is non-empty.

Scheduling (`scheduleConceptMapping`, `scheduleConceptMappingForUser`):

- **Precondition:** the analysis succeeded and the curriculum version is imported.
- **Enqueuing:** creates the run and its job (key `concept-mapping:<runId>`). Repeat calls return the
  existing run.
- **Retries:** a failed run is reset to `queued` with one retry job per failure
  (`concept-mapping:<runId>:retry:<failedUpdatedAt>`).

## `@academy/ai` (Contract)

- **`StructuredModel.generate({ system, prompt, jsonSchema })`:** returns the raw structured output,
  provider, model, usage, and duration. Throws `ModelCallError` with a code
  (`provider_unavailable`, `auth_failed`, `rate_limited`, `timeout`, `refused`, `output_truncated`,
  `invalid_output`, `request_rejected`, `provider_error`) and a `retryable` flag. Error messages carry
  only the code.
- **`mapConcepts({ model, context, graph })`:** returns validated `MappedConcept[]` (the M1 ranker's
  input type), drop counts, and call telemetry. When no file is included it skips the model call and
  reports `no_included_files`.
- **`@academy/ai/versions`:** exports `MAPPER_VERSION` with no provider code, for the web app.
- **`@academy/ai/testing`:** a scripted model, the context builders, and the golden fixtures.

### Prompt (mapper-v1)

- **System prompt:** the brief's mapper contract, output rules, and the untrusted-data rule, followed
  by the curriculum. For each concept it gives the ID, title, summary, recognition signals, and
  `related` boundaries. It is identical for every pull request of a curriculum version, so providers
  can cache it.
- **User message:** the pull request overview, manifests, each included file's patch, and numbered
  surrounding lines. Skipped files are listed by name only, followed by the list of citable paths.
- **Delimiting:** untrusted text sits inside blocks whose tag names carry a random per-call nonce, and
  the nonce is removed from that text. Repository content cannot close a block early.

### Claude CLI adapter (D21)

`claude -p --model <m> --effort <e> --tools "" --restricted --strict-mcp-config
--no-session-persistence --system-prompt-file <tmp> --output-format json --json-schema <schema>`

- **Prompt input:** the prompt goes on stdin, never argv.
- **Working directory:** a fresh temporary directory, removed afterwards.
- **Environment:** an allow-list (home, path, locale, XDG, `CLAUDE_CONFIG_DIR`). Database URLs, app
  secrets, and `ANTHROPIC_API_KEY` never reach the CLI.
- **Output handling:** stderr is drained and never read, and stdout is capped at 5 MB.
- **Timeout:** the process is killed after the timeout.

A custom system prompt keeps Claude Code's own setup overhead to about 1k tokens per call, measured
on 2026-09-14.

### Claude API adapter

`messages.create` with a cached system block and `output_config: { effort, format: { type:
"json_schema", schema } }`. It maps SDK error classes to `ModelCallError` codes, and refusal or
`max_tokens` stop reasons to `refused` and `output_truncated`.

## Validation (D23)

For each mapping, in order:

1. **Unknown concept ID:** dropped.
2. **Scores outside 0..1:** dropped.
3. **Duplicate concept:** the later mapping is dropped.

For each evidence item:

1. **Path not shown:** a path that is not an included file or manifest is dropped.
2. **Unusable excerpt:** an excerpt shorter than 8 characters, longer than 40 lines, or longer than
   2,000 characters is dropped.
3. **Excerpt not found:** an excerpt that does not appear in what the model was shown is dropped.
4. **Missing rationale:** dropped.

**How excerpts are matched:** the excerpt must appear in the patch (in order, head side, or base side)
or in a surrounding window.

- Whitespace is normalized.
- Copied diff markers and `N|` prefixes are tolerated.
- In a multi-line excerpt, the first and last lines may be partial.

Line numbers outside the shown ranges are removed while the evidence is kept. A mapping left with no
evidence is dropped. The survivors are sorted by relevance × significance and capped at 8.

Relevance thresholds are not applied here: the M1 ranker already excludes low-relevance mappings and
penalizes weak evidence.

## Failure states (brief §19)

| Situation                                | Behavior                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Only skipped files (lockfiles, binaries) | No model call; succeeded with zero mappings; "doesn't map cleanly" state         |
| Nothing maps with confidence             | Succeeded with zero mappings; same honest state, no generic lesson               |
| Invalid structure                        | `invalid_output`, retried by the queue                                           |
| Unknown IDs or fabricated evidence       | Dropped individually; counts stored in `dropped`                                 |
| CLI missing or not signed in             | `provider_unavailable` / `auth_failed`; `auth_failed` not retried; page explains |
| Usage limit                              | `rate_limited`, retried with backoff                                             |
| Worker on another curriculum version     | `curriculum_version_mismatch`, not retried                                       |
| Mapped concepts all below ranking bars   | Shown with the reason; no recommendation                                         |

## Environment (worker)

| Variable                    | Default                                               |
| --------------------------- | ----------------------------------------------------- |
| `CONCEPT_MAPPER_PROVIDER`   | unset (mapping disabled); `claude-cli` or `anthropic` |
| `CONCEPT_MAPPER_MODEL`      | `sonnet` (CLI) / `claude-sonnet-5` (API)              |
| `CONCEPT_MAPPER_EFFORT`     | `medium`                                              |
| `CONCEPT_MAPPER_TIMEOUT_MS` | `300000`                                              |
| `CLAUDE_CLI_PATH`           | `claude`                                              |
| `ANTHROPIC_API_KEY`         | required only for `anthropic`                         |

## Testing

- **Unit tests:** grounding, validation, prompt delimiting, the mapper, both adapters (with a fake
  process and a fake SDK client), and environment parsing.
- **PGlite tests:**
  - the mapping repository: idempotency, retries, tenancy, and the concept foreign key;
  - the worker job;
  - the web start route's scoping.
- **Golden fixtures:** six synthetic pull requests: the brief's five plus a prompt-injection comment.
  Each has required, allowed, and forbidden concepts, plus a recorded model answer that exercises every
  drop path.
- **Live evaluation:** `npm run eval:mapper -w @academy/ai` runs the fixtures against the configured
  provider. It spends real usage and is not part of `npm test`.

## Live results (2026-09-14)

**Golden evaluation.** Run with the Claude CLI (`sonnet`, medium effort).

- **Pass rate:** 3 of 6 fixtures passed after rules 3–6 of the prompt were tightened; 2 passed before.
  The first run mapped about five concepts per change, including foundations the code merely used; the
  tightened prompt maps two or three.
- **What held in every fixture:**
  - the required concepts were found;
  - the prompt-injection fixture mapped only to `fundamentals.dates-and-time`;
  - validation dropped no evidence.
- **Cost:** calls took 3.5–14.5 s. After the first call, about 12k prompt tokens were read from the
  cache.

**Remaining failures.** They are extra concepts that trace to the curriculum rather than the prompt.
They were raised with the product owner instead of being fixed by loosening fixtures:

- **`systems.concurrency` and `systems.bounded-concurrency`:** both list `Promise.all` as a signal and
  have no boundary between them, so the broader concept ranks first.
- **`db.joins`:** its signal "queries executed per item in a loop" also matches per-item inserts.
- **`dsa.search-and-sort`:** it has no boundary against database sorting (`ORDER BY`).
- **`fundamentals.control-flow`:** its guard-clause signal matches any early return, which gives
  low-relevance mappings.

**Real pull request.** A pull request from the owner's repository mapped end to end in 16 s: three
concepts, all evidence grounded, nothing dropped.
