import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";

const execFileAsync = promisify(execFile);
const hasDb = !!process.env.DATABASE_URL;
const dbModule = pathToFileURL(join(process.cwd(), "src/lib/db.ts")).href;
const serviceModule = pathToFileURL(join(process.cwd(), "src/lib/checkout/service.ts")).href;

function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function runTsx(source: string, env: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(join(tmpdir(), "t236-"));
  const file = join(dir, "run.mts");
  writeFileSync(file, source);
  try {
    const result = await execFileAsync("pnpm", ["exec", "tsx", file], {
      cwd: process.cwd(),
      env,
      shell: process.platform === "win32",
      timeout: 60_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoSecrets(text: string) {
  expect(text).not.toMatch(/postgres(ql)?:\/\//i);
  if (process.env.APP_RUNTIME_PASSWORD) {
    expect(text.includes(process.env.APP_RUNTIME_PASSWORD)).toBe(false);
  }
  if (process.env.STRIPE_SECRET_KEY) {
    expect(text.includes(process.env.STRIPE_SECRET_KEY)).toBe(false);
  }
}

describe.skipIf(!hasDb)("placeOrder keys and cold runtime", () => {
  let raw: PrismaClient;
  const storeIds: string[] = [];

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
  }, 30_000);

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  afterAll(async () => {
    if (raw && storeIds.length > 0) {
      await raw.$transaction([
        raw.$executeRaw`SET LOCAL ROLE app_user`,
        raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        raw.customer.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.orderLine.deleteMany({ where: { storeId: { in: storeIds } } }),
        raw.order.deleteMany({ where: { storeId: { in: storeIds } } }),
      ]);
      await raw.store.deleteMany({ where: { id: { in: storeIds } } });
    }
    await raw?.$disconnect();
  }, 30_000);

  it("placeOrder without STRIPE_SECRET_KEY fails before any write", async () => {
    const store = await raw.store.create({
      data: {
        slug: `t236-nokey-${crypto.randomUUID().slice(0, 8)}`,
        name: "No key",
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_nokey_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeIds.push(store.id);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.resetModules();
    const { placeOrder } = await import("./service");
    await expect(
      placeOrder(store.id, 0, "cart-missing", {
        name: "Ada Buyer",
        phone: "+15551234567",
        email: "nokey@t236.test",
      }, "pickup", null, null, "pi_missing_key"),
    ).rejects.toThrow("STRIPE_SECRET_KEY is not set. Stripe operations require this key at runtime.");
    expect(await storeScoped(store.id).customer.count()).toBe(0);
    expect(await storeScoped(store.id).order.count()).toBe(0);
  });

  it("cold production and Vercel checkout cannot use the fake flag without a key", async () => {
    const store = await raw.store.create({
      data: {
        slug: `t236-cold-${crypto.randomUUID().slice(0, 8)}`,
        name: "Cold",
        themePreset: "palm-and-shea",
        stripeAccountId: `acct_cold_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        stripeOnboardingStatus: "complete",
        pickupEnabled: true,
      },
    });
    storeIds.push(store.id);
    const source = `
      const { placeOrder } = await import(${JSON.stringify(serviceModule)});
      try {
        await placeOrder(${JSON.stringify(store.id)}, 0, "cart-missing", {
          name: "Ada Buyer", phone: "+15551234567", email: "cold@t236.test",
        }, "pickup", null, null, "pi_cold");
        console.log("PLACED");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    `;
    for (const vercel of [undefined, "1"] as const) {
      const result = await runTsx(source, childEnv({
        NODE_ENV: "production",
        E2E_FAKE_STRIPE: "1",
        STRIPE_SECRET_KEY: undefined,
        NEXT_PHASE: undefined,
        VERCEL: vercel,
      }));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "STRIPE_SECRET_KEY is not set. Stripe operations require this key at runtime.",
      );
      expect(result.stdout).not.toContain("PLACED");
      assertNoSecrets(`${result.stdout}\n${result.stderr}`);
    }
    expect(await storeScoped(store.id).customer.count()).toBe(0);
    expect(await storeScoped(store.id).order.count()).toBe(0);
  }, 60_000);

  it("cold production DB runtime requires app_runtime credentials", async () => {
    const source = `
      try {
        await import(${JSON.stringify(dbModule)});
        console.log("IMPORTED");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    `;
    const production = await runTsx(source, childEnv({
      NODE_ENV: "production",
      APP_RUNTIME_PASSWORD: undefined,
      NEXT_PHASE: undefined,
      E2E_FAKE_STRIPE: undefined,
    }));
    expect(production.code).not.toBe(0);
    expect(production.stderr).toContain("APP_RUNTIME_PASSWORD is required in production");
    expect(production.stdout).not.toContain("IMPORTED");
    assertNoSecrets(`${production.stdout}\n${production.stderr}`);

    const build = await runTsx(source, childEnv({
      NODE_ENV: "production",
      APP_RUNTIME_PASSWORD: undefined,
      NEXT_PHASE: "phase-production-build",
    }));
    expect(build.code).toBe(0);
    expect(build.stdout).toContain("IMPORTED");
    expect(build.stderr).not.toContain("APP_RUNTIME_PASSWORD is required in production");
    assertNoSecrets(`${build.stdout}\n${build.stderr}`);
  }, 60_000);

  it("hosted CI executes the lock suite without Stripe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t236-locks-"));
    const output = join(dir, "report.json");
    const env = childEnv({
      STRIPE_SECRET_KEY: "",
      E2E_FAKE_STRIPE: "1",
      NODE_ENV: "test",
    });
    try {
      await execFileAsync(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "src/lib/checkout/place-order-locks.integration.test.ts",
          "--reporter=json",
          "--outputFile",
          output,
        ],
        { cwd: process.cwd(), env, shell: process.platform === "win32", timeout: 180_000 },
      );
    } catch (err) {
      const failed = err as { stdout?: string; stderr?: string };
      throw new Error(`locks suite failed without Stripe\n${failed.stdout ?? ""}\n${failed.stderr ?? ""}`);
    }
    const report = JSON.parse(readFileSync(output, "utf8")) as {
      numPassedTests?: number;
      numPendingTests?: number;
      numFailedTests?: number;
      success?: boolean;
    };
    expect(report.numFailedTests ?? 0).toBe(0);
    expect(report.numPendingTests ?? 0).toBe(0);
    expect(report.numPassedTests ?? 0).toBeGreaterThanOrEqual(19);
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});
