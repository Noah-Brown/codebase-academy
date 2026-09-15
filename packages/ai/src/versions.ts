/**
 * Version of the concept mapper's prompt, output schema, and validation rules. It is part of the
 * mapping idempotency key, so bump it whenever the same context could map differently.
 * Side-effect free so the web app can import it without loading provider code.
 */
export const MAPPER_VERSION = "mapper-v1";
