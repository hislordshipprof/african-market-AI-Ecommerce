import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const denial = vi.fn();
const addDomainToStore = vi.fn();
const getDomainStatus = vi.fn();
const removeDomainFromStore = vi.fn();

vi.mock("@/lib/admin/session", () => ({ platformAdminApiDenial: () => denial() }));
vi.mock("@/lib/domain-service", () => ({
  addDomainToStore: (...a: unknown[]) => addDomainToStore(...a),
  getDomainStatus: (...a: unknown[]) => getDomainStatus(...a),
  removeDomainFromStore: (...a: unknown[]) => removeDomainFromStore(...a),
}));

import { POST, GET, DELETE } from "./route";

const STORE_ID = "cm0abcdefghijklmnopqrstu";
const URL_BASE = `http://admin.example.com/api/admin/stores/${STORE_ID}/domain`;
const ok = { ok: true, domain: "shop.example.com", verified: false, cname: "cname.vercel-dns.com" };

function req(method: string, body?: unknown, origin: string | null = "http://admin.example.com") {
  const headers: Record<string, string> = { host: "admin.example.com", "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return new NextRequest(URL_BASE, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const ctx = (storeId = STORE_ID) => ({ params: Promise.resolve({ storeId }) });

describe("domain admin route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    denial.mockResolvedValue(null);
    addDomainToStore.mockResolvedValue(ok);
    getDomainStatus.mockResolvedValue(ok);
    removeDomainFromStore.mockResolvedValue(ok);
  });

  it("returns the guard's denial before touching the service", async () => {
    denial.mockResolvedValue(NextResponse.json({ error: "Not authenticated" }, { status: 401 }));
    for (const res of [
      await POST(req("POST", { domain: "shop.example.com" }), ctx()),
      await GET(req("GET"), ctx()),
      await DELETE(req("DELETE"), ctx()),
    ]) expect(res.status).toBe(401);
    expect(addDomainToStore).not.toHaveBeenCalled();
    expect(getDomainStatus).not.toHaveBeenCalled();
    expect(removeDomainFromStore).not.toHaveBeenCalled();
  });

  it("refuses cross-origin POST and DELETE", async () => {
    expect((await POST(req("POST", { domain: "shop.example.com" }, "https://evil.example"), ctx())).status).toBe(403);
    expect((await DELETE(req("DELETE", undefined, null), ctx())).status).toBe(403);
    expect(addDomainToStore).not.toHaveBeenCalled();
    expect(removeDomainFromStore).not.toHaveBeenCalled();
  });

  it("rejects a malformed domain or extra keys with 400", async () => {
    for (const body of [{ domain: "not a domain" }, { domain: "localhost" }, {}, { domain: "shop.example.com", extra: 1 }]) {
      expect((await POST(req("POST", body), ctx())).status).toBe(400);
    }
    expect(addDomainToStore).not.toHaveBeenCalled();
  });

  it("rejects a malformed store id with 400", async () => {
    expect((await GET(req("GET"), ctx("x".repeat(200)))).status).toBe(400);
    expect(getDomainStatus).not.toHaveBeenCalled();
  });

  it("normalises the domain and passes the service result through", async () => {
    const res = await POST(req("POST", { domain: " Shop.Example.COM " }), ctx());
    expect(res.status).toBe(200);
    expect(addDomainToStore).toHaveBeenCalledWith(STORE_ID, "shop.example.com");
    addDomainToStore.mockResolvedValue({ ok: false, error: "Domain is already assigned to another store", status: 409 });
    expect((await POST(req("POST", { domain: "shop.example.com" }), ctx())).status).toBe(409);
  });
});
