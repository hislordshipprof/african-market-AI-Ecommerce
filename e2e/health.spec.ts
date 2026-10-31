import { test, expect } from "@playwright/test";

test.describe("GET /api/health", () => {
  test("returns 200 with all checks passing on a healthy server", async ({
    request,
  }) => {
    const res = await request.get("/api/health");
    const body = await res.json();

    if (res.status() !== 200) {
      console.error(
        `Health check returned ${res.status()}:`,
        JSON.stringify(body, null, 2),
      );
    }
    expect(
      res.status(),
      `Expected 200, got ${res.status()}: ${JSON.stringify(body)}`,
    ).toBe(200);

    expect(body).toHaveProperty("version");
    expect(typeof body.version).toBe("string");

    if ("status" in body && typeof body.status === "string") {
      // Production minimal shape: { status: 'ok'|'degraded', version }
      expect(body.status).toBe("ok");
      expect(Object.keys(body).sort()).toEqual(["status", "version"]);
    } else {
      // Detailed shape (preview / CI / local)
      expect(body.database).toEqual(
        expect.objectContaining({ reachable: true }),
      );
      expect(typeof body.database.user).toBe("string");
      expect(body.migrations).toEqual({ upToDate: true });
      expect(body.env).toEqual(
        expect.objectContaining({ DATABASE_URL: true }),
      );
    }

    const json = JSON.stringify(body);
    expect(json).not.toMatch(/postgres:\/\//);
  });
});
