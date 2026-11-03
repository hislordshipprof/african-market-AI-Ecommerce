import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextRequest, NextResponse } from "next/server";
import { normalizePhone } from "@/lib/phone";
import {
  checkPhoneRateLimit,
  PhoneRateLimitError,
} from "@/lib/phone-rate-limit";

const { GET: rawGET, POST: rawPOST } = toNextJsHandler(auth);

const CUSTOMER_ONLY_PATHS = [
  "/phone-number/send-otp",
  "/phone-number/verify",
  "/magic-link/verify",
  "/sign-in/phone-number",
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
    if (value && !isRelativeUrl(value)) {
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

function getAuthPath(req: NextRequest): string {
  return new URL(req.url).pathname.replace(/^\/api\/auth/, "");
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
    for (const param of CALLBACK_PARAMS) {
      if (body?.[param] && !isRelativeUrl(body[param])) {
        return NextResponse.json(
          { error: `${param} must be a relative path` },
          { status: 400 },
        );
      }
    }
    if (getAuthPath(req) === "/phone-number/send-otp" && body?.phoneNumber) {
      const normalized = normalizePhone(body.phoneNumber);
      if (normalized) {
        try {
          await checkPhoneRateLimit(normalized);
        } catch (e) {
          if (e instanceof PhoneRateLimitError) {
            return NextResponse.json(
              { error: "Too many requests. Please try again later." },
              { status: 429 },
            );
          }
          throw e;
        }
      }
    }
  } catch {
    // not JSON body — pass through
  }
  return rawPOST(req);
}
