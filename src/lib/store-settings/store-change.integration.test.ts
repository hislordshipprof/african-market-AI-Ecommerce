import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

const state = vi.hoisted(() => ({ revalidated: [] as string[] }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: (tag: string) => state.revalidated.push(tag),
}));

import { lockStoreRow, platform, storeScoped, storeScopedTransaction } from "../db";
import { addDays, storeToday } from "../analytics/range";
import { clearStoreChange, writeStoreChange, type StoreChange } from "./store-change";
import { saveStoreSettings } from "./settings";
import { DEFAULT_WEEK } from "./weekly-hours";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t819-${Date.now().toString(36)}`;
const NY = "America/New_York";
const WEEK = {
  monday: "9:00 AM - 8:00 PM", tuesday: "9:00 AM - 8:00 PM", wednesday: "9:00 AM - 8:00 PM", thursday: "9:00 AM - 8:00 PM",
  friday: "9:00 AM - 8:00 PM", saturday: "9:00 AM - 8:00 PM", sunday: "Closed",
};

describe.skipIf(!hasDb)("one-off store changes (#819)", () => {
  let raw: PrismaClient;
  const owner = { id: `${RUN}-owner`, email: `${RUN}-owner@example.com` };
  let storeId = "";
  const today = storeToday(NY);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const inThreeDays = addDays(today, 3);

  const write = (change: StoreChange, now = new Date()) =>
    storeScopedTransaction(storeId, async (tx) => {
      await lockStoreRow(tx, storeId);
      await writeStoreChange(tx, storeId, change, owner, now);
    });
  // The app client: it pins the session zone to UTC, which timestamptz reads depend on.
  const row = () => platform.store.findUniqueOrThrow({ where: { id: storeId }, select: { hours: true, deliveryPausedUntil: true } });
  const audits = (action: string) => storeScoped(storeId).auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.user.create({ data: { id: owner.id, name: owner.id, email: owner.email, twoFactorEnabled: true } });
    storeId = (await raw.store.create({ data: { slug: `${RUN}-a`, name: "One-off A", status: "active", timezone: NY, hours: { ...WEEK, dates: { [yesterday]: "Closed" } } } })).id;
  });

  beforeEach(() => {
    state.revalidated = [];
  });

  // Audit rows are append-only, so the run's store stays; RUN keeps it apart from other files.
  afterAll(async () => {
    await raw.$disconnect();
  });

  it("writes a one-off day under hours.dates, keeps the week, drops past days, and audits it", async () => {
    await write({ kind: "day_hours", date: tomorrow, closed: false, open: "09:00", close: "18:00" });
    expect((await row()).hours).toEqual({ ...WEEK, dates: { [tomorrow]: "9:00 AM - 6:00 PM" } });
    await write({ kind: "day_hours", date: inThreeDays, closed: true });
    expect((await row()).hours).toEqual({ ...WEEK, dates: { [tomorrow]: "9:00 AM - 6:00 PM", [inThreeDays]: "Closed" } });
    const [first, second] = await audits("store.hours_one_off");
    expect(first).toMatchObject({ actorId: owner.id, entityId: storeId, before: { date: tomorrow, hours: null }, after: { date: tomorrow, hours: "9:00 AM - 6:00 PM" } });
    expect(second).toMatchObject({ after: { date: inThreeDays, hours: "Closed" } });
  });

  it("pauses delivery and audits the old and new end", async () => {
    const until = new Date(Date.now() + 3 * 60 * 60_000);
    await write({ kind: "delivery_pause", until: until.toISOString() });
    expect((await row()).deliveryPausedUntil).toEqual(until);
    const [audit] = await audits("store.delivery_pause");
    expect(audit).toMatchObject({ before: { deliveryPausedUntil: null }, after: { deliveryPausedUntil: until.toISOString() } });
  });

  it("throws on a change it refuses and writes nothing", async () => {
    const before = await row();
    const count = (await audits("store.hours_one_off")).length;
    await expect(write({ kind: "day_hours", date: yesterday, closed: true })).rejects.toThrow();
    await expect(write({ kind: "delivery_pause", until: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString() })).rejects.toThrow();
    expect(await row()).toEqual(before);
    expect((await audits("store.hours_one_off")).length).toBe(count);
  });

  it("the owner's weekly-hours save keeps the one-off days", async () => {
    const saved = await saveStoreSettings(storeId, {
      hours: { ...DEFAULT_WEEK, monday: { closed: false, open: "10:00", close: "19:00" } },
      timezone: NY, pickupEnabled: true, minimumOrderCents: 0, phone: "", about: "", slots: {},
    }, owner);
    expect(saved).toEqual({ ok: true });
    const hours = (await row()).hours as Record<string, unknown>;
    expect(hours.monday).toBe("10:00 AM - 7:00 PM");
    expect(hours.dates).toEqual({ [tomorrow]: "9:00 AM - 6:00 PM", [inThreeDays]: "Closed" });
  });

  it("removes one day and the pause, audited, and says when there is nothing left to remove", async () => {
    expect(await clearStoreChange(storeId, { date: tomorrow }, owner)).toEqual({ ok: true });
    expect(((await row()).hours as Record<string, unknown>).dates).toEqual({ [inThreeDays]: "Closed" });
    expect(await clearStoreChange(storeId, { deliveryPause: true }, owner)).toEqual({ ok: true });
    expect((await row()).deliveryPausedUntil).toBeNull();
    expect(state.revalidated.length).toBeGreaterThan(0);
    expect((await audits("store.delivery_pause")).at(-1)).toMatchObject({ after: { deliveryPausedUntil: null } });
    expect((await audits("store.hours_one_off")).at(-1)).toMatchObject({ before: { date: tomorrow, hours: "9:00 AM - 6:00 PM" }, after: { date: tomorrow, hours: null } });
    expect((await clearStoreChange(storeId, { date: tomorrow }, owner)).ok).toBe(false);
    expect((await clearStoreChange(storeId, { deliveryPause: true }, owner)).ok).toBe(false);
  });

  it("refuses a one-off day for a store with no weekly hours, which is open at all times", async () => {
    const bare = (await raw.store.create({ data: { slug: `${RUN}-b`, name: "One-off B", status: "active", timezone: NY } })).id;
    await expect(storeScopedTransaction(bare, (tx) => writeStoreChange(tx, bare, { kind: "day_hours", date: tomorrow, closed: true }, owner, new Date())))
      .rejects.toThrow(/weekly hours/);
    expect((await platform.store.findUniqueOrThrow({ where: { id: bare } })).hours).toBeNull();
  });
});
