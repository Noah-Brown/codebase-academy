/**
 * Secret redaction for repository-derived text (patches, head content, manifests, PR bodies).
 *
 * Heuristic by design: it favors catching real credentials over preserving every string, but
 * leaves type declarations, environment reads, and short placeholders alone. Replacements never
 * change the number of lines, so hunk headers and line numbers stay valid. Running it twice is a
 * no-op because `[REDACTED:kind]` markers never match a pattern.
 */

export const REDACTION_KINDS = [
  "private_key",
  "aws_access_key_id",
  "github_token",
  "slack_token",
  "stripe_key",
  "anthropic_api_key",
  "openai_api_key",
  "jwt",
  "secret_assignment",
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export type RedactionCounts = Record<string, number>;

export interface RedactionResult {
  text: string;
  counts: RedactionCounts;
}

export interface RedactOptions {
  /** The text is a unified diff: keep each line's `+`/`-`/space prefix inside a multi-line secret. */
  diff?: boolean;
}

export function redactionMarker(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

const PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|[^\n]*(?:\n[+\- ]?[A-Za-z0-9+/=:, \r-]*(?=\n|$))*)/g;

/** Provider patterns, most specific first (Anthropic before the generic `sk-` OpenAI form). */
const TOKEN_PATTERNS: ReadonlyArray<{ kind: RedactionKind; pattern: RegExp }> = [
  { kind: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  { kind: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    kind: "openai_api_key",
    pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/g,
  },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/**
 * `name <op> "value"` where op is `=`, `:`, `:=`, `=>`, or `==`/`===`. The lookbehind pins the
 * start of the name so long identifier runs cannot trigger quadratic backtracking.
 */
const QUOTED_ASSIGNMENT =
  /(?<![\w$.-])(["'`]?)([A-Za-z_$][\w$.-]*)\1(\s*(?::=|=>|===?|[:=])\s*)(["'`])((?:\\.|(?!\4)[^\\\n])*)\4/g;

/** dotenv style `API_KEY=value` or `SECRET_KEY = value` on its own line (unquoted value). */
const ENV_ASSIGNMENT =
  /^([+\- ]?(?:export[ \t]+)?)([A-Z][A-Z0-9_]*)([ \t]*=[ \t]*)([^\s"'`$#()[\]{}<>;,]{8,})([ \t]*\r?)$/gm;

/** YAML style `password: value` on its own line (unquoted value, optional list dash and comment). */
const YAML_ASSIGNMENT =
  /^([+\- ]?[ \t]*(?:-[ \t]+)?)(["']?)([A-Za-z_][\w.-]*)\2([ \t]*:[ \t]+)([^\s"'`#][^\s]*)((?:[ \t]+#[^\n]*)?[ \t]*\r?)$/gm;

/** Sensitive names for unquoted values (stricter than `isSecretName`). Matched on snake_case words. */
const SENSITIVE_UNQUOTED_NAME =
  /(?:^|_)(?:password|passwd|secret|token|api_?key|private_?key|client_?secret)(?:_(?:access_)?key|_value)?$/;

const SECRET_WORDS: ReadonlySet<string> = new Set([
  "secret",
  "token",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "credential",
  "credentials",
]);
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  "api",
  "access",
  "private",
  "secret",
  "signing",
  "encryption",
  "master",
  "auth",
  "client",
  "service",
]);

const PLACEHOLDER_VALUE =
  /^(?:x+|\*+|\.+|-+|_+|#+|0+|changeme|change_me|placeholder|redacted|secret|password|todo|your[-_].*|example[-_]?.*|dummy.*|<[^>]*>)$/i;

function nameWords(name: string): string[] {
  const last = name.split(".").at(-1) ?? name;
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSecretName(name: string): boolean {
  const words = nameWords(name);
  const last = words.at(-1);
  if (last === undefined) return false;
  if (SECRET_WORDS.has(last)) return true;
  if (last === "key") {
    const previous = words.at(-2);
    return previous !== undefined && KEY_QUALIFIERS.has(previous);
  }
  return (
    /(?:secret|token|password|passwd)$/.test(last) ||
    /^(?:api|access|private|secret|signing|encryption|master|auth|client)key$/.test(last)
  );
}

function isRedactableValue(value: string, name: string): boolean {
  if (value.length < 8) return false;
  if (/\s/.test(value)) return false;
  if (value.includes("[REDACTED:")) return false;
  if (value.includes("${") || value.includes("{{") || value.includes("%(")) return false;
  if (value.toLowerCase() === name.toLowerCase()) return false;
  return !PLACEHOLDER_VALUE.test(value);
}

export function isSensitiveUnquotedName(name: string): boolean {
  return SENSITIVE_UNQUOTED_NAME.test(nameWords(name).join("_"));
}

/**
 * An unquoted value is redacted only when it looks like a literal, not code: identifiers, type
 * names, member access (`process.env.API_KEY`), calls, unions, template or env references, YAML
 * anchors/aliases/tags, and values ending a statement (`,` `;`) are left alone.
 */
export function isUnquotedSecretLiteral(value: string, name: string): boolean {
  if (!isRedactableValue(value, name)) return false;
  if (/[()[\]{}<>|"'`]/.test(value)) return false;
  if (/[,;]$/.test(value)) return false;
  if (/^[$%&*!@~>=?-]/.test(value)) return false;
  if (/^[A-Za-z_$]+$/.test(value)) return false;
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+$/.test(value)) return false;
  return !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value);
}

function replaceMultiline(match: string, kind: RedactionKind, diff: boolean): string {
  const lines = match.split("\n");
  const continuation = lines.slice(1).map((line) => {
    const prefix = line[0];
    return diff && (prefix === "+" || prefix === "-" || prefix === " ") ? prefix : "";
  });
  return [redactionMarker(kind), ...continuation].join("\n");
}

export function redactSecrets(text: string, options: RedactOptions = {}): RedactionResult {
  const counts: RedactionCounts = {};
  if (text === "") return { text, counts };
  const bump = (kind: RedactionKind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };

  let out = text.replace(PRIVATE_KEY, (match) => {
    bump("private_key");
    return replaceMultiline(match, "private_key", options.diff === true);
  });

  for (const { kind, pattern } of TOKEN_PATTERNS) {
    out = out.replace(pattern, () => {
      bump(kind);
      return redactionMarker(kind);
    });
  }

  out = out.replace(
    QUOTED_ASSIGNMENT,
    (match, nameQuote: string, name: string, operator: string, quote: string, value: string) => {
      if (!isSecretName(name) || !isRedactableValue(value, name)) return match;
      bump("secret_assignment");
      const marker = redactionMarker("secret_assignment");
      return `${nameQuote}${name}${nameQuote}${operator}${quote}${marker}${quote}`;
    },
  );

  out = out.replace(
    ENV_ASSIGNMENT,
    (match, prefix: string, name: string, operator: string, value: string, trailing: string) => {
      const redactable =
        operator === "="
          ? isSecretName(name) && isRedactableValue(value, name)
          : isSensitiveUnquotedName(name) && isUnquotedSecretLiteral(value, name);
      if (!redactable) return match;
      bump("secret_assignment");
      return `${prefix}${name}${operator}${redactionMarker("secret_assignment")}${trailing}`;
    },
  );

  out = out.replace(
    YAML_ASSIGNMENT,
    (
      match,
      prefix: string,
      nameQuote: string,
      name: string,
      operator: string,
      value: string,
      trailing: string,
    ) => {
      if (!isSensitiveUnquotedName(name) || !isUnquotedSecretLiteral(value, name)) return match;
      bump("secret_assignment");
      const marker = redactionMarker("secret_assignment");
      return `${prefix}${nameQuote}${name}${nameQuote}${operator}${marker}${trailing}`;
    },
  );

  return { text: out, counts };
}

/** Add `source` counts into `target` in place. */
export function mergeRedactionCounts(target: RedactionCounts, source: RedactionCounts): void {
  for (const [kind, count] of Object.entries(source)) {
    if (count > 0) target[kind] = (target[kind] ?? 0) + count;
  }
}

/** Count `[REDACTED:kind]` markers already present in `text`. */
export function countRedactionMarkers(text: string): RedactionCounts {
  const counts: RedactionCounts = {};
  for (const match of text.matchAll(/\[REDACTED:([a-z_]+)\]/g)) {
    const kind = match[1] as string;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}
