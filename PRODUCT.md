# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js (App Router, TypeScript) with Tailwind and shadcn/ui, as set in `docs/spec/platform-spec.md` §14. Responsive, mobile-first, installable as a PWA.

## Users

- **Customers:** mostly first-generation African immigrants in the US, roughly 30–65. They cook home dishes and shop on their phones, are WhatsApp-native, search by local food names (ugu, ata rodo, garri), and are loyal to a store they know.
- **Store owners and staff:** run the store's catalog, orders, picking and stock from a phone, often in the middle of serving customers at the counter.

## Product Purpose

A shared system that gives each independent US grocery or food store (African-first, but any grocer can join) its own branded online store, with ordering, picking, swap approval before charging, and local delivery or pickup. Success means real repeat orders per store, no unapproved substitutions, and owners who can run it all from their phone.

## Positioning

- Shelf prices and no hidden markup; the courier fee is the real quote.
- Nothing is swapped without the customer's tap.
- The store owns its brand and its customers; it is not just another listing in a marketplace.
- An AI that understands African food vocabulary and recipes.

## Operating Context

- Customers shop on phones, often arriving from a store's WhatsApp link, sometimes as guests.
- Staff pick orders on a phone in the store aisles and approve shortages live.
- Owners update stock by text, voice note or photo to the Store copilot.
- Terminology lives in `GLOSSARY.md`; decisions in `docs/adr/`.

## Capabilities and Constraints

See `docs/spec/platform-spec.md` and ADRs 0001–0010. Key constraints: US only; one shared system with per-store theming (ADR-0005); one customer account plus guest checkout (ADR-0002); fulfillment options are Store delivery, Courier delivery and Pickup (ADR-0006).

## Brand Commitments

- A storefront shows only the store's brand, plus a small "Powered by" footer (ADR-0003). The platform name is undecided.
- The user has ruled out yellow, amber, and the generic "AI" purple/blue gradient look.
- Avoid cultural clichés: stock "smiling woman in a headwrap" heroes, flag-color schemes, Africa-map silhouettes, tribal fonts, and patterns used as wallpaper.

## Evidence on Hand

Research only: `research/` and `research/ui/`. There are no real stores, customer testimonials, store photos or metrics yet, so none may be fabricated. Use clearly marked placeholders.

## Product Principles

1. The store comes first: every surface makes the store, not the platform, look established and trustworthy.
2. Honest by default: show real prices, real stock confidence and the real courier fee, and never act without the customer's approval.
3. Phone-first for both sides: thumb reach, fast pick, glanceable state.
4. Speak the customer's food language: local names sit next to English, everywhere.

## Accessibility & Inclusion

WCAG 2.1 AA. Respect `prefers-reduced-motion`. Use generous tap targets and readable sizes for older shoppers. Text must hold up with long local-language product names.
