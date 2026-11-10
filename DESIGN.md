---
name: African Markets Platform storefronts
description: Store-branded grocery storefronts. Three theme presets, Palm & Shea by default, each with light and dark themes.
colors:
  # Default preset: Palm & Shea, light. Other presets and dark themes are in "Colors" below.
  primary: "#1F5A43"
  primary-deep: "#123726"
  on-primary: "#FFFFFF"
  accent-mint: "#A8DDB5"
  on-accent: "#0F2A1B"
  stone-bg: "#F3F4EF"
  surface: "#FFFFFF"
  raised: "#E7E9E2"
  ink: "#15201A"
  muted: "#55625A"
  line: "#DCDFD6"
  soft: "#E1EEE3"
  deal: "#B42335"
  success: "#2E7D4F"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(28px, 4vw, 40px)"
    fontWeight: 700
    lineHeight: 1.1
  title:
    fontFamily: "Bricolage Grotesque, Segoe UI, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Figtree, Segoe UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Figtree, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
    height: "48px"
    padding: "0 24px"
  button-primary-pressed:
    backgroundColor: "{colors.primary-deep}"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "36px"
  chip-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
  product-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
  promo-band:
    backgroundColor: "{colors.primary-deep}"
    rounded: "{rounded.lg}"
  badge-deal:
    backgroundColor: "{colors.deal}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
---

# Design System: African Markets Platform storefronts

> Seed. Written before any app code exists, from `design/palette-studio.html` and ADR-0011. Re-run `/impeccable document` in scan mode once the Next.js app has real tokens.

## Overview

**Creative North Star: "The store you already trust, on your phone"**

Every storefront should feel like the store itself, established and honest, not like a platform. The store's name, logo and brand color lead. The system around them stays quiet: stone backgrounds, deep ink, food photography doing the selling. Density follows the big delivery apps (DoorDash, Instacart, Weee!): square product images, pill buttons, a sticky cart bar, local food names next to English everywhere.

Rejected: yellow, amber, the AI purple/blue gradient, cream with terracotta, flag colors, Africa-map silhouettes, tribal fonts, patterns as wallpaper.

**Key Characteristics:**
- The store's brand color is the primary color, and the system keeps it AA-compliant.
- Neutral, low-chroma grounds, so any store color and any photo sit well.
- The accent covers under 5% of a screen.
- Mobile-first, thumb-reach actions, motion that confirms rather than decorates.

## Colors

Three Theme presets (ADR-0011). A store's brand color, when set, replaces `primary`, and `primary-deep` is derived from it.

### Palm & Shea (default)
| Token | Light | Dark |
|---|---|---|
| bg | #F3F4EF | #0D1410 |
| surface | #FFFFFF | #1E2C23 |
| raised | #E7E9E2 | #2B3F33 |
| ink | #15201A | #EEF2EC |
| muted | #55625A | #A3B1A7 |
| line | #DCDFD6 | #35463B |
| line-strong | (uses line) | #71907D |
| primary | #1F5A43 | #6CC08F |
| primary-deep | #123726 | #1D3A2B |
| accent | #A8DDB5 | #A8DDB5 |
| soft | #E1EEE3 | #21412E |
| deal | #B42335 | #F28793 |
| success | #2E7D4F | #6CC08F |

### Cocoa & Bottle Green (heritage)
| Token | Light | Dark |
|---|---|---|
| bg | #EFEDE8 | #120F0D |
| surface | #FBFAF7 | #2D2621 |
| raised | #E4E1DA | #403730 |
| ink | #2A1D17 | #F1ECE5 |
| muted | #6A5C53 | #B3A69A |
| line | #DAD5CC | #48403A |
| line-strong | (uses line) | #91847A |
| primary | #0E3B2A | #66B791 |
| primary-deep | #072419 | #1E3A2D |
| accent | #E6C8BF | #E6C8BF |
| soft | #E9E3DA | #493526 |
| deal | #A1302A | #F0867D |
| success | #2F6B45 | #66B791 |

### Lagoon & Coral (any cuisine)
| Token | Light | Dark |
|---|---|---|
| bg | #F1F3F2 | #0C1314 |
| surface | #FFFFFF | #1C2C2F |
| raised | #E4E8E7 | #283E42 |
| ink | #13252A | #E7F0F1 |
| muted | #51666C | #9BB0B4 |
| line | #D6DCDB | #32464A |
| line-strong | (uses line) | #6D8F95 |
| primary | #0F4A57 | #6FC2CF |
| primary-deep | #082F38 | #103540 |
| accent | #C23B52 | #F07F92 |
| soft | #E0ECEC | #253E48 |
| deal | #C23B52 | #F18799 |
| success | #0F6B3A | #6FC79A |

### Named Rules
**The Readable Fill Rule.** Text on any colored fill (`primary`, `primary-deep`, `deal`, `success`) is computed: white or #0B0B0B, whichever has the higher contrast. No component hard-codes text color on a brand fill.

**The Store Color Nudge Rule.** If a store's brand color is under 4.5:1 against `bg` or against its own text, shade it darker (light theme) or mix it toward white (dark theme) in small steps until it passes. Tell the owner in the admin when this happens.

**The Quiet Accent Rule.** The accent is a fill for promo bands and highlights only, never text, and under 5% of any screen.

**The Dark Depth Rule.** In dark themes, `bg`, `surface` and `raised` sit at least 1.25:1 apart, ink stays at least 7:1 and muted at least 4.5:1 on each. `line` is the quiet divider; `line-strong` (dark only, at least 3:1 on every surface) edges inputs, selects, textareas, unselected chips and outlined or round buttons. Light themes have no `line-strong` and use `line`. A store's dark primary is nudged against `raised`, the lightest dark layer, so links stay AA on cards.

**The Quiet Night Header Rule.** In dark themes the header sits on `surface` with ink text; primary is kept for the cart button and key accents. Header sublabels are at least 13px. Selected chips use the `soft` tint, a 2px primary ring and a check mark, so selection never relies on colour alone.

**The Separate Semantics Rule.** Deal, success and error colors belong to the system, not the brand. Errors always carry an icon and text, never color alone.

## Typography

**Display Font:** Bricolage Grotesque (with Segoe UI, system-ui)
**Body Font:** Figtree (with Segoe UI, system-ui)

**Character:** Provisional. A warm, slightly quirky grotesque for store names and section titles, over a clear, open body face. The type decision is still open.

### Hierarchy
- **Display** (700, clamp(28px, 4vw, 40px), 1.1): store name and hero lines.
- **Title** (700, 22px, 1.2): section headers ("Soup kits", "Fresh produce").
- **Body** (400, 16px, 1.5): descriptions and cart lines. 16px minimum for older shoppers.
- **Label** (600, 13px): chips, unit prices, local names, badges.

### Named Rules
**The Two Names Rule.** A product shows its local name next to the English one ("Ugu · Fluted pumpkin leaves"). Layouts must hold long names on two lines without truncating the local name.

**The Honest Price Rule.** Prices use superscript cents and always show the unit price.

## Layout

Mobile-first, with breakpoints at 768, 1024 and 1280px. Spacing on a 4/8 grid. Product grid: 2 columns on phones, 3 on tablets, 4–6 on desktop. Primary actions sit in thumb reach. The cart bar is sticky at the bottom on mobile and becomes a side panel at 1024px and up. Tap targets are at least 44px. No horizontal page scroll at 320px.

## Elevation & Depth

Flat by default. Depth comes from tonal layers (`bg` → `surface` → `raised`), not shadows. Product images have no shadow. Shadows appear only on floating layers (the sticky cart bar, bottom sheets, toasts) and only as a soft ambient lift.

## Shapes

- Store cards and inputs: 8px.
- Product images and cards: 12px, square images.
- Promo bands and sheets: 16px.
- Buttons, chips and badges: pill.

## Components

- **Add button:** a round "+" on the product card that expands into a quantity stepper with a spring. The cart count bumps when it changes.
- **Swap rule pill:** on each cart line: "Exact item only", "Store suggests" or "Choose a swap".
- **Substitution prompt:** a card with a countdown, "Swap" and "Refund" side by side, shown when staff mark an item short.
- **Fee line:** the courier fee is labeled as the courier's real quote with no markup.
- **Pay button:** a pill in `primary`. On success, a `success` fill sweeps across and the label changes to "Order placed".

## Motion

Taken from the DoorDash, Instacart and Weee! teardowns (`research/ui/delivery-apps-teardown.md`).

| Token | Value | Use |
|---|---|---|
| ease-std | cubic-bezier(0.4, 0.4, 0, 1) | Most state changes and button release |
| ease-out | cubic-bezier(0, 0, 0, 1) | Things entering (toasts, sheets) |
| ease-exit | cubic-bezier(0.4, 0, 1, 1) | Things leaving |
| ease-large | cubic-bezier(0.45, 0, 0.05, 1) | Large surfaces and page-level moves |
| spring | linear(0, 0.006 1.2%, 0.026 2.5%, 0.111 5.5%, 0.591 16.8%, 0.785 22.3%, 0.859 25%, 0.918 27.7%, 0.965 30.5%, 1.002 33.5%, 1.038 38.7%, 1.049 44.9%, 1.004 72.8%, 1) | Stepper expand and cart bump (~5% overshoot) |

| Duration | Use |
|---|---|
| 50ms linear | Press-in |
| 150–200ms | Release, hover, color changes |
| 200–250ms | Small things entering |
| 300ms | Bottom sheets and toasts sliding up |
| 300–600ms | Large surfaces |
| 30ms | Stagger between list items |
| 1.3s loop | Skeleton shimmer |

**The Confirm, Don't Decorate Rule.** On task surfaces (browse, cart, checkout, order inbox, admin forms), motion only confirms an action (added, swapped, paid) or shows where something went. No ambient or looping animation there besides loading skeletons.

**The Story Surface Rule** (user direction, 2026-10-31). Sign-in, sign-up, invite-accept, onboarding and marketing pages are story surfaces. They tell the story: an independent African market, its shelves, produce, spices and the people who run it. Each one gets a rich background: a 3D scene (React Three Fiber, lazy-loaded on the client after the form is interactive, with a static poster image as first paint and fallback) plus high-quality photography or rendered imagery. Entrance and parallax motion use the `motion` library (Framer Motion's current package). Limits:
- The form stays first, readable (AA contrast over the background via a solid or blurred panel) and usable before any 3D loads.
- No layout shift, and LCP stays under 2.5s on mid-range mobile. Mobile and save-data get the poster image only.
- Under reduced motion, the scene is frozen to its poster and nothing moves.
- Images must be licensed for commercial use (record the source and license in `public/images/CREDITS.md`) or rendered by us. No AI-generated faces of real-looking people. Never stereotyped "Africa" clichés: real market textures, foods and colors from the research.

The shared background is `StorySurface` (`src/components/story-surface/`, #35). Every story surface uses it; never build a second one.
- **Scene:** a depth-parallax photograph, not modeled food. A real market photo and an offline depth map (`scripts/images/story-depth.py`) render through a small shader in React Three Fiber. The depth follows the pointer, with one slow breath as it wakes and a faint drift after that. Primitive shapes standing in for food are not acceptable.
- **Poster first:** the canvas stays transparent until its first frame has drawn, then fades in over the poster it matches pixel for pixel at rest. Under 768px wide or 500px tall, under reduced motion, on save-data, without a capable WebGL2 GPU, or after any scene failure, the visitor keeps the poster and no canvas exists. Phones get their own tall crop.
- **Crop:** hands and produce lead. Faces and stall signage stay out of frame, so food is the hero and nobody stares at the visitor.
- **Composition:** phones anchor the form at the bottom, in thumb reach, under the hands and peppers. From 1024px the form sits right of the stall, with the scene's line at 20 to 26px at the lower left, so it never outranks the form's 28px heading. Below 1024px the line gives way to a small tag naming the place.
- **Panel:** forms sit on `StoryCard`, a solid `card` fill, so AA holds over any part of the photo. Glass is not used here.
- **Color scheme:** the surface follows `prefers-color-scheme` on its own, on the platform host too. Dark multiplies a warm dusk tone (`#94897F`) over the photo, which keeps the produce appetizing, instead of a flat black overlay.
- **Motion:** the form is visible from first paint and only slides 16px, 500ms ease-out. The poster settles over 1.2s, once. Nothing loops except the scene's drift.

**The Reduced Motion Rule.** Under `prefers-reduced-motion`, all transitions and animations are off. State changes still happen instantly.

## Do's and Don'ts

**Do**
- Let the store's logo, color and real photos lead.
- Show local names, unit prices, stock confidence and the real courier fee.
- Use clearly marked placeholders until real photos exist.

**Don't**
- Use yellow, amber, purple/indigo or gradient text.
- Put eyebrow labels above headings, colored side borders on cards, or emoji as icons.
- Use stock "smiling woman in a headwrap" heroes, flag colors or patterns as wallpaper.
- Show the platform's brand on a storefront beyond the "Powered by" footer.

## Design round 4: storefront presentation

This owner-approved direction supersedes the earlier rail, marquee and product-image treatments. It extends the existing store palette, typography, focus ring and shared components.

- **Content grid:** `--sf-content-max` is 1440px, becoming 1536px at 1800px. `--sf-page-padding` is 16px on phones and 32px otherwise. Rail headings sit above their cards. The scroll viewport starts on the grid and ends at the right viewport edge, with no right padding. Products, deals, categories and collections use the same RailScroller, gap and card-width calculation: 2.25 cards on phones, 3.5 at 1024px, 4.5 at 1440px and 5.5 at 1920px. Short rails simply show all their cards. Arrow buttons, arrow keys, Home/End and touch scrolling remain available.
- **Reveals:** 0 to 1 opacity and a 24px rise over 500ms ease-out, once at 18% intersection. Product children stagger by 30ms, capped at index seven. The JS-added `html.sf-reveal-ready` class enables hidden states only after hydration; content already in view is never hidden. Without JavaScript or with reduced motion, content stays visible. Focusing unrevealed content also exposes it.
- **Local-name band:** one slim row of search chips and small accepted product cut-outs. Horizontal offset follows scroll progress through Motion's existing `useScroll` and `useTransform`; there is no timer or pause button. Keyboard focus exposes every chip. Reduced motion uses a static wrapping row.
- **Images:** square, rounded photo tiles use edge-to-edge cover sizing. Accepted alpha cut-outs use contain sizing with 7.5% inset on each side and the existing contact shadow. Category images fill a circular clip with cover sizing and no inset or shadow. A missing image uses the theme tint, category glyph and product initial; a failed request retries once before showing Photo unavailable.
- **Source order:** listing-owned image when provided, linked master-product R2 image, accepted local cut-out, designed fallback. Stored R2 paths resolve through `R2_PUBLIC_URL` or the existing allowlisted catalog-image route. Retired Wikimedia URLs are attribution metadata only. The current Listing schema has no owned-image field; no schema or upload work is introduced here.
- **Hero:** the first slide uses the locally hosted, licensed Bodija Market produce photograph credited in `public/images/CREDITS.md` and `/credits`. It remains the only preloaded home hero background.
