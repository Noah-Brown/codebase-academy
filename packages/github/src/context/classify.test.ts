import { describe, expect, it } from "vitest";
import { classifySkip, extensionOf, fileCategory, type ClassifiableFile } from "./classify";

const limits = { maxFileChanges: 1000, maxPatchChars: 5000 };
const PATCH = "@@ -1 +1 @@\n-a\n+b";

function file(path: string, overrides: Partial<ClassifiableFile> = {}): ClassifiableFile {
  return { path, status: "modified", changes: 2, patch: PATCH, ...overrides };
}

describe("classifySkip", () => {
  it.each([
    "package-lock.json",
    "yarn.lock",
    "apps/web/pnpm-lock.yaml",
    "bun.lockb",
    "Cargo.lock",
    "poetry.lock",
    "Gemfile.lock",
    "composer.lock",
    "go.sum",
  ])("skips lockfile %s", (path) => {
    expect(classifySkip(file(path), limits)).toBe("lockfile");
  });

  it.each([
    "dist/index.js",
    "packages/ui/build/main.js",
    "out/app.js",
    ".next/server/page.js",
    "coverage/lcov.info",
    "public/vendor.min.js",
    "styles/site.min.css",
    "static/app.js.map",
    "src/__generated__/graphql.ts",
    "src/__snapshots__/button.test.tsx.snap",
    "src/button.test.tsx.snap",
    "api/v1/service.pb.go",
    "proto/service_pb2.py",
  ])("skips generated %s", (path) => {
    expect(classifySkip(file(path), limits)).toBe("generated");
  });

  it.each([
    "vendor/github.com/pkg/errors/errors.go",
    "node_modules/left-pad/index.js",
    "third_party/zlib/zlib.h",
  ])("skips vendored %s", (path) => {
    expect(classifySkip(file(path), limits)).toBe("vendored");
  });

  it.each(["assets/logo.png", "fonts/Inter.woff2", "docs/spec.PDF", "lib/native.so", "model.onnx"])(
    "skips binary by extension %s",
    (path) => {
      expect(classifySkip(file(path, { patch: undefined, changes: 0 }), limits)).toBe("binary");
    },
  );

  it("skips binary content with no patch and no counted changes", () => {
    expect(classifySkip(file("assets/blob", { patch: undefined, changes: 0 }), limits)).toBe(
      "binary",
    );
  });

  it("skips too-large files by change count or patch size", () => {
    expect(classifySkip(file("src/a.ts", { changes: 1001 }), limits)).toBe("too_large");
    expect(classifySkip(file("src/a.ts", { patch: "x".repeat(5001) }), limits)).toBe("too_large");
    expect(classifySkip(file("src/a.ts", { patch: undefined, changes: 5000 }), limits)).toBe(
      "too_large",
    );
  });

  it("reports no_patch when GitHub omitted a text patch", () => {
    expect(classifySkip(file("src/a.ts", { patch: undefined, changes: 400 }), limits)).toBe(
      "no_patch",
    );
  });

  it("keeps ordinary text changes and metadata-only renames", () => {
    expect(classifySkip(file("src/index.ts"), limits)).toBeNull();
    expect(classifySkip(file("src/removed.ts", { status: "removed" }), limits)).toBeNull();
    expect(
      classifySkip(
        file("src/new-name.ts", { status: "renamed", patch: undefined, changes: 0 }),
        limits,
      ),
    ).toBeNull();
    // Lookalikes that must not be skipped.
    expect(classifySkip(file("src/roadmap.ts"), limits)).toBeNull();
    expect(classifySkip(file("src/distance.ts"), limits)).toBeNull();
    expect(classifySkip(file("src/lock.ts"), limits)).toBeNull();
  });

  it("applies precedence: lockfile, vendored, generated, binary, too_large", () => {
    expect(classifySkip(file("node_modules/pkg/package-lock.json"), limits)).toBe("lockfile");
    expect(classifySkip(file("vendor/dist/x.js"), limits)).toBe("vendored");
    expect(classifySkip(file("dist/logo.png"), limits)).toBe("generated");
    expect(classifySkip(file("a.png", { changes: 9999 }), limits)).toBe("binary");
  });
});

describe("fileCategory", () => {
  it.each([
    ["src/retry.ts", "source"],
    ["cmd/server/main.go", "source"],
    ["src/types.d.ts", "source"],
    ["src/retry.test.ts", "test"],
    ["src/retry.spec.tsx", "test"],
    ["src/__tests__/retry.ts", "test"],
    ["tests/test_retry.py", "test"],
    ["pkg/retry/retry_test.go", "test"],
    ["app/src/test/java/RetryTest.java", "test"],
    ["README.md", "docs"],
    ["docs/architecture.md", "docs"],
    ["LICENSE", "docs"],
    ["package.json", "config"],
    ["tsconfig.json", "config"],
    [".github/workflows/ci.yml", "config"],
    [".eslintrc", "config"],
    ["Dockerfile", "config"],
    ["vite.config.ts", "config"],
    ["requirements-dev.txt", "config"],
    ["build.gradle.kts", "config"],
  ] as const)("%s is %s", (path, category) => {
    expect(fileCategory(path)).toBe(category);
  });
});

describe("extensionOf", () => {
  it("lowercases and ignores dotfiles", () => {
    expect(extensionOf("src/App.TSX")).toBe("tsx");
    expect(extensionOf(".gitignore")).toBeNull();
    expect(extensionOf("Makefile")).toBeNull();
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });
});

describe("classifySkip empty files", () => {
  it.each(["src/__init__.py", "src/empty.ts", ".gitkeep", "docs/placeholder.md", "LICENSE"])(
    "labels an empty added %s as empty",
    (path) => {
      expect(
        classifySkip(file(path, { status: "added", patch: undefined, changes: 0 }), limits),
      ).toBe("empty");
    },
  );

  it("labels an emptied modified text file as empty and unknown content as binary", () => {
    expect(classifySkip(file("src/a.ts", { patch: undefined, changes: 0 }), limits)).toBe("empty");
    expect(
      classifySkip(file("bin/tool", { status: "added", patch: undefined, changes: 0 }), limits),
    ).toBe("binary");
    expect(
      classifySkip(
        file("data/blob.xyz", { status: "added", patch: undefined, changes: 0 }),
        limits,
      ),
    ).toBe("binary");
  });
});
