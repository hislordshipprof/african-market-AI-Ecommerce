import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { listDirectoryStores } from "./stores";

const hasDb = !!process.env.DATABASE_URL;

const PUBLIC_FIELDS = [
  "name",
  "slug",
  "logoUrl",
  "brandColor",
  "city",
  "state",
  "lat",
  "lng",
  "hours",
  "timezone",
  "pickupEnabled",
  "storeDeliveryEnabled",
  "listingBlurb",
  "ownerName",
  "ownerStory",
  "ownerPhotoUrl",
].sort();

describe.skipIf(!hasDb)("listDirectoryStores", () => {
  let raw: PrismaClient;
  const stamp = Date.now().toString(36);
  const slug = (name: string) => `t449-${name}-${stamp}`;
  const located = { city: "Houston", state: "TX", lat: 29.76, lng: -95.37 };

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.store.createMany({
      data: [
        {
          slug: slug("listed"),
          name: "Listed Market",
          ...located,
          listed: true,
          listingBlurb: "Fresh yam every Friday.",
          stripeAccountId: `acct_t449_${stamp}`,
          stripeOnboardingStatus: "complete",
          addressLine1: "12 Hidden St",
          zip: "77002",
          ownerName: "Ada",
        },
        { slug: slug("unlisted"), name: "Unlisted Market", ...located },
        { slug: slug("suspended"), name: "Suspended Market", ...located, listed: true, status: "suspended" },
        { slug: slug("nopoint"), name: "No Point Market", city: "Houston", state: "TX", listed: true },
        { slug: slug("nolng"), name: "No Lng Market", city: "Houston", state: "TX", lat: 29.7, listed: true },
      ],
    });
  });

  afterAll(async () => {
    await raw.store.deleteMany({ where: { slug: { startsWith: "t449-", endsWith: stamp } } });
    await raw.$disconnect();
  });

  it("returns a listed, active store with a point", async () => {
    const mine = (await listDirectoryStores()).filter((s) => s.slug.endsWith(stamp));
    expect(mine.map((s) => s.slug)).toEqual([slug("listed")]);
    expect(mine[0]).toMatchObject({ name: "Listed Market", city: "Houston", state: "TX", lat: 29.76, lng: -95.37, listingBlurb: "Fresh yam every Friday.", ownerName: "Ada" });
  });

  it("never returns unlisted, suspended or unlocated stores", async () => {
    const slugs = (await listDirectoryStores()).map((s) => s.slug);
    for (const name of ["unlisted", "suspended", "nopoint", "nolng"]) {
      expect(slugs).not.toContain(slug(name));
    }
  });

  it("returns only the public field list: no Stripe, fee, limit, onboarding or address columns", async () => {
    const [store] = (await listDirectoryStores()).filter((s) => s.slug === slug("listed"));
    expect(Object.keys(store).sort()).toEqual(PUBLIC_FIELDS);
    const leaked = JSON.stringify(store);
    for (const secret of [`acct_t449_${stamp}`, "complete", "12 Hidden St", "77002"]) {
      expect(leaked).not.toContain(secret);
    }
  });

  it("caps the blurb at 160 characters in the database", async () => {
    await expect(
      raw.store.create({ data: { slug: slug("long"), name: "Long Blurb", listingBlurb: "x".repeat(161) } }),
    ).rejects.toThrow();
    await raw.store.create({ data: { slug: slug("fits"), name: "Fits", listingBlurb: "x".repeat(160) } });
  });
});
