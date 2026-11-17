import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/assistant/client-ip";
import { healthQueryRaw } from "@/lib/db";
import { runHealthChecks, toMinimalResult } from "@/lib/health";
import { takeRateLimit, type RateLimitResult } from "@/lib/rate-limit/app-limiter";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ip = clientIp(req.headers);

  // With the database down the limiter cannot count; the probe must still answer and report it.
  const limit: RateLimitResult = await takeRateLimit(`health:ip:${ip}`, 10, 60_000).catch(() => ({ ok: true, count: 0 }));
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const { status, body } = await runHealthChecks({
    env: process.env as Record<string, string | undefined>,
    queryRaw: healthQueryRaw,
  });

  const responseBody =
    process.env.VERCEL_ENV === "production"
      ? toMinimalResult(status, body)
      : body;

  return NextResponse.json(responseBody, { status });
}
