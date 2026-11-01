import fs from "node:fs";

const path = "src/lib/storefront/catalog-media.json";
const catalog = JSON.parse(
  fs.readFileSync(path, "utf8").replace(/^\uFEFF/, ""),
);
fs.writeFileSync(path, JSON.stringify(catalog, null, 2) + "\n");
const existingCredits = fs.readFileSync("public/images/CREDITS.md", "utf8");
const oldCredits = existingCredits.split("## Storefront redesign photography")[0];
const derivativeCredits = existingCredits.includes("## Phase 3 product cut-outs")
  ? "## Phase 3 product cut-outs" + existingCredits.split("## Phase 3 product cut-outs")[1]
  : "";
const unique = [
  ...new Map(
    Object.values(catalog)
      .filter((x) => x.imageUrl)
      .map((x) => [x.imageUrl, x]),
  ).values(),
];
const licenseLink = (license) => {
  const cc = license.match(/^CC (BY(?:-SA)?) (\d\.\d)$/);
  if (cc)
    return `[${license}](https://creativecommons.org/licenses/${cc[1].toLowerCase()}/${cc[2]}/)`;
  if (license === "CC0")
    return "[CC0](https://creativecommons.org/publicdomain/zero/1.0/)";
  return license;
};
const editorial = [
  [
    "Hero and Jollof night collection",
    "1665556899022-9761f95769e5",
    "a-plate-of-food-gmQfS47FBOM",
    "Keesha's Kitchen (https://keeshaskitchen.com)",
  ],
  [
    "Market hero and demo store story (Bodija Market, Ibadan)",
    "1734255026082-82fdc81991f0",
    "a-group-of-people-standing-around-a-table-filled-with-tomatoes-cnVn4Gg4b00",
    "Tunde Buremo",
  ],
  [
    "Staples / grain category",
    "1734255074937-4b446b8dcf18",
    "a-man-standing-under-an-umbrella-in-a-market-NgH0WKgVR0A",
    "Tunde Buremo",
  ],
  [
    "Fish category / offer tile (Akosombo, Ghana)",
    "1689187015184-a9bc081f3de6",
    "a-pile-of-dried-bananas-sitting-on-top-of-a-blue-table-4i4y-5G4M9Q",
    "Brah Lyrix",
  ],
  [
    "Spice category / soup collection (ingredient still life)",
    "1677599082447-6549af4c5454",
    "spices-and-herbs-in-wooden-bowls-on-a-table-3gmr5ez2otU",
    "Vincent Bélanger",
  ],
];
let credit =
  "## Storefront redesign photography\n\nPhotos are resized by next/image. Commons product images represent ingredients or packaged goods, not verified store packshots. Prepared dishes appear only as editorial meal inspiration. The demo story photo depicts Bodija Market, not the fictional store or owner. Legacy SVG illustrations above are retired from the customer storefront.\n\n| Placement | Image URL | Source page | Author | License |\n|---|---|---|---|---|\n";
credit += editorial
  .map(
    ([use, id, page, author]) =>
      `| ${use} | https://images.unsplash.com/photo-${id} | https://unsplash.com/photos/${page} | ${author} | [Unsplash License](https://unsplash.com/license) |`,
  )
  .join("\n");
credit +=
  "\n| Retired phase 1 promo photograph | https://upload.wikimedia.org/wikipedia/commons/2/26/Yellow_chili.png | https://commons.wikimedia.org/wiki/File:Yellow_chili.png | Tiia Monto | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |\n";
credit +=
  "\n\n### Catalog photographs\n\nMatched by explicit English/local name to the catalog manifest. The missing source CSV was reconstructed in Phase 3; replacements have Commons metadata evidence in scripts/images. CC BY / BY-SA originals retain their authorship. Product sources use contain sizing; completed background-removal derivatives are listed separately below.\n\n| Catalog reference | Image URL | Source page | Author | License |\n|---|---|---|---|---|\n";
credit += unique
  .map(
    (x) =>
      `| ${x.catalogId} | ${x.imageUrl} | ${x.source} | ${x.author.replaceAll("|", "/")} | ${licenseLink(x.license)} |`,
  )
  .join("\n");
fs.writeFileSync("public/images/CREDITS.md", oldCredits + credit + "\n\n" + derivativeCredits);
console.log(
  `Credited ${unique.length} Commons and ${editorial.length} Unsplash images.`,
);
