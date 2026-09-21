CREATE TABLE "assessment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"response_kind" text NOT NULL,
	"response" jsonb NOT NULL,
	"status" text DEFAULT 'grading' NOT NULL,
	"error_code" text,
	"evidence_kind" "evidence_kind" NOT NULL,
	"assessment_mode" "assessment_mode" NOT NULL,
	"score" double precision,
	"grader_confidence" double precision,
	"grading" jsonb,
	"grader_provider" text,
	"grader_model" text,
	"grader_version" text,
	"mastery_event_id" uuid,
	"flagged_at" timestamp with time zone,
	"flag_note" text,
	"graded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_attempts_session_step_unique" UNIQUE("session_id","step_index"),
	CONSTRAINT "assessment_attempts_status_valid" CHECK ("assessment_attempts"."status" in ('grading', 'graded', 'failed')),
	CONSTRAINT "assessment_attempts_response_kind_valid" CHECK ("assessment_attempts"."response_kind" in ('choice', 'text', 'dont_know')),
	CONSTRAINT "assessment_attempts_score_range" CHECK ("assessment_attempts"."score" is null or "assessment_attempts"."score" between 0 and 1),
	CONSTRAINT "assessment_attempts_confidence_range" CHECK ("assessment_attempts"."grader_confidence" is null or "assessment_attempts"."grader_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "lesson_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_sessions_status_valid" CHECK ("lesson_sessions"."status" in ('active', 'completed')),
	CONSTRAINT "lesson_sessions_current_step_nonnegative" CHECK ("lesson_sessions"."current_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"analysis_id" uuid NOT NULL,
	"mapping_run_id" uuid NOT NULL,
	"concept_id" text NOT NULL,
	"curriculum_version" integer NOT NULL,
	"depth" text NOT NULL,
	"generator_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"sources" jsonb NOT NULL,
	"content" jsonb,
	"provider" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lessons_idempotency_unique" UNIQUE("user_id","analysis_id","concept_id","depth","generator_version"),
	CONSTRAINT "lessons_status_valid" CHECK ("lessons"."status" in ('queued', 'generating', 'ready', 'failed')),
	CONSTRAINT "lessons_depth_valid" CHECK ("lessons"."depth" in ('intro', 'applied', 'advanced', 'defense'))
);
--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_session_id_lesson_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."lesson_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_mastery_event_id_mastery_events_id_fk" FOREIGN KEY ("mastery_event_id") REFERENCES "public"."mastery_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_analysis_id_pr_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."pr_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_mapping_run_id_concept_mapping_runs_id_fk" FOREIGN KEY ("mapping_run_id") REFERENCES "public"."concept_mapping_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_concept_fk" FOREIGN KEY ("curriculum_version","concept_id") REFERENCES "public"."curriculum_concepts"("curriculum_version","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_sessions_one_active" ON "lesson_sessions" USING btree ("lesson_id","user_id") WHERE "lesson_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "lesson_sessions_user_idx" ON "lesson_sessions" USING btree ("user_id","completed_at");--> statement-breakpoint
CREATE INDEX "lessons_user_idx" ON "lessons" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mastery_events_assessment_attempt_unique" ON "mastery_events" USING btree ("assessment_attempt_id") WHERE "mastery_events"."assessment_attempt_id" is not null;