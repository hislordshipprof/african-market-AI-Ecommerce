import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const storeA = await prisma.store.upsert({
    where: { slug: "mama-ngozi" },
    update: {},
    create: {
      slug: "mama-ngozi",
      name: "Mama Ngozi African Market",
      brandColor: "#1F5A43",
      themePreset: "palm-and-shea",
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
    },
  });

  await prisma.storeContent.upsert({
    where: { storeId_key: { storeId: storeA.id, key: "hero_text" } },
    update: {},
    create: {
      storeId: storeA.id,
      key: "hero_text",
      value: "Fresh African groceries delivered to your door",
    },
  });

  await prisma.storeContent.upsert({
    where: { storeId_key: { storeId: storeB.id, key: "hero_text" } },
    update: {},
    create: {
      storeId: storeB.id,
      key: "hero_text",
      value: "Caribbean flavors, delivered fresh",
    },
  });

  console.log("Seeded 2 stores: mama-ngozi, tante-marie");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
