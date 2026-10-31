import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { acceptInvite } from "@/lib/invite/service";

export async function POST(req: NextRequest) {
  const reqHeaders = await headers();
  const session = await auth.api.getSession({
    headers: reqHeaders,
    query: { disableCookieCache: true },
  });

  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { token } = body as { token: string };

  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { error: "Missing invite token" },
      { status: 400 },
    );
  }

  const result = await acceptInvite(token, session.user.id, session.user.email);

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    storeId: result.storeId,
    storeSlug: result.storeSlug,
    role: result.role,
  });
}
