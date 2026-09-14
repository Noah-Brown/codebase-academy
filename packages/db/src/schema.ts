import { ASSESSMENT_MODES, type AssessmentMode } from "@academy/curriculum";
import { EVIDENCE_KINDS, STARTING_LEVELS } from "@academy/learning";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const startingLevelEnum = pgEnum("starting_level", STARTING_LEVELS);
export const evidenceKindEnum = pgEnum("evidence_kind", EVIDENCE_KINDS);
export const assessmentModeEnum = pgEnum("assessment_mode", ASSESSMENT_MODES);

// ---------------------------------------------------------------------------
// Users and Better Auth tables. JS property names follow Better Auth's Drizzle
// adapter (`user`, `session`, `account`, `verification`); columns stay snake_case.
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** Null until onboarding; sets priors only, never a permanent label. */
  startingLevel: startingLevelEnum("starting_level"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("accounts_user_id_idx").on(t.userId),
    unique("accounts_provider_account_unique").on(t.providerId, t.accountId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Canonical curriculum — imported from checked-in data, immutable per version.
// ---------------------------------------------------------------------------

export const curriculumVersions = pgTable("curriculum_versions", {
  version: integer("version").primaryKey(),
  contentHash: text("content_hash").notNull(),
  conceptCount: integer("concept_count").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const curriculumDomains = pgTable(
  "curriculum_domains",
  {
    curriculumVersion: integer("curriculum_version")
      .notNull()
      .references(() => curriculumVersions.version),
    id: text("id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.curriculumVersion, t.id] })],
);

export const curriculumConcepts = pgTable(
  "curriculum_concepts",
  {
    curriculumVersion: integer("curriculum_version").notNull(),
    id: text("id").notNull(),
    domainId: text("domain_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    difficulty: smallint("difficulty").notNull(),
    operationalImportance: doublePrecision("operational_importance").notNull(),
    learningObjectives: jsonb("learning_objectives").$type<string[]>().notNull(),
    recognitionSignals: jsonb("recognition_signals").$type<string[]>().notNull(),
    misconceptionPatterns: jsonb("misconception_patterns").$type<string[]>().notNull(),
    assessmentModes: jsonb("assessment_modes").$type<AssessmentMode[]>().notNull(),
    related: jsonb("related")
      .$type<Array<{ id: string; boundary: string }>>()
      .notNull()
      .default([]),
    tags: jsonb("tags").$type<string[]>().notNull(),
    conceptVersion: integer("concept_version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.curriculumVersion, t.id] }),
    foreignKey({
      columns: [t.curriculumVersion, t.domainId],
      foreignColumns: [curriculumDomains.curriculumVersion, curriculumDomains.id],
    }),
    check("curriculum_concepts_difficulty_range", sql`${t.difficulty} between 1 and 5`),
  ],
);

export const curriculumPrerequisites = pgTable(
  "curriculum_prerequisites",
  {
    curriculumVersion: integer("curriculum_version").notNull(),
    conceptId: text("concept_id").notNull(),
    prerequisiteId: text("prerequisite_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.curriculumVersion, t.conceptId, t.prerequisiteId] }),
    foreignKey({
      columns: [t.curriculumVersion, t.conceptId],
      foreignColumns: [curriculumConcepts.curriculumVersion, curriculumConcepts.id],
    }),
    foreignKey({
      columns: [t.curriculumVersion, t.prerequisiteId],
      foreignColumns: [curriculumConcepts.curriculumVersion, curriculumConcepts.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Learner model: append-only events plus a current projection.
// ---------------------------------------------------------------------------

export const learnerConceptStates = pgTable(
  "learner_concept_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conceptId: text("concept_id").notNull(),
    /** Curriculum version the state was initialized or last updated under. */
    curriculumVersion: integer("curriculum_version")
      .notNull()
      .references(() => curriculumVersions.version),
    priorAlpha: doublePrecision("prior_alpha").notNull(),
    priorBeta: doublePrecision("prior_beta").notNull(),
    alpha: doublePrecision("alpha").notNull(),
    beta: doublePrecision("beta").notNull(),
    evidenceCount: integer("evidence_count").notNull().default(0),
    evidenceWeight: doublePrecision("evidence_weight").notNull().default(0),
    sessionIds: jsonb("session_ids").$type<string[]>().notNull().default([]),
    demonstratedModes: jsonb("demonstrated_modes").$type<AssessmentMode[]>().notNull().default([]),
    highestModeDemonstrated: assessmentModeEnum("highest_mode_demonstrated"),
    lastAssessedAt: timestamp("last_assessed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.conceptId] }),
    check("learner_concept_states_positive_beta_params", sql`${t.alpha} > 0 and ${t.beta} > 0`),
  ],
);

export const masteryEvents = pgTable(
  "mastery_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Total order for replay; timestamps can tie inside a transaction. */
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conceptId: text("concept_id").notNull(),
    curriculumVersion: integer("curriculum_version").notNull(),
    /** Lesson session and assessment attempt links arrive with Milestone 4 tables. */
    sessionId: text("session_id"),
    assessmentAttemptId: text("assessment_attempt_id"),
    evidenceKind: evidenceKindEnum("evidence_kind").notNull(),
    assessmentMode: assessmentModeEnum("assessment_mode").notNull(),
    score: doublePrecision("score").notNull(),
    graderConfidence: doublePrecision("grader_confidence").notNull(),
    baseWeight: doublePrecision("base_weight").notNull(),
    confidenceFactor: doublePrecision("confidence_factor").notNull(),
    appliedWeight: doublePrecision("applied_weight").notNull(),
    alphaDelta: doublePrecision("alpha_delta").notNull(),
    betaDelta: doublePrecision("beta_delta").notNull(),
    alphaBefore: doublePrecision("alpha_before").notNull(),
    betaBefore: doublePrecision("beta_before").notNull(),
    alphaAfter: doublePrecision("alpha_after").notNull(),
    betaAfter: doublePrecision("beta_after").notNull(),
    applied: boolean("applied").notNull(),
    skipReason: text("skip_reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.curriculumVersion, t.conceptId],
      foreignColumns: [curriculumConcepts.curriculumVersion, curriculumConcepts.id],
    }),
    index("mastery_events_user_concept_idx").on(t.userId, t.conceptId, t.sequence),
    check("mastery_events_score_range", sql`${t.score} between 0 and 1`),
    check("mastery_events_confidence_range", sql`${t.graderConfidence} between 0 and 1`),
  ],
);

// ---------------------------------------------------------------------------
// GitHub ingestion. Installations are global; access for a user flows only
// through user_installations (verified against GitHub's /user/installations).
// ---------------------------------------------------------------------------

export const INSTALLATION_ACCOUNT_TYPES = ["User", "Organization"] as const;
export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;
export const ANALYSIS_STATUSES = ["queued", "running", "succeeded", "failed", "skipped"] as const;
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

export const githubInstallations = pgTable("github_installations", {
  /** GitHub installation ID. */
  id: bigint("id", { mode: "number" }).primaryKey(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userInstallations = pgTable(
  "user_installations",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.installationId] }),
    index("user_installations_installation_id_idx").on(t.installationId),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    /** GitHub repository ID. */
    id: bigint("id", { mode: "number" }).primaryKey(),
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    /** Null only when a webhook delta announced the repo without it; the next sync fills it. */
    defaultBranch: text("default_branch"),
    private: boolean("private").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("repositories_installation_id_idx").on(t.installationId)],
);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    authorLogin: text("author_login").notNull(),
    baseRef: text("base_ref").notNull(),
    headRef: text("head_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    state: text("state", { enum: PULL_REQUEST_STATES }).notNull(),
    githubUpdatedAt: timestamp("github_updated_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("pull_requests_repository_number_unique").on(t.repositoryId, t.number),
    index("pull_requests_repository_state_idx").on(t.repositoryId, t.state),
    check("pull_requests_state_valid", sql`${t.state} in (${inList(PULL_REQUEST_STATES)})`),
  ],
);

export const prAnalyses = pgTable(
  "pr_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    analyzerVersion: text("analyzer_version").notNull(),
    status: text("status", { enum: ANALYSIS_STATUSES }).notNull().default("queued"),
    /** Stable machine code only (failure or skip reason); never a free-form message. */
    errorCode: text("error_code"),
    /** `AnalysisContext` from @academy/github, validated there before storage. */
    context: jsonb("context").$type<Record<string, unknown>>(),
    estimatedTokens: integer("estimated_tokens"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("pr_analyses_idempotency_unique").on(
      t.repositoryId,
      t.prNumber,
      t.headSha,
      t.analyzerVersion,
    ),
    // Keeps the denormalized key consistent with the pull request it belongs to.
    foreignKey({
      name: "pr_analyses_pull_request_number_fk",
      columns: [t.repositoryId, t.prNumber],
      foreignColumns: [pullRequests.repositoryId, pullRequests.number],
    }).onDelete("cascade"),
    index("pr_analyses_pull_request_idx").on(t.pullRequestId, t.createdAt),
    check("pr_analyses_status_valid", sql`${t.status} in (${inList(ANALYSIS_STATUSES)})`),
  ],
);

// ---------------------------------------------------------------------------
// Durable job queue (D20).
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    idempotencyKey: text("idempotency_key").unique(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    /** Number of times the job has been claimed (a crashed attempt still counts). */
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Stable machine code only; error messages may carry repository content. */
    lastErrorCode: text("last_error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.queue, t.status, t.runAfter),
    check("jobs_status_valid", sql`${t.status} in (${inList(JOB_STATUSES)})`),
    check("jobs_max_attempts_positive", sql`${t.maxAttempts} >= 1`),
  ],
);
