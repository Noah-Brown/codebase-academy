import type { FileStatus, SkipReason } from "./schema";

export type FileCategory = "source" | "test" | "docs" | "config";

/** Lower ranks are included first: source over tests over docs and config. */
export const CATEGORY_RANK: Readonly<Record<FileCategory, number>> = {
  source: 0,
  test: 1,
  docs: 2,
  config: 2,
};

export const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "flake.lock",
  "packages.lock.json",
]);

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "avif", "heic", "tif", "tiff", "psd",
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
  // archives
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war", "ear", "whl", "gem", "apk", "ipa", "dmg", "iso", "deb", "rpm",
  // compiled and native
  "exe", "dll", "so", "dylib", "a", "lib", "o", "obj", "class", "pyc", "pyo", "wasm", "bin", "dat",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // media
  "mp3", "mp4", "m4a", "m4v", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg", "aac",
  // data and models
  "sqlite", "sqlite3", "db", "parquet", "avro", "npy", "npz", "pkl", "pickle", "h5", "onnx", "pt", "ckpt", "safetensors",
  // keystores
  "jks", "keystore", "p12", "pfx", "der",
]); // prettier-ignore

const VENDORED_DIR = /(?:^|\/)(?:vendor|node_modules|third_party)\//;
const GENERATED_DIR = /(?:^|\/)(?:dist|build|out|\.next|coverage|__generated__|__snapshots__)\//;
const GENERATED_NAME = /(?:\.min\.[A-Za-z0-9]+|\.map|\.snap|\.pb\.go|_pb2(?:_grpc)?\.py)$/;

/** Statuses GitHub reports without a patch for text files with no content change. */
const METADATA_ONLY_STATUSES: ReadonlySet<FileStatus> = new Set(["renamed", "copied", "unchanged"]);

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Lowercased extension without the dot, or `null` (dotfiles have no extension). */
export function extensionOf(path: string): string | null {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

export function isVendoredOrGeneratedPath(path: string): boolean {
  return VENDORED_DIR.test(path) || GENERATED_DIR.test(path) || GENERATED_NAME.test(basename(path));
}

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env",
  "md", "mdx", "markdown", "rst", "adoc", "txt", "csv", "tsv", "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro", "svg", "xml",
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "scala", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "fs", "php", "dart", "ex", "exs", "erl",
  "clj", "elm", "lua", "pl", "r", "jl", "sh", "bash", "zsh", "fish", "ps1", "sql", "graphql", "gql", "proto", "tf", "hcl", "nix", "gradle", "lock",
]); // prettier-ignore

/**
 * Whether a path without a patch is plausibly text: a known text extension, a dotfile
 * (`.gitkeep`), or a well-known extensionless config or docs name (`Makefile`, `LICENSE`).
 */
export function isTextLikePath(path: string): boolean {
  const extension = extensionOf(path);
  if (extension !== null) return TEXT_EXTENSIONS.has(extension);
  const name = basename(path);
  return name.startsWith(".") || CONFIG_NAME.test(name) || DOC_NAME.test(name);
}

export interface SkipLimits {
  maxFileChanges: number;
  maxPatchChars: number;
}

export interface ClassifiableFile {
  path: string;
  status: FileStatus;
  changes: number;
  patch?: string | undefined;
}

/**
 * Decide, before fetching anything, whether a changed file is left out of the context.
 * Returns `null` when the file is a candidate for inclusion (subject to budget).
 */
export function classifySkip(file: ClassifiableFile, limits: SkipLimits): SkipReason | null {
  const name = basename(file.path);
  if (LOCKFILES.has(name)) return "lockfile";
  if (VENDORED_DIR.test(file.path)) return "vendored";
  if (GENERATED_DIR.test(file.path) || GENERATED_NAME.test(name)) return "generated";
  const extension = extensionOf(file.path);
  if (extension !== null && BINARY_EXTENSIONS.has(extension)) return "binary";
  if (file.changes > limits.maxFileChanges || (file.patch?.length ?? 0) > limits.maxPatchChars) {
    return "too_large";
  }
  if (file.patch === undefined) {
    // GitHub omits the patch for large text diffs (changes > 0), and for binary files and empty
    // text files (changes 0). Without a patch the two are told apart by path.
    if (file.changes > 0) return "no_patch";
    if (!METADATA_ONLY_STATUSES.has(file.status)) {
      return isTextLikePath(file.path) ? "empty" : "binary";
    }
  }
  return null;
}

const TEST_DIR =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|testdata|fixtures)\//;
const TEST_NAME =
  /(?:[._-](?:test|spec)s?\.[A-Za-z0-9]+$|^test_.+\.py$|_test\.[A-Za-z0-9]+$|Tests?\.(?:java|kt|cs|swift|scala)$)/;
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "xml", "plist", "lock", "env", "gradle",
]); // prettier-ignore
const CONFIG_NAME =
  /^(?:dockerfile|containerfile|makefile|gemfile|rakefile|procfile|jenkinsfile|go\.mod|go\.work|requirements[^/]*\.txt|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|[^/]+\.config\.[cm]?[jt]s)$/i;
const CONFIG_DIR = /(?:^|\/)\.(?:github|circleci|husky|vscode|devcontainer)\//;
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "mdx",
  "markdown",
  "rst",
  "adoc",
  "txt",
]);
const DOC_NAME =
  /^(?:readme|changelog|changes|license|licence|contributing|notice|authors|code_of_conduct|security)(?:\.|$)/i;
const DOC_DIR = /(?:^|\/)docs?\//;

export function fileCategory(path: string): FileCategory {
  const name = basename(path);
  const extension = extensionOf(path);
  if (TEST_DIR.test(path) || TEST_NAME.test(name)) return "test";
  if (
    CONFIG_DIR.test(path) ||
    CONFIG_NAME.test(name) ||
    name.startsWith(".") ||
    (extension !== null && CONFIG_EXTENSIONS.has(extension))
  ) {
    return "config";
  }
  if (
    DOC_DIR.test(path) ||
    DOC_NAME.test(name) ||
    (extension !== null && DOC_EXTENSIONS.has(extension))
  ) {
    return "docs";
  }
  return "source";
}
