/**
 * Errors raised by this package carry a stable `code` and never the response body, which can
 * contain repository content.
 */
export class GitHubApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, status?: number) {
    super(status === undefined ? code : `${code} (HTTP ${status})`);
    this.name = "GitHubApiError";
    this.code = code;
    this.status = status;
  }
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}
