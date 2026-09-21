import type { LessonEvidence, LessonSources } from "./content";
import type { GraderOutput, LessonOutput } from "./schema";

/**
 * A realistic generated lesson for `web.idempotency` at depth `advanced` (allowed modes: predict,
 * explain, compare, design), built on the retry golden fixture's evidence. Synthetic; for tests.
 */
export const idempotencyEvidence: LessonEvidence[] = [
  {
    id: "e1",
    path: "src/billing/chargeCustomer.ts",
    startLine: 6,
    endLine: 8,
    excerpt: [
      "for (let attempt = 0; attempt < 4; attempt++) {",
      "  try {",
      '    return await paymentsClient.post("/charges", { customerId, amountCents });',
    ].join("\n"),
    rationale: "A POST that creates a charge is repeated when an attempt fails.",
  },
];

export const idempotencySources: LessonSources = {
  pullRequestTitle: "Retry failed charges",
  reasons: [
    "This PR retries a request that creates a charge.",
    "You haven't been assessed on it yet.",
  ],
  learner: { level: "intermediate", label: "new", insufficientEvidence: true },
  evidence: idempotencyEvidence,
};

export const idempotencyLessonOutput: LessonOutput = {
  title: "Why retrying a charge can bill a customer twice",
  estimatedMinutes: 8,
  rationale:
    "Your change retries a POST that creates a charge, so an attempt that timed out may already have succeeded.",
  objectiveIndexes: [0, 2],
  steps: [
    {
      type: "explanation",
      title: "Why this matters here",
      body: "Your `chargeCustomer` now retries up to four times. Retrying is only safe when repeating a call has the same effect as making it once.",
      evidenceIds: [],
    },
    {
      type: "explanation",
      title: "The code in focus",
      body: "Each attempt sends the same `POST /charges`. If the connection drops after the provider charged the card but before the response arrives, the loop treats it as a failure and charges again.",
      evidenceIds: ["e1"],
    },
    {
      type: "multiple_choice",
      mode: "predict",
      prompt:
        "The first attempt times out after the provider created the charge. What happens on the next attempt?",
      evidenceIds: ["e1"],
      choices: [
        { id: "a", text: "A second charge is created" },
        { id: "b", text: "The provider rejects the duplicate automatically" },
        { id: "c", text: "The loop stops because the charge already exists" },
      ],
      correctChoiceId: "a",
      explanation:
        "Nothing in the request tells the provider it is a repeat, so it creates another charge. Providers only deduplicate when the client sends something that identifies the original request.",
      objectiveIndex: 0,
    },
    {
      type: "open_response",
      mode: "compare",
      prompt: "Compare two ways to make this retry safe, and say which you would choose here.",
      evidenceIds: ["e1"],
      rubric: [
        {
          criterion: "Proposes an idempotency key that stays the same across attempts",
          weight: 2,
          expectedSignals: ["idempotency key", "same key on every retry"],
        },
        {
          criterion: "Weighs an alternative, such as checking for an existing charge first",
          weight: 1,
          expectedSignals: ["look up an existing charge", "race between the check and the create"],
        },
      ],
      exemplarSummary:
        "Send a stable idempotency key so the provider returns the original charge on retries. Checking for an existing charge first is weaker, because two attempts can race between the check and the create.",
      objectiveIndex: 2,
    },
    {
      type: "takeaway",
      points: [
        "Retries are safe only for idempotent operations.",
        "An idempotency key lets the server recognize a repeated request.",
      ],
    },
  ],
};

export const strongIdempotencyAnswer =
  "I would send an idempotency key with every attempt so the provider can dedupe the charge. Another option is to check whether a charge already exists before retrying, but two retries could race.";

export const idempotencyGraderOutput: GraderOutput = {
  criterionResults: [
    {
      criterionIndex: 0,
      met: "yes",
      evidenceFromAnswer: "send an idempotency key with every attempt",
    },
    {
      criterionIndex: 1,
      met: "partial",
      evidenceFromAnswer: "check whether a charge already exists before retrying",
    },
  ],
  feedback:
    "You named the key idea: a stable idempotency key. You also spotted the race in check-then-create; say which approach you would pick and why.",
  misconceptionConceptIds: [],
  graderConfidence: 0.9,
};
