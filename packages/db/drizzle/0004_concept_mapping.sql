CREATE TABLE "concept_mapping_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"mapper_version" text NOT NULL,
	"curriculum_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"provider" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"dropped" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_mapping_runs_idempotency_unique" UNIQUE("analysis_id","mapper_version","curriculum_version"),
	CONSTRAINT "concept_mapping_runs_id_curriculum_unique" UNIQUE("id","curriculum_version"),
	CONSTRAINT "concept_mapping_runs_status_valid" CHECK ("concept_mapping_runs"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "concept_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"curriculum_version" integer NOT NULL,
	"concept_id" text NOT NULL,
	"position" integer NOT NULL,
	"relevance" double precision NOT NULL,
	"significance" double precision NOT NULL,
	"suggested_depth" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_mappings_run_concept_unique" UNIQUE("run_id","concept_id"),
	CONSTRAINT "concept_mappings_relevance_range" CHECK ("concept_mappings"."relevance" between 0 and 1),
	CONSTRAINT "concept_mappings_significance_range" CHECK ("concept_mappings"."significance" between 0 and 1),
	CONSTRAINT "concept_mappings_depth_valid" CHECK ("concept_mappings"."suggested_depth" in ('intro', 'applied', 'advanced', 'defense')),
	CONSTRAINT "concept_mappings_evidence_present" CHECK (jsonb_typeof("concept_mappings"."evidence") = 'array' and jsonb_array_length("concept_mappings"."evidence") > 0)
);
--> statement-breakpoint
ALTER TABLE "concept_mapping_runs" ADD CONSTRAINT "concept_mapping_runs_analysis_id_pr_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."pr_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_mapping_runs" ADD CONSTRAINT "concept_mapping_runs_curriculum_version_curriculum_versions_version_fk" FOREIGN KEY ("curriculum_version") REFERENCES "public"."curriculum_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_mappings" ADD CONSTRAINT "concept_mappings_run_fk" FOREIGN KEY ("run_id","curriculum_version") REFERENCES "public"."concept_mapping_runs"("id","curriculum_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_mappings" ADD CONSTRAINT "concept_mappings_concept_fk" FOREIGN KEY ("curriculum_version","concept_id") REFERENCES "public"."curriculum_concepts"("curriculum_version","id") ON DELETE no action ON UPDATE no action;