const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * True for a short machine-readable code such as `github_not_found` or `ECONNRESET`.
 * Free-form messages are never persisted: they may carry repository content.
 */
export function isErrorCode(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value);
}

export function assertErrorCode(value: string): string {
  if (!isErrorCode(value)) {
    throw new TypeError("Expected a machine-readable error code (letters, digits, _ . : -)");
  }
  return value;
}
