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
  // --- Tubers ---
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
    id: "mp_cassava",
    name: "Cassava",
    categoryId: "cat_tubers",
    synonyms: [{ term: "akpu", language: "igbo" }, { term: "ege", language: "yoruba" }],
  },
  {
    id: "mp_cocoyam",
    name: "Cocoyam",
    categoryId: "cat_tubers",
    synonyms: [{ term: "ede", language: "igbo" }, { term: "koko", language: "yoruba" }],
  },
  {
    id: "mp_sweet_potato",
    name: "Sweet Potato",
    categoryId: "cat_tubers",
    synonyms: [{ term: "anamo", language: "igbo" }, { term: "odunkun", language: "yoruba" }],
  },
  // --- Grains & Flours ---
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
    id: "mp_semovita",
    name: "Semovita",
    categoryId: "cat_grains",
    synonyms: [{ term: "semo", language: "yoruba" }, { term: "semolina" }],
  },
  {
    id: "mp_pounded_yam_flour",
    name: "Pounded Yam Flour",
    categoryId: "cat_grains",
    synonyms: [{ term: "poundo yam" }, { term: "iyan" }],
  },
  {
    id: "mp_ofada_rice",
    name: "Ofada Rice",
    categoryId: "cat_grains",
    synonyms: [{ term: "ofada", language: "yoruba" }, { term: "unpolished rice" }],
  },
  {
    id: "mp_jollof_seasoning",
    name: "Jollof Rice Seasoning",
    categoryId: "cat_spices",
    synonyms: [{ term: "jollof mix" }, { term: "party rice seasoning" }],
  },
  // --- Spices & Seasonings ---
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
    id: "mp_cameroon_pepper",
    name: "Cameroon Pepper",
    categoryId: "cat_spices",
    synonyms: [{ term: "ata rodo" }, { term: "dried pepper" }],
  },
  {
    id: "mp_ground_crayfish",
    name: "Ground Crayfish",
    categoryId: "cat_spices",
    synonyms: [{ term: "ground crayfish powder" }],
  },
  {
    id: "mp_curry_powder",
    name: "Curry Powder",
    categoryId: "cat_spices",
    synonyms: [{ term: "curry" }],
  },
  {
    id: "mp_thyme",
    name: "Thyme",
    categoryId: "cat_spices",
    synonyms: [{ term: "dried thyme" }],
  },
  {
    id: "mp_ehuru",
    name: "Ehuru (Calabash Nutmeg)",
    categoryId: "cat_spices",
    synonyms: [{ term: "ehuru", language: "igbo" }, { term: "ariwo", language: "yoruba" }],
  },
  // --- Oils & Butters ---
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
    id: "mp_groundnut_oil",
    name: "Groundnut Oil",
    categoryId: "cat_oils",
    synonyms: [{ term: "peanut oil" }, { term: "man gyada", language: "hausa" }],
  },
  {
    id: "mp_coconut_oil",
    name: "Coconut Oil",
    categoryId: "cat_oils",
    synonyms: [{ term: "adi agbon", language: "yoruba" }],
  },
  // --- Vegetables ---
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
    id: "mp_ewedu",
    name: "Ewedu (Jute Leaves)",
    categoryId: "cat_vegetables",
    synonyms: [{ term: "ewedu", language: "yoruba" }, { term: "ahingbara", language: "igbo" }],
  },
  {
    id: "mp_waterleaf",
    name: "Waterleaf",
    categoryId: "cat_vegetables",
    synonyms: [{ term: "gbure", language: "yoruba" }, { term: "mmong ikong", language: "efik" }],
  },
  {
    id: "mp_okra",
    name: "Okra",
    categoryId: "cat_vegetables",
    synonyms: [{ term: "okro" }, { term: "ila", language: "yoruba" }, { term: "kubewa", language: "hausa" }],
  },
  {
    id: "mp_scotch_bonnet",
    name: "Scotch Bonnet Pepper",
    categoryId: "cat_vegetables",
    synonyms: [{ term: "ata rodo", language: "yoruba" }, { term: "ose oyibo", language: "igbo" }],
  },
  {
    id: "mp_garden_eggs",
    name: "Garden Eggs",
    categoryId: "cat_vegetables",
    synonyms: [{ term: "african eggplant" }, { term: "igba", language: "yoruba" }, { term: "anara", language: "igbo" }],
  },
  // --- Fish & Meat ---
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
    id: "mp_dried_fish",
    name: "Dried Fish (Eja Kika)",
    categoryId: "cat_fish_meat",
    synonyms: [{ term: "eja kika", language: "yoruba" }, { term: "azu oku", language: "igbo" }],
  },
  {
    id: "mp_goat_meat",
    name: "Goat Meat",
    categoryId: "cat_fish_meat",
    synonyms: [{ term: "eran ewure", language: "yoruba" }, { term: "anu ewu", language: "igbo" }],
  },
  {
    id: "mp_oxtail",
    name: "Oxtail",
    categoryId: "cat_fish_meat",
    synonyms: [{ term: "iru eran" }],
  },
  {
    id: "mp_cow_foot",
    name: "Cow Foot",
    categoryId: "cat_fish_meat",
    synonyms: [{ term: "ese eran", language: "yoruba" }, { term: "nkwobi" }],
  },
  {
    id: "mp_ponmo",
    name: "Ponmo (Cow Skin)",
    categoryId: "cat_fish_meat",
    synonyms: [{ term: "ponmo", language: "yoruba" }, { term: "kpomo" }, { term: "kanda" }],
  },
  // --- Snacks ---
  {
    id: "mp_chin_chin",
    name: "Chin Chin",
    categoryId: "cat_snacks",
    synonyms: [{ term: "chinchilla" }],
  },
  {
    id: "mp_puff_puff_mix",
    name: "Puff Puff Mix",
    categoryId: "cat_snacks",
    synonyms: [{ term: "puff puff" }, { term: "bofrot", language: "ghanaian" }],
  },
  {
    id: "mp_plantain_chips",
    name: "Plantain Chips",
    categoryId: "cat_snacks",
    synonyms: [{ term: "dodo chips" }, { term: "banana chips" }],
  },
  {
    id: "mp_kulikuli",
    name: "Kulikuli (Groundnut Cake)",
    categoryId: "cat_snacks",
    synonyms: [{ term: "kulikuli", language: "yoruba" }, { term: "kuli kuli" }],
  },
  // --- Drinks ---
  {
    id: "mp_zobo",
    name: "Zobo (Hibiscus) Drink",
    categoryId: "cat_drinks",
    synonyms: [{ term: "zobo", language: "hausa" }, { term: "sobolo", language: "ghanaian" }],
  },
  {
    id: "mp_malt_drink",
    name: "Malt Drink",
    categoryId: "cat_drinks",
    synonyms: [{ term: "malta" }, { term: "amstel malta" }, { term: "maltina" }],
  },
  {
    id: "mp_hibiscus_dried",
    name: "Dried Hibiscus Flowers",
    categoryId: "cat_drinks",
    synonyms: [{ term: "zobo leaves" }, { term: "bissap", language: "wolof" }],
  },
  // --- Pantry Staples ---
  {
    id: "mp_tomato_paste",
    name: "Tomato Paste",
    categoryId: "cat_pantry",
    synonyms: [{ term: "tin tomato" }, { term: "tomato puree" }],
  },
  {
    id: "mp_maggi_cubes",
    name: "Maggi Cubes",
    categoryId: "cat_pantry",
    synonyms: [{ term: "seasoning cubes" }, { term: "knorr" }, { term: "star maggi" }],
  },
  {
    id: "mp_peak_milk",
    name: "Peak Milk",
    categoryId: "cat_pantry",
    synonyms: [{ term: "evaporated milk" }, { term: "peak" }, { term: "carnation" }],
  },
];

function storeListings(storeId: string, prefix: string): CatalogListing[] {
  return [
    // --- Tubers ---
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
    {
      id: `${prefix}_cassava`,
      masterProductId: "mp_cassava",
      customName: null,
      price: 599,
      stockMode: "counted",
      qty: 15,
      status: null,
      frozen: false,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_cassava_v1`, label: "1 piece (~1.5 lb)", price: 599, weightG: 680 },
        { id: `${prefix}_cassava_v2`, label: "3 pieces (~4.5 lb)", price: 1499, weightG: 2040 },
      ],
    },
    {
      id: `${prefix}_cocoyam`,
      masterProductId: "mp_cocoyam",
      customName: null,
      price: 449,
      stockMode: "counted",
      qty: 20,
      status: null,
      frozen: false,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_cocoyam_v1`, label: "1 lb", price: 449, weightG: 454 },
      ],
    },
    {
      id: `${prefix}_sweet_potato`,
      masterProductId: "mp_sweet_potato",
      customName: null,
      price: 349,
      stockMode: "counted",
      qty: 30,
      status: null,
      frozen: false,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_sweet_potato_v1`, label: "1 lb", price: 349, weightG: 454 },
        { id: `${prefix}_sweet_potato_v2`, label: "3 lb bag", price: 899, weightG: 1362 },
      ],
    },
    // --- Grains & Flours ---
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
    {
      id: `${prefix}_semovita`,
      masterProductId: "mp_semovita",
      customName: null,
      price: 499,
      stockMode: "counted",
      qty: 25,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_semo_v1`, label: "2 lb bag", price: 499, weightG: 907 },
        { id: `${prefix}_semo_v2`, label: "10 lb bag", price: 1999, weightG: 4536 },
      ],
    },
    {
      id: `${prefix}_pounded_yam`,
      masterProductId: "mp_pounded_yam_flour",
      customName: "Poundo Yam",
      price: 699,
      stockMode: "counted",
      qty: 20,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_poundo_v1`, label: "2 lb bag", price: 699, weightG: 907 },
        { id: `${prefix}_poundo_v2`, label: "5 lb bag", price: 1499, weightG: 2268 },
      ],
    },
    {
      id: `${prefix}_ofada_rice`,
      masterProductId: "mp_ofada_rice",
      customName: null,
      price: 899,
      stockMode: "counted",
      qty: 15,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_ofada_v1`, label: "2 lb", price: 899, weightG: 907 },
        { id: `${prefix}_ofada_v2`, label: "10 lb bag", price: 3599, weightG: 4536 },
      ],
    },
    // --- Spices & Seasonings ---
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
    {
      id: `${prefix}_cameroon_pepper`,
      masterProductId: "mp_cameroon_pepper",
      customName: null,
      price: 599,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_cameroon_v1`, label: "4 oz", price: 599, weightG: 113 },
        { id: `${prefix}_cameroon_v2`, label: "8 oz", price: 999, weightG: 227 },
      ],
    },
    {
      id: `${prefix}_ground_crayfish`,
      masterProductId: "mp_ground_crayfish",
      customName: null,
      price: 799,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_gcray_v1`, label: "4 oz", price: 799, weightG: 113 },
        { id: `${prefix}_gcray_v2`, label: "8 oz", price: 1399, weightG: 227 },
      ],
    },
    {
      id: `${prefix}_curry`,
      masterProductId: "mp_curry_powder",
      customName: null,
      price: 299,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_curry_v1`, label: "3 oz", price: 299, weightG: 85 },
      ],
    },
    {
      id: `${prefix}_thyme`,
      masterProductId: "mp_thyme",
      customName: null,
      price: 249,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_thyme_v1`, label: "2 oz", price: 249, weightG: 57 },
      ],
    },
    {
      id: `${prefix}_ehuru`,
      masterProductId: "mp_ehuru",
      customName: null,
      price: 699,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_ehuru_v1`, label: "4 oz", price: 699, weightG: 113 },
      ],
    },
    {
      id: `${prefix}_jollof_seasoning`,
      masterProductId: "mp_jollof_seasoning",
      customName: null,
      price: 399,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_jollof_s_v1`, label: "4 oz packet", price: 399, weightG: 113 },
      ],
    },
    // --- Oils & Butters ---
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
    {
      id: `${prefix}_groundnut_oil`,
      masterProductId: "mp_groundnut_oil",
      customName: null,
      price: 899,
      stockMode: "counted",
      qty: 12,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_gnut_v1`, label: "500 ml", price: 899, weightG: 460 },
        { id: `${prefix}_gnut_v2`, label: "1 litre", price: 1599, weightG: 920 },
      ],
    },
    {
      id: `${prefix}_coconut_oil`,
      masterProductId: "mp_coconut_oil",
      customName: null,
      price: 1099,
      stockMode: "counted",
      qty: 10,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_coco_v1`, label: "500 ml", price: 1099, weightG: 460 },
      ],
    },
    // --- Vegetables ---
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
    {
      id: `${prefix}_ewedu`,
      masterProductId: "mp_ewedu",
      customName: null,
      price: 449,
      stockMode: "counted",
      qty: 12,
      status: null,
      frozen: true,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_ewedu_v1`, label: "8 oz bag (frozen)", price: 449, weightG: 227 },
      ],
    },
    {
      id: `${prefix}_waterleaf`,
      masterProductId: "mp_waterleaf",
      customName: null,
      price: 499,
      stockMode: "counted",
      qty: 8,
      status: null,
      frozen: true,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_wleaf_v1`, label: "8 oz bag (frozen)", price: 499, weightG: 227 },
      ],
    },
    {
      id: `${prefix}_okra`,
      masterProductId: "mp_okra",
      customName: null,
      price: 399,
      stockMode: "counted",
      qty: 20,
      status: null,
      frozen: false,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_okra_v1`, label: "1 lb", price: 399, weightG: 454 },
        { id: `${prefix}_okra_v2`, label: "3 lb bag", price: 999, weightG: 1362 },
      ],
    },
    {
      id: `${prefix}_scotch_bonnet`,
      masterProductId: "mp_scotch_bonnet",
      customName: null,
      price: 299,
      stockMode: "counted",
      qty: 35,
      status: null,
      frozen: false,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_scotch_v1`, label: "4 oz (~6 peppers)", price: 299, weightG: 113 },
        { id: `${prefix}_scotch_v2`, label: "1 lb bag", price: 699, weightG: 454 },
      ],
    },
    {
      id: `${prefix}_garden_eggs`,
      masterProductId: "mp_garden_eggs",
      customName: null,
      price: 499,
      stockMode: "counted",
      qty: 10,
      status: null,
      frozen: false,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_gegg_v1`, label: "4 pieces", price: 499, weightG: 300 },
      ],
    },
    // --- Fish & Meat ---
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
    {
      id: `${prefix}_dried_fish`,
      masterProductId: "mp_dried_fish",
      customName: null,
      price: 1499,
      stockMode: "counted",
      qty: 10,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_dfish_v1`, label: "8 oz", price: 1499, weightG: 227 },
        { id: `${prefix}_dfish_v2`, label: "1 lb", price: 2599, weightG: 454 },
      ],
    },
    {
      id: `${prefix}_goat_meat`,
      masterProductId: "mp_goat_meat",
      customName: null,
      price: 1299,
      stockMode: "counted",
      qty: 8,
      status: null,
      frozen: true,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_goat_v1`, label: "1 lb", price: 1299, weightG: 454 },
        { id: `${prefix}_goat_v2`, label: "3 lb pack", price: 3499, weightG: 1362 },
      ],
    },
    {
      id: `${prefix}_oxtail`,
      masterProductId: "mp_oxtail",
      customName: null,
      price: 1499,
      stockMode: "counted",
      qty: 6,
      status: null,
      frozen: true,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_oxtail_v1`, label: "1 lb", price: 1499, weightG: 454 },
        { id: `${prefix}_oxtail_v2`, label: "3 lb pack", price: 3999, weightG: 1362 },
      ],
    },
    {
      id: `${prefix}_cow_foot`,
      masterProductId: "mp_cow_foot",
      customName: null,
      price: 899,
      stockMode: "counted",
      qty: 5,
      status: null,
      frozen: true,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_cfoot_v1`, label: "2 lb pack", price: 899, weightG: 907 },
      ],
    },
    {
      id: `${prefix}_ponmo`,
      masterProductId: "mp_ponmo",
      customName: null,
      price: 699,
      stockMode: "counted",
      qty: 12,
      status: null,
      frozen: true,
      perishable: true,
      active: true,
      variants: [
        { id: `${prefix}_ponmo_v1`, label: "1 lb", price: 699, weightG: 454 },
      ],
    },
    // --- Snacks ---
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
    {
      id: `${prefix}_puff_puff_mix`,
      masterProductId: "mp_puff_puff_mix",
      customName: null,
      price: 499,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_puff_v1`, label: "1 lb bag", price: 499, weightG: 454 },
      ],
    },
    {
      id: `${prefix}_plantain_chips`,
      masterProductId: "mp_plantain_chips",
      customName: null,
      price: 399,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_pchips_v1`, label: "5 oz bag", price: 399, weightG: 142 },
        { id: `${prefix}_pchips_v2`, label: "10 oz bag", price: 699, weightG: 283 },
      ],
    },
    {
      id: `${prefix}_kulikuli`,
      masterProductId: "mp_kulikuli",
      customName: null,
      price: 349,
      stockMode: "status",
      qty: null,
      status: "in_stock",
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_kuli_v1`, label: "6 oz bag", price: 349, weightG: 170 },
      ],
    },
    // --- Drinks ---
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
    {
      id: `${prefix}_malt`,
      masterProductId: "mp_malt_drink",
      customName: null,
      price: 299,
      stockMode: "counted",
      qty: 48,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_malt_v1`, label: "330 ml can", price: 299, weightG: 330 },
        { id: `${prefix}_malt_v2`, label: "6-pack", price: 1499, weightG: 1980 },
      ],
    },
    {
      id: `${prefix}_hibiscus_dried`,
      masterProductId: "mp_hibiscus_dried",
      customName: "Dried Zobo Leaves",
      price: 499,
      stockMode: "counted",
      qty: 20,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_hibiscus_v1`, label: "8 oz bag", price: 499, weightG: 227 },
        { id: `${prefix}_hibiscus_v2`, label: "1 lb bag", price: 899, weightG: 454 },
      ],
    },
    // --- Pantry Staples ---
    {
      id: `${prefix}_tomato_paste`,
      masterProductId: "mp_tomato_paste",
      customName: null,
      price: 199,
      stockMode: "counted",
      qty: 50,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_tpaste_v1`, label: "70 g tin", price: 199, weightG: 70 },
        { id: `${prefix}_tpaste_v2`, label: "400 g tin", price: 499, weightG: 400 },
        { id: `${prefix}_tpaste_v3`, label: "800 g tin", price: 799, weightG: 800 },
      ],
    },
    {
      id: `${prefix}_maggi`,
      masterProductId: "mp_maggi_cubes",
      customName: null,
      price: 199,
      stockMode: "counted",
      qty: 100,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_maggi_v1`, label: "10-pack", price: 199, weightG: 40 },
        { id: `${prefix}_maggi_v2`, label: "100-cube box", price: 1299, weightG: 400 },
      ],
    },
    {
      id: `${prefix}_peak_milk`,
      masterProductId: "mp_peak_milk",
      customName: null,
      price: 349,
      stockMode: "counted",
      qty: 30,
      status: null,
      frozen: false,
      perishable: false,
      active: true,
      variants: [
        { id: `${prefix}_peak_v1`, label: "160 ml tin", price: 349, weightG: 175 },
        { id: `${prefix}_peak_v2`, label: "400 ml tin", price: 599, weightG: 425 },
      ],
    },
    // --- Inactive listing (for e2e test: category excludes inactive) ---
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
    // Retire the old demo alcohol listing on existing installations as well.
    // Preserve any historical references; it must never be offered for sale.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
      await tx.listing.updateMany({
        where: { id: `${prefix}_palm_wine`, storeId: store.id },
        data: { active: false },
      });
    });
    const listings = storeListings(store.id, prefix);
    for (const l of listings) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.store_id', ${store.id}, true)`;
        const listingData = {
          price: l.price,
          stockMode: l.stockMode,
          qty: l.qty,
          status: l.status,
          frozen: l.frozen,
          perishable: l.perishable,
          active: l.active,
        };
        await tx.listing.upsert({
          where: { id: l.id },
          update: listingData,
          create: {
            id: l.id,
            storeId: store.id,
            masterProductId: l.masterProductId,
            customName: l.customName,
            ...listingData,
          },
        });
        for (const v of l.variants) {
          const variantData = { label: v.label, price: v.price, weightG: v.weightG };
          await tx.listingVariant.upsert({
            where: { id: v.id },
            update: variantData,
            create: { id: v.id, listingId: l.id, ...variantData },
          });
        }
      });
    }
    console.log(`Seeded ${listings.length} listings for ${store.slug} (${listings.filter(l => l.active).length} active, ${listings.filter(l => !l.active).length} inactive)`);
  }
}
