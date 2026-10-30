# 4. Any independent grocery or food store can join; no restaurants in v1

Date: 2026-10-30 · Status: accepted

## Context
African markets are the core focus, but the team is also talking to other vendors. The ordering loop (list items → order → pick → short prompt → Ready → deliver) is the same for any grocery retailer.

## Decision
Any independent **grocery or food retail store** can be a store on the platform: African, Caribbean, Asian, Latin, butchers, and so on. Restaurants, hot food and catering stay out of scope until Phase 3.

## Consequences
- The master catalog and the AI knowledge base lead with African food, but must not assume every listing maps to an African master product. Custom listings are first-class.
- Categories are configurable per store on top of a shared default tree.
- The brand and marketing still lead with African markets.
