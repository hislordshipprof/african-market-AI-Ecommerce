# 11. Storefronts use three theme presets, Palm & Shea by default

Date: 2026-10-30 · Status: accepted

## Context
Storefronts carry the store's own brand (ADR-0003), so a store's brand color replaces the platform's primary color. What the platform still owns is everything around it: backgrounds, text, borders, deal and success colors, dark mode, and the look of a store that has no brand color yet. Six palette directions were compared in the Palette Studio (`design/palette-studio.html`), each revised after Impeccable and Taste critiques. All 72 palette × theme × store-color combinations passed WCAG AA. The user ruled out yellow, amber and the AI purple/blue look.

## Decision
A store owner picks one of three **Theme presets** at setup:

1. **Palm & Shea** (default): palm green on green-tinted stone, mint accent.
2. **Cocoa & Bottle Green** ("heritage"): cocoa-brown ink, bottle green, dusty-rose promo field.
3. **Lagoon & Coral** ("any cuisine"): deep teal with coral, for Caribbean, Asian and mixed grocers (ADR-0004).

Every preset has a light theme and a dark theme. The dark themes follow the Night Market approach (warm charcoal grounds, lifted primary). If the store sets a brand color, it becomes the primary. The system nudges it lighter or darker until it passes AA against the preset's background (in dark themes, against `raised`, the lightest dark layer, so links on cards stay AA) and its own text color, and tells the owner when it did.

Zobo & Moss, Adire & Pepper and Night Market are not presets. Red competes with deal and error states, and blue fights appetite on a grocery site. Night Market lives on only as the dark theme.

## Consequences
- Tokens and the motion spec live in `DESIGN.md`. Preset values are data, so adding a fourth preset later is configuration, not a redesign.
- Text on any colored fill picks white or near-black automatically. Components never hard-code text colors on brand fills.
- Typography is provisional (Bricolage Grotesque + Figtree) until a type decision is made.
- The palettes were tested with placeholder drawings, not real product photos. Recheck them against the pilot store's real photos and logo before launch.
