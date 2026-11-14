import { test, expect } from "@playwright/test";

test.describe("Domain admin API (/api/admin/stores/[storeId]/domain)", () => {
  const FAKE_ID = "00000000-0000-0000-0000-000000000000";

  test("POST without auth returns 401", async ({ request }) => {
    const res = await request.post(
      `/api/admin/stores/${FAKE_ID}/domain`,
      { data: { domain: "shop.example.com" } },
    );
    expect(res.status()).toBe(401);
  });

  test("GET without auth returns 401", async ({ request }) => {
    const res = await request.get(
      `/api/admin/stores/${FAKE_ID}/domain`,
    );
    expect(res.status()).toBe(401);
  });

  test("DELETE without auth returns 401", async ({ request }) => {
    const res = await request.delete(
      `/api/admin/stores/${FAKE_ID}/domain`,
    );
    expect(res.status()).toBe(401);
  });
});
