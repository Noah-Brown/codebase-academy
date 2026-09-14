import { describe, expect, it } from "vitest";
import { isManifestPath, manifestCandidates, manifestExcerpt } from "./manifests";

describe("isManifestPath", () => {
  it("matches manifests at any depth", () => {
    for (const path of [
      "package.json",
      "apps/web/package.json",
      "pyproject.toml",
      "requirements.txt",
      "go.mod",
      "Cargo.toml",
      "Gemfile",
      "pom.xml",
      "build.gradle",
      "app/build.gradle.kts",
    ]) {
      expect(isManifestPath(path), path).toBe(true);
    }
    for (const path of [
      "package-lock.json",
      "src/package.ts",
      "Gemfile.lock",
      "go.sum",
      "requirements-dev.txt",
    ]) {
      expect(isManifestPath(path), path).toBe(false);
    }
  });
});

describe("manifestCandidates", () => {
  const changed = [
    { path: "apps/web/package.json", status: "modified" as const },
    { path: "services/api/go.mod", status: "removed" as const },
    { path: "node_modules/x/package.json", status: "modified" as const },
    { path: "src/index.ts", status: "modified" as const },
  ];

  it("uses the root listing when available, then changed manifests, shallow first", () => {
    expect(manifestCandidates(changed, ["README.md", "package.json", "go.mod"], 10)).toEqual([
      "go.mod",
      "package.json",
      "apps/web/package.json",
    ]);
  });

  it("falls back to every root manifest name without a listing, and applies the limit", () => {
    const all = manifestCandidates(changed, null, 100);
    expect(all).toContain("pyproject.toml");
    expect(all.at(-1)).toBe("apps/web/package.json");
    expect(manifestCandidates(changed, null, 2)).toHaveLength(2);
  });
});

describe("manifestExcerpt", () => {
  const limits = { manifestMaxLines: 60, manifestMaxChars: 4_000 };

  it("returns short manifests unchanged", () => {
    expect(manifestExcerpt('{\n  "name": "x"\n}\n', limits)).toBe('{\n  "name": "x"\n}\n');
  });

  it("truncates by lines and by characters at a line boundary", () => {
    const long = Array.from({ length: 100 }, (_, i) => `dep${i} = "1.0.${i}"`).join("\n");
    const byLines = manifestExcerpt(long, limits);
    expect(byLines.split("\n")).toHaveLength(61);
    expect(byLines.endsWith("\n[truncated]")).toBe(true);

    const byChars = manifestExcerpt(long, { manifestMaxLines: 1_000, manifestMaxChars: 100 });
    expect(byChars.length).toBeLessThanOrEqual(100 + "\n[truncated]".length);
    for (const line of byChars.split("\n").slice(0, -1))
      expect(line).toMatch(/^dep\d+ = "1\.0\.\d+"$/);
  });
});
