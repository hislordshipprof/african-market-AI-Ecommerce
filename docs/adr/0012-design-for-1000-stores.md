# 12. Design the architecture for 1,000 stores

Date: 2026-10-30 · Status: accepted

## Context
Phase 1 is one pilot store (ADR-0001 opens onboarding nationwide). Picking the stack needs a scale target: too small forces a rewrite before national rollout, too large spends money and time before the first real order.

## Decision
Design for about **1,000 stores, 1M customer accounts and 20k orders a day** within roughly three years. Build only what the pilot needs, but make no choice that blocks this target. Every stack choice is justified against it, recorded with its scale limits, cost and best practices (ADRs 0013–0017).

## Consequences
- Rough load at target: 2–5M listings, peak tens of requests per second on storefronts, ~1M background steps a month.
- Paid tiers are expected to kick in gradually as stores join; the pilot should run on free tiers.
- Revisit this target when the store count passes 300, or when any service in 0013–0017 reaches 70% of a plan limit.
