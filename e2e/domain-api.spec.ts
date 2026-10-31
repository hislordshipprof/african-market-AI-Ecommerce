import { test, expect } from "@playwright/test";

test.describe("Domain admin API (/api/admin/stores/[storeId]/domain)", () => {
  const BASE = "http://localhost:3000";
  const FAKE_ID = "00000000-0000-0000-0000-000000000000";

  test("POST without auth returns 401", async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
      { data: { domain: "shop.example.com" } },
    );
    expect(res.status()).toBe(401);
  });

  test("GET without auth returns 401", async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
    );
    expect(res.status()).toBe(401);
  });

  test("DELETE without auth returns 401", async ({ request }) => {
    const res = await request.delete(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
    );
    expect(res.status()).toBe(401);
  });
});
