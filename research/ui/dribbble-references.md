# UI references: Dribbble and Behance

Research date: 2026-10-30. The hex values come from pixel sampling and colour quantisation of the published shot images and video frames, so treat them as close estimates, not the designers' own tokens. Constraints that apply throughout: **no yellow, no amber, no AI-style purple/violet/blue gradients.** Where a reference uses those colours, the notes say what to swap in.

---

## Part A: the user's picks

### A1. Dodolland: Local Marketplace Website
https://dribbble.com/shots/27712701-Dodolland-Local-Marketplace-Website (Tegar Putra / Agensip; 4 static desktop frames)

| Role | Hex | Note |
|---|---|---|
| Background | `#FAFAF2` | warm off-white, slightly green |
| Surface | `#FFFFFF` | cards |
| Primary (dark) | `#1C2C04` | very dark olive-forest, used for full-bleed bands |
| Accent | `#BCF45C` | electric lime, used on pill CTAs, "Buy Now", testimonial highlight cards |
| Tint | `#ECFCD4` | pale lime wash |
| Text | `#0A0A0A` / `#74645C` | near-black, warm grey meta text |

- **Type:** bold geometric sans (Plus Jakarta Sans / General Sans feel) for headlines, tight leading, 2–3 line display heads ("Top Products"). A serif shows up only inside product photography.
- **Layout:** split hero (large promo tile plus a smaller "30% off" tile); a horizontally scrolling "Top Products" rail with a tall label block on the left; a "Shop by Categories" mosaic in **monochrome / desaturated photos** of people working (culinary, fashion, handicraft, agriculture); a dark forest band with a cut-out basket image ("Get free delivery on shopping $200"); a dense 5-column product grid; a logo strip; testimonials as a masonry of white and lime cards; FAQ accordion.
- **Product card:** square photo, small category eyebrow, 2-line title, price, cart icon plus lime "Buy Now" pill. Radius about 12px on cards, fully pill-shaped buttons, almost no shadow (relies on the bg/surface contrast).
- **Imagery:** real photography. Category tiles use duotone/greyscale photos of people, which reads as editorial and premium. Hero products are cut-outs on soft gradient tiles.
- **Motion:** none shown (static shot).
- **Borrow:** desaturated "people behind the food" category mosaic (great for telling a store's story); dark full-bleed promo band; label-block-plus-rail pattern; pill CTA with an arrow chip.
- **Avoid:** the lime is close to chartreuse. Keep it to small, sparing accents or swap it for a mint. The 5-column grid is too dense for mobile-first.

### A2. Online Local Vendor Marketplace Website
https://dribbble.com/shots/18546519-Online-Local-Vendor-Marketplace-Website-Design (Harpreet Singh; 1 static long page)

| Role | Hex | Note |
|---|---|---|
| Background | `#FCFCFC` | |
| Frame/brand | `#B4D484` | sage-lime mount, plus `#7CBC2C` grass green in the UI |
| CTA | orange (about `#F07A2A`) | **conflicts with the constraint** |
| Pastel info tiles | `#FCE4BC`, `#DCECFC`, `#F4C4B4` | |
| Text | `#1A1A1A` | |

- **Type:** high-contrast display serif (Playfair-like) headline ("Fight Global Warming") over a stock photo, with a Poppins-style sans for body.
- **Layout:** classic 2019-era template: utility bar, hero photo with centred headline, a 4×2 grid of category photo cards with "See More" outline buttons, 3 pastel benefit tiles, a tabbed product carousel, testimonials, a blog row, a newsletter bar, and a fat footer.
- **Imagery:** generic stock lifestyle photos, plus bottles on white.
- **Motion:** none.
- **Borrow:** almost nothing visually. The **tabbed product rail** ("Health / Sports / Grocery…") is the only useful pattern.
- **Avoid:** stock photos, orange CTAs, an "everything centred" template feel, too many outline buttons. This is the weakest of the five picks.

### A3. Smart Food Delivery & Grocery App UI Design
https://dribbble.com/shots/27200176-Smart-Food-Delivery-Grocery-App-UI-Design (UX Crate; 1 static image. The attached video is an agency promo, not app motion.)

| Role | Hex | Note |
|---|---|---|
| Background | `#F4F4F4` to `#FFFFFF` | top of screen washed with a pale mint gradient `#E0FFE9` |
| Primary | `#03AF01` to `#0D8F04` | saturated green, used as a gradient on "Order Now" and the nav pill |
| Dark | `#143D1F` | promo banner |
| Macro chips | pastel red/green/yellow/blue tints | nutrition tiles |
| Text | `#111111`, `#646464` | |

- **Type:** neutral grotesk (Inter / SF-like), medium weights, small sizes; very "app default".
- **Layout:** greeting header with avatar and bell; search field plus a square filter button; segmented chips (Food / Grocery / Medicine / Drink); circular category thumbnails; a dark promo carousel with dot pager; 2-up dish cards; a **floating pill bottom nav** with the active tab expanded into a labelled green pill. The detail screen has a round cut-out hero, a stats row (rating / prep / cooking), macro tiles, and a sticky price plus "Order Now" footer.
- **Radius/shadow:** 16–24px cards, pill chips, soft drop shadows on the floating nav.
- **Borrow:** floating bottom nav whose active item expands with a label; a sticky bottom "price + primary CTA" bar on the product page; a stats row on product detail (useful for size / origin / heat level).
- **Avoid:** the over-saturated `#03AF01` gradient green (reads cheap) and the pastel macro tiles (off-brand for groceries).

### A4. Online Grocery App: Food Delivery & Shopping Lists UI
https://dribbble.com/shots/27268684-Online-Grocery-App-Food-Delivery-Shopping-Lists-UI (Sk Nahid Hasan; 3 static screens)

| Role | Hex | Note |
|---|---|---|
| Background | `#FCFCFC`; presentation bg `#E4DCD4` | |
| Primary | `#FC8C04` | orange: **conflicts with the constraint** |
| Promo | `#F4FCB4` / `#FCE45C` | yellow: **conflicts with the constraint** |
| Onboarding | `#FCE4FC` pink wash | |
| Text | `#111111` | |

- **Type:** rounded grotesk, medium. Mixed weights in the headline ("Your Healthy Market, **Simplified**").
- **Layout:** onboarding with a stacked-card photo carousel; home with a promo banner, icon chips, and a **"Recommended" carousel where the centre card is scaled up and neighbours peek** (coverflow); a shopping-lists screen made of full-width photo banners ("Diets & Values", "Seasonal", "Curator lists").
- **Imagery:** cut-out products (cans, baskets) breaking out of their cards; full-bleed food photos behind list titles.
- **Motion (implied):** coverflow carousel, stacked onboarding cards.
- **Borrow:** **curated list banners** (maps well onto "Jollof night essentials", "Christmas rice & stew", "Ramadan pantry" collections per store); a cut-out product breaking the card edge; a round "+" add button on the card corner.
- **Avoid:** the whole palette (orange + yellow). The coverflow is hard to use on the web; use a plain snap rail.

### A5. Grocery Delivery App Design (Musemind)
https://dribbble.com/shots/22661049-Grocery-Delivery-App-Design-Online-Grocery-App-UI-UX-Shopify (Musemind; 28s walkthrough video plus an agency promo)

| Role | Hex | Note |
|---|---|---|
| Background | `#F5FBFB` / `#FFFFFF` | cool white |
| Primary (header) | `#053532` | deep teal-green with a curved bottom edge |
| CTA | `#BBF773` | soft lime full-width pill ("Checkout $142.65", "Confirm order") |
| Tint | `#E1F8F0` | mint card wash |
| Promo accent | `#CD83B8` / plum `#6B1F55` | "Share cart" banner; **store-themed headers switch to plum per store** |
| Text | `#0F2A28`, `#7B8A88` | |

- **Type:** Inter/SF-style grotesk, semibold titles, prices with **superscript cents** (`17.²⁹$`).
- **Layout:** teal header with **convex curved bottom**, location line, and circular category icons sitting on the curve; a "You might need" rail of white cards with centred cut-out produce and a full-width "+" bar; **cart grouped by store** with "Delivery in 15 minute"; **per-line "Replace with ▸ [store/item]" row under every cart item** (exactly our swap rule); shared-cart banner; promo code; dark toast ("Get free delivery on this order"); payment screen with a map-thumbnail address card and a round payment-method picker.
- **Motion seen in video:** screen-to-screen walkthrough with smooth vertical scrolls, the header curve persisting across screens (shared element), a CTA that **fills left-to-right then morphs into "Order Confirm ✓"** (progress-to-success button), and a toast sliding up from the bottom.
- **Per-store theming:** the header colour switches (green vs plum) by store, which validates our white-label idea of one layout with store-colour tokens.
- **Borrow (high priority):** the "Replace with" row per cart line → our **swap rule** control; the fill-then-check confirm button; superscript cents; header colour as the single store-brand token; the dark contextual toast.
- **Avoid:** the curved header is slightly dated and hard to do responsively on desktop; keep it mobile-only or flatten it.

---

## Part B: further references

### B1. KUTOA: African restaurant brand identity (Behance)
https://www.behance.net/gallery/217723515/KUTOA-African-Brand-Identity-for-a-restaurant

| Bg | Primary | Secondary | Accent | Accent 2 | Text |
|---|---|---|---|---|---|
| `#F8F6EA` cream | `#D83838` hibiscus red | `#385838` moss | `#F8A8B8` blush | `#982818` oxblood | `#180808` |

- Hand-cut, stencil-like red logotype over warm food photography; **a custom set of geometric symbols (Adinkra-inspired, but redrawn as its own icon family)**, each labelled with a value (Purpose, Friendship, Quality…).
- Brand palette pulled straight from Lagos market street photography, shown as colour dots on the photo. This is the culturally grounded approach done without kente pattern.
- **Borrow:** a bespoke icon family for categories (Grains, Spices, Frozen, Beauty) instead of stock icons; cream bg plus a single strong red; taking the palette from a store's own photos. **Avoid:** the yellow and indigo from the photo dots.

### B2. Bantutaste: brand identity (Behance)
https://www.behance.net/gallery/196526349/Bantutaste

| Bg | Primary | Deep | Light | Text |
|---|---|---|---|---|
| `#6A8A3A` moss field | `#486828` olive | `#0B2A1A` bottle green | `#F8F8F8` | `#FFFFFF` on green |

- Tone-on-tone greens only: app icon, packing tape, delivery van, all monochrome green with a white wordmark. Very premium and restrained.
- **Borrow:** proof that a single-hue green system can feel high-end for African food; monochrome brand surfaces (van, tape, bags) as hero imagery. **Avoid:** going so monochrome that sale/stock states lose contrast. You still need a warm accent.

### B3. Gawula: packaging and brand identity (Behance)
https://www.behance.net/gallery/204412587/Gawula-Packaging-Brand-Identity

| Poly green | Ginger | Sky | Misty rose | (Yellow, excluded) |
|---|---|---|---|---|
| `#0F4C29` | `#C8451B` | `#3838C8` | `#F8E4DC` | ~~`#EFC71B`~~ |

- Chunky hand-drawn display caps, a sunburst mark, zig-zag border tape; colour-block grid tiles; food shot over open fire.
- **Borrow:** colour-block tiles for category headers; the pairing of poly green, ginger and misty rose (drop the yellow; use the sky blue only as a tiny accent, never as a gradient). **Avoid:** the zig-zag borders: in an app they turn into the "pattern overload" cliché.

### B4. Taste Africana: visual identity (Behance)
https://www.behance.net/gallery/189429673/Taste-Africana-Visual-Brand-Identity-Design

| Bg | Text | Crimson | Leaf | (Orange, excluded) |
|---|---|---|---|---|
| `#F8F6E6` | `#282828` | `#A80818` | `#98C848` | ~~`#F89808`~~ |

- Tall condensed grotesk display ("TASTE AFRICANA"), set in charcoal on parchment; a logo built from a cooking-spoon shape plus the Africa outline plus the letter "a".
- **Borrow:** condensed display type for section heads; charcoal on parchment as a calm base. **Avoid:** using the Africa-map silhouette in logos (overused).

### B5. African and Caribbean Supermarket Website (Behance, Deborah Afolabi)
https://www.behance.net/gallery/236429647/African-and-Caribbean-Supermarket-Website

| Bg | Surface | Primary | Neutral | Text |
|---|---|---|---|---|
| `#FFFFFF` | `#EDEDED` | `#1C4C3C` deep green | `#D4CCBC` sand | `#111111` |

- Closest functional match to our storefront: dark photo hero ("Fresh African & Caribbean Groceries Delivered to Your Doorstep"); a **bento photo mosaic for "Shop by Category"**; product rails grouped by aisle, each card with a full-width dark-green "Add to cart"; "Why shop with us"; FAQ.
- **Borrow:** the aisle-grouped rails and the bento category mosaic. **Avoid:** the visual flatness (no type personality, uniform grey sections). It needs a display face and a warm accent.

### B6. Afrocart: Afrocentric grocery rebrand (Dribbble)
https://dribbble.com/shots/20819292-Afrocart

| Clay | Green | (Yellow, excluded) | Text |
|---|---|---|---|
| `#9C5B42` | `#00AA00` | ~~`#ECC732`~~ | `#FFFFFF` |

- Animated GIF: **nested rounded panels wipe in one inside another** (yellow → clay → green) to reveal the wordmark; diamond-in-diamond mark.
- **Borrow:** the nested-panel reveal as a page-transition or splash motif, done in our own colours; clay brown as a warm neutral. **Avoid:** the pure `#00AA00` green and the yellow.

### B7. Naija Bites: Nigerian food delivery (Dribbble)
https://dribbble.com/shots/27294155-Nigerian-Food-Delivery-App-UI-Modern-Restaurant-Ordering

| Bg | Surface | Card | Primary | Accent | Text |
|---|---|---|---|---|---|
| `#1E1410` dark wood | `#2A201B` | `#EDE3D3` parchment | `#1F5A2A` leaf green | `#B5452B` pepper red | `#F3EADB` |

- Moody dark-wood photography, parchment product cards on a dark page, green "Add to Cart" with a secondary clay button. Looks partly AI-generated, but the **dark, appetite-forward mood** suits jollof, suya and egusi imagery.
- **Borrow:** a dark mode / dark hero for food categories; parchment cards. **Avoid:** busy textured backgrounds behind UI, low text contrast, and the gold/ochre "View Cart" button.

### B8. Meaty: meat e-commerce landing (Dribbble)
https://dribbble.com/shots/27649168-Meat-Ecommerce-Website

| Bg | Surface | Accent | Text |
|---|---|---|---|
| `#0C0C0C` | `#141C14` | `#84CC2C` | `#FFFFFF` |

- Huge distressed condensed headline ("MEAT / MARKET"), a dark studio food photo, a glass pill nav, trust chips ("Halal Certified", "Lab Tested"), and a stats row (4.9 rating, 5K+ customers).
- **Borrow:** **trust chips** (Halal, Fresh-cut today, Family-owned since 1998) are very relevant for butchers and halal grocers; glass pill nav over a photo hero. **Avoid:** distressed type; lime on black at large sizes.

### B9. Grevana: organic farm landing (Dribbble)
https://dribbble.com/shots/27430744-Organic-Farm-Website-Landing-Page

| Bg | Primary | Hero | Accent | Text |
|---|---|---|---|---|
| `#FFFFFF` | `#042464` navy | `#74CCFC` sky | `#D4E484` pale lime | `#042464` |

- A real person holding a produce crate on a flat sky-blue hero, a navy stats band, and portrait photos of the people who grow the food.
- **Borrow:** owner/staff portraits as trust ("Meet Mama Ngozi, owner since 2009"); a stats band. **Avoid:** navy plus sky (drifts towards the "tech blue" look the user dislikes).

### B10. Blendly: spice brand e-commerce (Dribbble)
https://dribbble.com/shots/27340755-Blendly-Spice-Brand-eCommerce-Website-Design

| Bg | Brown | Green | (Orange/yellow, excluded) |
|---|---|---|---|
| `#FCFCFC` / `#ECECE4` | `#6C3C34` | `#1C943C` | ~~`#FC7C34`, `#FCC43C`~~ |

- Heavy slab/soft serif display (Cooper / Recoleta feel), an announcement marquee, **an inline-image marquee headline** ("Shouldn't [photo] be complicated…"), colour-block product cards with jars angled out of frame, and taped-polaroid photo collages.
- **Borrow:** the inline-image marquee as a slow decorative motion strip; a warm serif display for personality; a brown as the text colour on cream. **Avoid:** the colour-block overload and the orange/yellow.

### Anti-references (looked at, rejected)
- **Agentic AI grocery app** (https://dribbble.com/shots/27834262): lilac-to-blue iridescent gradient with an orb "AI" button. **This is exactly the "AI colours" look to avoid.** The only keeper is the floating "Cart $5.99" pill.
- **AMA Fresh** (https://dribbble.com/shots/26456497) and **African Hyper Market** (https://www.behance.net/gallery/242221897): orange/amber-dominated, which is the default cliché for "African food". Useful only for flows (OTP via WhatsApp option, "You might also like" at checkout).
- **Eastern Block, Asian grocery** (https://www.behance.net/gallery/247155189): deep teal `#184858` with an orange accent; a nice cultural illustration layer. Take the teal, drop the orange.
- **Nana African Store** (https://dribbble.com/shots/23537751) and **MB Tropicale** (https://www.behance.net/gallery/207527283): amateur, heavy on stock photos and yellow; not premium.

---

## Patterns that recur

1. **Dark full-bleed band plus cut-out produce** (Dodolland, Musemind, Meaty, Naija): one deep-green or near-black band per page carries the promo or delivery offer. It reads as instantly premium.
2. **Photo category mosaic / bento** (Dodolland, B5, Gawula tiles): large, unequal tiles with real photos beat icon grids for ethnic grocery, because customers recognise the food on sight.
3. **Horizontal snap rails with a label block** for "Top / Recommended / By aisle"; on mobile, 2.2 cards visible so the rail hints at overflow.
4. **Pill CTAs plus a round "+" add button** on the card corner; the quantity stepper replaces the "+" after the first tap.
5. **Sticky bottom action bar** (price + primary CTA) on product detail, cart and checkout; a **floating pill bottom nav** on mobile.
6. **Per-line substitution row in the cart** (Musemind "Replace with ▸"): direct precedent for our swap rule UI.
7. **Store-themed header**: the only colour that changes between stores is the header/primary token (Musemind), which fits our white-label storefront model.
8. **Trust chips and people photography**: Halal / family-owned / owner portraits (Meaty, Grevana, Dodolland greyscale people tiles).
9. **Warm off-white bg (`#F7F3EA`-`#FAFAF2`) instead of pure white** in nearly every premium reference; pure white is reserved for cards.
10. **Typography split:** a characterful display face (condensed grotesk, soft serif, or bold geometric) with a neutral grotesk body. Superscript cents for prices.
11. **Motion vocabulary seen:** progress-fill CTA that morphs into a success check; a toast sliding up; a shared-element header persisting between screens; nested-panel wipe reveals (Afrocart); slow inline-image marquees (Blendly); coverflow and stacked-card carousels (use sparingly).
12. **Cultural grounding done well = specific, not generic:** palettes sampled from market photography (KUTOA), a bespoke symbol set, real store and owner photos. Done badly = kente borders, Africa-map logos, orange/yellow everywhere.

---

## Palette directions observed

All five avoid yellow, amber and purple/blue AI gradients. Each is written as tokens a store could override (the primary/header token is the store-brand slot).

### 1. Forest Market (from Dodolland, Musemind, Bantutaste)
| Bg | Surface | Primary | Primary deep | Accent | Text | Muted |
|---|---|---|---|---|---|---|
| `#F7F5EE` | `#FFFFFF` | `#1F5134` | `#0E2A1C` | `#9FE08A` mint-lime | `#14201A` | `#5E6B62` |

Mood: fresh, confident, modern grocer. The closest to the user's picks. The accent is pulled back from chartreuse towards mint so it can't read as yellow.

### 2. Clay & Bottle Green (from Afrocart, Naija Bites, B5)
| Bg | Surface | Primary | Accent | Warm neutral | Text | Muted |
|---|---|---|---|---|---|---|
| `#F6F0E6` | `#FFFDF8` | `#0E3B2A` | `#B4532F` terracotta | `#9C5B42` clay | `#231A15` | `#7A6A5E` |

Mood: warm, earthy, heritage pantry. Feels African without pattern. Terracotta is a red-brown, not amber; use it for sale badges and secondary buttons.

### 3. Hibiscus & Moss (from KUTOA, Taste Africana)
| Bg | Surface | Primary | Secondary | Soft | Deep accent | Text |
|---|---|---|---|---|---|---|
| `#FAF6EE` | `#FFFFFF` | `#C8323A` hibiscus | `#2F4A2F` moss | `#F4C9CC` blush | `#7E2418` oxblood | `#1C1414` |

Mood: celebratory, restaurant-grade, bold. Good for stores that want a stronger brand voice; keep the red off "error" semantics by using moss for success and a distinct tone for errors.

### 4. Night Market (dark theme; from Naija Bites, Meaty)
| Bg | Surface | Raised | Primary | Accent | Text | Muted |
|---|---|---|---|---|---|---|
| `#14110E` | `#1F1A16` | `#2A231E` | `#3E8E57` leaf | `#D2452B` pepper red | `#F3EADB` parchment | `#A89C8C` |

Mood: moody, premium, appetite-forward. Use it for hero bands, food categories and dark mode, not as the default storefront theme.

### 5. Deep Teal & Ginger (from Eastern Block, Gawula, Musemind)
| Bg | Surface | Primary | Secondary | Accent | Soft | Text |
|---|---|---|---|---|---|---|
| `#F5F3EE` | `#FFFFFF` | `#0F4A57` deep teal | `#0F4C29` poly green | `#C8451B` ginger | `#F8E3DC` misty rose | `#13252A` |

Mood: crisp, cosmopolitan, multi-cuisine. Works for Caribbean, Asian and mixed ethnic stores as well as African. Teal is a green-blue at low saturation, never used as a gradient. Keep ginger to small accents so it does not drift towards orange.

**Notes for the design system:** a neutral platform shell (bg, text, radius 12–16px cards / pill buttons, near-flat shadows) plus 2–3 store-overridable tokens (primary, primary-deep, accent) covers every reference above. Check every store palette against WCAG AA for text on primary and on accent.
