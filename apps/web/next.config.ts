import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// One .env at the repository root serves the web app, worker, and scripts.
// Variables already set in the environment take precedence.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@academy/curriculum",
    "@academy/db",
    "@academy/github",
    "@academy/learning",
    "@academy/shared",
  ],
};

export default nextConfig;
