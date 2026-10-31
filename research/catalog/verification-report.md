# Master catalog verification report (issue #7)

Verifier pass, 2026-10-31. Inputs: `west-africa-nigeria.csv` (NG, 222 rows), `west-africa-ghana-and-region.csv` (GH, 138 rows + 29 SHARED lines), `central-east-southern-africa.csv` (CES, 205 rows + 20 SHARED lines). The input files were not edited. Output: `master-catalog.csv`, using the exact README header.

## 1. Final counts
- **Total: 501 rows.** Path: 565 input rows → 510 after merging (55 rows folded in, 2 rows added) → 501 after 9 exclusions/drops.
- **By category:** spices 64 · frozen 52 · grains-and-flours 47 · seasonings-and-sauces 40 · drinks 38 · breakfast-and-dairy 37 · snacks 36 · vegetables 35 · fish-and-meat 30 · tubers 26 · beans-and-legumes 23 · canned-and-packaged 21 · household 20 · beauty 14 · oils 10 · fruits 8.
- **By source region:** CES only 190 · NG only 170 · GH only 90 · merged from several files 49 (GH+NG 35, all three 7, CES+NG 4, CES+GH 3) · added by the verifier 2.
- **With image:** 289 of 501 (58%). Every image is on upload.wikimedia.org. None come from Unsplash or Pexels.
- **By confidence:** high 188 · medium 243 · low 70. Every low row was in the sample (see §4).
- **Product type:** generic 398 · branded 103.

## 2. Merges (canonical id ← merged rows)
- `yam-white-puna` ← NG:yam-white-puna, GH:yam-puna-ghana; `cocoyam-taro` ← NG:cocoyam-taro, GH:taro-colocasia; `cocoyam-tannia` ← NG:cocoyam-tannia, GH:cocoyam-macabo
- `cocoyam-flour` ← NG:cocoyam-flour, GH:fufu-flour-cocoyam; `akpu-wet-frozen` ← NG:akpu-wet-frozen, GH:fufu-fermented-cassava-sl; `millet-flour` ← NG+GH millet-flour (same id)
- `millet-pearl` ← NG:millet-pearl, GH:pearl-millet-whole; `fonio` ← GH:fonio, NG:acha-fonio; `white-maize-meal` ← CES:white-maize-meal, NG:corn-flour-tuwo-masara, GH:corn-flour-white-fine
- `baobab-fruit-powder` ← GH+CES+NG (same id); `baobab-leaf-powder` ← GH:baobab-leaf-powder, NG:baobab-leaf-kuka; `moringa-powder` ← NG+GH (same id)
- `tamarind` ← GH:tamarind, NG:tamarind-tsamiya, CES:tamarind-block; `dates` ← CES:dates, NG:dates-dabino; `bambara-nut` ← NG:bambara-nut, GH:bambara-beans, CES:bambara-groundnuts
- `pigeon-peas-dried` ← CES:pigeon-peas-dried, NG:pigeon-peas-fiofio; `fumbwa-dried-gnetum-leaves` ← NG:okazi-leaves-dried, GH:eru-okok-dried, CES:fumbwa-dried-gnetum-leaves; `jute-leaves` ← GH:jute-leaves, NG:ewedu-leaves-frozen
- `potato-greens` ← GH:potato-greens, CES:matembele-sweet-potato-leaves; `roselle-leaves` ← GH:roselle-leaves, CES:ngai-ngai-roselle-leaves; `garden-egg` ← NG:garden-egg, GH:garden-eggs
- `okra-dried` ← NG:okra-dried, GH:okra-powder-dried, CES:weika-dried-okra-powder; `ground-hot-pepper` ← NG:ground-hot-pepper, GH:ground-dried-pepper; `cameroon-pepper` ← GH+NG (same id)
- `amaranth-leaves` ← CES:amaranth-leaves, NG:efo-tete-amaranth; `bitter-leaf-frozen` ← NG:bitter-leaf-frozen, GH:ndole-leaves; `ashanti-pepper` ← NG:uziza-seeds, GH:ashanti-pepper
- `grains-of-selim` ← NG:uda-grains-of-selim, GH:grains-of-selim; `calabash-nutmeg` ← NG:ehuru-calabash-nutmeg, GH:calabash-nutmeg; `aidan-fruit` ← NG:aidan-fruit, GH:prekese
- `dawadawa-dried` ← NG:dawadawa-dried, GH:dawadawa, GH:soumbala-powder; `palm-kernel-oil` ← NG+GH (same id); `groundnut-oil` ← NG:groundnut-oil, GH:peanut-oil-unrefined
- `palm-nut-cream` ← GH:palm-nut-cream, NG:palm-fruit-concentrate; `onga-seasoning`, `shea-butter-raw`, `african-black-soap`, `chewing-stick`, `velvet-tamarind`, `bitter-kola`, `geisha-mackerel` ← NG+GH (same ids)
- `african-net-sponge` ← GH:african-net-sponge, NG:native-sponge; `mortar-pestle-wood` ← NG:mortar-pestle-wood, GH:fufu-mortar-pestle; `kola-nut` ← NG:kola-nut, GH:kola-nut-red
- `hibiscus-dried` ← GH:hibiscus-dried, NG:zobo-leaves; `hibiscus-drink-bottled` ← GH:hibiscus-drink-bottled, NG:zobo-drink; `horse-mackerel-frozen` ← CES:mpiodi-frozen-horse-mackerel, NG:horse-mackerel-frozen
- `chikwangue-kwanga` ← CES:chikwangue-kwanga, GH:bobolo (Wikipedia says bobolo is the Cameroonian name for chikwangue); `ube-african-pear` ← NG:ube-african-pear, GH:safou-frozen, CES:safou-african-plum
- **SHARED lines (49):** each line's names were folded into its target row and the line was dropped. Lines naming one product in a family were also folded into the sibling form (for example ground and whole egusi, ground and whole ogbono, green and ripe plantain, whole and ground crayfish). `ginger-root` is a new row created from CES:ginger-root, because no row existed for it.
- **SHARED names held back** from local_names and recorded in the row's notes: names the agents flagged themselves (benga, accra, kobo, akatoa, diw tiir) and dish names (aloco, kelewele).
- **SHARED lines not folded in:** GH:snails-giant-african (excluded, see §3). GH:akara names a dish, not a product, so akara and koose went into the search synonyms of `bean-flour-peeled` only.
- **Considered and kept separate:** gari-ghana vs garri-white (stores list Ghana gari separately; the README treats garri variants as separate rows) · cassava-flour-congolese-fufu vs cassava-fufu-flour (akpu) · plantain-flour-unripe vs fufu-flour-plantain (the latter is a blend) · kokonte vs lafun · miondo vs chikwangue · njama-njama vs managu · afang-leaves-frozen (frozen form) vs the dried Gnetum row · iru (frozen, wet) vs dawadawa-dried.

## 3. Exclusions and drops (9)
- `grasscutter-frozen`: bushmeat and a wild African rodent (cane rat). CDC/FDA have banned imports of African rodents since 2003 (42 CFR 71.56), and bushmeat cannot legally be imported.
- `kohl-kuul`: FDA has not approved kohl/kajal/surma as a cosmetic color additive, and it often contains lead. The row's own image shows galena kohl.
- `snails-giant-african` (GH SHARED line, no row created): USDA APHIS prohibits importing and keeping giant African land snails (a federal noxious pest).
- **Brand rule** (README: only include brands confirmed in US African stores). Neither the agent nor the verifier found any US retail listing for `kings-vegetable-oil`, `power-oil`, `fanta-nigeria`, `coca-cola-nigeria` (UK retailers only), `amstel-malta`, `ideal-evaporated-milk`, or `gala-sausage-roll` (also hit by USDA meat-import limits). They can be restored if a partner store confirms it stocks them.
- No skin-lightening products or alcohol were found. `gesho` (a brewing herb, not alcohol) is kept. Henna is kept as a hair dye only (FDA has not approved it for direct use on skin).

## 4. Sample verification
- **Sample:** all 37 low-confidence rows, plus 71 others drawn at random (15% per category, seed 20261031) = **108 rows, 282 local names**.
- **Method:**
  - Opened every cited source (Wikipedia through its API, other pages as HTML) and checked each name, accents ignored, plus whether its language or country appears within 400 characters.
  - Names not found were looked up on en.wiktionary under the claimed language heading, then searched for on Wikipedia. Wikipedia hits were accepted only from on-topic pages (cuisine, dish or plant articles); off-topic hits such as song or biography pages were rejected by hand.
  - Images were checked for every row through the Commons API: file exists, URL, license, Artist field, description, categories. No image files were downloaded.
- **Name results:**

  | Result | Names |
  |---|---|
  | Confirmed in the cited source with language/country nearby | 76 |
  | Confirmed via Wiktionary | 49 |
  | Confirmed via an on-topic Wikipedia page (added as a source when there was room) | 12 |
  | Found, but the source shows no language attribution | 24 |
  | **Not confirmable** | **118 (42%)** |
  | Removed as unsupported or wrong | 4 |

- **Rule applied:** a row with any name that could not be confirmed was set to **low**, and its notes list those names (62 of the 101 rows still in the catalog). These names are mostly plausible but have no source. They are not known errors. `country-onion` was raised from low to medium: all three names, including the doubted "rondelle", appear in its source.
- **Rows fixed: 32 of 108 (30%).**
  - **21 rows (19%) had real errors:** 9 image content problems, 7 brand-rule violations, 4 unsupported names in 4 rows, 1 placeholder image author.
  - **11 rows had consistency fixes:** 9 brand names listed as local names, 3 category moves (one row overlaps with the real-error group).
- **Main error types:**
  1. Sources too thin to support the names. Most cite one general Wikipedia page or a shop category page that never mentions the local names.
  2. Cooked-dish photos used for packaged products.
  3. Brands with no US evidence.
  4. Name attributions copied from another context: Filipino `tinapa` for Ghanaian smoked herring, the generic Igbo `ose oyibo` for Nsukka pepper, unverified Ga `apateshi`, and a conflicting `sobolo (Twi)` next to `sobolo (Ghanaian English)`.
  5. Brand names entered as local names (for example `Iwisa (Zulu)`, `Vimto (English, Somalia)`), across 45 branded rows catalog-wide.
- **Not affected:** English names, categories and descriptions in the sample were consistent with their sources. No wrong-product rows were found.

## 5. Image issues (all 289 images)
- **License and author:** the license string matched the Commons page for all 290 image references checked (285 distinct files). All URLs resolve.
- **Author fixed:** `henna-powder` had the author "see source page"; now Andrey "A.I." Sitnik, taken from the file page.
- **Author taken from the uploader** (no Artist field on Commons): `cocoyam-taro`, `thyme-dried`, `rice-jasmine-thai`.
- **"trademark: needs review" (10):** heinz-salad-cream, lucozade, ribena, dudu-osun, aboniki-balm, indomie-onion-chicken, black-seed-oil, attieke-dried, fufu-flour-plantain, camel-milk. The last five are judged likely from their descriptions (packaged or bottled products).
- **"image: dish not product" (39):** akpu-wet-frozen, poundo-yam-flour, garri-ijebu, cassava-fufu-flour, semovita-golden-penny, rice-ofada, rice-flour-tuwo, oha-leaves-frozen, oha-leaves-dried, egusi-ground, ogbono-ground, suya-spice-yaji, pepper-soup-spice, nsala-soup-spice, banga-spice, cow-foot, indomie-chicken, custard-powder, tapioca-nigerian, ayamase-sauce, kenkey-ga, tom-brown, hausa-koko-mix, akassa, attieke-frozen, araw-millet-pellets, kokonte-flour, shito, cassava-leaves, sukuma-wiki-collard-greens, kunde-cowpea-leaves, githeri-maize-bean-mix, mandazi-mix, ayib-cottage-cheese, laxoox-canjeero-mix, ful-medames-canned, samp-and-beans-mix, puff-puff-mix, guinea-fowl-frozen.
- **Wrong or misleading image (flagged in notes):**
  - indomie-onion-chicken shows Mi Goreng packs.
  - beans-peeled-brown reuses the unpeeled-beans photo.
  - rosecoco-beans shows borlotti beans.
  - kik-yellow-split-peas: the file is categorised as pigeon peas.
  - mopane-worms shows a live caterpillar.
  - palm-nut-cream shows raw palm nuts.
  - kunu-drink shows a different kunu.
  - bitter-garden-egg reuses the garden-egg photo.
  - yam-water shows Philippine ube.
- **Images swapped to a better contributor image:** `white-maize-meal` (a photo of the flour replaces cooked ugali) and `groundnut-oil` (an unbranded oil photo replaces a branded bottle).

## 6. Consistency fixes
- Categories and subcategories: README slugs only. Subcategory wording was standardised within each category; for example, spices now uses whole spices / dried peppers / spice blends / dried herbs and leaves / soup seeds and thickeners.
- Frozen leafy greens moved to `frozen` (README rule): kontomire, cassava-leaves, potato-greens, roselle-leaves, gboma, njama-njama, jute-leaves.
- Cassava, plantain and potato swallow flours and `gari-ghana` moved to `tubers` to sit with their NG equivalents. Kola nuts unified under snacks/kola nuts.
- Countries normalised (DRC/Congo → `DR Congo` / `Republic of the Congo`). Local names without a language were fixed, or removed where no evidence existed (`dika (Cameroon)`, `koko (Ghana)`, `bofrot (Ghana)`). Slash pairs were split.
- Agents' "reviewer to dedupe" notes were removed once resolved.
- Final validator: 0 problems for ids, categories, units, storage, frozen=frozen, integer weights or list format. Two rows have **no source at all** and are flagged in their notes: `mangala-fish`, `turning-stick-omorogun`.

## 7. Human review list (by country / language)
Each entry is a name that no source confirmed, or that was held back. Each row's notes give the full context.
- **Nigeria – Yoruba:** epo epa, epa (groundnut), kankan (sponge), eja sawa (bonga), ata gbigbe, bokoto, eja aro, iresi ofada, abolabo, efo shoko, ogede agbagba.
- **Nigeria – Igbo:** atu (chewing stick), ose Nsukka, azu mangala, ahuekere, ude aki, ora (oha).
- **Nigeria – Hausa:** man gyada, ganda (ponmo, 2 rows), shuwaka, tarwada.
- **Nigeria – other:** etidot (Efik), oriwo (Edo), kote (Nigerian English, horse mackerel).
- **Ghana – Twi:** nkate ngo, tweapea, nketenkete (fennel or anise?), bɛsɛ fitaa, alata/anago samina, kooko, awonwono, apotoyiwa, adwengo, donkwa, wedeaba, esoro wisa, borode/brodeɛ/apantu. Held back: akatoa, kobo, kelewele.
- **Ghana – other:** kako (Ga; the species is also unknown), dakuwa (Hausa), herrings (Ghanaian English), aboboi (Twi vs Ga conflict on `bambara-nut`).
- **Senegal / Mali / Burkina:**
  - Wolof: diw gerte, tambadiang (the product itself is unverified), guro bu weex, jinjer, gej, dakhar, nebeday. Held back: diw tiir.
  - Bambara: datu, tomi. Mooré: bikalga; benga held back.
- **Côte d'Ivoire / Togo / Cameroon:**
  - French: noix de cola blanche, huile de palmiste, savon noir africain, arachides du pays.
  - Cameroon: nkui (Bamileke), achu spice.
- **Central Africa:** ngaingai/ngai ngai, makemba (Lingala) · feuilles de bananier (French) · lumanda (Bemba).
- **Ethiopia / Eritrea:**
  - Amharic (16): ye qibe qimem, menkeshkesh, ocholoni, bakela, bula, homer, telba, rekebot, kerbe, the Ge'ez script for awaze and cloves.
  - Afaan Oromo: qoocoo, nuugii. Tigrinya: ajibo, qolo.
- **East Africa:** Swahili: majani ya ndizi/migomba, tui la nazi, majani ya chai, manemane, pilau masala, bizari ya pilau · Luganda: endagala, gonja · Kenya: saget, thageti, tsisaka (spider plant) · Chichewa: nzungu.
- **Somalia / Sudan:** Somali: xinne, raqay, malmal, qaranfuul · Sudanese Arabic: ful sudani, asal, aradeib, kawal (Arabic script), qurunful, shata.
- **Southern Africa / Caribbean:** inkobe (Xhosa) · tambran (Jamaican Patois).
- **Store owners to confirm stock or product:** tambadiang, datou, nkui-spice, mangala-fish, country-peanuts-cameroon, aklui-corn-pellets, torborgee-oil, loya-milk, tomato-paste-tasty-tom (one out-of-stock Walmart listing), mbinzo and mopane-worms (insect import rules), muqmad and kilishi (must be US-made), ponmo (US-made hide only).
- **Not sampled but flagged by the agents:** about 70 medium/high rows. The largest groups: Nigeria 23 (for example scent-leaf, utazi, waterleaf, alligator-pepper, ube), Ghana 11, Kenya 10, Ethiopia 7.

## 8. Coverage gaps
- **Added (sourced):** `rice-jasmine-thai` (Wikipedia + Commons; no brands or local names claimed). `ginger-root` (from the SHARED line).
- **Present but missing brands:** parboiled rice (only Ben's Original and Par Excellence; Mama Gold / Royal Stallion-type Thai parboiled brands are unsourced) · broken rice (no brands) · jasmine rice (no brands) · Ga/Fante kenkey (only "Delicious") · Nigerian dried catfish (`smoked-catfish`, no brands). Teff brands are present: Maskal Teff, Bob's Red Mill, Shiloh Farms.
- **Missing staples, not added for lack of a proper source in this pass:**
  - Frozen: periwinkles, turkey wings / smoked turkey, chicken gizzards.
  - Frytol vegetable oil (named in the README).
  - Panla / dried hake as its own row.
  - Golden Penny / Honeywell wheat flour.
  - Mentos-era classic sweets (named in the README).
  - Agidi/eko as a Nigerian label (currently only inside `akassa`).
- **Excluded by policy:** palm wine and other alcohol; giant African snail.
