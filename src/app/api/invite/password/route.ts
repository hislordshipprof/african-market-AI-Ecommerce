import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setInviteePassword } from "@/lib/invite/service";
import { parseInput } from "@/lib/security/parse-input";
import { requireSameOrigin } from "@/lib/security/same-origin";

const bodySchema = z.strictObject({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(256),
});

export async function POST(req: NextRequest) {
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
  const result = await setInviteePassword(body.data.token, body.data.password);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
