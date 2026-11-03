// Action-layer integration tests (#147). Only the request edges are faked (headers, redirect,
// Better Auth session, store resolution, cache tags); requireStoreOwner, the listing service and
// storeScoped all run for real against the database.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const state = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown>; session: Record<string, unknown> },
  store: null as null | Record<string, unknown>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  // Real Next.js redirect() throws; mirror that so callers cannot continue past it.
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../auth", () => ({ auth: { api: { getSession: async () => state.session } } }));
vi.mock("../get-store", () => ({ getStore: async () => state.store }));
vi.mock("../storefront/cache", () => ({ revalidateStorefront: vi.fn() }));

import { listMasterProductsAction, updateListingAction } from "./actions";
import { getListing } from "./service";
import { platformAdmin } from "../db";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

function asSession(userId: string, email: string) {
  state.session = {
    user: { id: userId, email, twoFactorEnabled: true },
    session: { twoFactorVerified: true },
  };
}

// Store-owned tables have FORCE ROW LEVEL SECURITY, so even the table owner is filtered (CI connects as
// app_owner, not a BYPASSRLS role). Seed and clean up as platform admin, the way the other suites do.
async function asAdmin<T>(raw: PrismaClient, op: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return op(tx);
  }) as Promise<T>;
}

describe.skipIf(!hasDb)("listing actions (DB integration, real auth guard)", () => {
  let raw: PrismaClient;
  const slugA = `act147-a-${RUN}`;
  const slugB = `act147-b-${RUN}`;
  const emailA = `act147-a-${RUN}@example.com`;
  const emailB = `act147-b-${RUN}@example.com`;
  const userA = `act147-ua-${RUN}`;
  const userB = `act147-ub-${RUN}`;
  const staffId = `act147-us-${RUN}`;
  let storeA: { id: string; slug: string };
  let storeB: { id: string; slug: string };
  let masterId: string;
  let listingId: string;
  let variantId: string;

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
    storeA = await raw.store.create({ data: { slug: slugA, name: "Act147 A", themePreset: "palm-and-shea" } });
    storeB = await raw.store.create({ data: { slug: slugB, name: "Act147 B", themePreset: "palm-and-shea" } });
    await raw.user.create({ data: { id: userA, email: emailA, name: "A Owner", emailVerified: true } });
    await raw.user.create({ data: { id: userB, email: emailB, name: "B Owner", emailVerified: true } });
    await asAdmin(raw, async (tx) => {
      await tx.storeMembership.create({ data: { storeId: storeA.id, userId: userA, role: "owner" } });
      await tx.storeMembership.create({ data: { storeId: storeB.id, userId: userB, role: "owner" } });
    });

    // A listing as the #110 backfill leaves it: linked to a master product with no weight, so the
    // variant carries the 100 g fallback.
    const master = await platformAdmin.masterProduct.create({ data: { name: `Act147 Garri ${RUN}`, weightG: null } });
    masterId = master.id;
    await asAdmin(raw, async (tx) => {
      const listing = await tx.listing.create({
        data: { storeId: storeA.id, masterProductId: masterId, price: 500, stockMode: "counted", qty: 4 },
      });
      listingId = listing.id;
      const variant = await tx.listingVariant.create({
        data: { listingId, label: "Standard", price: 500, weightG: 100 },
      });
      variantId = variant.id;
    });
  });

  afterAll(async () => {
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL ROLE app_user`,
      raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      raw.auditLog.deleteMany({ where: { storeId: { in: [storeA.id, storeB.id] } } }),
      raw.stockEvent.deleteMany({ where: { storeId: { in: [storeA.id, storeB.id] } } }),
      raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: [storeA.id, storeB.id] } } } }),
      raw.listing.deleteMany({ where: { storeId: { in: [storeA.id, storeB.id] } } }),
    ]);
    await raw.masterProduct.deleteMany({ where: { id: masterId } });
    await asAdmin(raw, (tx) => tx.storeMembership.deleteMany({ where: { storeId: { in: [storeA.id, storeB.id] } } }));
    await raw.user.deleteMany({ where: { id: { in: [userA, userB, staffId] } } });
    await raw.store.deleteMany({ where: { id: { in: [storeA.id, storeB.id] } } });
    await raw.$disconnect();
  });

  beforeEach(() => {
    state.session = null;
    state.store = storeA;
  });

  describe("listMasterProductsAction authorization", () => {
    it("rejects an unauthenticated caller", async () => {
      state.session = null;
      await expect(listMasterProductsAction("garri")).rejects.toThrow(/NEXT_REDIRECT:\/store-admin\/sign-in/);
    });

    it("rejects a signed-in user whose second factor is not verified", async () => {
      asSession(userA, emailA);
      (state.session!.session as Record<string, unknown>).twoFactorVerified = false;
      await expect(listMasterProductsAction("garri")).rejects.toThrow(/NEXT_REDIRECT/);
    });

    // E3: user is a member of store A only, but the request resolves to store B.
    it("rejects a member of store A acting in store B's context", async () => {
      asSession(userA, emailA);
      state.store = storeB;
      await expect(listMasterProductsAction("garri")).rejects.toThrow(/NEXT_REDIRECT:\/store-admin\/sign-in\?store=/);
    });

    it("rejects a store member who is not an owner", async () => {
            await raw.user.create({ data: { id: staffId, email: `act147-s-${RUN}@example.com`, name: "Staff", emailVerified: true } });
      await asAdmin(raw, (tx) => tx.storeMembership.create({ data: { storeId: storeA.id, userId: staffId, role: "staff" } }));
      asSession(staffId, `act147-s-${RUN}@example.com`);
      await expect(listMasterProductsAction("garri")).rejects.toThrow(/NEXT_REDIRECT:\/store-admin\?store=/);
    });

    it("returns only id and name to an owner of the store", async () => {
      asSession(userA, emailA);
      const result = await listMasterProductsAction(`Act147 Garri ${RUN}`);
      expect(result).toEqual([{ id: masterId, name: `Act147 Garri ${RUN}` }]);
    });
  });

  // E5 / #110 AC7: a backfilled listing saves and reads back through storeScoped.
  describe("updateListingAction on a backfilled listing", () => {
    it("saves new variant weights and reads them back through storeScoped", async () => {
      asSession(userA, emailA);
      const before = await getListing(storeA.id, listingId);
      expect(before!.variants.map((v) => v.weightG)).toEqual([100]);
      expect(before!.id).toBe(listingId);
      expect(variantId).toBeTruthy();

      const result = await updateListingAction(
        formData({
          listingId,
          price: "650",
          variants: JSON.stringify([{ label: "Standard", price: 650, weightG: 900 }]),
        }),
      );
      expect(result).toEqual({ success: true, id: listingId });

      const after = await getListing(storeA.id, listingId);
      expect(after!.price).toBe(650);
      expect(after!.masterProductId).toBe(masterId);
      expect(after!.variants.map((v) => ({ label: v.label, weightG: v.weightG }))).toEqual([
        { label: "Standard", weightG: 900 },
      ]);
    });

    it("refuses to save a zero weight and leaves the stored weight unchanged (constraint holds)", async () => {
      asSession(userA, emailA);
      const result = await updateListingAction(
        formData({ listingId, variants: JSON.stringify([{ label: "Standard", price: 650, weightG: 0 }]) }),
      );
      expect(result.error).toMatch(/weight must be greater than 0/i);
      const after = await getListing(storeA.id, listingId);
      expect(after!.variants.map((v) => v.weightG)).toEqual([900]);
    });

    it("rejects the database CHECK when a zero weight bypasses action validation", async () => {
      await expect(
        asAdmin(raw, (tx) => tx.$executeRaw`UPDATE listing_variants SET weight_g = 0 WHERE listing_id = ${listingId}`),
      ).rejects.toThrow(/listing_variants_weight_g_positive|violates check constraint/);
    });

    it("another store's owner cannot update the listing", async () => {
      asSession(userB, emailB);
      state.store = storeB;
      const result = await updateListingAction(formData({ listingId, price: "1" }));
      expect(result.error).toBeTruthy();
      const after = await getListing(storeA.id, listingId);
      expect(after!.price).toBe(650);
    });
  });
});
