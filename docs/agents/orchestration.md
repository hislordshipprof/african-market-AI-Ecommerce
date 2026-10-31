# Orchestration workflow

How tickets get built. Adapted from SuperMatt's `orchestrate` (which needs Herdr, unavailable on Windows) and reviewed independently by Claude Fable and Codex `gpt-6-astra` (high) on 2026-10-31. Both found the same main bottleneck: the builder never ran `/supermatt:implement` (it can only be started by a prompt that names it), so its QA, three-axis review and self-fixing happened outside the builder, one slow round at a time.

## Stages

| Stage | Who | Command | Output |
|---|---|---|---|
| **T: Plan** (ticket N+1, while N builds) | headless Claude, main checkout, read-only | `scripts/plan-ticket.sh <n>` runs `/supermatt:triage #n` in delegated mode | Agent brief comment on the issue (verified claims, test seams, env needs, exclusions), label `ready-for-agent`, or `needs-info` with the missing facts |
| **Preflight** | script | inside `build-ticket.sh` | Refuses to start when the issue is blocked, has no brief, or `.env.local` lacks the keys in `scripts/ticket-env.txt` |
| **A: Build** | headless Claude, worktree | `scripts/build-ticket.sh <n>` runs `/supermatt:implement #n` | Small TDD commits; fresh-context `qa` on the local app; `code-review` (Standards / Spec / Adversarial + Codex peer, `docs/agents/cross-model.json`); every verified finding fixed or deferred to a follow-up; pushed branch + PR; `.builder/report-<n>.md` |
| **Fix** (at most 2 rounds) | same builder session, resumed | `scripts/build-ticket.sh <n> --resume "<findings>"` runs `/supermatt:fix-findings` | Fix commits, re-QA and re-review of the fix diff only |
| **V: Verify** | coordinator | CI green + live Vercel preview check in Chrome (`/api/health`, the ticket's acceptance scenarios) + coordinator spot-check of the review report | Pass, or blocking findings back to Fix |
| **B: Ship** | headless Claude, worktree | `scripts/ship-ticket.sh <n>` runs `/supermatt:ship-pr` | Rebase on `main`, QA the resolved diff if it changed, bounded CI repair, squash merge, issue closed |
| **C: Retro** | weekly, not per ticket | `/supermatt:retro` over the week's sessions | Lessons for the brief and scripts |

`scripts/codex-review.sh` (standalone Codex, high effort, exhaustive) is now a fallback for when `implement`'s own review can't run, not a default stage: running it on top duplicates review and causes drip.

## Merge policy

Blocks merge (fixed on the branch):
- security, auth or secret exposure; per-store isolation (RLS) breaks; data loss
- an acceptance criterion observed failing (QA or preview)
- red CI, or a preview that doesn't boot or can't sign in
- missing evidence for a critical behaviour

Everything else becomes **one follow-up issue** (`ready-for-agent`, blocked by the merged ticket), and the PR merges.

Anti-drip: one full review inside `implement`; follow-up reviews cover only the fix diff; **at most two fix rounds**. A third round means the ticket is too big: split it at triage. Any ticket with more than about 5 acceptance criteria, or more than one security-sensitive system, is split at triage.

## Concurrency (this PC)

- At most **two** Claude processes: one builder lane, plus one light planner or verifier.
- Never two builders: RAM and the 5-hour usage limit are shared, and Phase 1 waves overlap on schema and auth.
- One ship at a time (rebase + merge), so each PR merges on top of the last.
- Close idle Claude Code sessions before long runs; the OS memory guard kills builders below about 1 GB free.
- If a run is killed, resume the same session (`--resume`) instead of starting from zero.

## Evidence rules

- Every report names the commit SHA it checked. A report for an older SHA doesn't count.
- Scripts propagate failures; no `|| true` on the build or review step.
- The coordinator never builds; it plans the queue, checks evidence and previews, and merges via `ship-pr`.
