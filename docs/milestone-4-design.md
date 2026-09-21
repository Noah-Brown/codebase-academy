# Milestone 4 design: the lesson loop

Status: in progress. Brief sections: §6 (lesson anatomy), §11, §12 steps 5–6, §13, §15, §16.4, §17, §22.

## Scope

1. **Generation:** structured lesson generation for one mapped concept at the depth the ranker chose,
   using the concept's canonical fields and the PR's verified code evidence.
2. **Player:** a one-step-at-a-time lesson player, with answer-first checks and "I don't know—teach
   me".
3. **Grading:** multiple choice is graded deterministically. Open responses are graded by a model
   against a rubric stored with the lesson.
4. **Mastery:** every assessed step records an auditable mastery event, and the takeaway shows what
   changed.
5. **Feedback:** a user can flag a grade as unhelpful, and the flag is kept.

Out of scope, all Milestone 5: repository disconnect and data deletion, the end-to-end test, cost
telemetry, and a skill map with personal status.

## Product decisions (2026-09-15)

| Question                   | Decision                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Mastery calibration (D8)   | Keep the current bar (about nine perfect defenses to Mastered on a difficulty-4 concept)     |
| Rubric source              | Per question: the generator writes each rubric from the concept's canonical objectives (D24) |
| Draft lesson catalogue     | Not used; lessons come only from canonical curriculum fields and PR evidence                 |
| When lessons are generated | When the learner starts one (one model call per lesson actually taken)                       |

## Flow

```text
analysis page ─ Start lesson ─▶ requestLesson (server recomputes concept + depth) ─▶ lessons (queued) + job
lesson-generation job ─ generateLesson(model, concept, depth, learner, evidence) ─▶ validate ─▶ lessons (ready)
lesson page ─ Begin ─▶ lesson_sessions (active)
  multiple choice / "I don't know" ─▶ graded in the request ─▶ recordAssessmentEvidence ─▶ reveal
  open response ─▶ assessment_attempts (grading) + job ─▶ gradeResponse ─▶ score from criteria ─▶ mastery event
takeaway ─▶ session completed ─▶ mastery before/after for the concept
```

## Lesson content (Contract)

`GENERATOR_VERSION = "lesson-v1"`. The model returns the shape below. Validation is structural and
rejects the whole lesson (`invalid_output`, retried), because a partial lesson is not teachable.

```ts
type LessonContent = {
  title: string;
  estimatedMinutes: number; // clamped to 3..15
  rationale: string; // why this concept matters in this PR
  objectiveIndexes: number[]; // indexes into the concept's canonical learningObjectives
  steps: LessonStep[];
};

type LessonStep =
  | { type: "explanation"; title: string; body: string; evidenceIds: string[] }
  | {
      type: "multiple_choice";
      mode: "recognize" | "predict" | "trace";
      prompt: string;
      evidenceIds: string[];
      choices: Array<{ id: string; text: string }>;
      correctChoiceId: string;
      explanation: string;
      objectiveIndex: number;
    }
  | {
      type: "open_response";
      mode: "explain" | "compare" | "design" | "defend";
      prompt: string;
      evidenceIds: string[];
      rubric: Array<{ criterion: string; weight: number; expectedSignals: string[] }>;
      exemplarSummary: string;
      objectiveIndex: number;
    }
  | { type: "takeaway"; points: string[] };
```

**Validation:**

- **Order:**
  - 4–8 steps.
  - The first step is an explanation and the last is the only takeaway.
  - Two or three assessment steps (brief §6).
- **Evidence:**
  - `evidenceIds` refer to the evidence supplied with the request (`e1`, `e2`, …).
  - At least one explanation cites evidence (the "code focus" step).
- **Modes:**
  - Every assessment mode must be one of the concept's canonical `assessmentModes`.
  - `defend` appears only at depth `defense`.
  - `compare` and `design` appear only at `advanced` or `defense`.
  - An intro lesson has at most one open response.
  - A defense lesson has at least one.
- **Multiple choice:** 3–5 choices with unique IDs, and the correct choice is one of them.
- **Open responses:** 1–4 rubric criteria, each with a positive weight and at least one expected
  signal. Weights are normalized to sum to 1 when stored.
- **Objectives:** `objectiveIndex` and `objectiveIndexes` point at existing canonical objectives. The
  stored lesson carries the objective text.
- **No code in prose:** no fenced code blocks in any text. Code appears only through `evidenceIds`,
  which render the excerpts already verified against the PR (D23). The model therefore cannot put
  private or invented code in front of the learner (brief §17).
- **Length limits:** caps on every text field.

**Hidden until answered:** the lesson sent to the browser omits `correctChoiceId`, `explanation`,
`rubric`, and `exemplarSummary` until that step's attempt is graded (brief §13).

## Grading (Contract)

`GRADER_VERSION = "grader-v1"`.

**Multiple choice:** score 1 or 0, grader confidence 1, no model call.

**"I don't know—teach me":** score 0, confidence 1, no model call. The teaching (explanation or
exemplar) is revealed. It is honest evidence of not knowing yet, and the UI uses no shame language.

**Open responses:** the model returns:

```ts
type GraderOutput = {
  criterionResults: Array<{
    criterionIndex: number;
    met: "yes" | "partial" | "no";
    evidenceFromAnswer: string;
  }>;
  feedback: string;
  misconceptionConceptIds: string[];
  graderConfidence: number; // 0..1
};
```

**Grader validation:**

- **Coverage:** exactly one result per rubric criterion, or the output is invalid.
- **Score:** computed from the criteria and their stored weights (yes 1, partial 0.5, no 0; configurable
  in `@academy/learning`). The model's opinion of the total is not used, so scores are reproducible from
  the stored result (D25).
- **Quote check:** a `yes` or `partial` result must quote the learner's answer. When a quote does not
  appear in the answer (whitespace-normalized), confidence is multiplied by 0.5 (configurable) and the
  result is marked unverified.
- **Misconceptions:** concept IDs outside the curriculum are dropped.
- **Low confidence:** the D8 rules decide whether and how strongly the grade updates mastery. Feedback
  is always shown.

**Prompt safety:** the learner's answer is untrusted text and goes in a nonce-delimited block, like
repository content.

## Evidence kinds (brief §11)

| Step                                  | Evidence kind                 | Weight |
| ------------------------------------- | ----------------------------- | -----: |
| Multiple choice, `recognize`          | `multiple_choice`             |    0.5 |
| Multiple choice, `predict` / `trace`  | `prediction` / `trace`        |    0.8 |
| Open response, `explain`, no evidence | `short_explanation`           |    1.0 |
| Open response, `explain`, with code   | `code_grounded_open_response` |    1.3 |
| Open response, `compare` / `design`   | `design_comparison`           |    1.5 |
| Open response, `defend`               | `engineering_defense`         |    2.0 |

## Data model (Contract)

Every row is scoped to its user (`user_id`) and also reaches the repository through `pr_analyses`, so
revoking repository access hides lessons built from its code.

- **`lessons`:** unique on `(user_id, analysis_id, concept_id, depth, generator_version)`.
  - **Keys:** `mapping_run_id`, and `curriculum_version` with a foreign key to the concept.
  - **Status:** `queued | generating | ready | failed`, with `error_code`.
  - **Content:** `sources` is the generation input snapshot: evidence with IDs, ranking reasons, and the
    learner's status. `content` is the validated lesson.
  - **Telemetry:** provider, model, tokens, and duration.
- **`lesson_sessions`:** `status active | completed` and `current_step`. At most one active session per
  user and lesson.
- **`assessment_attempts`:** unique on `(session_id, step_index)`.
  - **Response:** `response_kind` is `choice | text | dont_know`, with the response.
  - **Grading:** `status grading | graded | failed`, score, grader confidence, the stored grading result,
    evidence kind, mode, grader provider, model, and version.
  - **Links:** `mastery_event_id`.
  - **Flags:** `flagged_at` and `flag_note`.
- **`mastery_events.assessment_attempt_id`:** a new partial unique index, so a retried grading job
  cannot record the same attempt twice.

Learner answers are private: never logged, shown only to their author.

## HTTP surface (brief §15)

| Route                                                          | Purpose                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /api/analyses/:analysisId/lessons` `{ conceptId }`       | Request a lesson; the server recomputes the ranked depth        |
| `GET /api/lessons/:lessonId`                                   | Generation status (polled while preparing)                      |
| `POST /api/lessons/:lessonId/sessions`                         | Begin or resume the active session                              |
| `POST /api/lesson-sessions/:sessionId/steps/:stepIndex/submit` | `{ choiceId }`, `{ text }`, or `{ dontKnow: true }`             |
| `POST /api/lesson-sessions/:sessionId/advance`                 | Move to the next step (an assessed step must be answered first) |
| `GET /api/assessment-attempts/:attemptId`                      | Grading status and the revealed result                          |
| `POST /api/assessment-attempts/:attemptId/flag` `{ note? }`    | "This grade seems wrong"                                        |

## Model configuration

Lesson generation and grading use the same provider settings as concept mapping
(`CONCEPT_MAPPER_*`, D21), so one `claude -p` setup serves all three. The worker registers the
`lesson-generation` and `assessment-grading` queues next to `concept-mapping`.

## Testing

- **Unit tests:**
  - lesson and grader validation;
  - prompt delimiting;
  - evidence-kind mapping and score computation in `@academy/learning`;
  - the public projection, which must not leak answers.
- **PGlite tests:**
  - lesson requests (idempotency, server-side depth, tenancy);
  - sessions and attempts (one attempt per step, deterministic grading, mastery events recorded once);
  - the generation and grading jobs.
- **Live evaluation:** `npm run eval:lesson -w @academy/ai` generates a lesson from golden mapping
  fixtures, then grades a strong and a weak answer. It checks that the lesson validates and that the
  strong answer outscores the weak one.

## Live results (2026-09-15)

The results below are from `npm run eval:lesson -w @academy/ai` on the Claude CLI (`sonnet`, medium effort), using the synthetic idempotency fixture at depth `advanced`.

- **First run: generation failed validation.** The draft had the wrong number of checks (`assessment_count`). Two changes fixed it:
  - the prompt now spells out the step order and says to count the checks;
  - a draft that fails structural validation gets one repair call that names the failed checks (`repairAttempts`, default 1).
- **Second run: grading.** A correct answer (the exemplar) scored 1.00 but its confidence fell from 0.95 to 0.24. Two of its quotes failed a literal substring check, which put the grade below the 0.4 confidence floor, so it would not have counted toward mastery.
  - Quotes are now compared as word sequences, ignoring punctuation, quotation marks, and case.
  - Quotes joined with an ellipsis are checked fragment by fragment.
  - The grader prompt asks for one exact phrase.
- **Third run: both passed.**
  - **Generation:** a 7-step lesson with three checks (predict, compare, design) in 74 s, producing about 8k output tokens.
  - **Grading:** the strong answer scored 1.00 and the weak answer 0.00, both at confidence 0.95, with every quote verified, in 11 s for both answers.

Generation takes over a minute, so the preparing screen says "a minute or two" and refreshes itself.

## Real lesson (2026-09-21)

The product owner took the first real lesson, on `systems.processes-and-threads` from a pull request in their own repository.

- **Generation:** 7 steps at `intro` depth, in 17.6 s (3.5k prompt tokens, 1.7k output).
- **Player:** completed the lesson, using "I don't know—teach me" on one check and writing an answer to the other.
- **Grading:** the written answer was graded at confidence 0.90, and no grade was flagged as unhelpful.
- **Mastery:** both answers recorded mastery events and applied to `systems.processes-and-threads`, with the weights their evidence kinds earn (prediction 0.8, short explanation 1.0).

The loop and the fairness of the grading were judged sound, which closes the milestone.
