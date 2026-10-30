# Delivery apps UI and motion teardown

Captured 2026-10-30 from the public, logged-out web experiences, at desktop (1024px) and mobile (375x812, Android UA) widths. Values come from `getComputedStyle`, resolved CSS custom properties and same-origin or CORS-readable stylesheets.

**Legend:** values without a marker are **measured**. **(est.)** marks an estimate from how the page behaved or from structure. **(n/v)** means not visible logged-out.

Limits: logged-out views do not show the cart drawer, checkout, or live order tracking on any site, since each one asks for an address or sign-in first. Notes on those parts are marked (est.). Gopuff showed a Cloudflare "Just a moment" interstitial, which cleared on its own with no CAPTCHA. Weee! now redirects sayweee.com to **weee.com**. The Browser pane was hidden, so no screenshots were taken. All findings come from DOM and CSS inspection.

---

## 1. DoorDash (doordash.com), "Prism" design system

The most mature token system of the five. Tokens are defined on `:where(.prism-theme)` in three layers: `--base-*` holds raw values, `--usage-*` holds semantic ones, and `--comp-*` holds per-component ones.

**Color**
- Brand/primary: red-60 `#EB1700`. Hover is red-70 `#D91400` and pressed is red-80 `#B71000`. Subdued tints are `#FFF0ED` / `#FFE0DB`.
- Text: default `#191919`, subdued `#606060`, links `#4969F5`, inverse `#FFFFFF`.
- Surfaces: background `#FFFFFF`, subdued `#F7F7F7`, strong `#F1F1F1`, inverse `#191919`. Border default `#E4E4E4`, border strong `#D6D6D6`.
- Positive `#00832D` on subdued `#E7FBEF`. Negative `#D91400` on `#FFF0ED`. Warning/yellow-60 `#D49400`. Membership purple `#4318AD`.
- Neutral ramp: `#F1F1F1, D6D6D6, C4C4C4, B2B2B2, 9F9F9F, 8B8B8B, 767676, 606060, 494949, 242424`.

**Typography**
- Fonts loaded: `DD Norms` at 500/600/700/800. `TTNormsProCond-Blk` (condensed black) is used for promo h1s, set in uppercase at 40/40 weight 900.
- Size scale in px: 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 56, 60, 72, 84.
- Line heights step by 2px: 16, 18, 20, 22, 24, 26, 28, 30, 32, 36…
- Body/label sizes: x-small 12/18, small 14/20, medium 16/22, large 18/24. "default" text is weight **500** and "strong" is **700**. Regular 400 is not used for UI text.
- Section h2 is 32/40 weight 800. Card title h3 is 18/24 weight 500. Prices are 14/20 weight 700 in `#606060`, and store meta lines are 14/20 weight 500.

**Spacing, radius, elevation**
- Spacing: 2, 4, 8, 12, 16, 24, 32, 40, 48.
- Radii: 2, 4, 8, 12, 16, 20, 32, and 9999 for pills.
- Elevation, all in `#19191933` (20% ink): e1 `0 1px 4px`, e2 `0 2px 8px`, e3 `0 4px 12px`, e4 `0 4px 16px`, e5 `0 6px 20px`, e6 `0 8px 24px`.

**Components**
- Header: 64px, white, sticky (`top:0`).
- Buttons: all pill-shaped (9999px). Header buttons are 32–40px tall. "Sign Up" uses a red fill.
- Store cards: image ratio **1.86:1** (307x165), radius **8px**, no shadow. A 76px round logo sits on the store hero, and the hero banner has 12px radius on its bottom corners only.
- Menu: an item quick-add is a 32px circular "+" with elevation-2 (`0 2px 8px rgba(0,0,0,.2)`). A secondary pill uses `#F1F1F1` with an inset 1px ring. The category sidebar is sticky at `top:64px`.
- Mobile store page: hero is 375x250 (3:2). The header stacks to 112px with an "Open App" pill, the address, and a cart pill showing "0 items". A bottom sheet (65px, `bottom:-12px`) peeks in as a sticky footer.

**Motion**
- Tokens are named by intent:
  - Tap: enter **50ms linear**, exit **200ms `cubic-bezier(0.4,0.4,0,1)`**. They are applied as `--press-transition-enter/exit` to background-color and box-shadow.
  - Functional default: 200 / 300 / 400 / 500ms on `cubic-bezier(0.4,0.4,0,1)`. Exits run 150–300ms on `cubic-bezier(0.4,0,0.6,0.6)`.
  - Fades: 50 / 100 / 150 / 200ms.
  - Spring-out: 200–250ms on `cubic-bezier(0,0,0,1)`. Spring-in: 50–100ms on `cubic-bezier(0.4,0,1,1)`.
  - "Auto" (large/page): 300–600ms on `cubic-bezier(0.45,0,0.05,1)`, with exit on `cubic-bezier(0.5,0,1,1)`.
  - Subtle: enter `cubic-bezier(0,0,0.6,1)`, exit `cubic-bezier(0.4,0,1,1)`.
  - "Smooth finish": `cubic-bezier(0.05,0.75,0,0.96)`.
  - Delays: cascade **30ms** stagger, functional 50–100ms, handoff 50–100ms.
  - Pulse: enter 500ms, hold 100ms, exit 600ms.
- Press scale: `--usage-motion-scale-pressed-default: 3px`, which shrinks a pressed element by 3px rather than by a percentage. The JS adds `data-visual-tap-state`, plus a `.click-released` class that switches the element to the exit curve.
- Skeleton shimmer: `background-position -200px → calc(100%+200px)`, **1300ms ease-in-out infinite**, used on about 19 rules.
- **`prefers-reduced-motion` is handled**: 7 rules set `transition:none !important; transform:scale(1) !important`.

---

## 2. Uber Eats (ubereats.com), Base Web with Styletron (atomic CSS-in-JS)

**Color** (sampled by usage count because Styletron inlines most colors)
- Ink is `#111111` (rgb 17,17,17), used for 771 text nodes. Pure black is used for h1.
- Secondary text `#525252`, tertiary `#808080`, disabled `#C4C4C4`.
- Surfaces: `#FFFFFF`, chip/secondary `#F6F6F6`, divider `#E8E8E8`, `#F3F3F3`.
- Brand accent: green `#0E8345` (badges and promos) and warm cream `#F6F0EA` (section backgrounds on city pages). Promo pink is `#FFD7D2`.
- The primary button is **black** `#111111` with text `#FCFCFC`. The green is not used for main CTAs.

**Typography**
- Fonts: `UberMove` 700 for display and `UberMoveText` 400/500 for body. A mono face is also defined.
- Root sizes are in rem (`calc(14/16*1rem)`).
- Scale: 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 42, plus a 52px hero.
- h1 home is 52/64 weight 700. City h1 is 36/44 weight 700. Store card title is 18/24 weight 500. Item name is 16/20 weight 500. Item price is 14/20 weight 400 in ink, not grey. Cuisine meta is 14 weight 400 `#525252`.

**Radius and elevation**
- Radius tokens: 6, 8, 12, 16, 24, 32, and 1000 (full). Pills use 500px.
- Floating circle buttons use `0 4px 16px rgba(0,0,0,.12)`.
- Elevation tokens are split into key and ambient colors (lowest/low/mid/high/highest).

**Components**
- Hero search is an address input (40px) inside an 8px-radius white field, followed by a black 56px "Search here" button with 8px radius.
- Header pills are 36px: "Log in" is white, "Sign up" is black.
- City-page store images run 1.56–1.72:1 with square corners (0 radius) in grid tiles.
- Store page: banner 652x210 at **12px** radius. Featured item tiles are 145x188 at 12px. A left menu nav is sticky at `top:63px`.
- Item "Quick Add" is a 36px white circle (radius 500px) placed over the image. Carousel prev/next are 36px circles in `#F6F6F6`.
- Mobile: no fixed bottom bar logged-out. Item rails scroll horizontally with 123x123 square thumbs and **no scroll-snap**. "Delivery | Pickup" is a horizontal segmented toggle.

**Motion**
- Minimal and functional. Transitions are mostly 200ms linear (`background .2s cubic-bezier(0,0,1,1)` on icon buttons), 300ms ease-in-out on box-shadow, and 400ms ease-in-out on opacity/size.
- Keyframes:
  - `_ae`: max-width 0→100% plus fade, 400ms forwards, a reveal.
  - `_af`: fade.
  - `_ag`: pointer-events lock until an animation ends.
  - `loadingAnimation`: skeleton, background-position -100vw→100vw, **2s linear infinite**.
  - Button spinner: 700ms linear.
- No `prefers-reduced-motion` rules were found. No Lottie or Framer Motion detected.

---

## 3. Instacart (instacart.com), "IDS" design system

**Color** (`--ids-color-*`)
- Brand primary green `#108910`, dark `#0D720D`, extra-dark `#0A610A`, light `#E9FBE9`, extra-light `#F6FDF6`.
- Secondary deep green `#003D29`. Tertiary warm cream `#FAF1E5` / `#F7F5F0`.
- Grayscale: `#FFFFFF, F6F7F8, E8E9EB, C7C8CD, 8F939B, 72767E, 56595E, 343538, 242529, 191A1C, 0B0C0D`.
- Body text `#343538`, strong `#242529`, meta `#72767E`.
- Feedback: success = brand green `#108910`. Error/"detrimental" is `#DE3534` (dark `#BB1C1B`, light `#FEF0F0`). Alert is `#FFA500`.
- Page background uses `#F6F7F8` heavily (35 nodes).

**Typography**
- Font: `Instacart Sans`, variable 400–800, with a metric-matched "Instacart Sans Fallback" face to avoid layout shift.
- h1 hero is 26/33 weight 600. Category h1 is 44/40 weight 700. PDP h1 is 32/36.8 weight 700. h3 is 17/20 weight 600. Product name is 14/20 weight 400 `#343538`, and the size line ("1 each") is 14/20 weight 600 `#72767E`. PDP price is **20/25 weight 600** `#242529`.

**Radius and elevation**
- Radii: 4, 8, 12, 24, and pill (999 or half the height: 20px on 40px buttons, 28px on 56px).
- Shadows are soft: `0 1px 8px rgba(0,0,0,.08)`, `0 1px 8px rgba(0,0,0,.16)`, `0 0 16px rgba(0,0,0,.16)`. The mobile sticky header uses a hairline `inset 0 -1px 0 rgba(0,0,0,.09)` instead of a shadow.

**Components**
- Header has an address pill ("current address: 80011"), a green 48px "Log in" pill at 24px radius, and a cart pill (72x40, `#F6F7F8`, 28px radius).
- Filter chips are 32px pills. Selected is dark `#242529` with white text. Unselected is `#E8E9EB`. Both are 14px weight 600 (for example "All" and "EBT").
- Product tile images are square **168x168 at 12px radius** with no card border or shadow. Category hero art is 300x300 at 16px radius on a pastel background.
- On the PDP, store availability cards are 180px wide at 12px radius.
- Breakpoints: **768** (dominant), 1024, 1280. Mobile sticky header is 61px.

**Motion**
- Ships **spring-like `linear()` easing functions** as CSS variables:
  - `--smooth-easing-function: linear(0, 0.159 3.3%, 0.29 6.5%, 0.41 10%, 0.515 13.7%, 0.608 17.7%, 0.686 21.9%, 0.754 26.5%, 0.812 31.6%, 0.858 36.9%, 0.896 42.7%, 0.95 56.4%, 0.98 74.2%, 1)`
  - `--elevated-easing-function` overshoots about 4.9%: `linear(0, 0.006 1.2%, 0.026 2.5%, 0.111 5.5%, 0.591 16.8%, 0.785 22.3%, 0.859 25%, 0.918 27.7%, 0.965 30.5%, 1.002 33.5%, 1.038 38.7%, 1.049 44.9%, 1.004 72.8%, 1)`
  - `--bounce-easing-function` overshoots about 11.9%: `linear(0, 0.007 1%, 0.031 2.1%, 0.132 4.6%, 0.676 13.5%, 0.888 17.7%, 0.964 19.7%, 1.026 21.8%, 1.071 23.9%, 1.102 26.2%, 1.119 29.2%, 1.115 32.7%, 1.017 47.2%, 0.988 56%, 1)`
- Transitions: micro **100ms** (4 rules) and 150ms with ease-out or ease-in-out. 200ms and 500ms are rare.
- Skeleton: `translate3d(-75%)→(75%)` sweep, 3000ms on `cubic-bezier(0.76,0,0.24,1)`, plus an SVG placeholder pulse keyframe. A 1.1s linear spinner.
- No `prefers-reduced-motion` rules were found in the readable sheets.

---

## 4. Weee! (weee.com, formerly sayweee.com), Next.js with Tailwind

The closest analog to us: an ethnic grocer serving a US diaspora.

**Color**
- Primary is "energy blue" dark-4 `#001BA5`, used on the 40px pill "My cart" button and the focus ring (`--tw-ring-color: rgba(0,27,165,1)`). Bright blue `#027FFF` / `#0274FF`.
- Page tints: `#E4EAF5` (24 nodes) and `#EEF2FB`.
- Ink `#111111`, `#07101A`, `#19181A`. Meta text slate `#52667D`.
- Sale/price red: tomato-red dark-1 `#B80617`, base `#EC2E3D`. Jade green base `#1AB393` / dark `#018260`. Badge text in a plum `#790841` ("Everyday value"). There is also an "electric durian yellow" `#F2F500`.
- Every hue has 7 light, 7 base and 7 dark steps. A full black/white alpha tint ramp runs from 5% to 93%.
- Product image tint is `rgba(92,143,208,.06)` on image wells.

**Typography**
- Font: **Poppins** 400/500, falling back to SF Pro and then CJK system fonts (Microsoft YaHei, PingFang). This is multilingual by design.
- Body is 16/24.
- Product card: price **18/22.5 weight 600 in red `#B80617`** (all prices are red, not only sale prices). Unit price is 14/17.5 `#52667D` ("$0.46/oz"). Name is 14/20 weight 400. Promo label is 10/14 weight 600. Delivery ETA line is 13/16.25 weight 500 ("Deliver by Nov 5").
- Top nav links are 14px weight 500 on 28px-tall, 4px-radius pills.

**Radius and elevation**
- Radius scale: 2, 4, 8, 12, 16, 20, 24, 28, full. SKU card radius is `--enki-sku-border-radius: 12px` and product images are 12px.
- The quantity/ATC control is a **36px-radius pill** with a double soft shadow (`0 0 6px rgba(0,0,0,.05), …`).

**Components**
- Header shows the zip and **delivery date window** ("80011 • 11/05 – 11/06"), search, a language switch (English/Chinese…), and a **"Select store" switcher between ethnic storefronts**.
- Under the header is a category grid (Deals, Snacks, Dairy & Eggs, Seasoning, Dry Goods, Tofu & Vegan…). There is a mini-cart ATC control (`--color-atc-mini-hairline`), and a favorite heart button on each card.
- Mobile: an 82px fixed header (language, zip, date, search, sign up). No bottom nav logged-out.
- Breakpoints are content-driven: 490, 810, 1100, 1280, 1440, 1600, 1920.

**Motion** (Tailwind and custom keyframes)
- Default transition is **150ms `cubic-bezier(.4,0,.2,1)`** (Tailwind default) on color and background. Also 200ms and 300ms.
- Named enter/leave pairs:
  - `scale-in-enter`: scale .5→1 plus fade, 300ms ease-out.
  - `slide-up-enter`: translateY 100%→0, 300ms ease-out, for bottom sheets.
  - slide-down, slide-left and slide-right enter/leave, 300ms. Leaves use ease-in-out.
  - `fade-in` to 0.3 opacity (the scrim), 300ms.
- Delight: `wiggle` (rotate 1°/-3°), `btn-rotate-left/right` (200ms, likely the +/- stepper icons, est.), `marquee` (10–20s linear) for promo tickers, `subscribe-button-text`.
- No `prefers-reduced-motion` rules were found.

---

## 5. Gopuff (gopuff.com), React Native Web with StyleX

**Color**
- Brand pure **`#0000FF`** blue on pill CTAs, with white text. Accent cyan `#00A4FF`. Alert red `#FF002B`.
- Ink is black. Meta text `#757575`, `#474747`. Surfaces `#FFFFFF`, `#E9E9E9`, `#F2F2F2`, `#FAFAFA`.

**Typography**
- Font: `ABC Ginto Normal` (Regular, Medium, Bold, **Black Italic**). Each weight is a separate family, so the computed weight is always 400. Icons use the `Phosphor` icon font.
- Display text is Black Italic UPPERCASE with tight tracking: 52/62 at -3.12px (-6%), 28/34 at -1.12px, and 285px for the footer wordmark. Mobile hero is 48px.
- Body is 14/17 and 16/19 Regular. CTA labels are 16/16 Black Italic uppercase.

**Components**
- CTAs are 40–48px pills (64px radius).
- Product tiles are square 146px (122px on mobile) at 8px radius with a faint tinted shadow `3px 4px 4px rgba(0,0,77,.04)`.
- Mobile: **sticky bottom CTA bar** (80px, "ENTER YOUR ADDRESS") and a transparent 56px top bar. Sticky stacked "chapter" panels (610px, `position:sticky; top:0`) give a scroll-driven card-stack effect.
- Breakpoints: 375/376, 767/768, 1023/1024, 1443/1444.

**Motion**
- Transitions are mostly 300ms (`max-height .3s cubic-bezier(0.4,0,0.2,1)` for accordions, `height/opacity .3s ease-in-out`), plus `transform .25s ease-in-out` and 200ms opacity.
- Keyframes:
  - Marquee: `translateX(-1 * var(--marquee-distance))`.
  - Parallax: translateY ±20%.
  - RN-web spinner.
  - A full library of `RollIn/RollOut`, `RotateIn/Out…`, which looks like react-native-reanimated layout animations (est.).
- No `prefers-reduced-motion` rules. No Lottie detected.

---

## Shared conventions worth adopting

**Tokens and structure**
1. Use three token layers (base → usage → component) the way DoorDash Prism and Weee! do. Store branding only swaps the `usage` brand and action colors, and the rest stays fixed. This fits per-store theming directly.
2. Neutral text is never pure black. Use `#191919` or `#111111` for ink, roughly `#606060` or `#72767E` for meta, `#E4E4E4` / `#E8E9EB` for borders, and `#F6F7F8` / `#F7F7F7` for subdued surfaces.
3. Keep semantic colors separate from the store brand: success green about `#00832D` / `#108910`, error about `#D91400` / `#DE3534`, warning about `#D49400`. A store whose brand is red still needs a distinct error treatment (DoorDash solves this with red-80 plus icons).
4. Ship hover and pressed shades with every action color. DoorDash uses -70 for hover and -80 for pressed.

**Type**
5. Use one sans family with a metric-matched fallback face (Instacart) to avoid layout shift. Include CJK and diacritic fallbacks (Weee!). Body 16/22–24. Product name 14/20 weight 400. Meta 12–14 weight 500. Prices: 14/20 weight 700 in lists and 18–20 weight 600 on PDP and cards. The unit price ("$0.46/oz") goes underneath at 13–14px in a muted color.
6. Line heights sit on a 2px grid (16, 18, 20, 22, 24…). The scale is 12, 14, 16, 18, 20, 24, 28, 32, 40.

**Shape and space**
7. Spacing: 4, 8, 12, 16, 24, 32, 40, 48. Radii: **8** (store cards), **12** (product image, banner, sheet), **16** (large tiles), and **full pills** for every button and chip.
8. Product tiles are **square images, 12px radius, no border and no shadow**, with the text sitting on the page background. Store cards use about 16:9 images (1.86:1 measured) at 8–12px radius.
9. Shadows are reserved for floating things: the quick-add "+" (`0 2px 8px rgba(0,0,0,.2)`), carousel arrows (`0 4px 16px rgba(0,0,0,.12)`), and sheets. Use a single-color, 20%-ink ramp from `0 1px 4px` to `0 8px 24px`.

**Components**
10. Header: 56–64px, sticky. It holds address/zip **plus the delivery window** (Weee!), search, and a cart pill showing the count. On mobile it can stack to about 112px.
11. Chips: 32px pills, 14px weight 600. Selected is dark ink on white text, unselected is a grey fill.
12. Put a quick-add "+" circle (32–36px) on the image corner. It expands into a −/qty/+ stepper pill (Weee! uses 36px radius; DoorDash has a floating stepper elevation token).
13. Menu category nav is sticky (desktop sidebar at `top: header height`; mobile horizontal tabs).
14. Mobile: a **sticky bottom CTA bar** about 64–80px (Gopuff address CTA, DoorDash's peeking sheet at `bottom:-12px`). Use bottom sheets that slide up 100%→0 over a scrim at about 30% opacity.
15. Breakpoints: **768** primary, then 1024 and 1280 (Instacart, Gopuff). Design at 375 first.

**Motion** (proposed platform tokens, from DoorDash with Instacart springs)
16. Press feedback: background/shadow change in **50ms linear on press**, releasing in **200ms `cubic-bezier(0.4,0.4,0,1)`**. Add a scale-down of about 3px, or `scale(.97)` (est. equivalent).
17. Hover/color: **150ms `cubic-bezier(.4,0,.2,1)`**.
18. Component enter (sheet, popover, toast): **250–300ms**, `cubic-bezier(0,0,0,1)` (spring-out) or Instacart's `--smooth-easing-function`. Exit: **200ms `cubic-bezier(0.4,0,1,1)`**. Exits should be faster than enters.
19. Page or large surface: 400–500ms on `cubic-bezier(0.45,0,0.05,1)`.
20. Lists: stagger items by **30ms**, and cap the stagger at about 8 items (est.).
21. Add-to-cart: animate the stepper expanding and the cart-count badge with `--elevated-easing-function`, which overshoots about 5%. Keep `--bounce` (12% overshoot) for one-off celebration moments such as "order placed".
22. Skeletons: shimmer sweep **1.3s ease-in-out infinite** (DoorDash), on `#F1F1F1` → `#F7F7F7`.
23. Always add `@media (prefers-reduced-motion: reduce)` that sets transitions to none and pins scale at 1, as DoorDash does. Only DoorDash of the five does this, which makes it easy to beat the others on accessibility.

## What to avoid
- **Brand color as the only CTA color.** Uber Eats uses black for primary CTAs and Instacart uses green for "success" and primary at once. With per-store brand colors, make sure the primary CTA passes 4.5:1 and fall back to ink if it does not. Gopuff's pure `#0000FF` is loud and does not carry over to a warm grocery brand.
- **All prices in red** (Weee!). It reads as "everything is on sale" and dilutes real deals. Save red or `deal` color for discounts and strike-throughs.
- **Square image corners mixed with rounded cards** (Uber city grid). Use one radius per tier.
- **Expressive display type everywhere.** Gopuff's Black Italic uppercase at -6% tracking suits a marketing page but hurts scanning in a catalog. Keep display faces for store hero and headlines only.
- **Separate font files per weight** (Gopuff). Prefer one variable font with weights 400–800 (Instacart).
- **Ignoring reduced motion** (four of the five sites), and long infinite animations such as marquees and wiggles that cannot be paused.
- **Linear 200ms on everything** (Uber icon buttons). It feels mechanical, so use the ease-out family.
- **Address gates before browsing** (Gopuff, Instacart, Uber feed). A single-store storefront should show the catalog right away and ask for the zip or address only for the delivery window and checkout.
- **Horizontal rails without scroll-snap or visible affordance** (Uber mobile). Add `scroll-snap-type: x mandatory`, a peek of the next card, and arrow buttons on desktop.
- **App-install interstitials and sign-in modals on first load** (DoorDash opened a sign-in modal on the home page).
