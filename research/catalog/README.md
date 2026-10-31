# Master catalog research (issue #7)

The master catalog is the shared inventory stores pick from when they add listings. It should cover what independent African grocery stores in the US actually sell: staple foods, produce, frozen goods, spices, drinks, snacks, popular imported brands, and beauty items.

This folder holds the research. Each region has its own CSV, followed by a merged and verified file. Nothing here is imported into the database until a human has reviewed it (#7, first acceptance criterion).

## Files
- `west-africa-nigeria.csv`: Nigeria
- `west-africa-ghana-and-region.csv`: Ghana, Senegal, Sierra Leone, Liberia, Côte d'Ivoire, Togo, Benin, Gambia, Guinea, Mali, Burkina Faso, Cameroon
- `central-east-southern-africa.csv`: DRC, Congo, Cameroon (Central dishes), Kenya, Uganda, Tanzania, Ethiopia, Eritrea, Somalia, Sudan, Zimbabwe, South Africa, Zambia, Malawi, plus Caribbean overlap items common in the same stores
- `master-catalog.csv`: merged, deduplicated and verified (written by the verifier)
- `verification-report.md`: what the verifier checked, fixed and flagged

## CSV columns (exact header, UTF-8, comma-separated, double-quote any field with commas)

```
id,english_name,local_names,search_synonyms,category,subcategory,origin_countries,product_type,common_brands,unit,common_pack_sizes,typical_weight_g,storage,perishable,description,image_url,image_source_page,image_license,image_author,sources,confidence,notes
```

| Column | Rules |
|---|---|
| `id` | lowercase kebab-case, unique, stable: `garri-white`, `palm-oil-red`, `egusi-ground` |
| `english_name` | the name a US shopper would search, e.g. "Fluted pumpkin leaves" |
| `local_names` | every well-known local name, pipe-separated, each as `name (language, country)`: `ugu (Igbo, Nigeria)|ugwu (Igbo, Nigeria)` |
| `search_synonyms` | lowercase search terms customers type: spellings, misspellings, transliterations, brand-agnostic names: `ugu|ugwu|fluted pumpkin|pumpkin leaf` |
| `category` | one slug from the taxonomy below |
| `subcategory` | free text, e.g. "leafy greens", "smoked fish", "stock cubes" |
| `origin_countries` | pipe-separated countries where it's eaten or known by these names |
| `product_type` | `generic` (yam, egusi) or `branded` (Indomie, Peak milk, Milo, Maggi) |
| `common_brands` | for generic items, popular brands sold in US stores (pipe-separated). For branded items, the brand itself |
| `unit` | `each`, `lb`, `kg`, `oz`, `bunch`, `pack`, `bag`, `bottle`, `can`, `jar`, `tin`, `carton`, `piece` |
| `common_pack_sizes` | what US African stores typically stock, pipe-separated: `1 lb|2 lb|5 lb|10 lb` |
| `typical_weight_g` | weight of the most common pack in grams (integer), for courier eligibility |
| `storage` | `ambient`, `chilled` or `frozen` |
| `perishable` | `yes` or `no` |
| `description` | one plain sentence on what it is and how it's used |
| `image_url` | a direct image URL that is **openly licensed**: Wikimedia Commons (preferred), Unsplash or Pexels only. Leave empty if none found. Never use retailer, brand or Google Images photos |
| `image_source_page` | the page the image comes from (the Commons file page, or the Unsplash/Pexels photo page) |
| `image_license` | e.g. `CC BY-SA 4.0`, `CC0`, `Unsplash License`, `Pexels License` |
| `image_author` | as credited on the source page |
| `sources` | 1–3 URLs supporting the names (pipe-separated): Wikipedia, academic or food references, reputable recipe sites, African grocery retailers' product pages (for names and pack sizes only) |
| `confidence` | `high`, `medium` or `low` for the local names |
| `notes` | anything a human reviewer should check |

## Category taxonomy

Existing in the database: `tubers`, `grains-and-flours`, `spices`, `oils`, `vegetables`, `fish-and-meat`, `frozen`, `snacks`, `drinks`, `beauty`.

Proposed additions (use them; the reviewer decides whether to add them to the database): `beans-and-legumes`, `fruits`, `seasonings-and-sauces` (stock cubes, tomato paste, soup bases, pepper sauces), `breakfast-and-dairy` (milk powder, evaporated milk, cocoa/malt drinks, cereals, custard), `canned-and-packaged` (sardines, corned beef, baked beans, noodles), `household` (sponges, chewing sticks, black soap if not beauty).

Frozen items go in `frozen` when they're only sold frozen (frozen fish, goat meat, frozen leaves). Dried or smoked fish goes in `fish-and-meat`.

## Quality rules
- Accuracy over volume. Don't invent local names. If unsure, mark `confidence` low and say why in `notes`.
- One row per distinct product a store would list. Variants that are genuinely different products get separate rows (white garri vs yellow garri, Ijebu garri). Pack sizes don't.
- Include the popular imported brands US African stores actually carry (e.g. Indomie, Golden Penny, Honeywell, Peak, Nido, Milo, Bournvita, Maggi, Knorr, Titus sardines, Gino, Tasty Tom, Ghana's Tom Brown, Frytol, Ideal milk, Mentos-era classics). Only include brands you can confirm are sold in US African stores.
- No duplicates across regions. If an item is shared (e.g. palm oil, plantain), the region that owns it most writes the row and lists every country in `origin_countries`. Owners: Nigeria owns pan-West-African staples (palm oil, egusi, garri, crayfish), Ghana/region owns Ghanaian and Francophone items, Central/East/Southern owns everything else.
