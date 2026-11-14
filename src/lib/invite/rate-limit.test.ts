import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  checkInviteRateLimit,
  INVITE_RATE_LIMIT_MAX,
  INVITE_RATE_LIMIT_WINDOW_MS,
} from "./rate-limit";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("checkInviteRateLimit", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "rate-limit-a" },
      update: {},
      create: { slug: "rate-limit-a", name: "Rate Limit Store A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "rate-limit-b" },
      update: {},
      create: { slug: "rate-limit-b", name: "Rate Limit Store B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;
  });

  beforeEach(async () => {
    await rawPrisma.appRateLimit.deleteMany({
      where: { key: { in: [`invite:${storeAId}`, `invite:${storeBId}`] } },
    });
  });

  afterAll(async () => {
    await rawPrisma.appRateLimit.deleteMany({
      where: { key: { startsWith: "invite:" } },
    });
    await rawPrisma.store.deleteMany({
      where: { slug: { in: ["rate-limit-a", "rate-limit-b"] } },
    });
    await rawPrisma.$disconnect();
  });

  it("allows the first invite", async () => {
    const result = await checkInviteRateLimit(storeAId);
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });

  it("allows up to INVITE_RATE_LIMIT_MAX invites", async () => {
    for (let i = 0; i < INVITE_RATE_LIMIT_MAX; i++) {
      const result = await checkInviteRateLimit(storeAId);
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(i + 1);
    }
  });

  it("rejects the (MAX + 1)th invite", async () => {
    for (let i = 0; i < INVITE_RATE_LIMIT_MAX; i++) {
      await checkInviteRateLimit(storeAId);
    }
    const result = await checkInviteRateLimit(storeAId);
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(INVITE_RATE_LIMIT_MAX + 1);
  });

  it("isolates counters per store", async () => {
    for (let i = 0; i < INVITE_RATE_LIMIT_MAX; i++) {
      await checkInviteRateLimit(storeAId);
    }
    const storeAResult = await checkInviteRateLimit(storeAId);
    expect(storeAResult.allowed).toBe(false);

    const storeBResult = await checkInviteRateLimit(storeBId);
    expect(storeBResult.allowed).toBe(true);
    expect(storeBResult.count).toBe(1);
  });

  it("resets count after the window expires", async () => {
    for (let i = 0; i < INVITE_RATE_LIMIT_MAX; i++) {
      await checkInviteRateLimit(storeAId);
    }
    const overLimit = await checkInviteRateLimit(storeAId);
    expect(overLimit.allowed).toBe(false);

    // Simulate window expiry by backdating last_request
    const key = `invite:${storeAId}`;
    const pastTimestamp = BigInt(Date.now() - 2 * 60 * 60 * 1000);
    await rawPrisma.appRateLimit.update({
      where: { key },
      data: { windowStart: pastTimestamp },
    });

    const afterExpiry = await checkInviteRateLimit(storeAId);
    expect(afterExpiry.allowed).toBe(true);
    expect(afterExpiry.count).toBe(1);
  });

  it("fixed window: steady use does not prevent reset after window from first invite elapses", async () => {
    const windowMs = INVITE_RATE_LIMIT_WINDOW_MS;
    const t0 = Date.now();
    const spread = Math.floor((windowMs * 0.98) / INVITE_RATE_LIMIT_MAX);

    // 20 invites spread across ~59 minutes (each ~2.94 min apart)
    for (let i = 0; i < INVITE_RATE_LIMIT_MAX; i++) {
      const nowMs = t0 + i * spread;
      const result = await checkInviteRateLimit(storeAId, nowMs);
      expect(result.allowed).toBe(true);
    }

    // 21st at t0 + 59min — still within window, should be blocked
    const t59 = t0 + Math.floor(windowMs * 0.98);
    const blocked = await checkInviteRateLimit(storeAId, t59);
    expect(blocked.allowed).toBe(false);

    // After the window from the FIRST invite elapses (t0 + windowMs + 1ms)
    const tAfterWindow = t0 + windowMs + 1;
    const allowed = await checkInviteRateLimit(storeAId, tAfterWindow);
    expect(allowed.allowed).toBe(true);
    expect(allowed.count).toBe(1);
  });
});
