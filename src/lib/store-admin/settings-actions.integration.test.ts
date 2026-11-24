import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped } from "../db";

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

import { updateStoreSettings } from "./settings-actions";
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
      select: { hours: true, timezone: true, timezoneSetAt: true, pickupEnabled: true, minimumOrderCents: true, phone: true, ownerStory: true },
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

  it("staff cannot change settings", async () => {
    as(ids.staff);
    await expect(updateStoreSettings({ ...VALID, minimumOrderCents: 9900 })).rejects.toThrow(/REDIRECT/);
    expect((await row()).minimumOrderCents).toBe(0);
  });
});
