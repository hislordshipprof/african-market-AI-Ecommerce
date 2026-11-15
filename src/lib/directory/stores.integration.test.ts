import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn() }));
import type { Prisma, PrismaClient } from "@prisma/client";
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
  "hours",
  "timezone",
  "pickupEnabled",
  "storeDeliveryEnabled",
  "listingBlurb",
  "cuisineTags",
  "ownerName",
  "ownerStory",
  "ownerPhotoUrl",
  "courierMayDeliver",
].sort();

describe.skipIf(!hasDb)("listDirectoryStores", () => {
  let raw: PrismaClient;
  const stamp = Date.now().toString(36);
  const slug = (name: string) => `t449-${name}-${stamp}`;
  const located = { city: "Houston", state: "TX", lat: 29.76, lng: -95.37 };
  // store_subscriptions is store-scoped even for the test client.
  const asPlatformAdmin = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await work(tx);
    });

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
          phone: "+17135550449",
          uberLocationId: `uber_t449_${stamp}`,
        },
        { slug: slug("noaddress"), name: "No Address Market", ...located, listed: true, uberLocationId: `uber_t453_${stamp}`, phone: "+17135550453" },
        { slug: slug("starter"), name: "Starter Plan Market", ...located, listed: true, addressLine1: "1 Main St", zip: "77002", phone: "+17135550454", doordashStoreId: `dd_t453_${stamp}` },
        { slug: slug("unlisted"), name: "Unlisted Market", ...located },
        { slug: slug("suspended"), name: "Suspended Market", ...located, listed: true, status: "suspended" },
        { slug: slug("setup"), name: "Opening Soon Market", ...located, listed: true, status: "setup" },
        { slug: slug("nopoint"), name: "No Point Market", city: "Houston", state: "TX", listed: true },
        { slug: slug("nolng"), name: "No Lng Market", city: "Houston", state: "TX", lat: 29.7, listed: true },
      ],
    });
    const listed = await raw.store.findUniqueOrThrow({ where: { slug: slug("listed") } });
    await asPlatformAdmin((tx) => tx.storeSubscription.create({ data: { storeId: listed.id, plan: "pro", status: "active" } }));
  });

  afterAll(async () => {
    await asPlatformAdmin((tx) => tx.storeSubscription.deleteMany({ where: { store: { slug: { startsWith: "t449-", endsWith: stamp } } } }));
    await raw.store.deleteMany({ where: { slug: { startsWith: "t449-", endsWith: stamp } } });
    await raw.$disconnect();
  });

  it("returns a listed, active store with a point", async () => {
    const mine = (await listDirectoryStores()).filter((s) => s.slug.endsWith(stamp));
    expect(mine.map((s) => s.slug)).toEqual([slug("listed"), slug("noaddress"), slug("starter")]);
    expect(mine[0]).toMatchObject({ name: "Listed Market", city: "Houston", state: "TX", listingBlurb: "Fresh yam every Friday.", ownerName: "Ada" });
  });

  it("says a courier may deliver only where the storefront offers it: registered, full address and phone, Pro plan", async () => {
    const mine = (await listDirectoryStores()).filter((s) => s.slug.endsWith(stamp));
    expect(mine.find((s) => s.slug === slug("listed"))?.courierMayDeliver).toBe(true);
    expect(mine.find((s) => s.slug === slug("noaddress"))?.courierMayDeliver).toBe(false);
    expect(mine.find((s) => s.slug === slug("starter"))?.courierMayDeliver).toBe(false);
  });

  it("never returns unlisted, suspended, unlocated or setup stores (#555)", async () => {
    const slugs = (await listDirectoryStores()).map((s) => s.slug);
    for (const name of ["unlisted", "suspended", "nopoint", "nolng", "setup"]) {
      expect(slugs).not.toContain(slug(name));
    }
  });

  it("returns only the public field list: no Stripe, fee, limit, onboarding or address columns", async () => {
    const [store] = (await listDirectoryStores()).filter((s) => s.slug === slug("listed"));
    expect(Object.keys(store).sort()).toEqual(PUBLIC_FIELDS);
    const leaked = JSON.stringify(store);
    for (const secret of [`acct_t449_${stamp}`, "complete", "12 Hidden St", "77002", "29.76", `uber_t449_${stamp}`, "+17135550449"]) {
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
