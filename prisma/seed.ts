import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionUrl =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL!;
const adapter = new PrismaPg(connectionUrl);
const prisma = new PrismaClient({ adapter });

async function main() {
  const storeA = await prisma.store.upsert({
    where: { slug: "mama-ngozi" },
    update: {},
    create: {
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: "#1F5A43",
      themePreset: "palm-and-shea",
      logoUrl: "/logos/mama-ngozi-logo.svg",
    },
  });

  const storeB = await prisma.store.upsert({
    where: { slug: "tante-marie" },
    update: {},
    create: {
      slug: "tante-marie",
      name: "Tante Marie Caribbean Grocer",
      brandColor: "#0F4A57",
      themePreset: "lagoon-and-coral",
      logoUrl: "/logos/tante-marie-logo.svg",
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

  console.log("Seeded 2 stores: mama-ngozi, tante-marie");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
