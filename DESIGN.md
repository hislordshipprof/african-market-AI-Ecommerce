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
| bg | #F3F4EF | #0F1712 |
| surface | #FFFFFF | #16211A |
| raised | #E7E9E2 | #1F2C24 |
| ink | #15201A | #EEF2EC |
| muted | #55625A | #A3B1A7 |
| line | #DCDFD6 | #2A3A30 |
| primary | #1F5A43 | #6CC08F |
| primary-deep | #123726 | #1D3A2B |
| accent | #A8DDB5 | #A8DDB5 |
| soft | #E1EEE3 | #1B2E23 |
| deal | #B42335 | #F0707E |
| success | #2E7D4F | #6CC08F |

### Cocoa & Bottle Green (heritage)
| Token | Light | Dark |
|---|---|---|
| bg | #EFEDE8 | #151210 |
| surface | #FBFAF7 | #1F1A17 |
| raised | #E4E1DA | #2A241F |
| ink | #2A1D17 | #F1ECE5 |
| muted | #6A5C53 | #B3A69A |
| line | #DAD5CC | #38302A |
| primary | #0E3B2A | #5FB08A |
| primary-deep | #072419 | #1E3A2D |
| accent | #E6C8BF | #E6C8BF |
| soft | #E9E3DA | #2C2520 |
| deal | #A1302A | #EF7B72 |
| success | #2F6B45 | #5FB08A |

### Lagoon & Coral (any cuisine)
| Token | Light | Dark |
|---|---|---|
| bg | #F1F3F2 | #0C1619 |
| surface | #FFFFFF | #122024 |
| raised | #E4E8E7 | #1B2C31 |
| ink | #13252A | #E7F0F1 |
| muted | #51666C | #9BB0B4 |
| line | #D6DCDB | #24383D |
| primary | #0F4A57 | #6FC2CF |
| primary-deep | #082F38 | #103540 |
| accent | #C23B52 | #F07F92 |
| soft | #E0ECEC | #16303A |
| deal | #C23B52 | #F07F92 |
| success | #0F6B3A | #6FC79A |

### Named Rules
**The Readable Fill Rule.** Text on any colored fill (`primary`, `primary-deep`, `deal`, `success`) is computed: white or #0B0B0B, whichever has the higher contrast. No component hard-codes text color on a brand fill.

**The Store Color Nudge Rule.** If a store's brand color is under 4.5:1 against `bg` or against its own text, shade it darker (light theme) or mix it toward white (dark theme) in small steps until it passes. Tell the owner in the admin when this happens.

**The Quiet Accent Rule.** The accent is a fill for promo bands and highlights only, never text, and under 5% of any screen.

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

**The Confirm, Don't Decorate Rule.** Motion only confirms an action (added, swapped, paid) or shows where something went. No ambient or looping animation besides loading skeletons.

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
