import { test, expect } from "@playwright/test";

test.describe("GET /api/health", () => {
  test("returns 200 with all checks passing on a healthy server", async ({
    request,
  }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);

    const body = await res.json();

    expect(body).toHaveProperty("version");
    expect(typeof body.version).toBe("string");

    expect(body.database).toEqual(
      expect.objectContaining({ reachable: true }),
    );
    expect(typeof body.database.user).toBe("string");

    expect(body.migrations).toEqual({ upToDate: true });

    expect(body.env).toEqual(
      expect.objectContaining({
        DATABASE_URL: true,
      }),
    );

    const json = JSON.stringify(body);
    expect(json).not.toMatch(/postgres:\/\//);
  });
});
