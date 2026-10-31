import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { resolveDirectUrl } from "../src/lib/env";
import { assertNotProduction } from "../src/lib/seed-guard";
import { seedDemoCatalog } from "./seed-demo-catalog";

const adapter = new PrismaPg(resolveDirectUrl());
const prisma = new PrismaClient({ adapter });

async function seedDemoStores() {
  const storeA = await prisma.store.upsert({
    where: { slug: "mama-ngozi" },
    update: {
      ownerName: "Ngozi Okafor",
      ownerStory:
        "Mama Ngozi has been bringing the flavors of home to the community since 2009. What started as a small shop in a strip mall is now the neighborhood’s go-to for authentic Nigerian and West African groceries, spices, and fresh produce.",
      ownerPhotoUrl: "/images/stores/mama-ngozi-owner.jpg",
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
    create: {
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: "#1F5A43",
      themePreset: "palm-and-shea",
      logoUrl: "/logos/mama-ngozi-logo.svg",
      status: "active",
      prepTimeMinutes: 30,
      deliveryRadiusMi: 8,
      minimumOrderCents: 3500,
      pickupEnabled: true,
      autoRefundLimitCents: 2500,
      ownerName: "Ngozi Okafor",
      ownerStory:
        "Mama Ngozi has been bringing the flavors of home to the community since 2009. What started as a small shop in a strip mall is now the neighborhood’s go-to for authentic Nigerian and West African groceries, spices, and fresh produce.",
      ownerPhotoUrl: "/images/stores/mama-ngozi-owner.jpg",
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
      ownerName: "Marie Desrosiers",
      ownerStory:
        "Tante Marie left Port-au-Prince in 1995 with three recipes and a dream. Today her shop is where Atlanta’s Caribbean community finds scotch bonnet peppers, fresh plantains, and the taste of the islands.",
      ownerPhotoUrl: "/images/stores/tante-marie-owner.jpg",
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
      ownerName: "Marie Desrosiers",
      ownerStory:
        "Tante Marie left Port-au-Prince in 1995 with three recipes and a dream. Today her shop is where Atlanta’s Caribbean community finds scotch bonnet peppers, fresh plantains, and the taste of the islands.",
      ownerPhotoUrl: "/images/stores/tante-marie-owner.jpg",
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
    { id: "cat_tubers", name: "Tubers & Roots", slug: "tubers-and-roots", localName: "ISU · BAYERE", imageUrl: "/images/categories/tubers-and-roots.jpg", sortOrder: 1 },
    { id: "cat_grains", name: "Grains & Flours", slug: "grains-and-flours", localName: "OKA · AGBADO", imageUrl: "/images/categories/grains-and-flours.jpg", sortOrder: 2 },
    { id: "cat_spices", name: "Spices & Seasonings", slug: "spices-and-seasonings", localName: "OSE · YAJI", imageUrl: "/images/categories/spices-and-seasonings.jpg", sortOrder: 3 },
    { id: "cat_oils", name: "Oils & Butters", slug: "oils-and-butters", localName: "NKWU · ORI", imageUrl: "/images/categories/oils-and-butters.jpg", sortOrder: 4 },
    { id: "cat_vegetables", name: "Vegetables", slug: "vegetables", localName: "EFO · AHIHARA", imageUrl: "/images/categories/vegetables.jpg", sortOrder: 5 },
    { id: "cat_fish_meat", name: "Fish & Meat", slug: "fish-and-meat", localName: "EJA · ERAN", imageUrl: "/images/categories/fish-and-meat.jpg", sortOrder: 6 },
    { id: "cat_frozen", name: "Frozen", slug: "frozen", localName: "", imageUrl: "/images/categories/frozen.jpg", sortOrder: 7 },
    { id: "cat_snacks", name: "Snacks", slug: "snacks", localName: "IPANU", imageUrl: "/images/categories/snacks.jpg", sortOrder: 8 },
    { id: "cat_drinks", name: "Drinks", slug: "drinks", localName: "OMU · ZOBO", imageUrl: "/images/categories/drinks.jpg", sortOrder: 9 },
    { id: "cat_beauty", name: "Beauty", slug: "beauty", localName: "", imageUrl: "/images/categories/beauty.jpg", sortOrder: 10 },
    { id: "cat_pantry", name: "Pantry Staples", slug: "pantry-staples", localName: "ILE IDANA", imageUrl: "/images/categories/pantry-staples.jpg", sortOrder: 11 },
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
      title: "Fresh yams just landed",
      subtitle: "Direct from Enugu · While stocks last",
      ctaText: "Shop tubers",
      ctaHref: "/categories/tubers-and-roots",
      imageUrl: "/images/banners/mama-ngozi-yams.jpg",
      sortOrder: 0,
    },
    {
      id: "banner_mn_2",
      storeId: storeA.id,
      title: "Soup season is here",
      subtitle: "Everything for egusi, ogbono and ewedu",
      ctaText: "Build your pot",
      ctaHref: "/collections/soup-essentials",
      imageUrl: "/images/banners/mama-ngozi-soup.jpg",
      sortOrder: 1,
    },
    {
      id: "banner_mn_3",
      storeId: storeA.id,
      title: "Free delivery over $75",
      subtitle: "Same-day to your door in Houston",
      ctaText: "Start shopping",
      ctaHref: "/",
      imageUrl: "/images/banners/mama-ngozi-delivery.jpg",
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
      imageUrl: "/images/banners/tante-marie-island.jpg",
      sortOrder: 0,
    },
    {
      id: "banner_tm_2",
      storeId: storeB.id,
      title: "Weekend special: oxtail",
      subtitle: "$12.99/lb this Saturday only",
      ctaText: "See deal",
      ctaHref: "/categories/fish-and-meat",
      imageUrl: "/images/banners/tante-marie-oxtail.jpg",
      sortOrder: 1,
    },
    {
      id: "banner_tm_3",
      storeId: storeB.id,
      title: "New: Caribbean breakfast box",
      subtitle: "Ackee, saltfish, plantain, bammy — feeds 4",
      ctaText: "Order now",
      ctaHref: "/collections/caribbean-breakfast",
      imageUrl: "/images/banners/tante-marie-breakfast.jpg",
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
      imageUrl: "/images/collections/jollof-night.jpg",
      sortOrder: 0,
      listingIds: ["mn_ofada_rice", "mn_tomato_paste", "mn_scotch_bonnet", "mn_palm_oil", "mn_maggi", "mn_curry"],
    },
    {
      id: "coll_mn_soup",
      storeId: storeA.id,
      title: "Soup essentials",
      subtitle: "Egusi, ogbono, ewedu and all the fixings",
      slug: "soup-essentials",
      imageUrl: "/images/collections/soup-essentials.jpg",
      sortOrder: 1,
      listingIds: ["mn_egusi", "mn_ogbono", "mn_ugu", "mn_bitter_leaf", "mn_stockfish", "mn_crayfish", "mn_palm_oil", "mn_iru"],
    },
    {
      id: "coll_mn_stew",
      storeId: storeA.id,
      title: "Sunday stew",
      subtitle: "Build the perfect Nigerian stew from scratch",
      slug: "sunday-stew",
      imageUrl: "/images/collections/sunday-stew.jpg",
      sortOrder: 2,
      listingIds: ["mn_tomato_paste", "mn_scotch_bonnet", "mn_palm_oil", "mn_curry", "mn_thyme", "mn_maggi", "mn_goat_meat"],
    },
    {
      id: "coll_mn_snack",
      storeId: storeA.id,
      title: "Snack run",
      subtitle: "Chin chin, kulikuli and more",
      slug: "snack-run",
      imageUrl: "/images/collections/snack-run.jpg",
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
      imageUrl: "/images/collections/caribbean-breakfast.jpg",
      sortOrder: 0,
      listingIds: ["tm_plantain", "tm_yam", "tm_palm_oil"],
    },
    {
      id: "coll_tm_pepper",
      storeId: storeB.id,
      title: "Pepper pot",
      subtitle: "The hottest picks",
      slug: "pepper-pot",
      imageUrl: "/images/collections/pepper-pot.jpg",
      sortOrder: 1,
      listingIds: ["tm_scotch_bonnet", "tm_cameroon_pepper", "tm_suya"],
    },
    {
      id: "coll_tm_staples",
      storeId: storeB.id,
      title: "Stock up staples",
      subtitle: "Pantry essentials that last",
      slug: "stock-up-staples",
      imageUrl: "/images/collections/stock-up-staples.jpg",
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

async function seedTestAdmin() {
  assertNotProduction(process.env);

  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("SEED_ADMIN_PASSWORD is required when SEED_TEST_ADMIN=1");
  }

  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    throw new Error("BETTER_AUTH_SECRET is required when SEED_TEST_ADMIN=1");
  }

  const totpSecret = process.env.SEED_ADMIN_TOTP_SECRET;
  if (!totpSecret) {
    throw new Error("SEED_ADMIN_TOTP_SECRET is required when SEED_TEST_ADMIN=1");
  }

  const adminId = "seed-platform-admin";
  const adminEmail = "admin@platform.test";
  const hashedPassword = await hashPassword(adminPassword);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { twoFactorEnabled: true },
    create: {
      id: adminId,
      name: "Platform Admin",
      email: adminEmail,
      emailVerified: true,
      role: "platform_admin",
      twoFactorEnabled: true,
      updatedAt: new Date(),
    },
  });

  const existingAccount = await prisma.account.findFirst({
    where: { userId: adminId, providerId: "credential" },
  });
  if (existingAccount) {
    await prisma.account.update({
      where: { id: existingAccount.id },
      data: { password: hashedPassword, updatedAt: new Date() },
    });
  } else {
    await prisma.account.create({
      data: {
        id: "seed-admin-account",
        accountId: adminId,
        providerId: "credential",
        userId: adminId,
        password: hashedPassword,
        updatedAt: new Date(),
      },
    });
  }

  const encryptedSecret = await symmetricEncrypt({
    key: authSecret,
    data: `base32:${totpSecret}`,
  });
  const encryptedBackupCodes = await symmetricEncrypt({
    key: authSecret,
    data: JSON.stringify(["BACKUP1234", "BACKUP5678"]),
  });

  const existingTwoFactor = await prisma.twoFactor.findFirst({
    where: { userId: adminId },
  });
  if (existingTwoFactor) {
    await prisma.twoFactor.update({
      where: { id: existingTwoFactor.id },
      data: { secret: encryptedSecret, backupCodes: encryptedBackupCodes },
    });
  } else {
    await prisma.twoFactor.create({
      data: {
        id: "seed-admin-totp",
        secret: encryptedSecret,
        backupCodes: encryptedBackupCodes,
        userId: adminId,
        verified: true,
      },
    });
  }

  console.log("Seeded test admin: admin@platform.test (2FA enrolled)");

  // Unenrolled admin for 2FA enrollment e2e test
  const unenrolledId = "seed-unenrolled-admin";
  const unenrolledEmail = "unenrolled-admin@platform.test";

  await prisma.$transaction(async (tx) => {
    await tx.twoFactor.deleteMany({ where: { userId: unenrolledId } });

    await tx.user.upsert({
      where: { email: unenrolledEmail },
      update: { twoFactorEnabled: false, updatedAt: new Date() },
      create: {
        id: unenrolledId,
        name: "Unenrolled Admin",
        email: unenrolledEmail,
        emailVerified: true,
        role: "platform_admin",
        twoFactorEnabled: false,
        updatedAt: new Date(),
      },
    });

    const existingUnenrolledAccount = await tx.account.findFirst({
      where: { userId: unenrolledId, providerId: "credential" },
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
          accountId: unenrolledId,
          providerId: "credential",
          userId: unenrolledId,
          password: hashedPassword,
          updatedAt: new Date(),
        },
      });
    }
  });

  console.log("Seeded unenrolled admin: unenrolled-admin@platform.test");
}

async function seedStoreOwner() {
  assertNotProduction(process.env);

  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("SEED_ADMIN_PASSWORD is required when SEED_TEST_ADMIN=1");
  }
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    throw new Error("BETTER_AUTH_SECRET is required when SEED_TEST_ADMIN=1");
  }
  const totpSecret = process.env.SEED_ADMIN_TOTP_SECRET;
  if (!totpSecret) {
    throw new Error("SEED_ADMIN_TOTP_SECRET is required when SEED_TEST_ADMIN=1");
  }

  const ownerId = "seed-store-owner";
  const ownerEmail = "owner@mama-ngozi.test";
  const hashedPassword = await hashPassword(adminPassword);

  await prisma.user.upsert({
    where: { email: ownerEmail },
    update: { twoFactorEnabled: true },
    create: {
      id: ownerId,
      name: "Mama Ngozi Owner",
      email: ownerEmail,
      emailVerified: true,
      role: "user",
      twoFactorEnabled: true,
      updatedAt: new Date(),
    },
  });

  const existingAccount = await prisma.account.findFirst({
    where: { userId: ownerId, providerId: "credential" },
  });
  if (existingAccount) {
    await prisma.account.update({
      where: { id: existingAccount.id },
      data: { password: hashedPassword, updatedAt: new Date() },
    });
  } else {
    await prisma.account.create({
      data: {
        id: "seed-store-owner-account",
        accountId: ownerId,
        providerId: "credential",
        userId: ownerId,
        password: hashedPassword,
        updatedAt: new Date(),
      },
    });
  }

  const encryptedSecret = await symmetricEncrypt({
    key: authSecret,
    data: `base32:${totpSecret}`,
  });
  const encryptedBackupCodes = await symmetricEncrypt({
    key: authSecret,
    data: JSON.stringify(["OWNERBACKUP1", "OWNERBACKUP2"]),
  });

  const existingTwoFactor = await prisma.twoFactor.findFirst({
    where: { userId: ownerId },
  });
  if (existingTwoFactor) {
    await prisma.twoFactor.update({
      where: { id: existingTwoFactor.id },
      data: { secret: encryptedSecret, backupCodes: encryptedBackupCodes },
    });
  } else {
    await prisma.twoFactor.create({
      data: {
        id: "seed-store-owner-totp",
        secret: encryptedSecret,
        backupCodes: encryptedBackupCodes,
        userId: ownerId,
        verified: true,
      },
    });
  }

  const mamaNgozi = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
  if (!mamaNgozi) throw new Error("mama-ngozi store not found; run seedDemoStores first");

  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${mamaNgozi.id}, true)`,
    prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
    prisma.storeMembership.upsert({
      where: { storeId_userId: { storeId: mamaNgozi.id, userId: ownerId } },
      update: { role: "owner" },
      create: { storeId: mamaNgozi.id, userId: ownerId, role: "owner" },
    }),
  ]);

  console.log("Seeded store owner: owner@mama-ngozi.test (2FA enrolled, mama-ngozi owner)");
}

async function main() {
  await seedDemoStores();
  await seedCategoryMetadata();
  await seedDemoCatalog(prisma);
  await seedStoreBanners();
  await seedStoreCollections();

  if (process.env.SEED_TEST_ADMIN === "1") {
    await seedTestAdmin();
    await seedStoreOwner();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
