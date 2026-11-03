import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextRequest, NextResponse } from "next/server";

const { GET: rawGET, POST: rawPOST } = toNextJsHandler(auth);

const CUSTOMER_ONLY_PATHS = [
  "/magic-link/verify",
  "/sign-in/magic-link",
];

const CALLBACK_PARAMS = ["callbackURL", "newUserCallbackURL", "errorCallbackURL"];

function isRelativeUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

function rejectIfBadCallback(req: NextRequest): NextResponse | null {
  const url = new URL(req.url);
  for (const param of CALLBACK_PARAMS) {
    const value = url.searchParams.get(param);
    if (value !== null && (typeof value !== "string" || !isRelativeUrl(value))) {
      return NextResponse.json(
        { error: `${param} must be a relative path` },
        { status: 400 },
      );
    }
  }
  return null;
}

function rejectIfAdminHost(req: NextRequest): NextResponse | null {
  if (!req.headers.get("x-store-slug")) {
    const url = new URL(req.url);
    const authPath = url.pathname.replace(/^\/api\/auth/, "");
    if (CUSTOMER_ONLY_PATHS.some((p) => authPath.startsWith(p))) {
      return NextResponse.json(
        { error: "Customer auth is only available on store hosts" },
        { status: 403 },
      );
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const bad = rejectIfBadCallback(req) ?? rejectIfAdminHost(req);
  if (bad) return bad;
  return rawGET(req);
}

export async function POST(req: NextRequest) {
  const bad = rejectIfAdminHost(req);
  if (bad) return bad;
  let body: Record<string, unknown> | null = null;
  try {
    body = await req.clone().json();
  } catch {}
  if (body) {
    for (const param of CALLBACK_PARAMS) {
      const val = body[param];
      if (val !== undefined && (typeof val !== "string" || !isRelativeUrl(val))) {
        return NextResponse.json(
          { error: `${param} must be a relative path` },
          { status: 400 },
        );
      }
    }
  }
  return rawPOST(req);
}
