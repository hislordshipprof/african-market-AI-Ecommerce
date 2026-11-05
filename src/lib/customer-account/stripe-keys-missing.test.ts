import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { authPrisma } from "../db";
import { addAddress } from "./address-book";
import { listAccountCards } from "./saved-cards";
import { checkoutPaymentsUseFake } from "../stripe/checkout-payments";

const execFileAsync = promisify(execFile);
const hasDb = Boolean(process.env.DATABASE_URL);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("saved cards when Stripe is not configured", () => {
  it("production without a secret key reports cards unavailable and does not throw", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("E2E_FAKE_STRIPE", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "");
    await expect(listAccountCards("user-without-stripe")).resolves.toEqual({
      unavailable: true,
      cards: [],
    });
  });

  it("the checkout fake stays off on Vercel and in production without CI", () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("CI", "");
    expect(checkoutPaymentsUseFake()).toBe(false);

    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "");
    expect(checkoutPaymentsUseFake()).toBe(false);

    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL", "");
    expect(checkoutPaymentsUseFake()).toBe(true);
  });
});

describe.skipIf(!hasDb)("cold production process", () => {
  const userId = `user-t248-cold-${Date.now()}`;

  afterAll(async () => {
    await authPrisma.user.deleteMany({ where: { id: userId } });
  });

  it("reads a populated account and refuses the fake when the key is missing", async () => {
    await authPrisma.user.create({
      data: { id: userId, name: "Cold", email: `${userId}@example.test` },
    });
    await addAddress(userId, {
      label: "Home",
      line1: "1 Market St",
      city: "Honolulu",
      state: "HI",
      zip: "96813",
    });
    const cardsHref = pathToFileURL(join(process.cwd(), "src/lib/customer-account/saved-cards.ts")).href;
    const paymentsHref = pathToFileURL(join(process.cwd(), "src/lib/stripe/checkout-payments.ts")).href;
    const addressHref = pathToFileURL(join(process.cwd(), "src/lib/customer-account/address-book.ts")).href;
    const dir = mkdtempSync(join(tmpdir(), "t248-cold-"));
    const file = join(dir, "run.mts");
    writeFileSync(file, `
      const { listAccountCards } = await import(${JSON.stringify(cardsHref)});
      const { getCheckoutPayments } = await import(${JSON.stringify(paymentsHref)});
      const { listAddresses } = await import(${JSON.stringify(addressHref)});
      const cards = await listAccountCards(${JSON.stringify(userId)});
      if (!cards.unavailable || cards.cards.length !== 0) process.exit(2);
      let refused = false;
      try {
        await getCheckoutPayments().createCustomer({ metadata: { user_id: "cold" } }, "cold-customer");
      } catch {
        refused = true;
      }
      if (!refused) process.exit(3);
      const addresses = await listAddresses(${JSON.stringify(userId)});
      if (addresses[0]?.city !== "Honolulu") process.exit(4);
      console.log("ok");
    `);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      STRIPE_SECRET_KEY: "",
      E2E_FAKE_STRIPE: "1",
      VERCEL: "1",
      CI: "",
    };
    try {
      const result = await execFileAsync("pnpm", ["exec", "tsx", file], {
        cwd: process.cwd(),
        env,
        shell: process.platform === "win32",
        timeout: 60_000,
      });
      expect(result.stdout).toContain("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
