// #787: an owner's own product photo. Only the request edges and the R2 upload are faked;
// requireStoreOwner, storeScoped and the storefront reads run for real against the database.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { testPrismaClient } from "@/lib/test-prisma";

const state = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown>; session: Record<string, unknown> },
  store: null as null | Record<string, unknown>,
  stored: new Map<string, { body: Buffer; contentType: string }>(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock("../auth", () => ({ auth: { api: { getSession: async () => state.session } } }));
vi.mock("../get-store", () => ({ getStore: async () => state.store }));
// Storage boundary: lanes have no R2 keys, so uploads land in this map.
vi.mock("../r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../r2")>();
  return {
    ...actual,
    uploadToR2: async (key: string, body: Buffer | Uint8Array, contentType: string) => {
      state.stored.set(key, { body: Buffer.from(body), contentType });
      return actual.catalogImageUrl(key);
    },
  };
});

import { uploadListingPhotoAction } from "./actions";
import { getListingDetail } from "../storefront/service";
import { platformAdmin } from "../db";
import { PHOTO_UPLOAD_MAX_BYTES } from "./csv-file-cap";

const hasDb = !!process.env.DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const MASTER_PHOTO = "/images/products/egusi.webp";

async function asAdmin<T>(raw: PrismaClient, op: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return op(tx);
  }) as Promise<T>;
}

function photoForm(listingId: string, bytes: Uint8Array, name = "photo.jpg", type = "image/jpeg"): FormData {
  const form = new FormData();
  form.set("listingId", listingId);
  form.set("photo", new File([Buffer.from(bytes)], name, { type }));
  return form;
}

const jpegWithExif = () =>
  sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#3a6" } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "secret-gps-owner", Make: "PhoneCo" } })
    .toBuffer();

describe.skipIf(!hasDb)("uploadListingPhotoAction (DB integration, #787)", () => {
  let raw: PrismaClient;
  const ids = { ownerA: `p787-oa-${RUN}`, ownerB: `p787-ob-${RUN}`, staff: `p787-st-${RUN}` };
  const email = (id: string) => `${id}@example.com`;
  let storeA: { id: string; slug: string };
  let storeB: { id: string; slug: string };
  let masterId: string;
  let listingA: string;
  let listingB: string;

  function signIn(userId: string) {
    state.session = { user: { id: userId, email: email(userId), twoFactorEnabled: true }, session: { twoFactorVerified: true } };
  }

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.$connect();
    storeA = await raw.store.create({ data: { slug: `p787-a-${RUN}`, name: "P787 A", themePreset: "palm-and-shea" } });
    storeB = await raw.store.create({ data: { slug: `p787-b-${RUN}`, name: "P787 B", themePreset: "palm-and-shea" } });
    for (const id of Object.values(ids)) await raw.user.create({ data: { id, email: email(id), name: id, emailVerified: true } });
    await asAdmin(raw, async (tx) => {
      await tx.storeMembership.create({ data: { storeId: storeA.id, userId: ids.ownerA, role: "owner" } });
      await tx.storeMembership.create({ data: { storeId: storeB.id, userId: ids.ownerB, role: "owner" } });
      await tx.storeMembership.create({ data: { storeId: storeA.id, userId: ids.staff, role: "staff" } });
    });
    const master = await platformAdmin.masterProduct.create({ data: { name: `P787 Egusi ${RUN}`, imageUrl: MASTER_PHOTO } });
    masterId = master.id;
    await asAdmin(raw, async (tx) => {
      for (const storeId of [storeA.id, storeB.id]) {
        const listing = await tx.listing.create({ data: { storeId, masterProductId: masterId, price: 500, stockMode: "status", status: "in_stock" } });
        await tx.listingVariant.create({ data: { listingId: listing.id, label: "Standard", price: 500, weightG: 400 } });
        if (storeId === storeA.id) listingA = listing.id;
        else listingB = listing.id;
      }
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const stores = [storeA.id, storeB.id];
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL ROLE app_user`,
      raw.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      raw.auditLog.deleteMany({ where: { storeId: { in: stores } } }),
      raw.listingVariant.deleteMany({ where: { listing: { storeId: { in: stores } } } }),
      raw.listing.deleteMany({ where: { storeId: { in: stores } } }),
      raw.storeMembership.deleteMany({ where: { storeId: { in: stores } } }),
    ]);
    await raw.masterProduct.deleteMany({ where: { id: masterId } });
    await raw.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await raw.store.deleteMany({ where: { id: { in: stores } } });
    await raw.$disconnect();
  });

  beforeEach(() => {
    state.session = null;
    state.store = storeA;
    state.stored.clear();
    for (const [name, value] of Object.entries({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket", R2_PUBLIC_URL: "" })) {
      vi.stubEnv(name, value);
    }
  });

  it("stores the owner's photo as a WebP with no EXIF and shows it on that store's product page only", async () => {
    signIn(ids.ownerA);
    const result = await uploadListingPhotoAction(photoForm(listingA, await jpegWithExif()));
    expect(result).toMatchObject({ success: true });

    expect(state.stored.size).toBe(1);
    const [[key, object]] = [...state.stored.entries()];
    expect(object.contentType).toBe("image/webp");
    const meta = await sharp(object.body).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(960);

    expect((await getListingDetail(storeA.id, listingA))?.imageUrl).toBe(`/api/catalog-image/${key}`);
    // AC2: the other store and the master product keep the catalogue photo.
    expect((await getListingDetail(storeB.id, listingB))?.imageUrl).toBe(MASTER_PHOTO);
    expect((await platformAdmin.masterProduct.findUnique({ where: { id: masterId } }))?.imageUrl).toBe(MASTER_PHOTO);

    const audits = await asAdmin(raw, (tx) => tx.auditLog.findMany({ where: { entityId: listingA, action: "listing.photo" } }));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toEqual({ imageUrl: `/api/catalog-image/${key}` });
  });

  it("refuses another store's listing and writes nothing", async () => {
    signIn(ids.ownerA);
    const result = await uploadListingPhotoAction(photoForm(listingB, await jpegWithExif()));
    expect(result).toEqual({ error: "Listing not found" });
    expect(state.stored.size).toBe(0);
    expect((await getListingDetail(storeB.id, listingB))?.imageUrl).toBe(MASTER_PHOTO);
  });

  it("refuses staff: photos are an owner's listing edit", async () => {
    signIn(ids.staff);
    await expect(uploadListingPhotoAction(photoForm(listingA, await jpegWithExif()))).rejects.toThrow(/NEXT_REDIRECT:\/store-admin\?store=/);
    expect(state.stored.size).toBe(0);
  });

  it("sniffs the bytes: a text file named .jpg and an SVG are refused", async () => {
    signIn(ids.ownerA);
    const text = new TextEncoder().encode("not a photo at all");
    expect(await uploadListingPhotoAction(photoForm(listingA, text))).toEqual({ error: "Upload a JPEG, PNG or WebP photo." });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect((await uploadListingPhotoAction(photoForm(listingA, svg, "x.png", "image/png"))).error).toMatch(/JPEG, PNG or WebP/);
    expect(state.stored.size).toBe(0);
  });

  it("refuses a photo over the size cap before reading it", async () => {
    signIn(ids.ownerA);
    const big = new Uint8Array(PHOTO_UPLOAD_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await uploadListingPhotoAction(photoForm(listingA, big))).error).toMatch(/over 2 MB/);
    expect(state.stored.size).toBe(0);
  });

  it("says photo storage is not set up when the bucket is missing", async () => {
    signIn(ids.ownerA);
    vi.stubEnv("R2_BUCKET", "");
    expect(await uploadListingPhotoAction(photoForm(listingA, await jpegWithExif()))).toEqual({ error: "Photo storage is not set up." });
  });
});
