import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  addDomainToStore,
  getDomainStatus,
  removeDomainFromStore,
} from "@/lib/domain-service";

export const dynamic = "force-dynamic";

const MAX_DOMAIN_LENGTH = 253;

async function requireAdmin(): Promise<NextResponse | null> {
  try {
    const reqHeaders = await headers();
    const session = await auth.api.getSession({
      headers: reqHeaders,
      query: { disableCookieCache: true },
    });
    if (!session || session.user.role !== "platform_admin") {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (!session.user.twoFactorEnabled || !session.session.twoFactorVerified) {
      return NextResponse.json(
        { error: "Two-factor authentication required" },
        { status: 403 },
      );
    }
    return null;
  } catch {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ storeId: string }> },
) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { storeId } = await params;

  let body: { domain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { domain } = body;
  if (!domain || typeof domain !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid domain" },
      { status: 400 },
    );
  }

  const domainLower = domain.toLowerCase().trim();
  if (
    domainLower.length > MAX_DOMAIN_LENGTH ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domainLower)
  ) {
    return NextResponse.json(
      { error: "Invalid domain format" },
      { status: 400 },
    );
  }

  const result = await addDomainToStore(storeId, domainLower);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    domain: result.domain,
    verified: result.verified,
    cname: result.cname,
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ storeId: string }> },
) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { storeId } = await params;

  const result = await getDomainStatus(storeId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    domain: result.domain,
    verified: result.verified,
    cname: result.cname,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ storeId: string }> },
) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { storeId } = await params;

  const result = await removeDomainFromStore(storeId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ removed: true });
}
