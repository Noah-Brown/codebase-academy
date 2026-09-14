import { basename, isVendoredOrGeneratedPath } from "./classify";
import type { FileStatus } from "./schema";
import { comparePaths } from "./tokens";

export const MANIFEST_NAMES: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

export function isManifestPath(path: string): boolean {
  const name = basename(path);
  return MANIFEST_NAMES.includes(name) || /^build\.gradle(?:\.[A-Za-z0-9]+)?$/.test(name);
}

/**
 * Manifest paths to look for at the head: root manifests (filtered by the root listing when one
 * is available) plus manifests the pull request touches and did not remove. Shallow paths first.
 */
export function manifestCandidates(
  changedFiles: ReadonlyArray<{ path: string; status: FileStatus }>,
  rootFileNames: readonly string[] | null,
  limit: number,
): string[] {
  const root =
    rootFileNames === null
      ? MANIFEST_NAMES
      : rootFileNames.filter((name) => !name.includes("/") && isManifestPath(name));
  const changed = changedFiles
    .filter((file) => file.status !== "removed" && isManifestPath(file.path))
    .filter((file) => !isVendoredOrGeneratedPath(file.path))
    .map((file) => file.path);
  const depth = (path: string) => path.split("/").length;
  return [...new Set([...root, ...changed])]
    .sort((a, b) => depth(a) - depth(b) || comparePaths(a, b))
    .slice(0, limit);
}

const TRUNCATION_NOTE = "\n[truncated]";

/** First `maxLines` lines, cut back to a line boundary under `maxChars`. Input must be redacted. */
export function manifestExcerpt(
  text: string,
  limits: { manifestMaxLines: number; manifestMaxChars: number },
): string {
  const lines = text.split("\n");
  let excerpt = lines.slice(0, limits.manifestMaxLines).join("\n");
  let truncated =
    lines.length > limits.manifestMaxLines && lines.slice(limits.manifestMaxLines).some(Boolean);
  if (excerpt.length > limits.manifestMaxChars) {
    const cut = excerpt.slice(0, limits.manifestMaxChars);
    const lastNewline = cut.lastIndexOf("\n");
    excerpt = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
    truncated = true;
  }
  return truncated ? `${excerpt.replace(/\n+$/, "")}${TRUNCATION_NOTE}` : excerpt;
}
