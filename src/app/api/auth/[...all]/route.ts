import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextRequest, NextResponse } from "next/server";

const { GET: rawGET, POST: rawPOST } = toNextJsHandler(auth);

const CUSTOMER_ONLY_PATHS = [
  "/phone-number/send-otp",
  "/sign-in/phone-number",
  "/sign-in/magic-link",
];

function isRelativeUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

function rejectIfBadCallback(req: NextRequest): NextResponse | null {
  const url = new URL(req.url);
  const callback = url.searchParams.get("callbackURL");
  if (callback && !isRelativeUrl(callback)) {
    return NextResponse.json(
      { error: "callbackURL must be a relative path" },
      { status: 400 },
    );
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
  const cloned = req.clone();
  try {
    const body = await cloned.json();
    if (body?.callbackURL && !isRelativeUrl(body.callbackURL)) {
      return NextResponse.json(
        { error: "callbackURL must be a relative path" },
        { status: 400 },
      );
    }
  } catch {
    // not JSON body — pass through
  }
  return rawPOST(req);
}
