import { auth, onCustomDomain, registeredCustomDomain } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseInput } from "@/lib/security/parse-input";

const { GET: rawGET, POST: rawPOST } = toNextJsHandler(auth);

const CUSTOMER_ONLY_PATHS = [
  "/magic-link/verify",
  "/sign-in/magic-link",
];

const CALLBACK_PARAMS = ["callbackURL", "newUserCallbackURL", "errorCallbackURL"];

const callbackValue = z.string().max(2000).refine(
  (value) => value.startsWith("/") && !value.startsWith("//"),
);

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

export async function GET(req: NextRequest) {
  const bad = rejectIfBadCallback(req) ?? (await rejectIfAdminHost(req));
  if (bad) return bad;
  return keepOnCustomDomain(req, await rawGET(req));
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
  return rawPOST(req);
}
