# 1. US only, onboarding in any state

Date: 2026-10-30 · Status: accepted · Supersedes spec D1 ("DMV or Houston")

## Context
The spec picked one launch metro, to be chosen between the DMV and Houston. The team is already talking to store owners in several states and wants to set up any owner who signs.

## Decision
The platform serves **US stores only**. There is no single launch metro: stores can be onboarded in any US state. Canada is out of scope (Danlex Wholesale Foods is reference research only).

## Consequences
- Sales tax, grocery-tax rules and marketplace-facilitator obligations must work per state from day one (Stripe Tax), not for just one state.
- Courier coverage varies by store address, so every store needs a working option when couriers don't cover it (pickup at minimum).
- The Phase 2 combined marketplace only makes sense where stores cluster. It stays gated on ≥3 stores in a metro (D2).
