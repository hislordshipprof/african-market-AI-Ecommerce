import { test, expect } from "@playwright/test";

test.describe("Domain admin API (/api/admin/stores/[storeId]/domain)", () => {
  const BASE = "http://localhost:3000";
  const FAKE_ID = "00000000-0000-0000-0000-000000000000";

  test("POST rejects missing domain", async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
      { data: {} },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing");
  });

  test("POST rejects invalid domain format", async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
      { data: { domain: "not a domain!" } },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid domain");
  });

  test("POST returns 404 for nonexistent store", async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
      { data: { domain: "shop.example.com" } },
    );
    expect(res.status()).toBe(404);
  });

  test("GET returns 404 for nonexistent store", async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
    );
    expect(res.status()).toBe(404);
  });

  test("DELETE returns 404 for nonexistent store", async ({ request }) => {
    const res = await request.delete(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
    );
    expect(res.status()).toBe(404);
  });

  test("POST rejects invalid JSON body", async ({ request }) => {
    const res = await request.fetch(
      `${BASE}/api/admin/stores/${FAKE_ID}/domain`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        data: "not json{",
      },
    );
    expect(res.status()).toBe(400);
  });
});
