import { editorial } from "../src/lib/storefront/editorial";
import { categoryPhotos } from "../src/lib/storefront/catalog";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { resolveDirectUrl } from "../src/lib/env";
import { assertNotProduction } from "../src/lib/seed-guard";
import { seedDemoCatalog } from "./seed-demo-catalog";
import { decideCliCatalogPrune, seedMasterCatalog, type SeedMasterCatalogDeps } from "./seed-master-catalog";
import { readCatalogImageReferences } from "../src/lib/catalog-prune-reader";
import { CatalogPruneRefusal, type DatabaseIdentity } from "../src/lib/catalog-prune";
import { revalidateSeededStores } from "../scripts/revalidate-storefront";

const adapter = new PrismaPg(resolveDirectUrl());
const prisma = new PrismaClient({ adapter });

async function seedDemoStores() {
  const storeA = await prisma.store.upsert({
    where: { slug: "mama-ngozi" },
    update: {
      status: "active",
      ownerName: "Ngozi Okafor",
      ownerStory:
        "Mama Ngozi has been bringing the flavors of home to the community since 2009. What started as a small shop in a strip mall is now the neighborhood’s go-to for authentic Nigerian and West African groceries, spices, and fresh produce.",
      ownerPhotoUrl: null,
      neighborhood: "Parkside, Houston TX",
      deliveryInfo: "Same-day delivery within 8 miles · Pickup ready in 30 min",
      stripeAccountId: null,
      stripeOnboardingStatus: "not_started",
      storeDeliveryEnabled: true,
      storeDeliveryFeeCents: 499,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
      lat: 29.693857800118,
      lng: -95.266257879374,
      timezone: "America/Chicago",
      hours: {
        monday: "9:00 AM - 8:00 PM",
        tuesday: "9:00 AM - 8:00 PM",
        wednesday: "9:00 AM - 8:00 PM",
        thursday: "9:00 AM - 8:00 PM",
        friday: "9:00 AM - 9:00 PM",
        saturday: "8:00 AM - 9:00 PM",
        sunday: "10:00 AM - 6:00 PM",
      },
    },
    create: {
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: "#1F5A43",
      themePreset: "palm-and-shea",
      logoUrl: "/logos/mama-ngozi-logo.svg",
      status: "active",
      prepTimeMinutes: 30,
      deliveryRadiusMi: 8,
      storeDeliveryEnabled: true,
      storeDeliveryFeeCents: 499,
      addressLine1: "8400 Park Place Blvd",
      city: "Houston",
      state: "TX",
      zip: "77017",
      lat: 29.693857800118,
      lng: -95.266257879374,
      minimumOrderCents: 3500,
      pickupEnabled: true,
      autoRefundLimitCents: 2500,
      timezone: "America/Chicago",
      ownerName: "Ngozi Okafor",
      ownerStory:
        "Mama Ngozi has been bringing the flavors of home to the community since 2009. What started as a small shop in a strip mall is now the neighborhood’s go-to for authentic Nigerian and West African groceries, spices, and fresh produce.",
      ownerPhotoUrl: null,
      neighborhood: "Parkside, Houston TX",
      deliveryInfo: "Same-day delivery within 8 miles · Pickup ready in 30 min",
      hours: {
        monday: "9:00 AM - 8:00 PM",
        tuesday: "9:00 AM - 8:00 PM",
        wednesday: "9:00 AM - 8:00 PM",
        thursday: "9:00 AM - 8:00 PM",
        friday: "9:00 AM - 9:00 PM",
        saturday: "8:00 AM - 9:00 PM",
        sunday: "10:00 AM - 6:00 PM",
      },
    },
  });

  const storeB = await prisma.store.upsert({
    where: { slug: "tante-marie" },
    update: {
      status: "active",
      ownerName: "Marie Desrosiers",
      ownerStory:
        "Tante Marie left Port-au-Prince in 1995 with three recipes and a dream. Today her shop is where Atlanta’s Caribbean community finds scotch bonnet peppers, fresh plantains, and the taste of the islands.",
      ownerPhotoUrl: null,
      neighborhood: "Little Caribbean, Atlanta GA",
      deliveryInfo: "Next-day delivery within 6 miles · No pickup",
      stripeAccountId: null,
      stripeOnboardingStatus: "not_started",
      timezone: "America/New_York",
      hours: {
        monday: "10:00 AM - 7:00 PM",
        tuesday: "10:00 AM - 7:00 PM",
        wednesday: "10:00 AM - 7:00 PM",
        thursday: "10:00 AM - 7:00 PM",
        friday: "10:00 AM - 8:00 PM",
        saturday: "9:00 AM - 8:00 PM",
        sunday: "Closed",
      },
    },
    create: {
      slug: "tante-marie",
      name: "Tante Marie Caribbean Grocer",
      brandColor: "#0F4A57",
      themePreset: "lagoon-and-coral",
      logoUrl: "/logos/tante-marie-logo.svg",
      status: "active",
      prepTimeMinutes: 25,
      deliveryRadiusMi: 6,
      minimumOrderCents: 3000,
      pickupEnabled: false,
      autoRefundLimitCents: 2000,
      timezone: "America/New_York",
      ownerName: "Marie Desrosiers",
      ownerStory:
        "Tante Marie left Port-au-Prince in 1995 with three recipes and a dream. Today her shop is where Atlanta’s Caribbean community finds scotch bonnet peppers, fresh plantains, and the taste of the islands.",
      ownerPhotoUrl: null,
      neighborhood: "Little Caribbean, Atlanta GA",
      deliveryInfo: "Next-day delivery within 6 miles · No pickup",
      hours: {
        monday: "10:00 AM - 7:00 PM",
        tuesday: "10:00 AM - 7:00 PM",
        wednesday: "10:00 AM - 7:00 PM",
        thursday: "10:00 AM - 7:00 PM",
        friday: "10:00 AM - 8:00 PM",
        saturday: "9:00 AM - 8:00 PM",
        sunday: "Closed",
      },
    },
  });

  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${storeA.id}, true)`,
    prisma.rlsTestFixture.upsert({
      where: { storeId_key: { storeId: storeA.id, key: "hero_text" } },
      update: {},
      create: {
        storeId: storeA.id,
        key: "hero_text",
        value: "Fresh African groceries delivered to your door",
      },
    }),
  ]);

  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${storeB.id}, true)`,
    prisma.rlsTestFixture.upsert({
      where: { storeId_key: { storeId: storeB.id, key: "hero_text" } },
      update: {},
      create: {
        storeId: storeB.id,
        key: "hero_text",
        value: "Caribbean flavors, delivered fresh",
      },
    }),
  ]);

  console.log("Seeded 2 demo stores: mama-ngozi, tante-marie");
}

async function seedCategoryMetadata() {
  const categories: {
    id: string;
    name: string;
    slug: string;
    localName: string;
    imageUrl: string;
    sortOrder: number;
  }[] = [
    { id: "cat_tubers", name: "Tubers & Roots", slug: "tubers-and-roots", localName: "ISU · BAYERE", imageUrl: categoryPhotos["tubers-and-roots"], sortOrder: 1 },
    { id: "cat_grains", name: "Grains & Flours", slug: "grains-and-flours", localName: "OKA · AGBADO", imageUrl: categoryPhotos["grains-and-flours"], sortOrder: 2 },
    { id: "cat_spices", name: "Spices & Seasonings", slug: "spices-and-seasonings", localName: "OSE · YAJI", imageUrl: categoryPhotos["spices-and-seasonings"], sortOrder: 3 },
    { id: "cat_oils", name: "Oils & Butters", slug: "oils-and-butters", localName: "NKWU · ORI", imageUrl: categoryPhotos["oils-and-butters"], sortOrder: 4 },
    { id: "cat_vegetables", name: "Vegetables", slug: "vegetables", localName: "EFO · AHIHARA", imageUrl: categoryPhotos["vegetables"], sortOrder: 5 },
    { id: "cat_fish_meat", name: "Fish & Meat", slug: "fish-and-meat", localName: "EJA · ERAN", imageUrl: categoryPhotos["fish-and-meat"], sortOrder: 6 },
    { id: "cat_frozen", name: "Frozen", slug: "frozen", localName: "", imageUrl: categoryPhotos.frozen, sortOrder: 7 },
    { id: "cat_snacks", name: "Snacks", slug: "snacks", localName: "IPANU", imageUrl: categoryPhotos["snacks"], sortOrder: 8 },
    { id: "cat_drinks", name: "Drinks", slug: "drinks", localName: "OMU · ZOBO", imageUrl: categoryPhotos["drinks"], sortOrder: 9 },
    { id: "cat_beauty", name: "Beauty", slug: "beauty", localName: "", imageUrl: categoryPhotos.beauty, sortOrder: 10 },
    { id: "cat_pantry", name: "Pantry Staples", slug: "pantry-staples", localName: "ILE IDANA", imageUrl: categoryPhotos["pantry-staples"], sortOrder: 11 },
    { id: "cat_beans_legumes", name: "Beans & Legumes", slug: "beans-and-legumes", localName: "EWA · WAKE", imageUrl: categoryPhotos["grains-and-flours"], sortOrder: 12 },
    { id: "cat_breakfast_dairy", name: "Breakfast & Dairy", slug: "breakfast-and-dairy", localName: "", imageUrl: categoryPhotos["pantry-staples"], sortOrder: 13 },
    { id: "cat_canned_packaged", name: "Canned & Packaged", slug: "canned-and-packaged", localName: "", imageUrl: categoryPhotos["pantry-staples"], sortOrder: 14 },
    { id: "cat_fruits", name: "Fruits", slug: "fruits", localName: "ESO · MANGO", imageUrl: categoryPhotos.vegetables, sortOrder: 15 },
    { id: "cat_household", name: "Household", slug: "household", localName: "", imageUrl: categoryPhotos.beauty, sortOrder: 16 },
    { id: "cat_seasonings_sauces", name: "Seasonings & Sauces", slug: "seasonings-and-sauces", localName: "OBE · DINDIN", imageUrl: categoryPhotos["spices-and-seasonings"], sortOrder: 17 },
  ];

  for (const cat of categories) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.category.upsert({
        where: { id: cat.id },
        update: {
          name: cat.name,
          slug: cat.slug,
          localName: cat.localName || null,
          imageUrl: cat.imageUrl,
          sortOrder: cat.sortOrder,
        },
        create: {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          localName: cat.localName || null,
          imageUrl: cat.imageUrl,
          sortOrder: cat.sortOrder,
        },
      });
    });
  }
  console.log(`Seeded ${categories.length} categories with localName and imageUrl`);
}

async function seedStoreBanners() {
  const storeA = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
  const storeB = await prisma.store.findUnique({ where: { slug: "tante-marie" } });
  if (!storeA || !storeB) throw new Error("Demo stores must exist before seeding banners");

  const banners: {
    id: string;
    storeId: string;
    title: string;
    subtitle: string;
    ctaText: string;
    ctaHref: string;
    imageUrl: string;
    sortOrder: number;
  }[] = [
    // mama-ngozi banners
    {
      id: "banner_mn_1",
      storeId: storeA.id,
      title: "A little closer to home.",
      subtitle: "The ingredients you grew up with. From your neighborhood store to your kitchen.",
      ctaText: "Shop your favorites",
      ctaHref: "/collections/jollof-night",
      imageUrl: editorial.jollof,
      sortOrder: 0,
    },
    {
      id: "banner_mn_2",
      storeId: storeA.id,
      title: "Soup season is here",
      subtitle: "Everything for egusi, ogbono and ewedu",
      ctaText: "Build your pot",
      ctaHref: "/collections/soup-essentials",
      imageUrl: editorial.spices,
      sortOrder: 1,
    },
    {
      id: "banner_mn_3",
      storeId: storeA.id,
      title: "Free delivery over $75",
      subtitle: "Same-day to your door in Houston",
      ctaText: "Start shopping",
      ctaHref: "/",
      imageUrl: editorial.market,
      sortOrder: 2,
    },
    // tante-marie banners
    {
      id: "banner_tm_1",
      storeId: storeB.id,
      title: "Island flavors, Atlanta prices",
      subtitle: "Scotch bonnet · Plantain · Callaloo",
      ctaText: "Browse all",
      ctaHref: "/",
      imageUrl: editorial.market,
      sortOrder: 0,
    },
    {
      id: "banner_tm_2",
      storeId: storeB.id,
      title: "Weekend special: oxtail",
      subtitle: "$12.99/lb this Saturday only",
      ctaText: "See deal",
      ctaHref: "/categories/fish-and-meat",
      imageUrl: editorial.fish,
      sortOrder: 1,
    },
    {
      id: "banner_tm_3",
      storeId: storeB.id,
      title: "New: Caribbean breakfast box",
      subtitle: "Ackee, saltfish, plantain, bammy — feeds 4",
      ctaText: "Order now",
      ctaHref: "/collections/caribbean-breakfast",
      imageUrl: editorial.jollof,
      sortOrder: 2,
    },
  ];

  for (const b of banners) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${b.storeId}, true)`;
      await tx.storeBanner.upsert({
        where: { id: b.id },
        update: {
          title: b.title,
          subtitle: b.subtitle,
          ctaText: b.ctaText,
          ctaHref: b.ctaHref,
          imageUrl: b.imageUrl,
          sortOrder: b.sortOrder,
          active: true,
        },
        create: {
          id: b.id,
          storeId: b.storeId,
          title: b.title,
          subtitle: b.subtitle,
          ctaText: b.ctaText,
          ctaHref: b.ctaHref,
          imageUrl: b.imageUrl,
          sortOrder: b.sortOrder,
          active: true,
        },
      });
    });
  }
  console.log(`Seeded ${banners.length} store banners`);
}

async function seedStoreCollections() {
  const storeA = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
  const storeB = await prisma.store.findUnique({ where: { slug: "tante-marie" } });
  if (!storeA || !storeB) throw new Error("Demo stores must exist before seeding collections");

  const collections: {
    id: string;
    storeId: string;
    title: string;
    subtitle: string;
    slug: string;
    imageUrl: string;
    sortOrder: number;
    listingIds: string[];
  }[] = [
    // mama-ngozi collections
    {
      id: "coll_mn_jollof",
      storeId: storeA.id,
      title: "Jollof night",
      subtitle: "Everything for the perfect pot",
      slug: "jollof-night",
      imageUrl: editorial.jollof,
      sortOrder: 0,
      listingIds: ["mn_ofada_rice", "mn_tomato_paste", "mn_scotch_bonnet", "mn_palm_oil", "mn_maggi", "mn_curry"],
    },
    {
      id: "coll_mn_soup",
      storeId: storeA.id,
      title: "Soup essentials",
      subtitle: "Egusi, ogbono, ewedu and all the fixings",
      slug: "soup-essentials",
      imageUrl: editorial.spices,
      sortOrder: 1,
      listingIds: ["mn_egusi", "mn_ogbono", "mn_ugu", "mn_bitter_leaf", "mn_stockfish", "mn_crayfish", "mn_palm_oil", "mn_iru"],
    },
    {
      id: "coll_mn_stew",
      storeId: storeA.id,
      title: "Sunday stew",
      subtitle: "Build the perfect Nigerian stew from scratch",
      slug: "sunday-stew",
      imageUrl: editorial.spices,
      sortOrder: 2,
      listingIds: ["mn_tomato_paste", "mn_scotch_bonnet", "mn_palm_oil", "mn_curry", "mn_thyme", "mn_maggi", "mn_goat_meat"],
    },
    {
      id: "coll_mn_snack",
      storeId: storeA.id,
      title: "Snack run",
      subtitle: "Chin chin, kulikuli and more",
      slug: "snack-run",
      imageUrl: categoryPhotos.snacks,
      sortOrder: 3,
      listingIds: ["mn_chin_chin", "mn_plantain_chips", "mn_kulikuli", "mn_puff_puff_mix", "mn_zobo", "mn_malt"],
    },
    // tante-marie collections
    {
      id: "coll_tm_breakfast",
      storeId: storeB.id,
      title: "Caribbean breakfast",
      subtitle: "Start the morning island-style",
      slug: "caribbean-breakfast",
      imageUrl: editorial.jollof,
      sortOrder: 0,
      listingIds: ["tm_plantain", "tm_yam", "tm_palm_oil"],
    },
    {
      id: "coll_tm_pepper",
      storeId: storeB.id,
      title: "Pepper pot",
      subtitle: "The hottest picks",
      slug: "pepper-pot",
      imageUrl: editorial.spices,
      sortOrder: 1,
      listingIds: ["tm_scotch_bonnet", "tm_cameroon_pepper", "tm_suya"],
    },
    {
      id: "coll_tm_staples",
      storeId: storeB.id,
      title: "Stock up staples",
      subtitle: "Pantry essentials that last",
      slug: "stock-up-staples",
      imageUrl: editorial.grains,
      sortOrder: 2,
      listingIds: ["tm_garri_white", "tm_ofada_rice", "tm_palm_oil", "tm_maggi", "tm_peak_milk", "tm_tomato_paste"],
    },
  ];

  for (const c of collections) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${c.storeId}, true)`;
      await tx.storeCollection.upsert({
        where: { storeId_slug: { storeId: c.storeId, slug: c.slug } },
        update: {
          title: c.title,
          subtitle: c.subtitle,
          imageUrl: c.imageUrl,
          sortOrder: c.sortOrder,
          active: true,
        },
        create: {
          id: c.id,
          storeId: c.storeId,
          title: c.title,
          subtitle: c.subtitle,
          imageUrl: c.imageUrl,
          slug: c.slug,
          sortOrder: c.sortOrder,
          active: true,
        },
      });
    });

    // Seed collection-listing associations
    const collection = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${c.storeId}, true)`;
      return tx.storeCollection.findFirst({
        where: { storeId: c.storeId, slug: c.slug },
        select: { id: true },
      });
    });
    if (!collection) continue;

    for (let i = 0; i < c.listingIds.length; i++) {
      const listingId = c.listingIds[i];
      const itemId = `${c.id}_item_${i}`;
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${c.storeId}, true)`;

        const existing = await tx.storeCollectionListing.findUnique({
          where: {
            collectionId_listingId: {
              collectionId: collection.id,
              listingId,
            },
          },
        });
        if (!existing) {
          await tx.storeCollectionListing.create({
            data: {
              id: itemId,
              collectionId: collection.id,
              listingId,
              sortOrder: i,
            },
          });
        }
      });
    }
  }
  console.log(`Seeded ${collections.length} store collections with listing associations`);
}

interface SeedUserOptions {
  name: string;
  email: string;
  role: string;
  /** Used only when the user is created; an existing user keeps its own id. */
  id: string;
  password: string;
  authSecret: string;
  totpSecret: string;
  backupCodes: string[];
  /** Ids used only when the account/twoFactor rows are created. */
  accountId: string;
  twoFactorId: string;
}

function requireSeedAuthEnv() {
  assertNotProduction(process.env);

  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) throw new Error("SEED_ADMIN_PASSWORD is required when SEED_TEST_ADMIN=1");
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) throw new Error("BETTER_AUTH_SECRET is required when SEED_TEST_ADMIN=1");
  const totpSecret = process.env.SEED_ADMIN_TOTP_SECRET;
  if (!totpSecret) throw new Error("SEED_ADMIN_TOTP_SECRET is required when SEED_TEST_ADMIN=1");
  return { password, authSecret, totpSecret };
}

/**
 * Upserts a user with a credential account and enrolled 2FA. Every dependent
 * write uses the id of the user the upsert returned, so a user that already
 * exists under a different id never causes a foreign-key failure.
 */
async function seedUserWith2FA(opts: SeedUserOptions) {
  const hashedPassword = await hashPassword(opts.password);

  const user = await prisma.user.upsert({
    where: { email: opts.email },
    update: { twoFactorEnabled: true },
    create: {
      id: opts.id,
      name: opts.name,
      email: opts.email,
      emailVerified: true,
      role: opts.role,
      twoFactorEnabled: true,
      updatedAt: new Date(),
    },
  });

  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
  });
  if (existingAccount) {
    await prisma.account.update({
      where: { id: existingAccount.id },
      data: { password: hashedPassword, updatedAt: new Date() },
    });
  } else {
    await prisma.account.create({
      data: {
        id: opts.accountId,
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: hashedPassword,
        updatedAt: new Date(),
      },
    });
  }

  const encryptedSecret = await symmetricEncrypt({
    key: opts.authSecret,
    data: `base32:${opts.totpSecret}`,
  });
  const encryptedBackupCodes = await symmetricEncrypt({
    key: opts.authSecret,
    data: JSON.stringify(opts.backupCodes),
  });

  const existingTwoFactor = await prisma.twoFactor.findFirst({
    where: { userId: user.id },
  });
  if (existingTwoFactor) {
    await prisma.twoFactor.update({
      where: { id: existingTwoFactor.id },
      data: { secret: encryptedSecret, backupCodes: encryptedBackupCodes },
    });
  } else {
    await prisma.twoFactor.create({
      data: {
        id: opts.twoFactorId,
        secret: encryptedSecret,
        backupCodes: encryptedBackupCodes,
        userId: user.id,
        verified: true,
      },
    });
  }

  return user;
}

async function seedTestAdmin() {
  const { password, authSecret, totpSecret } = requireSeedAuthEnv();

  await seedUserWith2FA({
    id: "seed-platform-admin",
    name: "Platform Admin",
    email: "admin@platform.test",
    role: "platform_admin",
    password,
    authSecret,
    totpSecret,
    backupCodes: ["BACKUP1234", "BACKUP5678"],
    accountId: "seed-admin-account",
    twoFactorId: "seed-admin-totp",
  });

  console.log("Seeded test admin: admin@platform.test (2FA enrolled)");

  // Unenrolled admin for 2FA enrollment e2e test. It has a credential account
  // but no 2FA, so it does not share the helper's enrolled-user flow.
  const unenrolledEmail = "unenrolled-admin@platform.test";
  const hashedPassword = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const unenrolled = await tx.user.upsert({
      where: { email: unenrolledEmail },
      update: { twoFactorEnabled: false, updatedAt: new Date() },
      create: {
        id: "seed-unenrolled-admin",
        name: "Unenrolled Admin",
        email: unenrolledEmail,
        emailVerified: true,
        role: "platform_admin",
        twoFactorEnabled: false,
        updatedAt: new Date(),
      },
    });

    await tx.twoFactor.deleteMany({ where: { userId: unenrolled.id } });

    const existingUnenrolledAccount = await tx.account.findFirst({
      where: { userId: unenrolled.id, providerId: "credential" },
    });
    if (existingUnenrolledAccount) {
      await tx.account.update({
        where: { id: existingUnenrolledAccount.id },
        data: { password: hashedPassword, updatedAt: new Date() },
      });
    } else {
      await tx.account.create({
        data: {
          id: "seed-unenrolled-account",
          accountId: unenrolled.id,
          providerId: "credential",
          userId: unenrolled.id,
          password: hashedPassword,
          updatedAt: new Date(),
        },
      });
    }
  });

  console.log("Seeded unenrolled admin: unenrolled-admin@platform.test");
}

async function seedStoreOwner() {
  const { password, authSecret, totpSecret } = requireSeedAuthEnv();

  const owner = await seedUserWith2FA({
    id: "seed-store-owner",
    name: "Mama Ngozi Owner",
    email: "owner@mama-ngozi.test",
    role: "user",
    password,
    authSecret,
    totpSecret,
    backupCodes: ["OWNERBACKUP1", "OWNERBACKUP2"],
    accountId: "seed-store-owner-account",
    twoFactorId: "seed-store-owner-totp",
  });

  const mamaNgozi = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
  if (!mamaNgozi) throw new Error("mama-ngozi store not found; run seedDemoStores first");

  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${mamaNgozi.id}, true)`,
    prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
    prisma.storeMembership.upsert({
      where: { storeId_userId: { storeId: mamaNgozi.id, userId: owner.id } },
      update: { role: "owner" },
      create: { storeId: mamaNgozi.id, userId: owner.id, role: "owner" },
    }),
  ]);

  console.log("Seeded store owner: owner@mama-ngozi.test (2FA enrolled, mama-ngozi owner)");
}

async function seedDemoOrders() {
  const store = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
  if (!store) throw new Error("mama-ngozi must exist before seeding orders");

  const variants = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
    return tx.listingVariant.findMany({
      where: { listing: { storeId: store.id } },
      include: { listing: { select: { frozen: true, perishable: true, customName: true } } },
      take: 6,
    });
  });
  if (variants.length < 3) {
    console.log("Skipping order seed: not enough listing variants");
    return;
  }

  const customer = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
    const existing = await tx.customer.findFirst({
      where: { storeId: store.id, email: "demo-customer@example.com" },
    });
    if (existing) return existing;
    return tx.customer.create({
      data: {
        storeId: store.id,
        name: "Adaeze Chukwu",
        email: "demo-customer@example.com",
        phone: "+17135551234",
      },
    });
  });

  const demoOrders = [
    { id: "seed-order-1", number: 1001, status: "AUTHORIZED", lines: [0, 1, 2] },
    { id: "seed-order-2", number: 1002, status: "ACCEPTED", lines: [1, 3] },
    { id: "seed-order-3", number: 1003, status: "PICKING", lines: [0, 2, 4 % variants.length] },
    { id: "seed-order-4", number: 1004, status: "AWAITING_PICKUP", lines: [3 % variants.length, 5 % variants.length] },
    { id: "seed-order-5", number: 1005, status: "PICKING", lines: [1, 3] },
  ];

  for (const demo of demoOrders) {
    const lineVariants = demo.lines.map((i) => variants[i % variants.length]);
    const subtotal = lineVariants.reduce((s, v) => s + v.price * 2, 0);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;

      const existing = await tx.order.findUnique({ where: { id: demo.id } });
      if (existing) {
        await tx.orderLine.deleteMany({ where: { orderId: demo.id } });
        await tx.order.delete({ where: { id: demo.id } });
      }

      await tx.order.create({
        data: {
          id: demo.id,
          storeId: store.id,
          number: demo.number,
          customerId: customer.id,
          status: demo.status,
          fulfillment: "pickup",
          subtotalCents: subtotal,
          bufferCents: Math.round(subtotal * 0.1),
          totalAuthorizedCents: subtotal + Math.round(subtotal * 0.1),
          totalCents: subtotal,
          paymentIntentId: `pi_seed_${demo.id}`,
          acceptedAt: ["ACCEPTED", "PICKING", "AWAITING_PICKUP"].includes(demo.status) ? new Date() : null,
          prepEstimateMinutes: ["ACCEPTED", "PICKING", "AWAITING_PICKUP"].includes(demo.status) ? 25 : null,
          readyAt: demo.status === "AWAITING_PICKUP" ? new Date() : null,
        },
      });

      for (let li = 0; li < lineVariants.length; li++) {
        const v = lineVariants[li];
        const isPicked = demo.status === "AWAITING_PICKUP" || (demo.status === "PICKING" && li === 0);
        await tx.orderLine.create({
          data: {
            storeId: store.id,
            orderId: demo.id,
            listingVariantId: v.id,
            qtyOrdered: 2,
            unitPriceCents: v.price,
            qtyPicked: isPicked ? 2 : 0,
            status: isPicked ? "picked" : "pending",
          },
        });
      }
    });
  }

  console.log(`Seeded ${demoOrders.length} demo orders for mama-ngozi`);
}

async function observeSeedConnection(): Promise<DatabaseIdentity> {
  const rows = await prisma.$queryRaw<Array<{ database: string; host: string; port: string }>>`
    SELECT current_database() AS database,
           COALESCE(host(inet_server_addr()), '127.0.0.1') AS host,
           inet_server_port()::text AS port
  `;
  const row = rows[0];
  if (!row?.database || !row.host || !row.port) {
    throw new CatalogPruneRefusal("Refusing catalog prune: the effective database connection was not observed");
  }
  return { host: row.host, port: String(row.port), database: row.database };
}

export async function runSeed(deps: SeedMasterCatalogDeps = {}) {
  const execution = deps.execution ?? { kind: "cli" as const };
  let priorReferences: string[] = [];
  if (execution.kind === "cli") {
    const decision = await decideCliCatalogPrune(process.env, () => observeSeedConnection());
    if ("refused" in decision) throw new CatalogPruneRefusal(decision.refused);
    if (decision.mode !== "off") {
      priorReferences = (await readCatalogImageReferences()).references;
    }
  } else if (execution.mode !== "off") {
    priorReferences = (await readCatalogImageReferences()).references;
  }

  await seedDemoStores();
  await seedCategoryMetadata();
  await seedDemoCatalog(prisma);
  await seedStoreBanners();
  await seedStoreCollections();

  await seedMasterCatalog(prisma, { ...deps, execution, priorReferences });

  if (process.env.SEED_TEST_ADMIN === "1") {
    await seedTestAdmin();
    await seedStoreOwner();
    await seedDemoOrders();
  }
  await revalidateSeededStores(await prisma.store.findMany({ where: { slug: { in: ["mama-ngozi", "tante-marie"] } }, select: { id: true, slug: true } }));
}

export { prisma as seedPrisma };

if (process.env.VITEST !== "true") {
  runSeed()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
