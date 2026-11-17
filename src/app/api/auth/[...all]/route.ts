import { auth, onCustomDomain, registeredCustomDomain } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/assistant/client-ip";
import { isLocalCallbackPath } from "@/lib/security/callback-path";
import { hashTag, logSecurityEvent } from "@/lib/security/events";
import { parseInput } from "@/lib/security/parse-input";

const { GET: rawGET, POST: rawPOST } = toNextJsHandler(auth);

const CUSTOMER_ONLY_PATHS = [
  "/magic-link/verify",
  "/sign-in/magic-link",
];

const CALLBACK_PARAMS = ["callbackURL", "newUserCallbackURL", "errorCallbackURL"];

const callbackValue = z.string().max(2000).refine(isLocalCallbackPath);

function rejectCallback(param: string, value: unknown): NextResponse | null {
  if (value === undefined || value === null) return null;
  const parsed = parseInput(callbackValue, value);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: `${param} must be a relative path` },
      { status: 400 },
    );
  }
  return null;
}

function rejectIfBadCallback(req: NextRequest): NextResponse | null {
  const url = new URL(req.url);
  for (const param of CALLBACK_PARAMS) {
    const rejected = rejectCallback(param, url.searchParams.get(param));
    if (rejected) return rejected;
  }
  return null;
}

async function isStoreHost(req: NextRequest): Promise<boolean> {
  if (req.headers.get("x-store-slug")) return true;
  return (await registeredCustomDomain(req.headers)) !== null;
}

async function rejectIfAdminHost(req: NextRequest): Promise<NextResponse | null> {
  if (!(await isStoreHost(req))) {
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

async function keepOnCustomDomain(req: NextRequest, res: Response): Promise<Response> {
  const location = res.headers.get("location");
  if (!location) return res;
  const domain = await registeredCustomDomain(req.headers);
  if (!domain) return res;
  const headers = new Headers(res.headers);
  headers.set("location", onCustomDomain(location, domain));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const TWO_FACTOR_PATHS = ["/two-factor/verify-totp", "/two-factor/verify-backup-code"];

/** One event per refused sign-in, second step or rate-limited call (#712). No email, password or code. */
function logAuthOutcome(req: NextRequest, res: Response): Response {
  const path = new URL(req.url).pathname.replace(/^\/api\/auth/, "");
  const ip = hashTag(clientIp(req.headers));
  if (res.status === 429) {
    logSecurityEvent("rate_limited", { source: "auth", path: path.slice(0, 64), ip });
  } else if (res.status >= 400 && res.status < 500) {
    if (path === "/sign-in/email") logSecurityEvent("auth_sign_in_failed", { path, status: res.status, ip });
    else if (TWO_FACTOR_PATHS.includes(path)) logSecurityEvent("auth_two_factor_failed", { path, status: res.status, ip });
  }
  return res;
}

export async function GET(req: NextRequest) {
  const bad = rejectIfBadCallback(req) ?? (await rejectIfAdminHost(req));
  if (bad) return bad;
  return keepOnCustomDomain(req, logAuthOutcome(req, await rawGET(req)));
}

export async function POST(req: NextRequest) {
  const bad = await rejectIfAdminHost(req);
  if (bad) return bad;
  let body: Record<string, unknown> | null = null;
  try {
    body = await req.clone().json();
  } catch {}
  if (body) {
    for (const param of CALLBACK_PARAMS) {
      const rejected = rejectCallback(param, body[param]);
      if (rejected) return rejected;
    }
  }
  return logAuthOutcome(req, await rawPOST(req));
}
