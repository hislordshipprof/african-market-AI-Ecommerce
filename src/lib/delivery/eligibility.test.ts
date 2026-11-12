import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { checkCourierEligibility, readCourierWeightSettings } from "./eligibility";

const LB = 453.59237;
const settings = { courierWeightLimitLb: 50 };

describe("checkCourierEligibility", () => {
  it("refuses a single item over the limit and an order over the limit, and accepts one under it", () => {
    expect(checkCourierEligibility([{ weightG: Math.round(60 * LB), quantity: 1 }], settings)).toEqual({
      eligible: false,
      reason: "item_over_limit",
    });
    expect(
      checkCourierEligibility(
        [
          { weightG: Math.round(30 * LB), quantity: 1 },
          { weightG: Math.round(12.5 * LB), quantity: 2 },
        ],
        settings,
      ),
    ).toEqual({ eligible: false, reason: "order_over_limit" });
    expect(checkCourierEligibility([{ weightG: Math.round(20 * LB), quantity: 2 }], settings)).toEqual({ eligible: true });
  });

  it("follows the limit it is given, not a built-in 50 lb", () => {
    const cart = [{ weightG: Math.round(40 * LB), quantity: 1 }];
    expect(checkCourierEligibility(cart, { courierWeightLimitLb: 30 }).eligible).toBe(false);
    expect(checkCourierEligibility(cart, { courierWeightLimitLb: 50 }).eligible).toBe(true);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("courier weight limit platform setting", () => {
  let raw: PrismaClient;
  const setLimit = (courierWeightLimitLb: number) =>
    raw.$transaction([
      raw.$executeRaw`SET LOCAL ROLE app_user`,
      raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      raw.platformSettings.update({ where: { id: "platform" }, data: { courierWeightLimitLb } }),
    ]);
  beforeAll(() => {
    raw = testPrismaClient();
  });
  afterAll(async () => {
    await setLimit(50);
    await raw.$disconnect();
  });

  it("reads the limit from the platform setting, 50 lb by default", async () => {
    expect(await readCourierWeightSettings()).toEqual({ courierWeightLimitLb: 50 });
    await setLimit(30);
    const cart = [{ weightG: Math.round(40 * LB), quantity: 1 }];
    expect(checkCourierEligibility(cart, await readCourierWeightSettings()).eligible).toBe(false);
  });
});
