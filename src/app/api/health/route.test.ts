import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ip = `192.0.2.${Math.floor(Math.random() * 250)}-${Date.now()}`;
const probe = () => new NextRequest("http://localhost/api/health", { headers: { "x-forwarded-for": ip } });

describe.skipIf(!process.env.DATABASE_URL)("GET /api/health rate limit", () => {
  it("counts in the shared limiter, so a fresh instance still refuses the 11th probe in a minute", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await import("./route");
    for (let i = 0; i < 10; i++) expect((await first.GET(probe())).status).not.toBe(429);

    vi.resetModules();
    const second = await import("./route");
    const limited = await second.GET(probe());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
