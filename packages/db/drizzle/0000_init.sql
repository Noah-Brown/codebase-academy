CREATE TYPE "public"."assessment_mode" AS ENUM('recognize', 'predict', 'trace', 'explain', 'compare', 'design', 'defend');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('multiple_choice', 'prediction', 'trace', 'short_explanation', 'code_grounded_open_response', 'design_comparison', 'engineering_defense');--> statement-breakpoint
CREATE TYPE "public"."starting_level" AS ENUM('novice', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TABLE "curriculum_concepts" (
	"curriculum_version" integer NOT NULL,
	"id" text NOT NULL,
	"domain_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"difficulty" smallint NOT NULL,
	"operational_importance" double precision NOT NULL,
	"learning_objectives" jsonb NOT NULL,
	"recognition_signals" jsonb NOT NULL,
	"misconception_patterns" jsonb NOT NULL,
	"assessment_modes" jsonb NOT NULL,
	"tags" jsonb NOT NULL,
	"concept_version" integer NOT NULL,
	CONSTRAINT "curriculum_concepts_curriculum_version_id_pk" PRIMARY KEY("curriculum_version","id"),
	CONSTRAINT "curriculum_concepts_difficulty_range" CHECK ("curriculum_concepts"."difficulty" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "curriculum_domains" (
	"curriculum_version" integer NOT NULL,
	"id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "curriculum_domains_curriculum_version_id_pk" PRIMARY KEY("curriculum_version","id")
);
--> statement-breakpoint
CREATE TABLE "curriculum_prerequisites" (
	"curriculum_version" integer NOT NULL,
	"concept_id" text NOT NULL,
	"prerequisite_id" text NOT NULL,
	CONSTRAINT "curriculum_prerequisites_curriculum_version_concept_id_prerequisite_id_pk" PRIMARY KEY("curriculum_version","concept_id","prerequisite_id")
);
--> statement-breakpoint
CREATE TABLE "curriculum_versions" (
	"version" integer PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"concept_count" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learner_concept_states" (
	"user_id" text NOT NULL,
	"concept_id" text NOT NULL,
	"curriculum_version" integer NOT NULL,
	"prior_alpha" double precision NOT NULL,
	"prior_beta" double precision NOT NULL,
	"alpha" double precision NOT NULL,
	"beta" double precision NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"evidence_weight" double precision DEFAULT 0 NOT NULL,
	"session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"demonstrated_modes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"highest_mode_demonstrated" "assessment_mode",
	"last_assessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_concept_states_user_id_concept_id_pk" PRIMARY KEY("user_id","concept_id"),
	CONSTRAINT "learner_concept_states_positive_beta_params" CHECK ("learner_concept_states"."alpha" > 0 and "learner_concept_states"."beta" > 0)
);
--> statement-breakpoint
CREATE TABLE "mastery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "mastery_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"concept_id" text NOT NULL,
	"curriculum_version" integer NOT NULL,
	"session_id" text,
	"assessment_attempt_id" text,
	"evidence_kind" "evidence_kind" NOT NULL,
	"assessment_mode" "assessment_mode" NOT NULL,
	"score" double precision NOT NULL,
	"grader_confidence" double precision NOT NULL,
	"base_weight" double precision NOT NULL,
	"confidence_factor" double precision NOT NULL,
	"applied_weight" double precision NOT NULL,
	"alpha_delta" double precision NOT NULL,
	"beta_delta" double precision NOT NULL,
	"alpha_before" double precision NOT NULL,
	"beta_before" double precision NOT NULL,
	"alpha_after" double precision NOT NULL,
	"beta_after" double precision NOT NULL,
	"applied" boolean NOT NULL,
	"skip_reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mastery_events_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "mastery_events_score_range" CHECK ("mastery_events"."score" between 0 and 1),
	CONSTRAINT "mastery_events_confidence_range" CHECK ("mastery_events"."grader_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"starting_level" "starting_level",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "curriculum_concepts" ADD CONSTRAINT "curriculum_concepts_curriculum_version_domain_id_curriculum_domains_curriculum_version_id_fk" FOREIGN KEY ("curriculum_version","domain_id") REFERENCES "public"."curriculum_domains"("curriculum_version","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_domains" ADD CONSTRAINT "curriculum_domains_curriculum_version_curriculum_versions_version_fk" FOREIGN KEY ("curriculum_version") REFERENCES "public"."curriculum_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_prerequisites" ADD CONSTRAINT "curriculum_prerequisites_curriculum_version_concept_id_curriculum_concepts_curriculum_version_id_fk" FOREIGN KEY ("curriculum_version","concept_id") REFERENCES "public"."curriculum_concepts"("curriculum_version","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curriculum_prerequisites" ADD CONSTRAINT "curriculum_prerequisites_curriculum_version_prerequisite_id_curriculum_concepts_curriculum_version_id_fk" FOREIGN KEY ("curriculum_version","prerequisite_id") REFERENCES "public"."curriculum_concepts"("curriculum_version","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_concept_states" ADD CONSTRAINT "learner_concept_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_concept_states" ADD CONSTRAINT "learner_concept_states_curriculum_version_curriculum_versions_version_fk" FOREIGN KEY ("curriculum_version") REFERENCES "public"."curriculum_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_events" ADD CONSTRAINT "mastery_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_events" ADD CONSTRAINT "mastery_events_curriculum_version_concept_id_curriculum_concepts_curriculum_version_id_fk" FOREIGN KEY ("curriculum_version","concept_id") REFERENCES "public"."curriculum_concepts"("curriculum_version","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mastery_events_user_concept_idx" ON "mastery_events" USING btree ("user_id","concept_id","sequence");