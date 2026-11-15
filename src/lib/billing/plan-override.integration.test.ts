import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: () => unknown) => () => fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { testPrismaClient } from "@/lib/test-prisma";
import { listSubscriptionOverviewRows, platformAdmin } from "../db";
import { setPlanOverrideAction } from "../admin/actions";
import { listSubscriptions } from "../admin/subscriptions";
import { claimAssistantChat } from "./assistant-chats";
import { storePlan, storeMayUse } from "./plan";
import { createFakeBillingProvider, setBillingProvider } from "./provider";
import { getStoreBilling, setPlanOverride } from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("plan override (#547, lane DB)", () => {
  const run = `ovr547-${Date.now()}`;
  const admin = { id: "system_00000000000000000000000", email: "system@platform.internal" };
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  const providerCalls: string[] = [];

  async function asAdmin<T>(fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>) {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return fn(tx);
    });
  }

  /** Days from the database clock, as the date the admin picks. */
  async function dbDate(days: number): Promise<Date> {
    const [row] = await raw.$queryRaw<{ at: Date }[]>`SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + make_interval(days => ${days}) AS at`;
    return row!.at;
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    storeA = (await raw.store.create({ data: { slug: `ovr-a-${run}`, name: `Ovr A ${run}` } })).id;
    storeB = (await raw.store.create({ data: { slug: `ovr-b-${run}`, name: `Ovr B ${run}` } })).id;
    await asAdmin(async (tx) => {
      await tx.storeSubscription.create({ data: { storeId: storeA, plan: "starter", status: "active", stripeSubscriptionId: `sub_${run}_a`, stripeCustomerId: `cus_${run}_a` } });
      await tx.storeSubscription.create({ data: { storeId: storeB, plan: "starter", status: "active", stripeSubscriptionId: `sub_${run}_b`, stripeCustomerId: `cus_${run}_b` } });
    });
    const fake = createFakeBillingProvider();
    setBillingProvider(
      new Proxy(fake, {
        get(target, prop: string) {
          const value = (target as unknown as Record<string, unknown>)[prop];
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            providerCalls.push(prop);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }),
    );
  });

  afterAll(async () => {
    setBillingProvider(null);
    if (!raw) return;
    const ids = [storeA, storeB];
    await asAdmin(async (tx) => {
      await tx.auditLog.deleteMany({ where: { storeId: { in: ids } } });
      await tx.assistantChatMonth.deleteMany({ where: { storeId: { in: ids } } });
      await tx.storeSubscription.deleteMany({ where: { storeId: { in: ids } } });
      await tx.store.deleteMany({ where: { id: { in: ids } } });
    });
    await raw.$disconnect();
  });

  it("a Pro override drives the plan gate, writes an audit row and never calls Stripe", async () => {
    expect(await storePlan(storeA)).toBe("starter");
    const endsAt = await dbDate(30);
    const result = await setPlanOverride({ storeId: storeA, plan: "pro", endsAt, reason: "  Launch partner  " }, admin);
    expect(result).toEqual({ ok: true });

    expect(await storePlan(storeA)).toBe("pro");
    expect(await storeMayUse(storeA, "analytics-dashboard")).toBe(true);
    const claim = await claimAssistantChat(storeA, new Date());
    expect(claim).toMatchObject({ ok: true, plan: "pro", cap: 5_000 });
    expect(providerCalls).toEqual([]);

    const row = await platformAdmin.storeSubscription.findUniqueOrThrow({ where: { storeId: storeA } });
    expect(row).toMatchObject({ plan: "starter", status: "active", overridePlan: "pro", overrideReason: "Launch partner" });
    expect(row.overrideEndsAt?.toISOString()).toBe(endsAt.toISOString());

    const audits = await platformAdmin.auditLog.findMany({ where: { storeId: storeA, action: "subscription.plan_override_set" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: admin.id,
      entityType: "store_subscription",
      entityId: storeA,
      before: { overridePlan: null, overrideEndsAt: null, overrideReason: null },
      after: { overridePlan: "pro", overrideEndsAt: endsAt.toISOString(), overrideReason: "Launch partner" },
    });
  });

  it("the owner's plan page sees the override and its end date; another store sees neither", async () => {
    const billing = await getStoreBilling(storeA);
    expect(billing.plan).toBe("pro");
    expect(billing.override).toMatchObject({ plan: "pro" });

    const other = await getStoreBilling(storeB);
    expect(other.plan).toBe("starter");
    expect(other.override).toBeNull();
    expect(await storePlan(storeB)).toBe("starter");
  });

  it("the override wins over a Stripe downgrade while it runs", async () => {
    await asAdmin((tx) => tx.storeSubscription.update({ where: { storeId: storeA }, data: { status: "canceled" } }));
    expect(await storePlan(storeA)).toBe("pro");
  });

  it("the override ends on its date by the database clock, then the Stripe plan applies", async () => {
    // Move the end to the database's own now(): the override must already be over.
    await asAdmin((tx) => tx.$executeRaw`UPDATE store_subscriptions SET override_ends_at = now() WHERE store_id = ${storeA}`);
    expect(await storePlan(storeA)).toBe("starter");
    expect((await getStoreBilling(storeA)).override).toBeNull();
    const overview = (await listSubscriptionOverviewRows()).find((row) => row.storeId === storeA);
    expect(overview).toMatchObject({ overridePlan: null, overrideEndsAt: null, overrideReason: null, status: "canceled" });

    await asAdmin((tx) => tx.$executeRaw`UPDATE store_subscriptions SET override_ends_at = now() + interval '1 hour' WHERE store_id = ${storeA}`);
    expect(await storePlan(storeA)).toBe("pro");
    await asAdmin((tx) => tx.storeSubscription.update({ where: { storeId: storeA }, data: { status: "active" } }));
  });

  it("refuses a past or open-ended date, a blank reason and an unknown store, writing nothing", async () => {
    const before = await platformAdmin.auditLog.count({ where: { storeId: storeB } });
    expect(await setPlanOverride({ storeId: storeB, plan: "pro", endsAt: await dbDate(0), reason: "x" }, admin)).toMatchObject({ ok: false });
    expect(await setPlanOverride({ storeId: storeB, plan: "pro", endsAt: await dbDate(400), reason: "x" }, admin)).toMatchObject({ ok: false });
    expect(await setPlanOverride({ storeId: storeB, plan: "pro", endsAt: await dbDate(5), reason: "   " }, admin)).toMatchObject({ ok: false });
    expect(await setPlanOverride({ storeId: `missing-${run}`, plan: "pro", endsAt: await dbDate(5), reason: "x" }, admin)).toMatchObject({ ok: false });
    expect(await platformAdmin.auditLog.count({ where: { storeId: storeB } })).toBe(before);
    expect(await storePlan(storeB)).toBe("starter");
    await expect(asAdmin((tx) => tx.$executeRaw`UPDATE store_subscriptions SET override_plan = 'pro' WHERE store_id = ${storeB}`)).rejects.toThrow(/override_complete_check/);
  });

  it("only a platform admin may set an override or read the overview", async () => {
    const form = new FormData();
    form.set("storeId", storeB);
    form.set("plan", "pro");
    form.set("endsOn", (await dbDate(10)).toISOString().slice(0, 10));
    form.set("reason", "not an admin");
    await expect(setPlanOverrideAction(form)).rejects.toThrow("REDIRECT:/admin/sign-in");
    await expect(listSubscriptions()).rejects.toThrow("REDIRECT:/admin/sign-in");
    expect(await storePlan(storeB)).toBe("starter");
  });

  it("a store's own RLS context cannot change its override", async () => {
    const changed = await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${storeB}, true)`;
      return tx.$executeRaw`UPDATE store_subscriptions SET override_plan = 'pro', override_ends_at = now() + interval '1 day', override_reason = 'self' WHERE store_id = ${storeB}`;
    });
    expect(changed).toBe(0);
    expect(await storePlan(storeB)).toBe("starter");
  });
});
