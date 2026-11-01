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
| **B: Ship** | coordinator script, then headless Claude only if needed | `scripts/merge-ticket.sh <n> "<verdict>"` squash-merges directly when the PR is up to date with `main` and all checks are green; otherwise it falls back to `scripts/ship-ticket.sh` (`/supermatt:ship-pr`: rebase, re-QA, bounded CI repair) | Squash merge, issue closed |
| **C: Retro** | weekly, not per ticket | `/supermatt:retro` over the week's sessions | Lessons for the brief and scripts |

`scripts/codex-review.sh` (standalone Codex, high effort, exhaustive) is now a fallback for when `implement`'s own review can't run, not a default stage: running it on top duplicates review and causes drip.

## Vercel previews

Previews are built only on request, to save the Hobby plan's daily build limit and Neon branches. `vercel.json` runs `scripts/vercel-ignore.sh`: `main` (production) always builds, and a PR branch builds only when the pushed commit message contains `[preview]`. Builders never add it. The coordinator pushes `git commit --allow-empty -m "chore: preview for verification [preview]"` to the PR branch at a milestone it wants to check, or when the user asks to see one. CI (ci and e2e on GitHub Actions) still runs on every push.

## Merge policy

Merge method: **squash merge**, confirmed by the user on 2026-10-31. Each ticket lands as one commit on `main`, and the builder's individual commits stay in the PR. GitHub deletes the head branch on merge, which triggers Neon's automatic cleanup of that PR's preview database branch.

Blocks merge (fixed on the branch):
- security, auth or secret exposure; per-store isolation (RLS) breaks; data loss
- an acceptance criterion observed failing (QA or preview)
- red CI, or a preview that doesn't boot or can't sign in
- missing evidence for a critical behaviour

Everything else becomes **one follow-up issue** (`ready-for-agent`, blocked by the merged ticket), and the PR merges.

Keyless builds: when a ticket's provider keys aren't available yet, `NO_KEYS=1 scripts/build-ticket.sh <n>` builds it against a fake behind a small interface. The PR is titled `[needs keys]`, lists the real-key checks, and stays unmerged until the human runs them. Tickets blocked by it wait too.

Anti-drip: one full review inside `implement`; follow-up reviews cover only the fix diff; **at most two fix rounds**. A third round means the ticket is too big: split it at triage. Any ticket with more than about 5 acceptance criteria, or more than one security-sensitive system, is split at triage.

## Concurrency (this PC)

- Up to **two builder lanes** (a Codex run counts as one lane), plus one light planner, only when free RAM is above about 6 GB and the two tickets touch disjoint areas. For example, a storefront UI round alongside a backend follow-up that adds no migrations. Tickets that both change the Prisma schema, auth or the same feature folder never run in parallel.
- Otherwise one builder lane. RAM and the 5-hour usage limit are shared.
- One ship at a time, so each PR merges on top of the last. CI runs once per PR (pull_request) and on `main` after merges (push), with superseded runs cancelled.
- Close idle Claude Code sessions before long runs; the OS memory guard kills builders below about 1 GB free.
- If a run is killed, resume the same session (`--resume`) instead of starting from zero.

## Evidence rules

- Every report names the commit SHA it checked. A report for an older SHA doesn't count.
- Scripts propagate failures; no `|| true` on the build or review step.
- The coordinator never builds; it plans the queue, checks evidence and previews, and merges via `ship-pr`.
