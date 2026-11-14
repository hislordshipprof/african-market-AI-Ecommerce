# 11. Storefronts use three theme presets, Palm & Shea by default

Date: 2026-10-30 · Status: accepted · Amended 2026-11-13 (neutral grounds, #528)

## Context
Storefronts carry the store's own brand (ADR-0003), so a store's brand color replaces the platform's primary color. What the platform still owns is everything around it: backgrounds, text, borders, deal and success colors, dark mode, and the look of a store that has no brand color yet. Six palette directions were compared in the Palette Studio (`design/palette-studio.html`), each revised after Impeccable and Taste critiques. All 72 palette × theme × store-color combinations passed WCAG AA. The user ruled out yellow, amber and the AI purple/blue look.

## Decision
A store owner picks one of three **Theme presets** at setup:

1. **Palm & Shea** (default): palm green on warm white, mint accent.
2. **Cocoa & Bottle Green** ("heritage"): cocoa-brown ink, bottle green, dusty-rose promo field.
3. **Lagoon & Coral** ("any cuisine"): deep teal with coral, for Caribbean, Asian and mixed grocers (ADR-0004).

Every preset has a light theme and a dark theme. The dark themes use neutral charcoal grounds and a lifted primary. If the store sets a brand color, it becomes the primary. The system nudges it lighter or darker until it passes AA against the preset's background (in dark themes, against `raised`, the lightest dark layer, so links on cards stay AA) and its own text color, and tells the owner when it did.

Zobo & Moss, Adire & Pepper and Night Market are not presets. Red competes with deal and error states, and blue fights appetite on a grocery site. Night Market lives on only as the dark theme.

## Consequences
- Tokens and the motion spec live in `DESIGN.md`. Preset values are data, so adding a fourth preset later is configuration, not a redesign.
- Text on any colored fill picks white or near-black automatically. Components never hard-code text colors on brand fills.
- Typography is provisional (Bricolage Grotesque + Figtree) until a type decision is made.
- The palettes were tested with placeholder drawings, not real product photos. Recheck them against the pilot store's real photos and logo before launch.

## Amendment, 2026-11-13: neutral grounds, colour only on actions
Owner decision (#528). The storefront was tinted green everywhere: the header was a primary slab, and the page background and dark surfaces carried the preset's hue. Modern grocery sites keep the page neutral and put colour only on actions.

- Every preset's grounds (`bg`, `surface`, `raised`, `line`, `soft`, `photo-well`) are warm white in light and neutral charcoal in dark, with no more than a trace of tint. `soft` keeps a trace of primary for selected states only.
- The header is neutral (surface, ink, hairline) in both themes. Primary stays on the cart button. Promo bands, collection cards and the hero may keep `primary-deep`.
- Primary appears only on actions: buttons, links, selected states and small marks. The accent stays under 5% of a screen.
- A store's brand colour still replaces primary and is still nudged to AA.
- Neutral charcoal cannot keep dark layers 1.25:1 apart without turning grey, so adjacent dark layers are now at least 1.15:1 apart and `bg` to `raised` at least 1.4:1.
