import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const denial = vi.fn();
vi.mock("@/lib/admin/session", () => ({ platformAdminApiDenial: () => denial() }));

import { GET } from "./route";

const hasDb = !!process.env.DATABASE_URL;
const get = (query: string) => GET(new Request(`http://admin.example.com/api/admin/billing/ledger/export${query}`));

describe.skipIf(!hasDb)("fee ledger CSV export route (lane DB)", () => {
  beforeEach(() => {
    denial.mockReset();
    denial.mockResolvedValue(null);
  });

  it("answers anyone but a verified platform admin with the guard's denial and no ledger", async () => {
    denial.mockResolvedValue(NextResponse.json({ error: "Not authenticated" }, { status: 401 }));
    const res = await get("?month=2031-07");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("Month total");
  });

  it("gives a platform admin the month as a private CSV download", async () => {
    const res = await get("?month=2031-07");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="platform-fee-ledger-2031-07.csv"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect((await res.text()).trim().split("\r\n").at(-1)).toBe("2031-07,,All stores,,Month total (0 orders),0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00");
  });

  it("refuses a month that is not strictly YYYY-MM", async () => {
    for (const bad of ["2031-7", "2031-13", "2031-07'--", "2031-07-01"]) {
      const res = await get(`?month=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    }
  });

  it("exports the current UTC month when none is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2031-08-31T23:30:00Z") });
    try {
      const res = await get("");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="platform-fee-ledger-2031-08.csv"');
    } finally {
      vi.useRealTimers();
    }
  });
});
