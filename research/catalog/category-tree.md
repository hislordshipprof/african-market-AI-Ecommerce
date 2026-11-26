# Category tree proposal: shop aisles for African and Afro-Caribbean grocers

Date: 2026-11-25. Question from the owner: "the catalogue abonaki can fall under ointments, we dont have for creams and pomades. are there no local shops you can check for ideas on how we can build the categories correctly".

Method: read each store's own navigation or its own `collections.json` / category pages (first-party pages, fetched 2026-11-25). Shop pages change; counts are the numbers the shop showed that day. Nothing here edits code, seed or the database.

## 1. Answer first

- Abonaki is spelled **Aboniki** by the maker and in our catalog (`aboniki-balm`). Shoppers search "aboniki", so keep that spelling and add "abonaki" as a search synonym.
- Aboniki, Robb and menthol balm go to **Health & Wellness > Balms & Ointments**. Creams go to **Beauty & Personal Care > Skin Care & Body Creams**. Pomades go to **Beauty & Personal Care > Hair Care > Pomades & Hair Food**.
- Real shops split on Aboniki: Abart Foods files it under Beauty and personal care > Personal care; Yado Market files Robb Original Ointment under "Health & Personal Care" (both evidenced below). A health aisle is the better fit because it is pain-relief, not cosmetic, and three of the nine shops (Abart, Yado, African Delights) run a health and wellness or remedies aisle.
- The seed already has 17 categories, not 8 (`prisma/seed-categories.ts`, `SEEDED_CATEGORIES`): the 8 the owner named plus Frozen, Beauty, Pantry Staples, Beans & Legumes, Breakfast & Dairy, Canned & Packaged, Fruits, Household, Seasonings & Sauces. So every catalog row has an aisle today. The gap is the second level: there is no ointment, cream, pomade or hair sub-aisle, and no health aisle. The `Category` model already has `parentId` (`prisma/schema.prisma` line 478), so two levels need no schema change.

## 2. Stores studied (top and second level, exact names)

Fetched by reading each store's navigation HTML or its public Shopify `/collections.json` list. "Not reached" stores are listed in section 7.

### 2.1 Abart Foods (US, WooCommerce) - strongest tree
Source: https://abartfoods.com/shop/ (category sidebar, with counts).
Top level then second level, verbatim:
- Bakery and bread > Bread and pastries
- Beauty and personal care (277) > Beauty/medicated soap and sanitizer; Body and skin care (150); Hair care (21); Oral care; Personal care (73) (https://abartfoods.com/product-category/beauty-and-personal-care/)
- Beverages (361) > Coffee drink; Juice and cider; Soda/ Malt drinks/Energy drinks; Tea/ cocoa drink; Water
- Breakfast and cereals > Cereals/porridge/oatmeal
- Dairy and Eggs > Butter; Cheese; Coffee creamer; Eggs; Milk and milk substitutes; Yogurt and sour cream
- Flours (165) > Cassava Fufu; Corn Fufu; Garri; Millet flour; Plantain Fufu; Potato/wheat flour; Yam Flour
- Fresh produce > fresh fruits; Fresh vegetable and salad; Tubers
- Frozen item (115) > African plum; Frozen vegetable and leaves; Frozen Yuca, corn and millet
- Health & Beauty (78) > Natural & Alternative Remedies; Skin Lightening; Vitamins & Supplements (https://abartfoods.com/product-category/health-beauty/)
- Health and wellness (108) > Bitters and Roots; Capsules/syrup
- Kitchen and household essentials (242) > Candles and Air fresheners; Laundry; Paper /plastic and kitchen products; Soap and cleaner
- Leaves and seeds > Dried Leaves; Seeds and Roots
- Meat and Seafoods (102) > Beef; Chickens; Dried and smoked fish; Frozen fish/shrim/snails; Goat meat; Pork; Sausages; Turkey
- Pantry essential (947) > Baking supplies and ingredients; Canned food; Noodles, Sauces & Instant Food; Oil and vinegars/ palm soup; Pasta, rice and grains; Sauces and salsa; Soups and broth; Spices and seasoning (300); Spreads, condiments and dressings
- Snacks food and candy > Chips, crackers and popcorn; Cookies and sweets; Nuts and dried fruits
- Also: Games, Wholesale, Combo Deals, Best Selling Products (merchandising buckets, not aisles).
Aboniki evidence: the product page https://abartfoods.com/product/aboniki-balm-25g/ lists "Categories: Beauty and personal care, Personal care".
Lesson: a big shop still keeps frozen vegetables and leaves under Frozen, dried/smoked fish under Meat and Seafoods, and splits Beauty from Health. Its weakness (two overlapping health aisles, "Uncategorized (243)", typos like "Laudry") is what to avoid.

### 2.2 Yado Market (US, Shopify, Chicago) - best on beauty and health names
Source: homepage navigation https://yadomarket.com/ and https://yadomarket.com/collections.json (99 collections).
Menu, verbatim:
- FOOD & GROCERY (/collections/african-grocery-store): Rice & Grains; Fufu, Flour, Gari & Swallow; Beans & Legumes; Spices & Seasonings; Bara Musso Seasonings; Palm Oil, Zomi & Cooking Oils; Sauces & Condiments; Tomato Paste & Cooking Sauces; Fish & Seafood; Canned Foods; Pasta & Noodles; Breakfast Foods; Drinks & Malta; Snacks; Biscuits & Cookies; Candy & Sweets
- BITTERS & TEAS: Soursop Bitters; All Bitters; Herbal Teas; Jamaican Herbs & Bush Teas; Leaves & Herbs
- BEAUTY & BODY (/collections/body-oils-creams-lotions): Shea Butter; African Black Soap; Bar Soaps; Liquid Soap; Body Oils, Creams & Lotions; Hair Care; Bath Bombs; Fragrance & Burner Oils; Forever Living
- BEST SELLERS: African & Caribbean Food; Herbal Bitters & Teas; Skin, Hair & Beauty
Other collection names in `collections.json`: Health & Personal Care (163), Lotion & Cream (82), Skin care (206), Soap (110), Milo, Bournvita & Ovaltine Malt Drinks, Malta Drinks, Evaporated Milk & Condensed Milk, Arabian Perfume Oils & Bakhoor Air Fresheners, African Net Sponge.
Product evidence from https://yadomarket.com/collections/shop-all-departments-1/products.json: "Robb Original Ointment | Soothing Topical Comfort" is tagged Health and Healing Product; "Victago Pommade - African Herbal Massage Balm" has product type "Massage balm", tags Balm, Health & Beauty, Health & Personal care; "Chambers Chapter 2000 Hair & Scalp Pomade 160g" and "Sode Pommade - Hair & Scalp Conditioning Pomade" are tagged hair care; "Nature's Blessings Hair Pomade" is tagged cosmetic.
Lesson: this is the only shop that gives creams and shea butter their own names ("Body Oils, Creams & Lotions", "Lotion & Cream", "Shea Butter"). Pomade is a hair product; balm and ointment are health.

### 2.3 African Delights (US, Shopify, Pennsylvania)
Source: https://africandelightstore.com/ (main menu) and https://africandelightstore.com/collections.json.
Main menu, verbatim: Groceries; Spices & Sauces; Drinks; Beauty & Personal Care; Clothing; Home & Arts; Wholesale. Top bar: Shop Aisles; Shop Sales; Shop by Country; Shop Brands.
Second level from `collections.json`: Groceries > Baby Cereals, Breakfast, Canned, Cooking, Dried Beans, Milk, Pantry, Pantry Essentials, Produce, Ready to Eat; Spices & Sauces > Bouillon, Pepper, Sauces; Drinks > Canned Milk, Coffee, Dry Milk, Fruit Juice, Soda, Tea; Beauty & Personal Care > Cough Candy, Moisturizers, Soaps & Cleansers, Wellness; also Bath & Body, Baby (25), Household Essentials, Energy & Herbal Drink, Cooking Essentials, Frozen Fish & Meat, Dried Fish, Fufu & Swallow Foods.
Product types seen in the catalog: Shea Butter, Black Soap, Prayer Mat, Asanka (clay pot), Banku Stick (https://africandelightstore.com/collections/all-products/products.json).
Lesson: puts cough candy (Robb) and "Wellness" inside Beauty. Shows baby, prayer mat and cookware are real, but small: they live under Home & Arts, not their own aisle.

### 2.4 Shop Africa USA (US, Shopify)
Source: https://shopafricausa.com/ main menu and https://shopafricausa.com/collections.json (128 collections).
Verbatim: Food & Pantry > Groceries; African Snacks; Rice & Grains; Spices & Seasonings; Dry Fish & Seafood; Drinks & Beverages. Fashion; Beauty & Wellness > Hair & Extensions; Jewelry & Accessories; Home & Decor; Art & Culture; Gifts; Shop by Country; Bundles.
Lesson: food is secondary to fashion and art here; beauty has only 11 products. It confirms shoppers say "Dry Fish" and "Hair & Extensions", not a combined name.

### 2.5 Nigerianstore.com (US, Shopify)
Source: https://www.nigerianstore.com/collections.json (33 collections).
Food and care names: African Groceries (47); African Seasoning & Spices (40); Nigerian & African Beverages; Nigerian & African Snacks; Groceries & Toiletries; Skincare & Beauty Products (43). The rest is fashion, books, movies and jewelry.
Lesson: confirms "Seasoning & Spices" and "Skincare & Beauty Products" as shopper wording.

### 2.6 Your Own African Store (US)
Source: https://yourownafricanstore.com/ "Shop By Category" block: Fufu & Garri; Rice & Grains; Canned Foods; Oils & Sauces; Seasonings; Soup Ingredients; Fish & Seafood; Frozen Foods; Snacks & Drinks; Beans & Flour. Plus Shop By Country (Liberia, Nigeria, Ghana, Sierra Leone, Caribbean).
Lesson: names "Soup Ingredients" as an aisle; groups oils with sauces.

### 2.7 Alpha Fresh Food (US)
Source: https://alphafreshfood.com/ menu: FROZEN FOOD; FLOUR; SPICES; FISH; DRINKS; FOOD & GROCERIES. Six aisles, no second level (the small-store baseline).

### 2.8 Obateni Foods (UK, WooCommerce)
Source: https://obatenifoods.co.uk/ "Categories" menu, verbatim: bread and pastries; candy & sweet; Canned and paste; combo; Dried Ingredients; Drinks; Flours and Grains; Fresh fish; Fresh vegetables; Frozen Poultry/Meat; frozen vegetables; Hair and Body Cream; Hair Extensions; Milk and butter; NATURAL SEASONINGS AND DRY INGREDIENTS; Oil; pap and custard; Pasta and Noodles; PASTE, SEASONING AND INGREDIENTS; plastic &coolers; RICE AND GRAINS; Seasoning and Spices; Snacks; TEA, SNACKS BEVERAGES; Uncategorized; Vegetables & Fruits (> Dried Vegetables, Fresh Vegetables); Yam.
https://obatenifoods.co.uk/product-category/hair-and-body-cream/ lists relaxers, shea butter, whitening creams, soap and dusting powder together.
Lesson: a UK shop where one "Hair and Body Cream" bucket holds everything non-food; duplicate names (two rice aisles, two seasoning aisles, "Uncategorized") show what happens without a tree.

### 2.9 Danlex Wholesale Foods (Calgary, Canada; the origin teardown)
`research/danlex-teardown.md` records stack and checkout only; it lists no categories. The live shop https://danlexwholesalefoods.com/shop shows filter buttons: All (17); Tubers (4); Vegetables (3); Cereals (1); Spices (1); Cream and Nuts (4); Oil (1); Fruits (1); Other (2). The public API https://danlexwholesalefoods.com/api/categories returns the same set (Tubers, Vegetables, Spices, Cereals, Cream and Nuts, Oil, Fruits). No beauty, health, frozen or household aisle, and "Cream and Nuts" is a food label (not skin cream).
Lesson: a 17-product shop needs 8 flat names; ours holds 500 catalog products and many stores, so we need two levels.

## 3. Patterns across the shops

1. Every shop with a beauty aisle keeps **soap, black soap, shea butter, creams/lotions, hair** inside it (Yado, Abart, African Delights, Nigerianstore). Shea butter is Beauty, not Oils.
2. Health is separate in 3 of 9 shops: Abart "Health and wellness" and "Health & Beauty > Natural & Alternative Remedies", Yado "Bitters & Teas" and "Health & Personal Care", African Delights "Wellness".
3. **Hair care** has its own sub-aisle everywhere it exists (Yado "Hair Care", Abart "Hair care", Obateni "Hair and Body Cream" + "Hair Extensions", Shop Africa "Hair & Extensions"). Wigs and extensions are fashion; we do not sell them.
4. "Soup ingredients / leaves and seeds / dried ingredients" is a named aisle (Your Own African Store, Abart "Leaves and seeds", Obateni "Dried Ingredients").
5. Frozen is always its own aisle (Abart, Alpha Fresh, Your Own African Store, Obateni). Dried fish sits with fish (Abart "Dried and smoked fish", Shop Africa "Dry Fish & Seafood").
6. Malt (Milo, Bournvita, Malta) is a drink (Yado "Milo, Bournvita & Ovaltine Malt Drinks", Abart "Soda/ Malt drinks/Energy drinks").
7. Baby, prayer items and cookware are small: Baby is a few products (African Delights Baby, 25), prayer mat and asanka sit in Home and Arts. None is an aisle on its own in a grocery-first shop.
8. Palm oil is with oil and cooking (Yado "Palm Oil, Zomi & Cooking Oils", Abart "Oil and vinegars/ palm soup").

## 4. Proposed tree (16 aisles)

Names use the shopper words from section 2. Rules are one line each.

| # | Aisle | Subcategories | Edge-case rule |
|---|---|---|---|
| 1 | Tubers & Roots | Yam; Cocoyam & Taro; Cassava; Sweet Potato & Other Roots | Fresh or whole tubers only; the flour made from them goes to Fufu, Flours & Swallow. Plantain is not a tuber: it goes to Fresh Produce. |
| 2 | Fresh Produce | Vegetables; Leafy Greens & Wrapping Leaves; Fresh Peppers & Herbs; Fruits; Plantain & Cooking Bananas | Only chilled or fresh. Dried leaves go to Soup Ingredients; frozen leaves go to Frozen. |
| 3 | Fufu, Flours & Swallow | Fufu & Swallow Flours; Garri & Cassava Flour; Maize Meal & Ugali; Flours & Baking; Plantain, Yam & Cocoyam Flours | Anything ground to eat as a swallow or bake with. Whole grains go to Rice, Grains & Beans. |
| 4 | Rice, Grains & Beans | Rice; Beans & Peas; Lentils; Grains, Couscous & Millet | Dry beans here; canned beans go to Canned & Packaged; bean flour goes to Flours. |
| 5 | Soup Ingredients | Egusi & Melon Seeds; Ogbono & Thickeners; Dried Leaves & Vegetables; Fermented Seasonings (iru, ogiri); Soup Bases & Mixes | What goes into a pot of soup that is not a spice or a fish. Crayfish go to Fish & Meat. |
| 6 | Spices & Seasonings | Whole Spices; Ground Spices; Spice Blends & Suya Spice; Dried Peppers & Pepper Powder; Stock Cubes & Bouillon | Dry flavourings. Wet sauces and pastes go to Oils, Sauces & Condiments. |
| 7 | Oils, Sauces & Condiments | Palm Oil; Cooking Oils; Ghee & Cooking Butter; Pepper Sauces & Shito; Tomato Paste; Sauces & Condiments | Palm oil is here, shea butter is in Beauty. Cooking butter and ghee here; body butter goes to Beauty. |
| 8 | Fish & Meat | Dried & Smoked Fish; Stockfish; Crayfish & Shrimp (dried); Dried Meat, Ponmo & Insects | Dried, smoked or salted only. Frozen fish and frozen meat go to Frozen. |
| 9 | Frozen | Frozen Fish & Seafood; Frozen Meat & Poultry; Frozen Leaves & Vegetables; Frozen Swallow & Dough; Frozen Snacks & Ready Meals | Storage decides: if it ships frozen it lives here. |
| 10 | Canned & Packaged | Canned Fish & Meat; Canned Vegetables, Beans & Fruit; Noodles & Pasta; Instant & Ready Meals | Tins, cartons and instant packs. Canned milk goes to Breakfast & Dairy. |
| 11 | Breakfast & Dairy | Cereals & Porridge; Pap, Ogi & Custard; Milk & Cream; Cheese, Spreads & Sugar; Bread & Bakery | Milk powder and evaporated milk here. Milo, Bournvita and Ovaltine go to Drinks. |
| 12 | Snacks & Sweets | Chips & Savoury Snacks; Biscuits & Baked Snacks; Sweets & Chocolate; Nuts, Seeds & Dried Fruit; Kola Nuts; Meat Snacks (kilishi, biltong) | Eaten out of the packet. Menthol cough candy (Robb sweets) is a sweet. |
| 13 | Drinks | Soft Drinks & Water; Malt, Cocoa & Nutrition Drinks; Juice & Cordials; Tea & Coffee; Traditional & Herbal Drinks (zobo, sobolo) | Ready or mix-and-drink. Herbal bitters sold as a remedy go to Health & Wellness. |
| 14 | Health & Wellness | Balms & Ointments; Bitters & Herbal Remedies; Natural Remedies; Vitamins & Supplements | Pain relief, chest rubs and remedies. If it is for looks or skin feel, it is Beauty. |
| 15 | Beauty & Personal Care | Skin Care & Body Creams; Shea Butter & Natural Butters; Soap & Black Soap; Hair Care (Pomades & Hair Food; Relaxers & Treatments; Hair Oils; Henna & Natural Dyes); Oral Care & Bath Tools; Traditional Body Care & Fragrance | Cosmetic, hair and skin items. Pomade is hair care. A balm sold for pain is Health & Wellness. |
| 16 | Household & Kitchen | Cookware & Utensils (mortar and pestle, pots, turning sticks); Coffee Ceremony; Incense & Fragrance; Cleaning & Laundry; Prayer & Cultural Items; Baby | Things you use, not eat or put on skin. Baby food goes to Breakfast & Dairy; baby care waits until we carry it. |

Notes:
- Subcategory names in rows 14 to 16 for products we do not carry yet (Vitamins & Supplements, Relaxers & Treatments, Hair Oils, Cleaning & Laundry, Prayer & Cultural Items, Baby) are shopper-evidenced (Abart, Yado, African Delights) but have no catalog rows today. Create them only when a store lists such a product.
- Each aisle has 4 to 6 subcategories, inside the 3 to 8 asked for.
- 2 levels only: aisle > subcategory. No deeper level, as in every shop studied.
- Tax: the seed sets Stripe tax codes per slug (`taxCodes` in `prisma/seed-categories.ts`: snacks, drinks, beauty, household have their own). A new Health & Wellness aisle needs a tax-code decision (a drug-like balm may be taxed differently from a cosmetic). Not decided here.

### Edge cases in one place
- Palm oil: Oils, Sauces & Condiments. Shea butter, black soap, cocoa butter for skin: Beauty.
- Dried, smoked, salted fish: Fish & Meat. Frozen fish: Frozen.
- Dried leaves (ugu, bitterleaf): Soup Ingredients. Fresh leaves: Fresh Produce. Frozen leaves: Frozen.
- Egusi and ogbono: Soup Ingredients (today under Spices).
- Garri and fufu flour: Fufu, Flours & Swallow (garri is today under Tubers).
- Malta, Milo, Bournvita: Drinks. Milk powder (Peak, Nido): Breakfast & Dairy.
- Aboniki, Robb ointment, menthol crystals, Victago balm: Health & Wellness > Balms & Ointments.
- Body cream, lotion, petroleum jelly, camphor cream, milking jelly: Beauty > Skin Care & Body Creams.
- Hair pomade, hair food, relaxer, henna: Beauty > Hair Care.
- Chewing stick, miswak, net sponge: Beauty > Oral Care & Bath Tools.
- Incense, bakhoor, frankincense: Household & Kitchen > Incense & Fragrance. Perfume oil and body-smoking woods: Beauty > Traditional Body Care & Fragrance.
- Kola nut: Snacks & Sweets. Bitter kola: Health & Wellness > Bitters & Herbal Remedies (chewed for health; Abart files bitters and roots as health).
- Mortar and pestle, asanka, turning stick: Household & Kitchen > Cookware & Utensils.

## 5. Master catalog mapping

Source: `research/catalog/master-catalog.csv` (501 rows, 16 category slugs; README at `research/catalog/README.md`). Every (category, subcategory) pair maps to one aisle and subcategory; no row is left without an aisle (checked by script: 0 unmapped). Rows per new aisle: Tubers & Roots 8; Fresh Produce 29; Fufu, Flours & Swallow 44; Rice, Grains & Beans 36; Soup Ingredients 36; Spices & Seasonings 66; Oils, Sauces & Condiments 28; Fish & Meat 30; Frozen 52; Canned & Packaged 19; Breakfast & Dairy 37; Snacks & Sweets 39; Drinks 41; Health & Wellness 4; Beauty & Personal Care 16; Household & Kitchen 16.

Findings from the catalog:
- All non-food catalog rows (14 beauty, 20 household) already have an aisle in the seed, but only one place for Aboniki: Beauty. The catalog row `aboniki-balm` is in `beauty` / `skin care`; the Nigeria source CSV (`research/catalog/west-africa-nigeria.csv`) had it as `balms`.
- Four rows move into Health & Wellness: `aboniki-balm`, `alum-stone`, `bitter-kola`, `sea-moss-dried`. The aisle is thin; it grows only if stores list Robb, menthol, bitters. Decision for the owner: whether to open Health & Wellness now or keep Balms & Ointments inside Beauty until more health products exist.
- No catalog row exists for creams other than `ingrams-camphor-cream`, `arimis-milking-jelly`, `bio-oil`, and no row for pomade, relaxer or Robb. Stores will add them as proposals; the sub-aisles should exist first.
- Catalog items the README flagged as proposed additions (`beans-and-legumes`, `seasonings-and-sauces`, `breakfast-and-dairy`, `canned-and-packaged`, `household`) are all in the seed already.

### 5.1 Full mapping, by catalog category and subcategory

| Catalog category | Catalog subcategory | New aisle > subcategory | Rows |
|---|---|---|---|
| beans-and-legumes | dried beans | Rice, Grains & Beans > Beans & Peas | 13 |
| beans-and-legumes | dried mixes | Rice, Grains & Beans > Beans & Peas | 2 |
| beans-and-legumes | fermented seeds | Soup Ingredients > Fermented Seasonings (iru, ogiri) | 1 |
| beans-and-legumes | legume flours | Fufu, Flours & Swallow > Flours & Baking | 3 |
| beans-and-legumes | lentils and split peas | Rice, Grains & Beans > Beans & Peas | 2 |
| beans-and-legumes | seeds and nuts | Soup Ingredients > Egusi & Melon Seeds | 2 |
| beauty | hair dye | Beauty & Personal Care > Hair Care | 1 |
| beauty | skin and hair | Beauty & Personal Care > Shea Butter & Natural Butters | 2 |
| beauty | skin and hair | Beauty & Personal Care > Skin Care & Body Creams | 1 |
| beauty | skin and hair | Beauty & Personal Care > Hair Care | 1 |
| beauty | skin care | Health & Wellness > Balms & Ointments | 1 |
| beauty | skin care | Beauty & Personal Care > Skin Care & Body Creams | 3 |
| beauty | soap | Beauty & Personal Care > Soap & Black Soap | 2 |
| beauty | traditional body care | Beauty & Personal Care > Traditional Body Care & Fragrance | 3 |
| breakfast-and-dairy | bread | Breakfast & Dairy > Bread & Bakery | 3 |
| breakfast-and-dairy | cereals | Breakfast & Dairy > Cereals & Porridge | 5 |
| breakfast-and-dairy | cheese | Breakfast & Dairy > Cheese, Spreads & Sugar | 2 |
| breakfast-and-dairy | cocoa and malt drinks | Drinks > Malt, Cocoa & Nutrition Drinks | 4 |
| breakfast-and-dairy | custard | Breakfast & Dairy > Pap, Ogi & Custard | 1 |
| breakfast-and-dairy | evaporated milk | Breakfast & Dairy > Milk & Cream | 2 |
| breakfast-and-dairy | milk | Breakfast & Dairy > Milk & Cream | 1 |
| breakfast-and-dairy | pap (ogi) | Breakfast & Dairy > Pap, Ogi & Custard | 3 |
| breakfast-and-dairy | porridge mixes | Breakfast & Dairy > Cereals & Porridge | 8 |
| breakfast-and-dairy | powdered milk | Breakfast & Dairy > Milk & Cream | 5 |
| breakfast-and-dairy | spreads | Breakfast & Dairy > Cheese, Spreads & Sugar | 2 |
| breakfast-and-dairy | sugar | Breakfast & Dairy > Cheese, Spreads & Sugar | 1 |
| canned-and-packaged | canned beans | Canned & Packaged > Canned Vegetables, Beans & Fruit | 4 |
| canned-and-packaged | canned fish | Canned & Packaged > Canned Fish & Meat | 6 |
| canned-and-packaged | canned fruit | Canned & Packaged > Canned Vegetables, Beans & Fruit | 1 |
| canned-and-packaged | canned meat | Canned & Packaged > Canned Fish & Meat | 2 |
| canned-and-packaged | canned milk | Breakfast & Dairy > Milk & Cream | 1 |
| canned-and-packaged | canned relish | Canned & Packaged > Canned Vegetables, Beans & Fruit | 1 |
| canned-and-packaged | canned vegetables | Canned & Packaged > Canned Vegetables, Beans & Fruit | 2 |
| canned-and-packaged | noodles | Canned & Packaged > Noodles & Pasta | 2 |
| canned-and-packaged | pasta | Canned & Packaged > Noodles & Pasta | 1 |
| canned-and-packaged | soup mixes | Soup Ingredients > Soup Bases & Mixes | 1 |
| drinks | coffee | Drinks > Tea & Coffee | 5 |
| drinks | cordials | Drinks > Juice & Cordials | 3 |
| drinks | drink ingredients | Drinks > Traditional & Herbal Drinks | 2 |
| drinks | drink ingredients | Health & Wellness > Natural Remedies | 1 |
| drinks | juices | Drinks > Juice & Cordials | 5 |
| drinks | malt and nutrition drinks | Drinks > Malt, Cocoa & Nutrition Drinks | 5 |
| drinks | soft drinks | Drinks > Soft Drinks & Water | 6 |
| drinks | tea | Drinks > Tea & Coffee | 8 |
| drinks | traditional drinks | Drinks > Traditional & Herbal Drinks | 3 |
| fish-and-meat | cow skin | Fish & Meat > Dried Meat, Ponmo & Insects | 1 |
| fish-and-meat | dried crayfish | Fish & Meat > Crayfish & Shrimp (dried) | 3 |
| fish-and-meat | dried fish | Fish & Meat > Dried & Smoked Fish | 4 |
| fish-and-meat | dried insects | Fish & Meat > Dried Meat, Ponmo & Insects | 2 |
| fish-and-meat | dried meat | Fish & Meat > Dried Meat, Ponmo & Insects | 3 |
| fish-and-meat | fermented fish | Fish & Meat > Dried & Smoked Fish | 3 |
| fish-and-meat | salted fish | Fish & Meat > Dried & Smoked Fish | 3 |
| fish-and-meat | smoked fish | Fish & Meat > Dried & Smoked Fish | 7 |
| fish-and-meat | stockfish | Fish & Meat > Stockfish | 4 |
| frozen | frozen breads and dough | Frozen > Frozen Swallow & Dough | 3 |
| frozen | frozen fish | Frozen > Frozen Fish & Seafood | 7 |
| frozen | frozen fruit | Frozen > Frozen Leaves & Vegetables | 1 |
| frozen | frozen leaves | Frozen > Frozen Leaves & Vegetables | 14 |
| frozen | frozen meat | Frozen > Frozen Meat & Poultry | 9 |
| frozen | frozen snacks | Frozen > Frozen Snacks & Ready Meals | 2 |
| frozen | frozen swallow and doughs | Frozen > Frozen Swallow & Dough | 12 |
| frozen | frozen vegetables | Frozen > Frozen Leaves & Vegetables | 4 |
| fruits | dried fruit | Snacks & Sweets > Nuts, Seeds & Dried Fruit | 4 |
| fruits | fresh fruit | Fresh Produce > Fruits | 4 |
| grains-and-flours | baking mixes | Fufu, Flours & Swallow > Flours & Baking | 2 |
| grains-and-flours | bean flours | Fufu, Flours & Swallow > Flours & Baking | 2 |
| grains-and-flours | breads and flatbreads | Breakfast & Dairy > Bread & Bakery | 3 |
| grains-and-flours | couscous and grits | Rice, Grains & Beans > Grains, Couscous & Millet | 2 |
| grains-and-flours | flours | Fufu, Flours & Swallow > Flours & Baking | 8 |
| grains-and-flours | grains | Rice, Grains & Beans > Grains, Couscous & Millet | 7 |
| grains-and-flours | maize meal | Fufu, Flours & Swallow > Maize Meal & Ugali | 7 |
| grains-and-flours | rice | Rice, Grains & Beans > Rice | 8 |
| grains-and-flours | seeds | Rice, Grains & Beans > Grains, Couscous & Millet | 2 |
| grains-and-flours | swallow flours | Fufu, Flours & Swallow > Fufu & Swallow Flours | 6 |
| household | coffee ceremony | Household & Kitchen > Coffee Ceremony | 4 |
| household | incense | Household & Kitchen > Incense & Fragrance | 5 |
| household | kitchen tools | Household & Kitchen > Cookware & Utensils | 7 |
| household | personal care | Beauty & Personal Care > Oral Care & Bath Tools | 3 |
| household | personal care | Health & Wellness > Natural Remedies | 1 |
| oils | clarified butter | Oils, Sauces & Condiments > Ghee & Cooking Butter | 2 |
| oils | cooking oils and fats | Oils, Sauces & Condiments > Cooking Oils | 2 |
| oils | palm oil | Oils, Sauces & Condiments > Palm Oil | 4 |
| oils | specialty oils | Oils, Sauces & Condiments > Cooking Oils | 2 |
| seasonings-and-sauces | condiments | Oils, Sauces & Condiments > Sauces & Condiments | 5 |
| seasonings-and-sauces | cooking aids | Spices & Seasonings > Stock Cubes & Bouillon | 2 |
| seasonings-and-sauces | fermented seasonings | Soup Ingredients > Fermented Seasonings (iru, ogiri) | 5 |
| seasonings-and-sauces | marinades | Oils, Sauces & Condiments > Sauces & Condiments | 2 |
| seasonings-and-sauces | pepper sauces and pastes | Oils, Sauces & Condiments > Pepper Sauces & Shito | 6 |
| seasonings-and-sauces | ready sauces | Oils, Sauces & Condiments > Sauces & Condiments | 1 |
| seasonings-and-sauces | soup bases | Soup Ingredients > Soup Bases & Mixes | 2 |
| seasonings-and-sauces | stock cubes and seasoning | Spices & Seasonings > Stock Cubes & Bouillon | 13 |
| seasonings-and-sauces | tomato paste | Oils, Sauces & Condiments > Tomato Paste | 4 |
| snacks | baked snacks | Snacks & Sweets > Biscuits & Baked Snacks | 2 |
| snacks | biscuits | Snacks & Sweets > Biscuits & Baked Snacks | 5 |
| snacks | chips | Snacks & Sweets > Chips & Savoury Snacks | 4 |
| snacks | kola nuts | Health & Wellness > Bitters & Herbal Remedies | 1 |
| snacks | kola nuts | Snacks & Sweets > Kola Nuts | 2 |
| snacks | meat snacks | Snacks & Sweets > Meat Snacks (kilishi, biltong) | 1 |
| snacks | nuts | Snacks & Sweets > Nuts, Seeds & Dried Fruit | 6 |
| snacks | savoury snacks | Snacks & Sweets > Chips & Savoury Snacks | 4 |
| snacks | snack mixes | Snacks & Sweets > Chips & Savoury Snacks | 1 |
| snacks | sweets and chocolate | Snacks & Sweets > Sweets & Chocolate | 10 |
| spices | dried herbs and leaves | Soup Ingredients > Dried Leaves & Vegetables | 6 |
| spices | dried peppers | Spices & Seasonings > Dried Peppers & Pepper Powder | 5 |
| spices | ground spices | Spices & Seasonings > Ground Spices | 3 |
| spices | soup seeds and thickeners | Soup Ingredients > Egusi & Melon Seeds | 7 |
| spices | spice blends | Spices & Seasonings > Spice Blends & Suya Spice | 20 |
| spices | whole spices | Spices & Seasonings > Whole Spices | 23 |
| tubers | cassava products | Tubers & Roots > Cassava | 2 |
| tubers | cooking bananas and breadfruit | Fresh Produce > Plantain & Cooking Bananas | 2 |
| tubers | fresh tubers | Tubers & Roots > Yam | 6 |
| tubers | garri | Fufu, Flours & Swallow > Garri & Cassava Flour | 4 |
| tubers | swallow flours | Fufu, Flours & Swallow > Fufu & Swallow Flours | 12 |
| vegetables | dried leaves | Soup Ingredients > Dried Leaves & Vegetables | 10 |
| vegetables | dried vegetables | Soup Ingredients > Dried Leaves & Vegetables | 2 |
| vegetables | fresh herbs | Fresh Produce > Fresh Peppers & Herbs | 1 |
| vegetables | fresh peppers | Fresh Produce > Fresh Peppers & Herbs | 4 |
| vegetables | fresh vegetables | Fresh Produce > Vegetables | 6 |
| vegetables | leafy greens | Fresh Produce > Leafy Greens & Wrapping Leaves | 9 |
| vegetables | plantain | Fresh Produce > Plantain & Cooking Bananas | 2 |
| vegetables | wrapping leaves | Fresh Produce > Leafy Greens & Wrapping Leaves | 1 |
### 5.2 Products that change aisle (110 of 501)

A product "moves" when its new aisle differs from the aisle its catalog category maps to today. Format: old catalog category -> new aisle > subcategory (count): products.

- **beans-and-legumes -> Fufu, Flours & Swallow > Flours & Baking** (3): Shiro powder (spiced chickpea/pea flour) (`shiro-powder`); Nech shiro (mild white shiro powder) (`nech-shiro-powder`); Hilbet powder (Eritrean legume and fenugreek dip mix) (`hilbet-powder`)
- **beans-and-legumes -> Soup Ingredients > Egusi & Melon Seeds** (2): African breadfruit seeds (ukwa) (`ukwa-breadfruit`); Raw groundnuts (peanuts) (`groundnuts-raw`)
- **beans-and-legumes -> Soup Ingredients > Fermented Seasonings (iru, ogiri)** (1): Fermented oil bean slices (ugba) (`ugba-oil-bean`)
- **beauty -> Health & Wellness > Balms & Ointments** (1): Aboniki balm (`aboniki-balm`)
- **breakfast-and-dairy -> Drinks > Malt, Cocoa & Nutrition Drinks** (4): Milo chocolate malt drink (`milo`); Cadbury Bournvita (`bournvita`); Ovaltine (`ovaltine`); Golden Tree cocoa powder (`golden-tree-cocoa`)
- **canned-and-packaged -> Breakfast & Dairy > Milk & Cream** (1): Coconut milk, canned (`coconut-milk-canned`)
- **canned-and-packaged -> Soup Ingredients > Soup Bases & Mixes** (1): Grace Cock Flavoured Soup Mix (`grace-cock-soup-mix`)
- **drinks -> Health & Wellness > Natural Remedies** (1): Sea moss (Irish moss), dried (`sea-moss-dried`)
- **fruits -> Snacks & Sweets > Nuts, Seeds & Dried Fruit** (4): Baobab fruit powder (bouye) (`baobab-fruit-powder`); Tamarind (pods, pulp or block) (`tamarind`); Dates (timir, tamr) (`dates`); Baobab fruit pulp pieces (with seeds) (`baobab-fruit-pulp`)
- **grains-and-flours -> Breakfast & Dairy > Bread & Bakery** (3): Injera (teff flatbread) (`injera`); Bammy (Jamaican cassava flatbread) (`bammy`); Hard dough bread (hardo) (`hard-dough-bread`)
- **grains-and-flours -> Rice, Grains & Beans > Grains, Couscous & Millet** (11): Pearl millet (`millet-pearl`); Fonio (`fonio`); Guinea corn (sorghum) (`sorghum-guinea-corn`); Dried corn (maize kernels) (`corn-dried-whole`); Millet couscous (thiéré) (`couscous-de-mil`); Millet grits (sankal) (`sankal-millet-grits`); Teff grain (whole) (`teff-grain-whole`); Kinche (cracked wheat) (`kinche-cracked-wheat`); Flaxseed (telba) (`telba-flaxseed`); Niger seed (nug) (`nug-niger-seed`); Samp (dried crushed maize kernels) (`samp-crushed-maize`)
- **grains-and-flours -> Rice, Grains & Beans > Rice** (8): Ofada rice (`rice-ofada`); Long grain parboiled rice (`rice-parboiled-long-grain`); Broken rice (riz brisé) (`rice-broken`); Country rice (local West African rice) (`rice-country-liberia`); Basmati rice (bariis) (`basmati-rice-somali`); Tastic rice (`tastic-rice`); Pishori rice (Kenyan aromatic rice) (`pishori-rice`); Thai jasmine rice (hom mali) (`rice-jasmine-thai`)
- **household -> Beauty & Personal Care > Oral Care & Bath Tools** (3): Chewing stick (`chewing-stick`); African net sponge (`african-net-sponge`); Miswak chewing stick (caday) (`miswak-caday`)
- **household -> Health & Wellness > Natural Remedies** (1): Alum (stone) (`alum-stone`)
- **seasonings-and-sauces -> Soup Ingredients > Fermented Seasonings (iru, ogiri)** (5): Dried fermented locust beans (dawadawa, soumbala, nététou), balls or powder (`dawadawa-dried`); Fermented locust beans (iru) (`iru-fermented-locust-beans`); Ogiri (fermented seed paste) (`ogiri`); Datou / bikalga (fermented roselle seed seasoning) (`datou`); Kawal (fermented sicklepod leaves) (`kawal-fermented-leaves`)
- **seasonings-and-sauces -> Soup Ingredients > Soup Bases & Mixes** (2): Palm nut cream concentrate (banga, abenkwan, moambe, palm butter) (`palm-nut-cream`); Groundnut paste (unsweetened peanut paste) (`groundnut-paste`)
- **seasonings-and-sauces -> Spices & Seasonings > Stock Cubes & Bouillon** (15): Onga seasoning (`onga-seasoning`); Potash (kaun / akanwu) (`potash-kaun`); Maggi Star seasoning cubes (`maggi-star-cubes`); Maggi Crayfish seasoning cubes (`maggi-crayfish-cubes`); Knorr chicken cubes (`knorr-chicken-cubes`); Adja seasoning cubes and powder (`adja-seasoning`); Jumbo seasoning cubes (`jumbo-seasoning`); Remie seasoning powder (`remie-seasoning`); Ohene Yere seasoning powder (`ohene-yere-seasoning`); Royco Mchuzi Mix (`royco-mchuzi-mix`); Royco cubes (`royco-cubes`); Aromat all-purpose seasoning (`aromat-seasoning`); Goya Sazón seasoning (`goya-sazon`); Goya Adobo all-purpose seasoning (`goya-adobo`); Browning sauce (`browning-sauce`)
- **snacks -> Health & Wellness > Bitters & Herbal Remedies** (1): Bitter kola (`bitter-kola`)
- **spices -> Soup Ingredients > Dried Leaves & Vegetables** (6): Dried thyme (`thyme-dried`); Waakye leaves (dried sorghum leaf sheaths) (`waakye-leaves`); Koseret (dried Ethiopian herb) (`koseret`); Besobela (Ethiopian sacred basil) (`besobela`); Tena adam (rue) (`tena-adam-rue`); Gesho (buckthorn leaves and stems for brewing) (`gesho`)
- **spices -> Soup Ingredients > Egusi & Melon Seeds** (7): Egusi (melon seeds), shelled (`egusi-seeds-whole`); Egusi, ground (`egusi-ground`); Ogbono seeds, whole (`ogbono-whole`); Ogbono, ground (`ogbono-ground`); Achi (soup thickener) (`achi-thickener`); Ofor (soup thickener) (`ofor-thickener`); Ukpo (soup thickener) (`ukpo-thickener`)
- **tubers -> Fresh Produce > Plantain & Cooking Bananas** (2): Matoke (green cooking bananas) (`matoke-green-cooking-bananas`); Breadfruit (frozen or fresh) (`breadfruit-frozen`)
- **tubers -> Fufu, Flours & Swallow > Fufu & Swallow Flours** (12): Cocoyam flour (cocoyam fufu) (`cocoyam-flour`); Pounded yam flour (poundo yam) (`poundo-yam-flour`); Yam flour (elubo) for amala (`yam-flour-elubo`); Unripe plantain flour (`plantain-flour-unripe`); Cassava flour (lafun) (`cassava-flour-lafun`); Cassava fufu flour (akpu) (`cassava-fufu-flour`); Cassava starch (usi) (`cassava-starch-usi`); Plantain fufu flour (`fufu-flour-plantain`); Cassava and plantain fufu flour (`fufu-flour-cassava-plantain`); Instant fufu flour (potato starch blend) (`fufu-flour-instant-potato`); Kokonte (dried cassava flour) (`kokonte-flour`); Congolese fufu flour (cassava flour) (`cassava-flour-congolese-fufu`)
- **tubers -> Fufu, Flours & Swallow > Garri & Cassava Flour** (4): White garri (`garri-white`); Yellow garri (palm oil garri) (`garri-yellow`); Ijebu garri (`garri-ijebu`); Ghana gari (fine, white) (`gari-ghana`)
- **vegetables -> Soup Ingredients > Dried Leaves & Vegetables** (12): Baobab leaf powder (lalo, kuka) (`baobab-leaf-powder`); Moringa leaf powder (`moringa-powder`); Eru / okazi / afang / fumbwa leaves (Gnetum), dried and shredded (`fumbwa-dried-gnetum-leaves`); Dried okra, whole or powder (gombo sec, weika) (`okra-dried`); Bitter leaf, dried (`bitter-leaf-dried`); Uziza leaves, dried (`uziza-leaves-dried`); Utazi leaves, dried (`utazi-leaves-dried`); Oha (ora) leaves, dried (`oha-leaves-dried`); Scent leaf, dried (`scent-leaf-dried`); Fluted pumpkin leaves (ugu), dried (`ugu-leaves-dried`); Atama leaves, dried (`atama-leaves-dried`); Dried turkey berries (dried kittely) (`turkey-berry-dried`)

## 6. Suggested build order (for the owner to decide; not started)

1. Add Health & Wellness and the second level (`parentId`) in the seed; keep slugs of the existing aisles to avoid breaking listings.
2. Move the 110 products in 5.2 by re-pointing `category`/`subcategory` in the catalog CSV, then the importer.
3. Add search synonyms "abonaki", "aboniki", "robb", "pomade", "pommade" to the balm and hair rows.

## 7. What was not reached or checked

- Not reached: Jumia (HTTP 403 to automated fetch, https://www.jumia.com.ng/health-beauty/ timed out), Weee and Instacart (category pages returned no content to a plain fetch), Afroemporium (HTTP 402), Africana Food Arlington (maintenance page), AfroMarket, Ikorodu Market, African Food Express, Pan African Foods, Afro Asian Supermarket (domains guessed in the brief did not resolve or reset the connection; searches did not find official sites). Jumia's taxonomy is therefore not cited; the lists above are first-party for 9 stores only.
- Afrocosmopolitan (https://afrocosmopolitan.com) is a fashion and lifestyle magazine, not a store; excluded.
- Danlex teardown file has no category data; Danlex's live shop and API were used instead.
- Store trees are snapshots from 2026-11-25; counts change daily.
- Product-level evidence for Aboniki, Robb and pomade comes from only two shops (Abart, Yado); the Health versus Beauty choice for Aboniki rests on those two plus the Abart/Yado/African Delights health aisles.
- The mapping assigns by subcategory, so a few rows inside a subcategory may deserve a different home when a human reads them (for example some "personal care" rows).
