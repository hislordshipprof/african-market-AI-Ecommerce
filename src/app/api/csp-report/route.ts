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
// report-uri sends one object; the Reporting API (report-to) sends a batch.
const legacySchema = z.looseObject({
  "csp-report": z.looseObject({
    "document-uri": text,
    "blocked-uri": text,
    "effective-directive": text,
    "violated-directive": text,
    disposition: text,
  }),
});
const batchSchema = z.array(z.looseObject({
  type: z.string(),
  body: z.looseObject({
    documentURL: text,
    blockedURL: text,
    effectiveDirective: text,
    disposition: text,
  }).optional(),
})).max(100);

type Violation = { document?: string; blocked?: string; directive?: string; disposition?: string };

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

function violations(raw: string): Violation[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const legacy = parseInput(legacySchema, json);
  if (legacy.ok) {
    const report = legacy.data["csp-report"];
    return [{
      document: report["document-uri"],
      blocked: report["blocked-uri"],
      directive: report["effective-directive"] ?? report["violated-directive"],
      disposition: report.disposition,
    }];
  }
  const batch = parseInput(batchSchema, json);
  if (!batch.ok) return [];
  return batch.data
    .filter((report) => report.type === "csp-violation" && report.body)
    .map(({ body }) => ({ document: body!.documentURL, blocked: body!.blockedURL, directive: body!.effectiveDirective, disposition: body!.disposition }));
}

/** CSP violation reports from both the enforced and the report-only policy (#712). Always 204: browsers ignore the answer. */
export async function POST(req: NextRequest) {
  const ip = hashTag(clientIp(req.headers));
  const limit = await takeRateLimit(`csp-report:ip:${ip}`, REPORTS_PER_MINUTE, 60_000);
  if (!limit.ok) return new NextResponse(null, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  for (const violation of violations(raw)) {
    logSecurityEvent("csp_violation", {
      disposition: violation.disposition === "report" ? "report" : violation.disposition === "enforce" ? "enforce" : null,
      directive: violation.directive?.slice(0, 64) ?? null,
      document: safeUrl(violation.document),
      blocked: safeUrl(violation.blocked),
      ip,
    });
  }
  return new NextResponse(null, { status: 204 });
}
