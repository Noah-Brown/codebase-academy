/**
 * Version of the concept mapper's prompt, output schema, and validation rules. It is part of the
 * mapping idempotency key, so bump it whenever the same context could map differently.
 * Side-effect free so the web app can import it without loading provider code.
 */
export const MAPPER_VERSION = "mapper-v1";

/** Version of the lesson generator's prompt, output schema, and validation. Part of the lesson key. */
export const GENERATOR_VERSION = "lesson-v1";

/** Version of the open-response grader's prompt and validation. Stored with every graded attempt. */
export const GRADER_VERSION = "grader-v1";
