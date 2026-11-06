import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { testOnlyRoutesAllowed } from "./test-only-routes";

const e2eRoot = path.join(process.cwd(), "src", "app", "api", "e2e");

function routeFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, acc);
    else if (name === "route.ts") acc.push(full);
  }
  return acc;
}

const closed = [
  { VERCEL: "1", NODE_ENV: "production", VERCEL_ENV: "production", CI: "true", E2E_STORE_OVERRIDE: "1" },
  { NODE_ENV: "production", VERCEL_ENV: "production", E2E_STORE_OVERRIDE: "1" },
  { NODE_ENV: "production", E2E_STORE_OVERRIDE: "1" },
  { VERCEL: "1", NODE_ENV: "development", E2E_STORE_OVERRIDE: "1" },
];

describe("test-only routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("every /api/e2e route is 404 under each production env even with the flag on", async () => {
    const files = routeFiles(e2eRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const mod = await import(pathToFileURL(file).href);
      for (const env of closed) {
        for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
        vi.stubEnv("CI", env.CI ?? "");
        const request = new NextRequest("http://localhost/api/e2e/magic-link-token?email=a@b.test", {
          headers: { "x-e2e-allow": "1", cookie: "e2e=1" },
        });
        if (typeof mod.GET === "function") expect((await mod.GET(request)).status).toBe(404);
        if (typeof mod.POST === "function") expect((await mod.POST(request)).status).toBe(404);
        vi.unstubAllEnvs();
      }
    }
  });

  it("request values never open the gate", () => {
    expect(testOnlyRoutesAllowed({ NODE_ENV: "production", E2E_STORE_OVERRIDE: "1" }, "1")).toBe(false);
    expect(testOnlyRoutesAllowed({
      NODE_ENV: "production",
      CI: "true",
      E2E_STORE_OVERRIDE: "1",
    }, "1")).toBe(true);
    expect(testOnlyRoutesAllowed({ NODE_ENV: "test", E2E_STORE_OVERRIDE: "1" }, "0")).toBe(false);
  });

  it("cart-bootstrap route is gone", () => {
    expect(existsSync(path.join(e2eRoot, "cart-bootstrap", "route.ts"))).toBe(false);
    expect(routeFiles(e2eRoot).some((file) => file.includes("cart-bootstrap"))).toBe(false);
  });
});
