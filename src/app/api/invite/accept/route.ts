import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { acceptInvite } from "@/lib/invite/service";
import { parseInput } from "@/lib/security/parse-input";
import { requireSameOrigin } from "@/lib/security/same-origin";

const bodySchema = z.strictObject({
  token: z.string().min(1).max(512),
});

export async function POST(req: NextRequest) {
  const reqHeaders = await headers();
  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });

  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (!session.user.twoFactorEnabled || !session.session.twoFactorVerified) {
    return NextResponse.json(
      { error: "Two-factor authentication required" },
      { status: 403 },
    );
  }

  if (!requireSameOrigin(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Missing invite token" }, { status: 400 });
  }
  const body = parseInput(bodySchema, raw);
  if (!body.ok) {
    return NextResponse.json({ error: "Missing invite token" }, { status: 400 });
  }

  const result = await acceptInvite(body.data.token, session.user.id, session.user.email);

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    storeId: result.storeId,
    storeSlug: result.storeSlug,
    role: result.role,
  });
}
