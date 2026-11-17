import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/assistant/client-ip";
import { takeRateLimit } from "@/lib/rate-limit/app-limiter";
import { hashTag, logSecurityEvent } from "@/lib/security/events";
import { parseInput } from "@/lib/security/parse-input";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const REPORTS_PER_MINUTE = 30;

const text = z.string().max(4096).optional();
const reportSchema = z.looseObject({
  "csp-report": z.looseObject({
    "document-uri": text,
    "blocked-uri": text,
    "effective-directive": text,
    "violated-directive": text,
    disposition: text,
  }),
});

/** Origin and path only: a query string can carry a sign-in token. Keywords such as "inline" pass through. */
function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  if (/^[a-z-]{1,32}$/.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return null;
  }
}

function violation(raw: string): z.infer<typeof reportSchema>["csp-report"] | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = parseInput(reportSchema, json);
  return parsed.ok ? parsed.data["csp-report"] : null;
}

/** report-uri violation reports from both the enforced and the report-only policy (#712). Browsers ignore the answer. */
export async function POST(req: NextRequest) {
  const ip = hashTag(clientIp(req.headers));
  const limit = await takeRateLimit(`csp-report:ip:${ip}`, REPORTS_PER_MINUTE, 60_000);
  if (!limit.ok) return new NextResponse(null, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  const report = violation(raw);
  if (report) {
    logSecurityEvent("csp_violation", {
      disposition: report.disposition === "report" ? "report" : report.disposition === "enforce" ? "enforce" : null,
      directive: (report["effective-directive"] ?? report["violated-directive"])?.slice(0, 64) ?? null,
      document: safeUrl(report["document-uri"]),
      blocked: safeUrl(report["blocked-uri"]),
      ip,
    });
  }
  return new NextResponse(null, { status: 204 });
}
