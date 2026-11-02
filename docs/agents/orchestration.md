# Orchestration workflow

How tickets get built. Adapted from SuperMatt's `orchestrate` (which needs Herdr, unavailable on Windows) and reviewed independently by Claude Fable and Codex `gpt-6-astra` (high) on 2026-10-31. Both found the same main bottleneck: the builder never ran `/supermatt:implement` (it can only be started by a prompt that names it), so its QA, three-axis review and self-fixing happened outside the builder, one slow round at a time.

## Stages

| Stage | Who | Command | Output |
|---|---|---|---|
| **T: Plan** (ticket N+1, while N builds) | headless Claude, main checkout, read-only | `scripts/plan-ticket.sh <n>` runs `/supermatt:triage #n` in delegated mode | Agent brief comment on the issue (verified claims, test seams, env needs, exclusions), label `ready-for-agent`, or `needs-info` with the missing facts |
| **Preflight** | script | inside `build-ticket.sh` | Refuses to start when the issue is blocked, has no brief, or `.env.local` lacks the keys in `scripts/ticket-env.txt` |
| **A: Build** | headless Claude, worktree | `scripts/build-ticket.sh <n>` runs `/supermatt:implement #n` | Small TDD commits; fresh-context `qa` on the local app; `code-review` (Standards / Spec / Adversarial, host-only per `docs/agents/cross-model.json`; no Codex peer per build); every verified finding fixed or deferred to a follow-up; pushed branch + PR; `.builder/report-<n>.md` |
| **Fix** (at most 2 rounds) | same builder session, resumed | `scripts/build-ticket.sh <n> --resume "<findings>"` runs `/supermatt:fix-findings` | Fix commits, re-QA and re-review of the fix diff only |
| **V: Verify** | coordinator | CI green + live Vercel preview check in Chrome (`/api/health`, the ticket's acceptance scenarios) + coordinator spot-check of the review report | Pass, or blocking findings back to Fix |
| **B: Ship** | coordinator script, then headless Claude only if needed | `scripts/merge-ticket.sh <n> "<verdict>"` squash-merges directly when all checks are green and the PR is up to date with `main`, or is behind only by commits that touch none of its files (main's post-merge CI is the safety net); otherwise it falls back to `scripts/ship-ticket.sh` (`/supermatt:ship-pr`: rebase, re-QA, bounded CI repair) | Squash merge, issue closed |
| **C: Retro** | weekly, not per ticket | `/supermatt:retro` over the week's sessions | Lessons for the brief and scripts |

`scripts/codex-review.sh` (standalone Codex, medium effort per `cross-model.json`) is now a fallback for when `implement`'s own review can't run, not a default stage: running it on top duplicates review and causes drip.

## Vercel previews

Previews are built only on request, to save the Hobby plan's daily deployment limit (100 a day) and Neon branches. An ignored build still creates a canceled deployment that counts toward that limit, so `vercel.json` also turns off Git deployments for `ticket-*`, `chore/*`, `docs/*`, `fix/*` and `feat/*` branches: builder pushes create no deployment at all. A milestone preview is a `preview/<name>` branch cut from the PR head or main with an empty `[preview]` commit. `vercel.json` runs `scripts/vercel-ignore.sh`: `main` (production) always builds, and a PR branch builds only when the pushed commit message contains `[preview]`. Builders never add it. The coordinator pushes `git commit --allow-empty -m "chore: preview for verification [preview]"` to the PR branch at a milestone it wants to check, or when the user asks to see one. CI (ci and e2e on GitHub Actions) still runs on every push.

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

- Up to **three builder lanes** (a Codex run counts as one lane), plus one light planner, only when free RAM is above about 8 GB and the tickets touch disjoint areas. Each lane gets its own e2e port (`E2E_PORT=3000`, `3100`, `3200`; Playwright reads it). For example, a storefront UI round alongside a backend follow-up that adds no migrations. Tickets that both change the Prisma schema, auth or the same feature folder never run in parallel.
- Otherwise one builder lane. RAM and the 5-hour usage limit are shared.
- One ship at a time, so each PR merges on top of the last. CI runs once per PR (pull_request) and on `main` after merges (push), with superseded runs cancelled.
- Close idle Claude Code sessions before long runs; the OS memory guard kills builders below about 1 GB free.
- If a run is killed, resume the same session (`--resume`) instead of starting from zero.

## Evidence rules

- Every report names the commit SHA it checked. A report for an older SHA doesn't count.
- Scripts propagate failures; no `|| true` on the build or review step.
- The coordinator never builds; it plans the queue, checks evidence and previews, and merges via `ship-pr`.

## No agent reviews its own work (owner-approved 2026-11-02)

The owner wants as few bugs as possible, and no agent reviewing its own work in the same session.

- The builder never runs the code review on its own code.
- After every build and every fix round, `scripts/build-ticket.sh` runs `scripts/review-ticket.sh <n>`. That is a fresh `claude -p` session at high effort that sees only the diff, the issue and the brief, and writes `.builder/review-<n>.md` (first line `VERDICT: PASS` or `VERDICT: BLOCKING`).
- RISK tickets also get the Codex review (gpt-6-astra, medium) in the same step. RISK means money, auth or external providers, detected from the keys in `ticket-env.txt`, or set with `RISK=1`. RISK tickets always build at full tier.
- Blocking findings go back to the builder's session as a fix round. The builder reproduces each finding first, then fixes it test-first. The fix is re-reviewed by a new fresh session. After 2 fix rounds the coordinator decides.
- Planner briefs include 'Integration contracts' (how each provider really behaves, with doc links) and an 'Edge cases' table. The builder turns each row into a test.
- Test doubles must enforce the provider's real rules, and each external path needs a real sandbox test.
- The coordinator still reads the risky code paths itself before merging.

## Rigor tiers (owner-approved 2026-11-01)

- **full** (default; `scripts/build-ticket.sh <n>`): most capable model at high effort, with a three-axis review. Required for money (Stripe, checkout, refunds), auth, RLS/data isolation, migrations and order-state work.
- **light** (`TIER=light scripts/build-ticket.sh <n>`): Sonnet at medium effort. Only for test coverage, docs, CSS, copy and small follow-ups; it is overridden to full for RISK tickets. Review is always the independent step above.
- **Batches:** small follow-ups in one area are grouped under one batch issue ("Batch: …", listing `Closes #a, #b, …`) and built in a single light run.
- **Codex:** no external peer on every build (`cross-model.json` mode `host-only`). The coordinator runs `scripts/codex-review.sh` (gpt-6-astra, medium effort) at milestones: before merging a money or auth ticket, and on the main-path PR that completes a phase slice. Codex UI builds also run at Astra medium, via `scripts/codex-ui-build.sh <worktree> <brief>`, without the Windows sandbox (owner-approved 2026-11-02) so Codex can run browsers, tests and builds itself. Its guard rules keep it inside the worktree and away from `.env` files.

