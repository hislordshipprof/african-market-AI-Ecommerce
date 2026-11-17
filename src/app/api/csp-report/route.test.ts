import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

function post(body: string, contentType: string, ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
  return POST(new NextRequest("http://localhost/api/csp-report", {
    method: "POST",
    body,
    headers: { "content-type": contentType, "x-forwarded-for": ip },
  }));
}

function warnings(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

describe.skipIf(!process.env.DATABASE_URL)("POST /api/csp-report", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs one csp_violation from a report-uri body, with no query string or token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(JSON.stringify({
      "csp-report": {
        "document-uri": "https://shop.example.test/account/sign-in/confirm?token=secret-token#x",
        "blocked-uri": "https://evil.example.test/x.js?session=abc",
        "effective-directive": "script-src-elem",
        disposition: "enforce",
      },
    }), "application/csp-report", "203.0.113.7");
    expect(res.status).toBe(204);
    const events = warnings(warn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "csp_violation",
      disposition: "enforce",
      directive: "script-src-elem",
      document: "https://shop.example.test/account/sign-in/confirm",
      blocked: "https://evil.example.test/x.js",
    });
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain("secret-token");
    expect(line).not.toContain("session=abc");
    expect(line).not.toContain("203.0.113.7");
  });

  it("drops a malformed body without logging a violation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post("not json", "application/csp-report");
    expect(res.status).toBe(204);
    expect(warnings(warn).filter((e) => e.event === "csp_violation")).toEqual([]);
  });

  it("stops logging once one IP passes the limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://a.test/", "blocked-uri": "inline", "effective-directive": "img-src" } });
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const statuses = [];
    for (let i = 0; i < 32; i++) statuses.push((await post(body, "application/csp-report", ip)).status);
    expect(statuses.slice(0, 30).every((s) => s === 204)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    expect(warnings(warn).filter((e) => e.event === "csp_violation")).toHaveLength(30);
  });
});
