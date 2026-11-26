import type { Prisma } from "@prisma/client";

/**
 * The platform's aisles (#861): 16 aisles, each with its subcategories, as the owner approved on 2026-11-25
 * (research/catalog/category-tree.md section 4). Two levels only. A product sits in one subcategory; its
 * aisle is that subcategory's parent.
 *
 * Aisles keep the id of the old aisle whose rows they mostly took, so an id can name a different aisle
 * than it did before #861 (cat_vegetables is Fresh Produce, cat_grains is Fufu, Flours & Swallow).
 */

export type Subcategory = { id: string; name: string; slug: string; localName?: string; photo?: string; taxCode?: string };
export type Aisle = { id: string; name: string; slug: string; localName?: string; photo: string; taxCode: string; subcategories: Subcategory[] };

// Stripe tax codes, checked against GET /v1/tax_codes on 2026-11-25.
const FOOD = "txcd_40040000";
const SNACK_FOODS = "txcd_40070005";
const SOFT_DRINKS = "txcd_41040008";
const COSMETICS = "txcd_32050025";
const GENERAL = "txcd_99999999";
const OTC_DRUGS = "txcd_32020002";
const DIETARY_SUPPLEMENTS = "txcd_40090001";

/** `photo` is a key of src/lib/storefront/catalog-media.json. */
export const AISLES: Aisle[] = [
  {
    id: "cat_tubers", name: "Tubers & Roots", slug: "tubers-and-roots", localName: "ISU · BAYERE", photo: "yam", taxCode: FOOD,
    subcategories: [
      { id: "sub_yam", name: "Yam", slug: "yam", photo: "yam" },
      { id: "sub_cocoyam_taro", name: "Cocoyam & Taro", slug: "cocoyam-and-taro", photo: "cocoyam" },
      { id: "sub_cassava", name: "Cassava", slug: "cassava", photo: "cassava" },
      { id: "sub_sweet_potato_roots", name: "Sweet Potato & Other Roots", slug: "sweet-potato-and-other-roots", photo: "sweet potato" },
    ],
  },
  {
    id: "cat_vegetables", name: "Fresh Produce", slug: "fresh-produce", localName: "EFO · AHIHARA", photo: "scotch bonnet pepper", taxCode: FOOD,
    subcategories: [
      { id: "sub_fresh_vegetables", name: "Vegetables", slug: "fresh-vegetables", photo: "okra" },
      { id: "sub_leafy_greens", name: "Leafy Greens & Wrapping Leaves", slug: "leafy-greens-and-wrapping-leaves", photo: "fluted pumpkin leaves (ugu)" },
      { id: "sub_fresh_peppers_herbs", name: "Fresh Peppers & Herbs", slug: "fresh-peppers-and-herbs", photo: "scotch bonnet pepper" },
      { id: "sub_fresh_fruits", name: "Fruits", slug: "fresh-fruits" },
      { id: "sub_plantain_cooking_bananas", name: "Plantain & Cooking Bananas", slug: "plantain-and-cooking-bananas", photo: "plantain" },
    ],
  },
  {
    id: "cat_grains", name: "Fufu, Flours & Swallow", slug: "fufu-flours-and-swallow", localName: "OKA · AGBADO", photo: "white garri", taxCode: FOOD,
    subcategories: [
      { id: "sub_swallow_flours", name: "Fufu & Swallow Flours", slug: "fufu-and-swallow-flours", photo: "pounded yam flour" },
      { id: "sub_garri_cassava_flour", name: "Garri & Cassava Flour", slug: "garri-and-cassava-flour", photo: "white garri" },
      { id: "sub_maize_meal_ugali", name: "Maize Meal & Ugali", slug: "maize-meal-and-ugali", photo: "semovita" },
      { id: "sub_flours_baking", name: "Flours & Baking", slug: "flours-and-baking", photo: "puff puff mix" },
      { id: "sub_plantain_yam_cocoyam_flours", name: "Plantain, Yam & Cocoyam Flours", slug: "plantain-yam-and-cocoyam-flours", photo: "poundo yam" },
    ],
  },
  {
    id: "cat_beans_legumes", name: "Rice, Grains & Beans", slug: "rice-grains-and-beans", localName: "EWA · WAKE", photo: "ofada rice", taxCode: FOOD,
    subcategories: [
      { id: "sub_rice", name: "Rice", slug: "rice", photo: "ofada rice" },
      { id: "sub_beans_peas", name: "Beans & Peas", slug: "beans-and-peas" },
      { id: "sub_lentils", name: "Lentils", slug: "lentils" },
      { id: "sub_grains_couscous_millet", name: "Grains, Couscous & Millet", slug: "grains-couscous-and-millet" },
    ],
  },
  {
    id: "cat_soup_ingredients", name: "Soup Ingredients", slug: "soup-ingredients", photo: "egusi (melon seeds)", taxCode: FOOD,
    subcategories: [
      { id: "sub_egusi_melon_seeds", name: "Egusi & Melon Seeds", slug: "egusi-and-melon-seeds", photo: "egusi (melon seeds)" },
      { id: "sub_ogbono_thickeners", name: "Ogbono & Thickeners", slug: "ogbono-and-thickeners", photo: "ogbono (wild mango seed)" },
      { id: "sub_dried_leaves_vegetables", name: "Dried Leaves & Vegetables", slug: "dried-leaves-and-vegetables", photo: "bitter leaf" },
      { id: "sub_fermented_seasonings", name: "Fermented Seasonings", slug: "fermented-seasonings", localName: "IRU · OGIRI", photo: "iru (locust bean)" },
      { id: "sub_soup_bases_mixes", name: "Soup Bases & Mixes", slug: "soup-bases-and-mixes" },
    ],
  },
  {
    id: "cat_spices", name: "Spices & Seasonings", slug: "spices-and-seasonings", localName: "OSE · YAJI", photo: "cameroon pepper", taxCode: FOOD,
    subcategories: [
      { id: "sub_whole_spices", name: "Whole Spices", slug: "whole-spices", photo: "ehuru (calabash nutmeg)" },
      { id: "sub_ground_spices", name: "Ground Spices", slug: "ground-spices", photo: "curry powder" },
      { id: "sub_spice_blends_suya", name: "Spice Blends & Suya Spice", slug: "spice-blends-and-suya-spice", photo: "suya spice" },
      { id: "sub_dried_peppers", name: "Dried Peppers & Pepper Powder", slug: "dried-peppers-and-pepper-powder", photo: "cameroon pepper" },
      { id: "sub_stock_cubes_bouillon", name: "Stock Cubes & Bouillon", slug: "stock-cubes-and-bouillon", photo: "maggi cubes" },
    ],
  },
  {
    id: "cat_oils", name: "Oils, Sauces & Condiments", slug: "oils-sauces-and-condiments", localName: "NKWU", photo: "palm oil", taxCode: FOOD,
    subcategories: [
      { id: "sub_palm_oil", name: "Palm Oil", slug: "palm-oil", photo: "palm oil" },
      { id: "sub_cooking_oils", name: "Cooking Oils", slug: "cooking-oils", photo: "groundnut oil" },
      { id: "sub_ghee_cooking_butter", name: "Ghee & Cooking Butter", slug: "ghee-and-cooking-butter" },
      { id: "sub_pepper_sauces_shito", name: "Pepper Sauces & Shito", slug: "pepper-sauces-and-shito" },
      { id: "sub_tomato_paste", name: "Tomato Paste", slug: "tomato-paste", photo: "tomato paste" },
      { id: "sub_sauces_condiments", name: "Sauces & Condiments", slug: "sauces-and-condiments" },
    ],
  },
  {
    id: "cat_fish_meat", name: "Fish & Meat", slug: "fish-and-meat", localName: "EJA · ERAN", photo: "stockfish", taxCode: FOOD,
    subcategories: [
      { id: "sub_dried_smoked_fish", name: "Dried & Smoked Fish", slug: "dried-and-smoked-fish", photo: "dried fish (eja kika)" },
      { id: "sub_stockfish", name: "Stockfish", slug: "stockfish", photo: "stockfish" },
      { id: "sub_crayfish_shrimp_dried", name: "Crayfish & Shrimp (dried)", slug: "dried-crayfish-and-shrimp", photo: "dried crayfish" },
      { id: "sub_dried_meat_ponmo", name: "Dried Meat, Ponmo & Insects", slug: "dried-meat-ponmo-and-insects", photo: "ponmo (cow skin)" },
    ],
  },
  {
    id: "cat_frozen", name: "Frozen", slug: "frozen", photo: "goat meat", taxCode: FOOD,
    subcategories: [
      { id: "sub_frozen_fish_seafood", name: "Frozen Fish & Seafood", slug: "frozen-fish-and-seafood" },
      { id: "sub_frozen_meat_poultry", name: "Frozen Meat & Poultry", slug: "frozen-meat-and-poultry", photo: "goat meat" },
      { id: "sub_frozen_leaves_vegetables", name: "Frozen Leaves & Vegetables", slug: "frozen-leaves-and-vegetables" },
      { id: "sub_frozen_swallow_dough", name: "Frozen Swallow & Dough", slug: "frozen-swallow-and-dough" },
      { id: "sub_frozen_snacks_meals", name: "Frozen Snacks & Ready Meals", slug: "frozen-snacks-and-ready-meals" },
    ],
  },
  {
    id: "cat_canned_packaged", name: "Canned & Packaged", slug: "canned-and-packaged", photo: "tomato paste", taxCode: FOOD,
    subcategories: [
      { id: "sub_canned_fish_meat", name: "Canned Fish & Meat", slug: "canned-fish-and-meat" },
      { id: "sub_canned_vegetables_beans_fruit", name: "Canned Vegetables, Beans & Fruit", slug: "canned-vegetables-beans-and-fruit" },
      { id: "sub_noodles_pasta", name: "Noodles & Pasta", slug: "noodles-and-pasta" },
      { id: "sub_instant_ready_meals", name: "Instant & Ready Meals", slug: "instant-and-ready-meals" },
    ],
  },
  {
    id: "cat_breakfast_dairy", name: "Breakfast & Dairy", slug: "breakfast-and-dairy", photo: "peak milk", taxCode: FOOD,
    subcategories: [
      { id: "sub_cereals_porridge", name: "Cereals & Porridge", slug: "cereals-and-porridge" },
      { id: "sub_pap_ogi_custard", name: "Pap, Ogi & Custard", slug: "pap-ogi-and-custard" },
      { id: "sub_milk_cream", name: "Milk & Cream", slug: "milk-and-cream", photo: "peak milk" },
      { id: "sub_cheese_spreads_sugar", name: "Cheese, Spreads & Sugar", slug: "cheese-spreads-and-sugar" },
      { id: "sub_bread_bakery", name: "Bread & Bakery", slug: "bread-and-bakery" },
    ],
  },
  {
    id: "cat_snacks", name: "Snacks & Sweets", slug: "snacks-and-sweets", localName: "IPANU", photo: "chin chin", taxCode: SNACK_FOODS,
    subcategories: [
      { id: "sub_chips_savoury_snacks", name: "Chips & Savoury Snacks", slug: "chips-and-savoury-snacks", photo: "plantain chips" },
      { id: "sub_biscuits_baked_snacks", name: "Biscuits & Baked Snacks", slug: "biscuits-and-baked-snacks", photo: "chin chin" },
      { id: "sub_sweets_chocolate", name: "Sweets & Chocolate", slug: "sweets-and-chocolate" },
      { id: "sub_nuts_seeds_dried_fruit", name: "Nuts, Seeds & Dried Fruit", slug: "nuts-seeds-and-dried-fruit", photo: "kulikuli (groundnut cake)" },
      { id: "sub_kola_nuts", name: "Kola Nuts", slug: "kola-nuts" },
      { id: "sub_meat_snacks", name: "Meat Snacks", slug: "meat-snacks", localName: "KILISHI · BILTONG" },
    ],
  },
  {
    id: "cat_drinks", name: "Drinks", slug: "drinks", localName: "OMU · ZOBO", photo: "dried hibiscus flowers", taxCode: SOFT_DRINKS,
    subcategories: [
      { id: "sub_soft_drinks_water", name: "Soft Drinks & Water", slug: "soft-drinks-and-water" },
      { id: "sub_malt_cocoa_nutrition", name: "Malt, Cocoa & Nutrition Drinks", slug: "malt-cocoa-and-nutrition-drinks", photo: "malt drink" },
      { id: "sub_juice_cordials", name: "Juice & Cordials", slug: "juice-and-cordials" },
      { id: "sub_tea_coffee", name: "Tea & Coffee", slug: "tea-and-coffee" },
      { id: "sub_traditional_herbal_drinks", name: "Traditional & Herbal Drinks", slug: "traditional-and-herbal-drinks", localName: "ZOBO · SOBOLO", photo: "zobo (hibiscus) drink" },
    ],
  },
  {
    id: "cat_health_wellness", name: "Health & Wellness", slug: "health-and-wellness", photo: "aboniki balm", taxCode: OTC_DRUGS,
    subcategories: [
      { id: "sub_balms_ointments", name: "Balms & Ointments", slug: "balms-and-ointments", photo: "aboniki balm" },
      { id: "sub_bitters_herbal_remedies", name: "Bitters & Herbal Remedies", slug: "bitters-and-herbal-remedies", taxCode: DIETARY_SUPPLEMENTS },
      { id: "sub_natural_remedies", name: "Natural Remedies", slug: "natural-remedies", taxCode: DIETARY_SUPPLEMENTS },
      { id: "sub_vitamins_supplements", name: "Vitamins & Supplements", slug: "vitamins-and-supplements", taxCode: DIETARY_SUPPLEMENTS },
    ],
  },
  {
    id: "cat_beauty", name: "Beauty & Personal Care", slug: "beauty-and-personal-care", photo: "shea butter", taxCode: COSMETICS,
    subcategories: [
      { id: "sub_skin_care_body_creams", name: "Skin Care & Body Creams", slug: "skin-care-and-body-creams" },
      { id: "sub_shea_natural_butters", name: "Shea Butter & Natural Butters", slug: "shea-butter-and-natural-butters", photo: "shea butter" },
      { id: "sub_soap_black_soap", name: "Soap & Black Soap", slug: "soap-and-black-soap" },
      { id: "sub_hair_care", name: "Hair Care", slug: "hair-care" },
      { id: "sub_oral_care_bath_tools", name: "Oral Care & Bath Tools", slug: "oral-care-and-bath-tools" },
      { id: "sub_traditional_body_care", name: "Traditional Body Care & Fragrance", slug: "traditional-body-care-and-fragrance" },
    ],
  },
  {
    id: "cat_household", name: "Household & Kitchen", slug: "household-and-kitchen", photo: "shea butter", taxCode: GENERAL,
    subcategories: [
      { id: "sub_cookware_utensils", name: "Cookware & Utensils", slug: "cookware-and-utensils" },
      { id: "sub_coffee_ceremony", name: "Coffee Ceremony", slug: "coffee-ceremony" },
      { id: "sub_incense_fragrance", name: "Incense & Fragrance", slug: "incense-and-fragrance" },
      { id: "sub_cleaning_laundry", name: "Cleaning & Laundry", slug: "cleaning-and-laundry" },
      { id: "sub_prayer_cultural_items", name: "Prayer & Cultural Items", slug: "prayer-and-cultural-items" },
      { id: "sub_baby", name: "Baby", slug: "baby" },
    ],
  },
];

/** Aisles #861 retired, by id: every row they held moved before they were deleted. */
export const RETIRED_AISLE_IDS = ["cat_pantry", "cat_fruits", "cat_seasonings_sauces"] as const;

/**
 * Old aisle slugs and where they now live; each redirects with a 301. 'tubers', 'spices' and 'oils' are the
 * slugs 20261031000002 created before seed.ts renamed them.
 */
export const OLD_AISLE_SLUGS: Record<string, string> = {
  tubers: "tubers-and-roots",
  spices: "spices-and-seasonings",
  oils: "oils-sauces-and-condiments",
  "oils-and-butters": "oils-sauces-and-condiments",
  "grains-and-flours": "fufu-flours-and-swallow",
  vegetables: "fresh-produce",
  fruits: "fresh-produce",
  "beans-and-legumes": "rice-grains-and-beans",
  "seasonings-and-sauces": "spices-and-seasonings",
  "pantry-staples": "canned-and-packaged",
  snacks: "snacks-and-sweets",
  beauty: "beauty-and-personal-care",
  household: "household-and-kitchen",
};

/**
 * The subcategory a row in an old aisle goes to when nothing more specific names its home: a product
 * outside the master catalogue CSV, a custom listing, a product proposal.
 */
export const OLD_AISLE_DEFAULT_SUBCATEGORY: Record<string, string> = {
  cat_tubers: "sub_yam",
  cat_grains: "sub_flours_baking",
  cat_spices: "sub_whole_spices",
  cat_oils: "sub_cooking_oils",
  cat_vegetables: "sub_fresh_vegetables",
  cat_fish_meat: "sub_dried_smoked_fish",
  cat_frozen: "sub_frozen_leaves_vegetables",
  cat_snacks: "sub_chips_savoury_snacks",
  cat_drinks: "sub_soft_drinks_water",
  cat_beauty: "sub_skin_care_body_creams",
  cat_pantry: "sub_instant_ready_meals",
  cat_beans_legumes: "sub_beans_peas",
  cat_breakfast_dairy: "sub_cereals_porridge",
  cat_canned_packaged: "sub_canned_fish_meat",
  cat_fruits: "sub_fresh_fruits",
  cat_household: "sub_cookware_utensils",
  cat_seasonings_sauces: "sub_stock_cubes_bouillon",
};

export const SUBCATEGORIES: Array<Subcategory & { aisleId: string; taxCode: string }> = AISLES.flatMap((aisle) =>
  aisle.subcategories.map((sub) => ({ ...sub, aisleId: aisle.id, taxCode: sub.taxCode ?? aisle.taxCode })));

const subcategoryBySlug = new Map(SUBCATEGORIES.map((sub) => [sub.slug, sub]));

/** The subcategory id for a master-catalogue CSV `category` cell (a subcategory slug), or null. */
export function subcategoryIdForSlug(slug: string): string | null {
  return subcategoryBySlug.get(slug.trim())?.id ?? null;
}

export type CategoryChoiceRow = { id: string; name: string; parentId: string | null };
export type AisleChoice = { id: string; name: string; subcategories: Array<{ id: string; name: string }> };

/**
 * Categories in sibling order, as the aisles a picker shows with their subcategories under them. A product
 * picks a subcategory, or an aisle that has none (an admin's own aisle).
 */
export function aisleChoices(rows: CategoryChoiceRow[]): AisleChoice[] {
  return rows.filter((row) => !row.parentId).map((aisle) => ({
    id: aisle.id,
    name: aisle.name,
    subcategories: rows.filter((row) => row.parentId === aisle.id).map(({ id, name }) => ({ id, name })),
  }));
}

/** Why a product may not sit in this category, or null (#861): it must exist, and an aisle with subcategories takes none directly. */
export async function productCategoryError(tx: Pick<Prisma.TransactionClient, "category">, categoryId: string): Promise<string | null> {
  const category = await tx.category.findUnique({ where: { id: categoryId }, select: { name: true, _count: { select: { children: true } } } });
  if (!category) return "Choose a category from the list";
  return category._count.children > 0 ? `Choose a subcategory of ${category.name}` : null;
}
