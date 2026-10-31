import { PrismaClient } from "@prisma/client";

interface CatalogProduct {
  id: string;
  name: string;
  categoryId: string;
  synonyms: { term: string; language?: string }[];
}

interface CatalogListing {
  id: string;
  masterProductId: string;
  customName: string | null;
  price: number;
  stockMode: "counted" | "status";
  qty: number | null;
  status: string | null;
  frozen: boolean;
  perishable: boolean;
  active: boolean;
  variants: {
    id: string;
    label: string;
    price: number;
    weightG: number;
  }[];
}

const PRODUCTS: CatalogProduct[] = [
  {
    id: "mp_yam",
    name: "Yam",
    categoryId: "cat_tubers",
    synonyms: [{ term: "isu", language: "igbo" }, { term: "iyan", language: "yoruba" }],
  },
  {
    id: "mp_plantain",
    name: "Plantain",
    categoryId: "cat_tubers",
    synonyms: [{ term: "dodo", language: "yoruba" }, { term: "boli", language: "yoruba" }],
  },
  {
    id: "mp_garri",
    name: "Garri",
    categoryId: "cat_grains",
    synonyms: [{ term: "gari", language: "yoruba" }, { term: "eba", language: "yoruba" }],
  },
  {
    id: "mp_egusi",
    name: "Egusi (Melon Seeds)",
    categoryId: "cat_grains",
    synonyms: [{ term: "egusi", language: "igbo" }, { term: "agushi", language: "hausa" }],
  },
  {
    id: "mp_ogbono",
    name: "Ogbono (Wild Mango Seed)",
    categoryId: "cat_grains",
    synonyms: [{ term: "ogbono", language: "igbo" }, { term: "apon", language: "yoruba" }],
  },
  {
    id: "mp_suya_spice",
    name: "Suya Spice",
    categoryId: "cat_spices",
    synonyms: [{ term: "yaji", language: "hausa" }],
  },
  {
    id: "mp_dawadawa",
    name: "Locust Bean (Dawadawa)",
    categoryId: "cat_spices",
    synonyms: [{ term: "iru", language: "yoruba" }, { term: "dawadawa", language: "hausa" }, { term: "ogiri", language: "igbo" }],
  },
  {
    id: "mp_palm_oil",
    name: "Palm Oil",
    categoryId: "cat_oils",
    synonyms: [{ term: "zomi", language: "ghanaian" }, { term: "nkwu", language: "igbo" }],
  },
  {
    id: "mp_shea_butter",
    name: "Shea Butter",
    categoryId: "cat_oils",
    synonyms: [{ term: "ori", language: "yoruba" }],
  },
  {
    id: "mp_ugu",
    name: "Fluted Pumpkin Leaves (Ugu)",
    categoryId: "cat_vegetables",
    synonyms: [{ term: "ugu", language: "igbo" }],
  },
  {
    id: "mp_bitter_leaf",
    name: "Bitter Leaf",
    categoryId: "cat_vegetables",
    synonyms: [{ term: "onugbu", language: "igbo" }, { term: "ewuro", language: "yoruba" }],
  },
  {
    id: "mp_stockfish",
    name: "Stockfish",
    categoryId: "cat_fish_meat",
    synonyms: [{ term: "okporoko", language: "igbo" }, { term: "panla", language: "yoruba" }],
  },
  {
    id: "mp_dried_crayfish",
    name: "Dried Crayfish",
    categoryId: "cat_fish_meat",
    synonyms: [{ term: "crayfish" }],
  },
  {
    id: "mp_chin_chin",
    name: "Chin Chin",
    categoryId: "cat_snacks",
    synonyms: [{ term: "chinchilla" }],
  },
  {
    id: "mp_zobo",
    name: "Zobo (Hibiscus) Drink",
    categoryId: "cat_drinks",
    synonyms: [{ term: "zobo", language: "hausa" }, { term: "sobolo", language: "ghanaian" }],
  },
];

function storeListings(storeId: string, prefix: string): CatalogListing[] {
  return [
    // Tubers
    {
      id: `${prefix}_yam`,
      masterProductId: "mp_yam",
      customName: null,
      price: 899,
      stockMode: "counted",
      qty: 25,
      status: null,
      frozen: false,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_yam_v1`, label: "1 tuber (~2 lb)", price: 899, weightG: 907 },
        { id: `${prefix}_yam_v2`, label: "3 tubers (~6 lb)", price: 2399, weightG: 2722 },
      ],
    },
    {
      id: `${prefix}_plantain`,
      masterProductId: "mp_plantain",
      customName: null,
      price: 199,
      stockMode: "counted",
      qty: 50,
      status: null,
      frozen: false,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_plantain_v1`, label: "1 bunch (5 fingers)", price: 499, weightG: 1000 },
        { id: `${prefix}_plantain_v2`, label: "Single", price: 199, weightG: 200 },
      ],
    },
    // Grains & Flours
    {
      id: `${prefix}_garri_white`,
      masterProductId: "mp_garri",
      customName: "White Garri",
      price: 599,
      stockMode: "counted",
      qty: 30,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_garri_w_v1`, label: "1 lb", price: 599, weightG: 454 },
        { id: `${prefix}_garri_w_v2`, label: "5 lb bag", price: 2499, weightG: 2268 },
      ],
    },
    {
      id: `${prefix}_garri_yellow`,
      masterProductId: "mp_garri",
      customName: "Yellow Garri (Ijebu)",
      price: 699,
      stockMode: "counted",
      qty: 18,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_garri_y_v1`, label: "1 lb", price: 699, weightG: 454 },
        { id: `${prefix}_garri_y_v2`, label: "5 lb bag", price: 2999, weightG: 2268 },
      ],
    },
    {
      id: `${prefix}_egusi`,
      masterProductId: "mp_egusi",
      customName: null,
      price: 1099,
      stockMode: "counted",
      qty: 12,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_egusi_v1`, label: "8 oz", price: 1099, weightG: 227 },
        { id: `${prefix}_egusi_v2`, label: "1 lb", price: 1899, weightG: 454 },
        { id: `${prefix}_egusi_v3`, label: "5 lb bag", price: 7999, weightG: 2268 },
      ],
    },
    {
      id: `${prefix}_ogbono`,
      masterProductId: "mp_ogbono",
      customName: null,
      price: 1299,
      stockMode: "counted",
      qty: 8,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_ogbono_v1`, label: "8 oz", price: 1299, weightG: 227 },
        { id: `${prefix}_ogbono_v2`, label: "1 lb", price: 2199, weightG: 454 },
      ],
    },
    // Spices
    {
      id: `${prefix}_suya`,
      masterProductId: "mp_suya_spice",
      customName: null,
      price: 499,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_suya_v1`, label: "4 oz", price: 499, weightG: 113 },
        { id: `${prefix}_suya_v2`, label: "8 oz", price: 899, weightG: 227 },
      ],
    },
    {
      id: `${prefix}_iru`,
      masterProductId: "mp_dawadawa",
      customName: "Iru (Locust Bean)",
      price: 399,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_iru_v1`, label: "4 oz", price: 399, weightG: 113 },
      ],
    },
    // Oils
    {
      id: `${prefix}_palm_oil`,
      masterProductId: "mp_palm_oil",
      customName: null,
      price: 799,
      stockMode: "counted",
      qty: 20,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_palm_v1`, label: "500 ml", price: 799, weightG: 460 },
        { id: `${prefix}_palm_v2`, label: "1 litre", price: 1399, weightG: 920 },
        { id: `${prefix}_palm_v3`, label: "1 gallon", price: 3999, weightG: 3680 },
      ],
    },
    {
      id: `${prefix}_shea`,
      masterProductId: "mp_shea_butter",
      customName: null,
      price: 999,
      stockMode: "counted",
      qty: 3,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_shea_v1`, label: "8 oz jar", price: 999, weightG: 227 },
        { id: `${prefix}_shea_v2`, label: "16 oz jar", price: 1699, weightG: 454 },
      ],
    },
    // Vegetables
    {
      id: `${prefix}_ugu`,
      masterProductId: "mp_ugu",
      customName: "Ugu Leaves",
      price: 499,
      stockMode: "counted",
      qty: 15,
      status: null,
      frozen: true,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_ugu_v1`, label: "8 oz bag (frozen)", price: 499, weightG: 227 },
        { id: `${prefix}_ugu_v2`, label: "1 lb bag (frozen)", price: 899, weightG: 454 },
      ],
    },
    {
      id: `${prefix}_bitter_leaf`,
      masterProductId: "mp_bitter_leaf",
      customName: null,
      price: 599,
      stockMode: "status",
      qty: null,
      status: "low",
      frozen: true,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_bitter_v1`, label: "8 oz bag (frozen)", price: 599, weightG: 227 },
      ],
    },
    // Fish & Meat
    {
      id: `${prefix}_stockfish`,
      masterProductId: "mp_stockfish",
      customName: null,
      price: 2499,
      stockMode: "counted",
      qty: 5,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_stock_v1`, label: "Whole (medium)", price: 2499, weightG: 400 },
        { id: `${prefix}_stock_v2`, label: "Cut pieces (1 lb)", price: 1999, weightG: 454 },
      ],
    },
    {
      id: `${prefix}_crayfish`,
      masterProductId: "mp_dried_crayfish",
      customName: null,
      price: 699,
      stockMode: "counted",
      qty: 0,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_cray_v1`, label: "4 oz", price: 699, weightG: 113 },
        { id: `${prefix}_cray_v2`, label: "8 oz", price: 1199, weightG: 227 },
      ],
    },
    // Snacks
    {
      id: `${prefix}_chin_chin`,
      masterProductId: "mp_chin_chin",
      customName: null,
      price: 599,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_chin_v1`, label: "8 oz bag", price: 599, weightG: 227 },
        { id: `${prefix}_chin_v2`, label: "1 lb bag", price: 999, weightG: 454 },
      ],
    },
    // Drinks
    {
      id: `${prefix}_zobo`,
      masterProductId: "mp_zobo",
      customName: null,
      price: 399,
      stockMode: "counted",
      qty: 40,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_zobo_v1`, label: "500 ml bottle", price: 399, weightG: 500 },
        { id: `${prefix}_zobo_v2`, label: "1 litre bottle", price: 699, weightG: 1000 },
      ],
    },
    // Inactive listing (for e2e test: category excludes inactive)
    {
      id: `${prefix}_inactive_item`,
      masterProductId: "mp_garri",
      customName: "Garri (Seasonal - Unavailable)",
      price: 599,
      stockMode: "status",
      qty: null,
      status: "out_of_stock",
      frozen: false,
      perishable: false,
      active: false,
      variants: [],
    },
  ];
}

export async function seedDemoCatalog(prisma: PrismaClient) {
  if (process.env.VERCEL_ENV === "production") {
    console.log("Skipping demo catalog seed in production");
    return;
  }

  const storeA = await prisma.store.findUnique({ where: { slug: "mama-ngozi" } });
  const storeB = await prisma.store.findUnique({ where: { slug: "tante-marie" } });
  if (!storeA || !storeB) {
    throw new Error("Demo stores must exist before seeding catalog");
  }

  // Seed master products + synonyms (platform admin scope)
  for (const p of PRODUCTS) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.masterProduct.upsert({
        where: { id: p.id },
        update: { name: p.name, categoryId: p.categoryId },
        create: { id: p.id, name: p.name, categoryId: p.categoryId },
      });
      for (const syn of p.synonyms) {
        const synId = `${p.id}_syn_${syn.term.replace(/\s+/g, "_")}`;
        await tx.productSynonym.upsert({
          where: { id: synId },
          update: { term: syn.term, language: syn.language ?? null },
          create: {
            id: synId,
            productId: p.id,
            term: syn.term,
            language: syn.language ?? null,
          },
        });
      }
    });
  }
  console.log(`Seeded ${PRODUCTS.length} master products with synonyms`);

  // Seed listings for each store
  for (const { store, prefix } of [
    { store: storeA, prefix: "mn" },
    { store: storeB, prefix: "tm" },
  ]) {
    const listings = storeListings(store.id, prefix);
    for (const l of listings) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
        await tx.listing.upsert({
          where: { id: l.id },
          update: {
            price: l.price,
            stockMode: l.stockMode,
            qty: l.qty,
            status: l.status,
            frozen: l.frozen,
            perishable: l.perishable,
            active: l.active,
          },
          create: {
            id: l.id,
            storeId: store.id,
            masterProductId: l.masterProductId,
            customName: l.customName,
            price: l.price,
            stockMode: l.stockMode,
            qty: l.qty,
            status: l.status,
            frozen: l.frozen,
            perishable: l.perishable,
            active: l.active,
          },
        });
        for (const v of l.variants) {
          await tx.listingVariant.upsert({
            where: { id: v.id },
            update: { label: v.label, price: v.price, weightG: v.weightG },
            create: {
              id: v.id,
              listingId: l.id,
              label: v.label,
              price: v.price,
              weightG: v.weightG,
            },
          });
        }
      });
    }
    console.log(`Seeded ${listings.length} listings for ${store.slug} (${listings.filter(l => l.active).length} active, ${listings.filter(l => !l.active).length} inactive)`);
  }
}
