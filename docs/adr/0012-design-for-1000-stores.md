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

## Amendment, 2026-11-16 (#578): the 300-store revisit

Measured on the local lane database (Postgres 18, Apple silicon), never Neon, with a synthetic seed
(`scripts/scale-check/run.sh seed`): 300 stores, 2,000 listings each (600,000), and 10,000 orders a day for
the 30 days of October 2026 (300,000 orders, 1.2M order lines, 1.15M stock events, 100,000 courier
deliveries with 290,000 delivery events, 6,000 refunds). Every store shares one zone and digest hour, the
worst case for the hourly crons. `scripts/scale-check/run.sh measure` prints the timings and EXPLAIN plans.

| Path | Target | Measured |
|---|---:|---:|
| Orders search, six filter cases | 1 s | 1–15 ms |
| Courier incident log, first page | 2 s | 309 ms |
| Fee ledger, October (288,000 captured orders, 292,002 rows) | 2 s | 452 ms |
| Subscriptions list (302 stores) | 2 s | 1 ms |
| Daily-digest step, 100 stores due | 120 s | 7.7–8.1 s, ~7,200 statements |
| Weekly-report step, 100 stores due | 120 s | 6.8–7.1 s, ~9,500 statements |

**The target holds.** Every path is inside its budget. The PR adds no index or rollup.

A cron step serves 100 stores, so more stores add steps, not time per step. Production adds time per step:
about 3 ms a statement to Neon (+22 to 29 s) and about 250 ms an email to Resend (+25 s). Neon compute
is also slower than the lane machine (up to 2× on query time). Together that is about 65 s a step, under
the 120 s budget.

**Inngest is the limit that moved.** Inngest counts executions, not runs: one per function run plus one per
step (https://www.inngest.com/docs/usage-limits/inngest, read 2026-11-16). The Free plan includes 50,000 a
month and pauses at the cap. Pro costs $99 a month with 1M included, then $50 per 1M on the pricing page's
table, with tiered rates down to $15 per 1M in its FAQ.

- Idle crons, with no orders, use about 30,600 executions a month at one store. That is 61% of Free. The
  orphan sweep uses 14,400 (5 a run, every 15 minutes) and the reconcile sweep 11,520 (4 a run). The
  hourly digest and weekly report use 2,160 each (3 a run). The daily crons use about 300 together. At
  300 stores the digest and weekly report use 5 a run (3 pages), so idle comes to about 33,600.
- One order costs about 36 executions. `order/authorized` starts four functions (13). About four customer
  notifications each run four channel steps (20). A courier order adds dispatch, the assignment timer and
  the proof copy (9, so 3 averaged over all orders).
- At the seeded load (300,000 orders a month) that is about 10.8M executions a month: Pro, at about $250
  to $590 a month. At this ADR's target (20k orders a day) it is about 21.6M, or $400 to $1,130 a month.
  ADR-0016's estimate of $50 to $100 a month at 1,000 stores is too low.
- Free covers about 540 orders a month on top of the idle crons (about 18 a day). The 70% usage alert in
  ADR-0016 fires at about 120 orders a month.

The cron-budget test (`src/lib/inngest/cron-budget.test.ts`) counts runs (7,350 a month), not executions.
Read its figure as runs only.

**Revisit triggers, kept from this measurement:**

- The courier incident log reads the whole `delivery_events` history on every load. It takes about 310 ms
  for 30 days at this load and grows with retained history, so it reaches about 2 s near 1.2M courier
  events (about six months at this load). Before then, give it a default date window or keep incidents in
  a table.
- The fee ledger loads every row of the month into memory and pages after. It grows with orders a month
  (452 ms at 288,000). Move totals to a monthly rollup and page rows in SQL before about 1M captured orders
  a month.
- Plan the Inngest Pro upgrade, or the self-hosted fallback in ADR-0016, before the pilot passes about 500
  orders a month.
