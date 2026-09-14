import { describe, expect, it } from "vitest";
import { countRedactionMarkers, isSecretName, mergeRedactionCounts, redactSecrets } from "./redact";

// Synthetic credentials, assembled at runtime so the source never contains a scanner-shaped literal.
const FAKE = {
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  awsSession: "ASIA" + "Q3EGTXYZ7EXAMPLE",
  githubClassic: "ghp_" + "A1b2C3d4".repeat(5).slice(0, 36),
  githubServer: "ghs_" + "Z9y8X7w6".repeat(5).slice(0, 36),
  githubFineGrained: "github_pat_" + "11ABCDEFG0".repeat(4) + "_" + "abcdEFGH12".repeat(5),
  slack: "xoxb-" + "123456789012-1234567890123-" + "AbCdEfGhIjKlMnOpQrStUvWx",
  stripeLive: "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  stripeRestricted: "rk_live_" + "51Hx2abcDEF34ghiJKL56mno",
  stripeTest: "sk_test_" + "26PHem9AhJZvU623DfE1x4sd",
  anthropic: "sk-ant-" + "api03-" + "Qw3rTy8uIoPaSdFgHjKl".repeat(2),
  openaiProject: "sk-proj-" + "Ab12Cd34Ef56Gh78Ij90".repeat(2),
  openaiLegacy: "sk-" + "T3BlbkFJ".repeat(6),
  jwt:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
};

const BEGIN = (label: string) => `-----BEGIN ${label}PRIVATE KEY-----`;
const END = (label: string) => `-----END ${label}PRIVATE KEY-----`;

describe("redactSecrets: provider credentials", () => {
  it.each([
    ["aws_access_key_id", FAKE.aws],
    ["aws_access_key_id", FAKE.awsSession],
    ["github_token", FAKE.githubClassic],
    ["github_token", FAKE.githubServer],
    ["github_token", FAKE.githubFineGrained],
    ["slack_token", FAKE.slack],
    ["stripe_key", FAKE.stripeLive],
    ["stripe_key", FAKE.stripeRestricted],
    ["stripe_key", FAKE.stripeTest],
    ["anthropic_api_key", FAKE.anthropic],
    ["openai_api_key", FAKE.openaiProject],
    ["openai_api_key", FAKE.openaiLegacy],
    ["jwt", FAKE.jwt],
  ])("redacts %s", (kind, secret) => {
    const result = redactSecrets(`client.use(${secret});`);
    expect(result.text).toBe(`client.use([REDACTED:${kind}]);`);
    expect(result.counts).toEqual({ [kind]: 1 });
  });

  it("counts every occurrence", () => {
    const result = redactSecrets(`${FAKE.aws} and ${FAKE.aws}\n${FAKE.githubClassic}`);
    expect(result.counts).toEqual({ aws_access_key_id: 2, github_token: 1 });
    expect(result.text).not.toContain("AKIA");
  });

  it("classifies an Anthropic key as Anthropic, not OpenAI", () => {
    expect(redactSecrets(FAKE.anthropic).counts).toEqual({ anthropic_api_key: 1 });
  });

  it("redacts a provider key inside an assignment once", () => {
    const result = redactSecrets(`const apiKey = "${FAKE.stripeLive}";`);
    expect(result.text).toBe('const apiKey = "[REDACTED:stripe_key]";');
    expect(result.counts).toEqual({ stripe_key: 1 });
  });
});

describe("redactSecrets: private keys", () => {
  const body = [
    "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
    "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
    "=Zm9v",
  ];

  it("redacts a whole block and keeps the line count", () => {
    const text = ["const pem = `", BEGIN("RSA "), ...body, END("RSA "), "`;"].join("\n");
    const result = redactSecrets(text);
    expect(result.counts).toEqual({ private_key: 1 });
    expect(result.text).toBe(
      ["const pem = `", "[REDACTED:private_key]", "", "", "", "", "`;"].join("\n"),
    );
    expect(result.text.split("\n")).toHaveLength(text.split("\n").length);
  });

  it("keeps diff prefixes so hunk line counts stay valid", () => {
    const patch = [
      "@@ -1,2 +1,7 @@",
      " context",
      `+${BEGIN("")}`,
      ...body.map((line) => `+${line}`),
      `+${END("")}`,
      " tail",
    ].join("\n");
    const result = redactSecrets(patch, { diff: true });
    expect(result.text).toBe(
      ["@@ -1,2 +1,7 @@", " context", "+[REDACTED:private_key]", "+", "+", "+", "+", " tail"].join(
        "\n",
      ),
    );
  });

  it("redacts an unterminated block through its base64 lines", () => {
    const patch = [
      `+${BEGIN("EC ")}`,
      ...body.map((line) => `+${line}`),
      "@@ -40,2 +41,2 @@",
      " next()",
    ].join("\n");
    const result = redactSecrets(patch, { diff: true });
    expect(result.text).toBe(
      ["+[REDACTED:private_key]", "+", "+", "+", "@@ -40,2 +41,2 @@", " next()"].join("\n"),
    );
  });

  it("handles OPENSSH and PGP blocks and leaves public keys alone", () => {
    const openssh = [BEGIN("OPENSSH "), "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=", END("OPENSSH ")].join(
      "\n",
    );
    expect(redactSecrets(openssh).counts).toEqual({ private_key: 1 });
    const pgp = [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "lQOYBF",
      "-----END PGP PRIVATE KEY BLOCK-----",
    ].join("\n");
    expect(redactSecrets(pgp).counts).toEqual({ private_key: 1 });
    const publicKey = [
      "-----BEGIN PUBLIC KEY-----",
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
      "-----END PUBLIC KEY-----",
    ].join("\n");
    expect(redactSecrets(publicKey)).toEqual({ text: publicKey, counts: {} });
  });
});

describe("redactSecrets: secret assignments", () => {
  it.each([
    ['const apiKey = "abcd1234efgh5678";', 'const apiKey = "[REDACTED:secret_assignment]";'],
    ["SECRET: 'zq8Lr2Vn4Wm9'", "SECRET: '[REDACTED:secret_assignment]'"],
    ['password="hunter2hunter2"', 'password="[REDACTED:secret_assignment]"'],
    ['{"token": "tok_9f8e7d6c5b4a"}', '{"token": "[REDACTED:secret_assignment]"}'],
    ['  client_secret: "c2VjcmV0LXZhbHVl"', '  client_secret: "[REDACTED:secret_assignment]"'],
    [
      'AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG"',
      'AWS_SECRET_ACCESS_KEY = "[REDACTED:secret_assignment]"',
    ],
    ['token := "a8f5f167f44f4964e6c998dee827110c"', 'token := "[REDACTED:secret_assignment]"'],
    ["  :api_key => 'k3y-value-123456'", "  :api_key => '[REDACTED:secret_assignment]'"],
    ["config.authToken = `t0k3n-v4lu3-xyz`", "config.authToken = `[REDACTED:secret_assignment]`"],
    ['if (password === "letmein-2024!") {', 'if (password === "[REDACTED:secret_assignment]") {'],
    ["DB_PASSWORD=s3cr3tP@ssw0rd", "DB_PASSWORD=[REDACTED:secret_assignment]"],
    [
      "export STRIPE_SECRET=whsec_abcdef123456",
      "export STRIPE_SECRET=[REDACTED:secret_assignment]",
    ],
    ["+GITHUB_TOKEN=abcdef1234567890", "+GITHUB_TOKEN=[REDACTED:secret_assignment]"],
  ])("redacts %s", (input, expected) => {
    const result = redactSecrets(input);
    expect(result.text).toBe(expected);
    expect(result.counts).toEqual({ secret_assignment: 1 });
  });

  it.each([
    "password: string;",
    "type Config = { token: string; apiKey?: string };",
    "apiKey: process.env.API_KEY,",
    'const token = process.env.GITHUB_TOKEN ?? "";',
    "SECRET_KEY = os.environ['SECRET_KEY']",
    'password = "short"',
    'token: "1234567"',
    "API_KEY=${API_KEY}",
    "API_KEY=$API_KEY",
    'API_KEY=""',
    '"password": "Password"',
    'password: "********"',
    'token = "<your-token-here>"',
    'apiKey = "your_api_key"',
    'secret: "xxxxxxxxxxxx"',
    'const tokenizer = "whitespace-tokenizer";',
    'sortKey = "createdAtTimestamp"',
    'primaryKey: "user_id_column"',
    'label: "Enter your password"',
    'passwordHint = "correct-horse"',
    'tokenType = "Bearer-scheme"',
    "const header = `Bearer ${token}`;",
    'token: "{{ secrets.DEPLOY_TOKEN }}"',
    'password: "Please choose a strong password"',
    'apiKey = "[REDACTED:secret_assignment]"',
    'if (password === "") return;',
    "const keyboard = 'qwertyuiop';",
    "const sk = 'sk-learn-is-a-python-library'",
    "task-ant-colony-simulation",
    "eyJhbGciOi.incomplete",
  ])("leaves %s unchanged", (input) => {
    expect(redactSecrets(input)).toEqual({ text: input, counts: {} });
  });
});

describe("redactSecrets: invariants", () => {
  const sample = [
    `const apiKey = "${FAKE.anthropic}";`,
    `headers.authorization = "Bearer ${FAKE.jwt}";`,
    'password = "hunter2hunter2"',
    BEGIN("RSA "),
    "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
    END("RSA "),
    `aws = ${FAKE.aws}`,
    "DEPLOY_TOKEN=abcdef1234567890",
  ].join("\n");

  it("is idempotent", () => {
    const once = redactSecrets(sample);
    const twice = redactSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.counts).toEqual({});
  });

  it("preserves line count and removes every raw secret", () => {
    const result = redactSecrets(sample);
    expect(result.text.split("\n")).toHaveLength(sample.split("\n").length);
    for (const secret of [
      FAKE.anthropic,
      FAKE.jwt,
      "hunter2hunter2",
      "MIIEow",
      FAKE.aws,
      "abcdef1234567890",
    ]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.counts).toEqual({
      anthropic_api_key: 1,
      jwt: 1,
      secret_assignment: 2,
      private_key: 1,
      aws_access_key_id: 1,
    });
    expect(countRedactionMarkers(result.text)).toEqual(result.counts);
  });

  it("returns empty input unchanged and stays linear on long identifier runs", () => {
    expect(redactSecrets("")).toEqual({ text: "", counts: {} });
    const long = `${"a".repeat(200_000)} = 1\n${"b.".repeat(50_000)}`;
    const started = performance.now();
    expect(redactSecrets(long).counts).toEqual({});
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("redaction helpers", () => {
  it("recognizes secret-bearing names", () => {
    for (const name of [
      "apiKey",
      "API_KEY",
      "APIKey",
      "secret",
      "client_secret",
      "accessToken",
      "DB_PASSWORD",
      "privateKey",
      "config.authToken",
      "passphrase",
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of [
      "key",
      "sortKey",
      "tokenizer",
      "tokenType",
      "passwordHint",
      "label",
      "keyboard",
      "monkey",
    ]) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  it("merges counts", () => {
    const target = { jwt: 1 };
    mergeRedactionCounts(target, { jwt: 2, github_token: 1, stripe_key: 0 });
    expect(target).toEqual({ jwt: 3, github_token: 1 });
  });
});

describe("redactSecrets: unquoted YAML and spaced dotenv values", () => {
  it.each([
    ["password: hunter2hunter2", "password: [REDACTED:secret_assignment]"],
    ["api_key: abc123def456", "api_key: [REDACTED:secret_assignment]"],
    [
      "  client_secret: 9f8e7d6c5b4a3f2e  # rotated monthly",
      "  client_secret: [REDACTED:secret_assignment]  # rotated monthly",
    ],
    ["  - token: tk-8842-alpha-99", "  - token: [REDACTED:secret_assignment]"],
    ["+  db_password: Sup3r-Secret!", "+  db_password: [REDACTED:secret_assignment]"],
    ['"private_key": MIIEvQIBADANBg==', '"private_key": [REDACTED:secret_assignment]'],
    ["SECRET_KEY = abcdef123456", "SECRET_KEY = [REDACTED:secret_assignment]"],
    ["export API_TOKEN = zyx987wvu654", "export API_TOKEN = [REDACTED:secret_assignment]"],
    [
      "AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI/K7MDENG",
      "AWS_SECRET_ACCESS_KEY = [REDACTED:secret_assignment]",
    ],
  ])("redacts %s", (input, expected) => {
    const result = redactSecrets(input);
    expect(result.text).toBe(expected);
    expect(result.counts).toEqual({ secret_assignment: 1 });
    expect(redactSecrets(result.text)).toEqual({ text: result.text, counts: {} });
  });

  it.each([
    "password: string",
    "  token: string | null",
    "  password: string;",
    "  apiKey: process.env.API_KEY",
    "  nextPageToken: response.nextPageToken",
    "  nextPageToken: string",
    "  nextPageToken: nextToken2",
    "  secret: Optional[str]",
    "  token: undefined",
    "  password: hunter2",
    "  password: ${DB_PASSWORD}",
    "  token: *default_token",
    "  secret: !vault |",
    "  password_hint: remember123",
    "  tokenizer: whitespace123",
    "  sortKey: created_at_2024",
    "SECRET_KEY = DEFAULT_SECRET_KEY",
    "SECRET_KEY = get_secret()",
    "API_TOKEN = settings.API_TOKEN",
    "SECRET_KEY = os.environ['SECRET_KEY']",
    "TIMEOUT_SECONDS = 1234567890",
    "  password: changeme",
    "  password: [REDACTED:secret_assignment]",
  ])("leaves %s unchanged", (input) => {
    expect(redactSecrets(input)).toEqual({ text: input, counts: {} });
  });
});
