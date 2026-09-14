import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const notConfigured = () =>
  Response.json(
    { error: "auth_not_configured", message: "Sign-in is not configured. See /setup." },
    { status: 503 },
  );

export async function GET(request: Request) {
  const auth = getAuth();
  return auth ? toNextJsHandler(auth).GET(request) : notConfigured();
}

export async function POST(request: Request) {
  const auth = getAuth();
  return auth ? toNextJsHandler(auth).POST(request) : notConfigured();
}
