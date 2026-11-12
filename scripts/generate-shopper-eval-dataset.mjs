import { readFileSync, writeFileSync } from "node:fs";

const csv = readFileSync("research/catalog/master-catalog.csv", "utf8").split(/\r?\n/).slice(1).filter(Boolean);
const products = csv.map(parseCsvLine).map((fields) => ({
  id: fields[0],
  name: fields[1],
  synonyms: (fields[3] ?? "").split("|").map((term) => term.trim()).filter(Boolean),
})).filter((product) => product.id && product.name);

const blocked = new Set(products.filter((product) => /onion|tomato/.test(product.id) && !product.id.includes("tomato-paste") && !product.id.includes("pepper-onion")).map((product) => product.id));
const usable = products.filter((product) => !blocked.has(product.id));
const byId = new Map(usable.map((product) => [product.id, product]));

function take(id) {
  const product = byId.get(id);
  if (!product) throw new Error(`missing master product ${id}`);
  byId.delete(id);
  return product;
}

const wanted = [
  "rice-parboiled-long-grain",
  "rice-ofada",
  "tomato-paste-gino",
  "pepper-scotch-bonnet",
  "pepper-tatashe",
  "thyme-dried",
  "curry-powder-nigerian",
  "maggi-star-cubes",
  "hard-chicken",
  "palm-oil-red",
  "egusi-seeds-whole",
  "egusi-ground",
  "ugu-leaves-fresh",
  "crayfish-ground",
  "stockfish-cut",
  "teff-flour-ivory",
  "teff-flour-brown",
  "berbere",
  "yam-white-puna",
  "garri-white",
  "garri-yellow",
  "beans-honey-oloyin",
  "beans-brown",
  "plantain-ripe",
  "plantain-green",
  "goat-meat-frozen",
  "ginger-dried-ground",
  "palm-oil-bleached-ofada",
  "tomato-paste-de-rica",
  "maggi-crayfish-cubes",
  "knorr-chicken-cubes",
  "cassava-fufu-flour",
  "semolina-honeywell",
  "suya-spice-yaji",
  "hibiscus-dried",
  "cocoyam-taro",
  "gino-pepper-onion-paste",
  "salt-cod-makayabu-saltfish",
  "crayfish-whole-dried",
  "stockfish-whole",
];
const pinned = wanted.filter((id) => byId.has(id)).map(take);
while (pinned.length < 70) pinned.push(take(byId.keys().next().value));
const decoys = [];
while (decoys.length < 10) decoys.push(take(byId.keys().next().value));

const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const hours = Object.fromEntries(days.map((day) => [day, { open: "09:00", close: "21:00" }]));

function listing(product, index, store, extra = {}) {
  const price = 199 + index * 37;
  return {
    key: product.id,
    masterProductId: product.id,
    priceCents: price,
    stockMode: "unlimited",
    qty: null,
    status: null,
    confidence: 1,
    active: true,
    maxPerOrder: null,
    variants: [{ key: `${product.id}-pack`, label: "5 lb", priceCents: price, weightG: 2268 }],
    store,
    ...extra,
  };
}

const listings = pinned.map((product, index) => listing(product, index, "A"));
listings[0] = listing(pinned[0], 0, "A", {
  variants: [
    { key: `${pinned[0].id}-5lb`, label: "5 lb", priceCents: 199, weightG: 2268 },
    { key: `${pinned[0].id}-10lb`, label: "10 lb", priceCents: 349, weightG: 4536 },
  ],
});
Object.assign(listings[1], { confidence: 0.4 });
Object.assign(listings[2], { stockMode: "counted", qty: 0 });
Object.assign(listings[3], { stockMode: "status", status: "out_of_stock" });
Object.assign(listings[4], { active: false });
Object.assign(listings[5], { maxPerOrder: 2 });
for (const [index, product] of decoys.entries()) listings.push(listing(product, 100 + index, "B"));

const fixture = {
  schemaVersion: 1,
  pinnedNow: "2026-06-15T16:00:00.000Z",
  store: {
    name: "Golden Eval Market",
    timezone: "America/Chicago",
    hours,
    minimumOrderCents: 1500,
    pickupEnabled: true,
  },
  listings,
};

const inStock = listings.filter((item) => item.store === "A" && item.active && item.confidence >= 0.6 && item.qty !== 0 && item.status !== "out_of_stock");
const low = listings.find((item) => item.store === "A" && item.confidence < 0.6);
const countedOut = listings.find((item) => item.store === "A" && item.qty === 0);
const statusOut = listings.find((item) => item.store === "A" && item.status === "out_of_stock");
const inactive = listings.find((item) => item.store === "A" && !item.active);
const nameOf = new Map(products.map((product) => [product.id, product.name]));

function chosenVariants(item, namedFive) {
  const variants = namedFive ? item.variants.filter((variant) => variant.label === "5 lb") : item.variants;
  return variants.length > 0 ? variants : item.variants;
}
function pack(item, namedFive = false) {
  return { listingKey: item.key, variantKeys: chosenVariants(item, namedFive).map((variant) => variant.key) };
}
function must(item, namedFive = false) {
  return { options: [pack(item, namedFive)] };
}
function qtyRules(item, min, max, namedFive = false) {
  return chosenVariants(item, namedFive).map((variant) => ({ listingKey: item.key, variantKey: variant.key, min, max }));
}
function caseOf(id, category, turns, extra) {
  return {
    id,
    category,
    turns,
    mustHave: extra.mustHave ?? [],
    mayHave: extra.mayHave ?? [],
    gaps: extra.gaps ?? [],
    ...(extra.qty ? { qty: extra.qty } : {}),
    ...(extra.swapRule ? { swapRule: extra.swapRule } : {}),
    ...(extra.addsFromTurn ? { addsFromTurn: extra.addsFromTurn } : {}),
  };
}

const cases = [];
const jollof = ["rice-parboiled-long-grain", "tomato-paste-gino", "pepper-scotch-bonnet", "thyme-dried", "curry-powder-nigerian", "maggi-star-cubes", "hard-chicken", "palm-oil-red"].map((id) => listings.find((item) => item.key === id)).filter(Boolean);
const egusi = ["egusi-seeds-whole", "ugu-leaves-fresh", "crayfish-ground", "palm-oil-red", "stockfish-cut"].map((id) => listings.find((item) => item.key === id)).filter(Boolean);
const breakfast = ["teff-flour-ivory", "berbere"].map((id) => listings.find((item) => item.key === id)).filter(Boolean);

for (let index = 0; index < 20; index += 1) {
  cases.push(caseOf(`jollof-for-ten-${index + 1}`, "recipe-to-cart", [
    `Jollof for ${8 + (index % 5)} people. Use tomato paste, not fresh tomato, and no yellow onion.`,
    "Yes, add those.",
  ], { mustHave: jollof.map((item) => must(item)), qty: jollof.flatMap((item) => qtyRules(item, 1, 20)), addsFromTurn: 2 }));
}
for (let index = 0; index < 10; index += 1) {
  cases.push(caseOf(`egusi-soup-${index + 1}`, "recipe-to-cart", [
    `Egusi soup for ${4 + (index % 4)} people.`,
    "Yes, add those.",
  ], { mustHave: egusi.map((item) => must(item)), qty: egusi.flatMap((item) => qtyRules(item, 1, 20)), addsFromTurn: 2 }));
}
for (let index = 0; index < 10; index += 1) {
  cases.push(caseOf(`ethiopian-breakfast-${index + 1}`, "recipe-to-cart", [
    `Ethiopian breakfast for ${2 + (index % 3)} people, with teff and berbere.`,
    "Yes, add those.",
  ], { mustHave: breakfast.map((item) => must(item)), qty: breakfast.flatMap((item) => qtyRules(item, 1, 20)), addsFromTurn: 2 }));
}

inStock.slice(0, 35).forEach((item, index) => {
  cases.push(caseOf(`add-one-${index + 1}`, "single-item", [
    `Add 1 of the 5 lb ${nameOf.get(item.key)}.`,
  ], { mustHave: [must(item, true)], qty: qtyRules(item, 1, 1, true) }));
});

const multiPool = inStock.slice(0, 25);
cases.push(caseOf("add-twenty-five", "multi-item", [
  `Add 1 of each of these: ${multiPool.map((item) => nameOf.get(item.key)).join(", ")}.`,
], { mustHave: multiPool.map((item) => must(item)), qty: multiPool.flatMap((item) => qtyRules(item, 1, 1)) }));
for (let index = 0; index < 29; index += 1) {
  const picked = [inStock[index % inStock.length], inStock[(index + 3) % inStock.length], inStock[(index + 7) % inStock.length]];
  const unique = [...new Map(picked.map((item) => [item.key, item])).values()];
  cases.push(caseOf(`add-three-${index + 1}`, "multi-item", [
    `Add 1 of each: ${unique.map((item) => nameOf.get(item.key)).join(", ")}.`,
  ], { mustHave: unique.map((item) => must(item)), qty: unique.flatMap((item) => qtyRules(item, 1, 1)) }));
}

const synonymAsks = [
  ["ata-rodo", "Add 1 ata rodo.", "pepper-scotch-bonnet"],
  ["tatashe", "Add 1 tatashe.", "pepper-tatashe"],
  ["isu", "Add 1 isu.", "yam-white-puna"],
  ["agushi", "Add 1 agushi.", "egusi-seeds-whole"],
  ["nech-teff", "Add 1 nech teff.", "teff-flour-ivory"],
];
for (let index = 0; index < 30; index += 1) {
  const ask = synonymAsks[index % synonymAsks.length];
  const item = listings.find((row) => row.key === ask[2]);
  cases.push(caseOf(`synonym-${ask[0]}-${index + 1}`, "synonym", [ask[1]], { mustHave: [must(item)], qty: qtyRules(item, 1, 1) }));
}

for (let index = 0; index < 8; index += 1) {
  cases.push(caseOf(`counted-out-${index + 1}`, "out-of-stock", [
    `Add 1 ${nameOf.get(countedOut.key)}.`,
  ], {
    mustHave: [must(countedOut)],
    qty: qtyRules(countedOut, 1, 1),
    swapRule: { listingKey: countedOut.key, allowed: ["store_suggests", "named_substitute"] },
  }));
}
for (let index = 0; index < 7; index += 1) {
  cases.push(caseOf(`status-out-${index + 1}`, "out-of-stock", [
    `Add 1 ${nameOf.get(statusOut.key)}.`,
  ], {
    mustHave: [must(statusOut)],
    qty: qtyRules(statusOut, 1, 1),
    swapRule: { listingKey: statusOut.key, allowed: ["store_suggests", "named_substitute"] },
  }));
}
for (let index = 0; index < 10; index += 1) {
  cases.push(caseOf(`inactive-gap-${index + 1}`, "out-of-stock", [
    `Add 1 ${nameOf.get(inactive.key)}.`,
  ], { gaps: [{ key: inactive.key, mention: [nameOf.get(inactive.key).split(" ")[0].toLowerCase()] }] }));
}

inStock.slice(35, 55).forEach((item, index) => {
  cases.push(caseOf(`some-then-one-${index + 1}`, "ambiguous-quantity", [
    `I need some ${nameOf.get(item.key)}, but I have not said how many.`,
    `Add 1 of the 5 lb ${nameOf.get(item.key)}.`,
  ], { mustHave: [must(item, true)], qty: qtyRules(item, 1, 1, true), addsFromTurn: 2 }));
});

for (let index = 0; index < 20; index += 1) {
  cases.push(caseOf(`backup-${index + 1}`, "substitution", [
    `Add 1 ${nameOf.get(low.key)} and set a backup swap rule because stock confidence is low.`,
  ], {
    mustHave: [must(low)],
    qty: qtyRules(low, 1, 1),
    swapRule: { listingKey: low.key, allowed: ["store_suggests", "named_substitute"] },
  }));
}

const counts = {};
for (const item of cases) counts[item.category] = (counts[item.category] ?? 0) + 1;
if (cases.length !== 200) throw new Error(`generated ${cases.length}: ${JSON.stringify(counts)}`);

writeFileSync("src/lib/assistant/eval/catalog.json", `${JSON.stringify(fixture, null, 2)}\n`);
writeFileSync("src/lib/assistant/eval/dataset.json", `${JSON.stringify(cases, null, 2)}\n`);
console.log(JSON.stringify({ listings: listings.length, storeA: listings.filter((item) => item.store === "A").length, cases: cases.length, counts }));

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}
