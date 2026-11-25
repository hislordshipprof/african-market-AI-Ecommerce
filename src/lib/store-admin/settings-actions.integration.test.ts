import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { platform, storeScoped, storeScopedTransaction, updateStoreOneOff } from "../db";

const state = vi.hoisted(() => ({ headers: new Headers(), userId: "", revalidated: [] as string[] }));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: (tag: string) => state.revalidated.push(tag),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("../auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        state.userId
          ? {
              user: { id: state.userId, email: `${state.userId}@example.com`, name: "T", twoFactorEnabled: true },
              session: { twoFactorVerified: true },
            }
          : null,
    },
  },
}));

import { removeStoreChange, updateStoreSettings } from "./settings-actions";
import { addDays, storeToday } from "../analytics/range";
import { readGoLiveChecklist } from "../go-live/checklist";
import { DEFAULT_WEEK } from "../store-settings/weekly-hours";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `t786-${Date.now().toString(36)}`;
// A Monday afternoon in Chicago.
const MONDAY_2PM = new Date("2026-11-16T20:00:00Z");

const WEEK = { ...DEFAULT_WEEK, sunday: { closed: true, open: "09:00", close: "20:00" } };
const VALID = {
  hours: WEEK,
  timezone: "America/Chicago",
  pickupEnabled: true,
  minimumOrderCents: 0,
  phone: "(312) 555-0142",
  about: "  Family shop since 2009: yams, palm oil and fresh fish on Fridays.  ",
  slots: {} as Record<string, string>,
};

describe.skipIf(!hasDb)("updateStoreSettings (#786)", () => {
  let raw: PrismaClient;
  const ids = { a: "", owner: `${RUN}-owner`, staff: `${RUN}-staff` };
  const slug = `${RUN}-a`;

  function as(userId: string) {
    state.userId = userId;
    state.headers = new Headers({ "x-store-slug": slug });
  }
  const row = () =>
    raw.store.findUniqueOrThrow({
      where: { id: ids.a },
      select: { hours: true, timezone: true, timezoneSetAt: true, pickupEnabled: true, minimumOrderCents: true, phone: true, ownerStory: true, pickupSlotSettings: true, storeDeliverySlotSettings: true },
    });
  const audits = () => storeScoped(ids.a).auditLog.findMany({ where: { action: "store.settings" }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    raw = testPrismaClient();
    // As a store application leaves it: zone guessed, no hours, pickup off.
    ids.a = (await raw.store.create({ data: { slug, name: "Settings A", status: "setup", timezone: "America/New_York" } })).id;
    for (const id of [ids.owner, ids.staff]) {
      await raw.user.create({ data: { id, name: id, email: `${id}@example.com`, twoFactorEnabled: true } });
    }
    await storeScoped(ids.a).storeMembership.create({ data: { storeId: ids.a, userId: ids.owner, role: "owner" } });
    await storeScoped(ids.a).storeMembership.create({ data: { storeId: ids.a, userId: ids.staff, role: "staff" } });
  });

  beforeEach(() => {
    state.revalidated = [];
  });

  // Audit rows are append-only, so the run's store stays; RUN keeps it apart from other files.
  afterAll(async () => {
    await raw.$disconnect();
  });

  it("saves hours, zone, pickup, a $0 minimum, phone and about; audits it; the hours item goes done", async () => {
    as(ids.owner);
    expect(await updateStoreSettings(VALID)).toEqual({ ok: true });
    const saved = await row();
    expect(saved).toMatchObject({
      timezone: "America/Chicago",
      pickupEnabled: true,
      minimumOrderCents: 0,
      phone: "+13125550142",
      ownerStory: "Family shop since 2009: yams, palm oil and fresh fish on Fridays.",
    });
    expect(saved.hours).toMatchObject({ monday: "9:00 AM - 8:00 PM", sunday: "Closed" });
    expect(saved.timezoneSetAt).toBeInstanceOf(Date);
    const [audit] = await audits();
    expect(audit).toMatchObject({
      actorId: ids.owner,
      entityId: ids.a,
      before: { timezone: "America/New_York", pickupEnabled: false, minimumOrderCents: 3500, hours: null },
      after: { timezone: "America/Chicago", pickupEnabled: true, minimumOrderCents: 0, phone: "+13125550142" },
    });
    // Checkout reads the cached store row.
    expect(state.revalidated.length).toBeGreaterThan(0);
    const hours = (await readGoLiveChecklist(ids.a, MONDAY_2PM))?.items.find((i) => i.key === "hours");
    expect(hours).toMatchObject({ done: true, detail: "Chicago time" });
  });

  it("refuses a bad phone, a zone outside the US list, a negative minimum and a same-time day, and saves nothing", async () => {
    as(ids.owner);
    const before = await row();
    const count = (await audits()).length;
    expect((await updateStoreSettings({ ...VALID, phone: "12345" })).ok).toBe(false);
    expect((await updateStoreSettings({ ...VALID, timezone: "Europe/London" })).ok).toBe(false);
    expect((await updateStoreSettings({ ...VALID, minimumOrderCents: -1 })).ok).toBe(false);
    expect((await updateStoreSettings({ ...VALID, hours: { ...WEEK, monday: { closed: false, open: "09:00", close: "09:00" } } })).ok).toBe(false);
    expect(await row()).toEqual(before);
    expect((await audits()).length).toBe(count);
  });

  it("clears the phone and about when left empty", async () => {
    as(ids.owner);
    expect(await updateStoreSettings({ ...VALID, phone: " ", about: "" })).toEqual({ ok: true });
    expect(await row()).toMatchObject({ phone: null, ownerStory: null });
  });

  it("sets pickup and delivery slots, audits the change, and refuses unreadable windows (#807)", async () => {
    as(ids.owner);
    const slots = {
      pickupSlotsEnabled: "on", pickupSlotsMinutes: "30", pickupSlotsLead: "180", pickupSlotsCapacity: "6", pickupSlotsDaysAhead: "3",
      pickupSlotsMon: "10:00 AM - 1:00 PM",
      deliverySlotsEnabled: "on", deliverySlotsMinutes: "120", deliverySlotsLead: "240", deliverySlotsCapacity: "2", deliverySlotsDaysAhead: "2",
      deliverySlotsSat: "2:00 PM - 6:00 PM",
    };
    expect(await updateStoreSettings({ ...VALID, slots })).toEqual({ ok: true });
    const saved = await row();
    expect(saved.pickupSlotSettings).toMatchObject({ slotMinutes: 30, leadMinutes: 180, capacity: 6, daysAhead: 3 });
    expect((saved.pickupSlotSettings as { windows: unknown[] }).windows[1]).toEqual([{ start: 600, end: 780 }]);
    expect(saved.storeDeliverySlotSettings).toMatchObject({ slotMinutes: 120, leadMinutes: 240, capacity: 2, daysAhead: 2 });
    const last = (await audits()).at(-1)!;
    expect(last.before).toMatchObject({ pickupSlotSettings: null, storeDeliverySlotSettings: null });
    expect(last.after).toMatchObject({ pickupSlotSettings: { capacity: 6 }, storeDeliverySlotSettings: { capacity: 2 } });

    const count = (await audits()).length;
    const refused = await updateStoreSettings({ ...VALID, slots: { ...slots, pickupSlotsMon: "noon till late" } });
    expect(refused).toEqual({ ok: false, message: expect.stringMatching(/9:00 AM - 12:00 PM/) });
    expect((await audits()).length).toBe(count);

    // Unticked turns them off again.
    expect(await updateStoreSettings({ ...VALID, slots: { ...slots, pickupSlotsEnabled: "" } })).toEqual({ ok: true });
    expect((await row()).pickupSlotSettings).toBeNull();
  });

  it("staff cannot change settings", async () => {
    as(ids.staff);
    await expect(updateStoreSettings({ ...VALID, minimumOrderCents: 9900 })).rejects.toThrow(/REDIRECT/);
    expect((await row()).minimumOrderCents).toBe(0);
  });

  it("the owner removes a one-off day and the delivery pause; staff cannot; a malformed ref is refused (#819)", async () => {
    const day = addDays(storeToday("America/Chicago"), 2);
    await storeScopedTransaction(ids.a, async (tx) => {
      await updateStoreOneOff(tx, ids.a, { hours: { ...((await row()).hours as object), dates: { [day]: "Closed" } } });
      await updateStoreOneOff(tx, ids.a, { deliveryPausedUntil: new Date(Date.now() + 60 * 60_000) });
    });
    as(ids.staff);
    await expect(removeStoreChange({ deliveryPause: true })).rejects.toThrow(/REDIRECT/);
    as(ids.owner);
    expect((await removeStoreChange({ date: "soon" })).ok).toBe(false);
    expect(await removeStoreChange({ date: day })).toEqual({ ok: true });
    expect(await removeStoreChange({ deliveryPause: true })).toEqual({ ok: true });
    const pause = await platform.store.findUniqueOrThrow({ where: { id: ids.a }, select: { deliveryPausedUntil: true } });
    expect(pause.deliveryPausedUntil).toBeNull();
    expect((await row()).hours).not.toHaveProperty("dates");
  });
});
