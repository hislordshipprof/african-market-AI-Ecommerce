import { afterEach, describe, expect, it, vi } from "vitest";

const SIGNING_KEY = "signkey-test-0123456789abcdef0123456789abcdef";

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return import("./route");
}

function call(handler: unknown, method: string, headers?: HeadersInit) {
  const fn = handler as (request: Request) => Promise<Response>;
  return fn(new Request("http://localhost/api/inngest", { method, headers, body: method === "GET" ? undefined : "{}" }));
}

describe("inngest serve", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("unsigned GET/POST/PUT and a wrongly signed POST are 401 with a signing key", async () => {
    const route = await load({ VERCEL: "1", INNGEST_SIGNING_KEY: SIGNING_KEY, INNGEST_DEV: "" });
    for (const method of ["GET", "POST", "PUT"] as const) {
      const response = await call(route[method], method);
      expect(response.status, method).toBe(401);
    }
    const now = Math.floor(Date.now() / 1000);
    const forged = await call(route.POST, "POST", { "x-inngest-signature": `t=${now}&s=${"0".repeat(64)}` });
    expect(forged.status).toBe(401);
  });

  it("cloud mode without key is 500", async () => {
    const route = await load({ VERCEL: "1", INNGEST_SIGNING_KEY: "", INNGEST_DEV: "" });
    const response = await call(route.GET, "GET");
    expect(response.status).toBe(500);
  });

  it("INNGEST_DEV ignored on Vercel", async () => {
    const route = await load({ VERCEL: "1", INNGEST_DEV: "1", INNGEST_SIGNING_KEY: SIGNING_KEY });
    const response = await call(route.POST, "POST");
    expect(response.status).toBe(401);
  });
});
