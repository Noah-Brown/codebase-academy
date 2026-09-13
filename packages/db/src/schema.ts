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
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const startingLevelEnum = pgEnum("starting_level", STARTING_LEVELS);
export const evidenceKindEnum = pgEnum("evidence_kind", EVIDENCE_KINDS);
export const assessmentModeEnum = pgEnum("assessment_mode", ASSESSMENT_MODES);

// ---------------------------------------------------------------------------
// Users. Column names follow the Auth.js Drizzle adapter so Milestone 2 can
// attach `accounts`/`sessions` tables without reshaping this one.
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  /** Null until onboarding; sets priors only, never a permanent label. */
  startingLevel: startingLevelEnum("starting_level"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
