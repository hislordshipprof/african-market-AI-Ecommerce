# Orchestration workflow

How tickets get built. Adapted from SuperMatt's `orchestrate` (which needs Herdr, unavailable on Windows) and reviewed independently by Claude Fable and Codex `gpt-6-astra` (high) on 2026-10-31. Both found the same main bottleneck: the builder never ran `/supermatt:implement` (it can only be started by a prompt that names it), so its QA, three-axis review and self-fixing happened outside the builder, one slow round at a time.

## Stages

| Stage | Who | Command | Output |
|---|---|---|---|
| **T: Plan** (ticket N+1, while N builds) | headless Claude, main checkout, read-only | `scripts/plan-ticket.sh <n>` runs `/supermatt:triage #n` in delegated mode | Agent brief comment on the issue (verified claims, test seams, env needs, exclusions), label `ready-for-agent`, or `needs-info` with the missing facts |
| **Preflight** | script | inside `build-ticket.sh` | Refuses to start when the issue is blocked, has no brief, or `.env.local` lacks the keys in `scripts/ticket-env.txt` |
| **A: Build** | headless Claude, worktree | `scripts/build-ticket.sh <n>` runs `/supermatt:implement #n` | Small TDD commits; fresh-context `qa` on the local app; `code-review` (Standards / Spec / Adversarial, host-only per `docs/agents/cross-model.json`; no Codex peer per build); every verified finding fixed or deferred to a follow-up; pushed branch + PR; `.builder/report-<n>.md` |
| **Fix** (one automatic fix, then the coordinator's round 3) | same builder session, resumed | `scripts/build-ticket.sh <n> --resume "<findings>"` runs `/supermatt:fix-findings`. Refused when 3 review logs already exist | The coordinator's fix. Its review does not auto-fix |
| **V: Verify** | coordinator | CI green + live Vercel preview check in Chrome (`/api/health`, the ticket's acceptance scenarios) + coordinator spot-check of the review report | Pass, or blocking findings back to Fix |
| **B: Ship** | coordinator script, then headless Claude only if needed | `scripts/merge-ticket.sh <n>` checks the merge gate itself (see "Merge gate" below), then squash-merges directly when all checks are green and the PR is up to date with `main`, or is behind only by commits that touch none of its files (`scripts/ci-main.sh` is the safety net). If it overlaps but `git merge --no-edit origin/main` is clean, the script merges main in, pushes normally and reruns only what the merge can affect, with no agent. Nothing force-pushes. Otherwise it aborts the merge and `scripts/ship-ticket.sh` (`/supermatt:ship-pr`: merge main in, re-QA, bounded CI repair) repairs the branch and stops without merging: the repaired head needs `scripts/review-ticket.sh <n>` and then `scripts/merge-ticket.sh <n>` again | Squash merge, issue closed |
| **C: Retro** | weekly, not per ticket | `/supermatt:retro` over the week's sessions | Lessons for the brief and scripts |

`scripts/codex-review.sh` (standalone Codex, medium effort per `cross-model.json`) is now a fallback for when `implement`'s own review can't run, not a default stage: running it on top duplicates review and causes drip.

## Vercel previews

Previews are built only on request, to save the Hobby plan's daily deployment limit (100 a day) and Neon branches. An ignored build still creates a canceled deployment that counts toward that limit, so `vercel.json` also turns off Git deployments for `ticket-*`, `chore/*`, `docs/*`, `fix/*` and `feat/*` branches: builder pushes create no deployment at all. A milestone preview is a `preview/<name>` branch cut from the PR head or main with an empty `[preview]` commit. `vercel.json` runs `scripts/vercel-ignore.sh`. `main` (production) builds **only at milestones**: when the squash-merge subject ends with `[deploy]` (`DEPLOY=1 scripts/merge-ticket.sh <issue>`, only with the owner's go). Ordinary merges don't deploy, which saves the build allowance and Neon usage, because each production build runs `prisma migrate deploy` against the production database. The next `[deploy]` merge ships everything merged since. A PR branch builds only when the pushed commit message contains `[preview]`. Builders never add it. The coordinator pushes `git commit --allow-empty -m "chore: preview for verification [preview]"` to the PR branch at a milestone it wants to check, or when the user asks to see one. Hosted CI runs only on the `run-ci` label; the everyday gate is `scripts/ci-local.sh` (see builder.md).

## Merge policy

Merge method: **squash merge**, confirmed by the user on 2026-10-31. Each ticket lands as one commit on `main`, and the builder's individual commits stay in the PR. GitHub deletes the head branch on merge, which triggers Neon's automatic cleanup of that PR's preview database branch.

Blocks merge (fixed on the branch):
- security, auth or secret exposure; per-store isolation (RLS) breaks; data loss
- an acceptance criterion observed failing (QA or preview)
- red CI, or a preview that doesn't boot or can't sign in
- missing evidence for a critical behaviour

Everything else becomes **one follow-up issue** (`ready-for-agent`, blocked by the merged ticket), and the PR merges.

Keyless builds: when a ticket's provider keys aren't available yet, `NO_KEYS=1 scripts/build-ticket.sh <n>` builds it against a fake behind a small interface. The PR is titled `[needs keys]`, lists the real-key checks, and stays unmerged until the human runs them. Tickets blocked by it wait too.

Anti-drip: one full review inside `implement`; follow-up reviews cover only the fix diff; **one automatic fix round, then the coordinator's round 3**. After the second review the run stops and the coordinator diagnoses. `--resume` is that round 3 and does not auto-fix after its review; every mode is refused once 3 review rounds exist (from round 3 only real blockers block). Tickets are never split (owner decision 2026-11-04: splitting adds pipeline bottlenecks); each ticket ships as one PR.

## Lane credentials

`scripts/build-ticket.sh` does not copy `.env.local` into a lane. It writes the file through `scripts/lane-env.mjs` (`scripts/lane-env.sh`). The filter drops `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` unless that ticket's `scripts/ticket-env.txt` line lists one of them before the trailing `#` comment. It always drops `SEED_PRUNE_R2`, including for tickets that are allowed to write R2, and it drops `DATABASE_URL_UNPOOLED`. Those are the exceptions to byte-for-byte copying. Inherited copies of the same variables are unset in the builder shell before lane setup, the reviewer, or any other child starts. A filter failure removes the destination and stops the build before seeding. There is no raw-copy fallback.

The reason is the shared dev bucket `african-markets-dev`. A catalog prune deletes objects permanently: R2 does not implement bucket versioning, and the production and preview environments use that same bucket. A lane database does not own those references. A reviewer read-only token stays in #224. `scripts/lane-db.sh` also removes `DATABASE_URL_UNPOOLED` and `SEED_PRUNE_R2` so `resolveDirectUrl()` cannot follow a copied Neon URL and the seed cannot prune.

## Concurrency (this PC)

- Up to **three builder lanes** (a Codex run counts as one lane), plus one light planner, only when free RAM is above about 8 GB and the tickets touch disjoint areas. Each lane gets its own e2e port (`E2E_PORT=3000`, `3100`, `3200`; Playwright reads it). For example, a storefront UI round alongside a backend follow-up that adds no migrations. Tickets that both change the Prisma schema, auth or the same feature folder never run in parallel.
- Otherwise one builder lane. RAM and the 5-hour usage limit are shared.
- One ship at a time, so each PR merges on top of the last. CI runs once per PR (pull_request) and on `main` after merges (push), with superseded runs cancelled.
- Close idle Claude Code sessions before long runs; the OS memory guard kills builders below about 1 GB free.
- If a run is killed, resume the same session (`--resume`) instead of starting from zero.

## Evidence rules

- Every report names the commit SHA it checked. A report for an older SHA doesn't count.
- Scripts propagate failures; no `|| true` on the build or review step.
- The coordinator never builds; it plans the queue, checks evidence and previews, and merges with `scripts/merge-ticket.sh`.

## No agent reviews its own work (owner-approved 2026-11-02)

The owner wants as few bugs as possible, and no agent reviewing its own work in the same session.

- The builder never runs the code review on its own code.
- After every build and every fix round, `scripts/build-ticket.sh` runs `scripts/review-ticket.sh <n>`. That is a fresh `claude -p` session at high effort that sees only the diff, the issue and the brief, and writes `.builder/review-<n>.md` (first line `VERDICT: PASS` or `VERDICT: BLOCKING`) and `.builder/review-<n>.sha` (the commit it reviewed).
- RISK tickets also get the Codex review (gpt-6-astra, medium) in the same step. RISK means money, auth or external providers, detected from the keys in `ticket-env.txt`, or set with `RISK=1`. RISK tickets always build at full tier.
- Blocking findings go back to the builder's session as one automatic fix round. The builder reproduces each finding first, then fixes it test-first. The fix is re-reviewed by a new fresh session. After the second review the run stops before another automatic fix and the coordinator diagnoses. `--resume` is round 3; its review does not auto-fix.
- Planner briefs include 'Integration contracts' (how each provider really behaves, with doc links), an 'Edge cases' table, a short 'Required tests' list (file, name, level, regression caught) and a 'Review checklist'. The builder handles each edge case in code and writes only the required tests (docs/agents/builder.md, 'Which tests to write'; owner's rule, added to the pipeline 2026-11-05).
- **Brief review (owner decision 2026-11-03):** after the brief is posted, `plan-ticket.sh` runs the review engine (Codex) against the brief before any code exists, acting as the PR reviewer. Its 'Brief review' comment adds the failure modes reviewers used to find after the build as required tests. The builder covers both comments.
- **Round cap (owner decision 2026-11-06):** a ticket gets at most 3 review rounds, counted across runs from `.builder/logs/review-<n>-*.json` excluding `.second.json` (`ticket_review_count` in `scripts/build-ticket.sh`; tests: `bash scripts/ticket-rounds.test.sh`). After review round 2, `build-ticket.sh` stops before `run_fix` and the coordinator diagnoses. `--resume` is round 3; its review does not auto-fix, and local-ci is not cancelled on that last round. Every mode (build, `--resume`, `--continue`) is refused when 3 or more reviews already exist. There is no override. From review round 3, only real blockers block (security, isolation, money or data loss, an acceptance criterion observed failing, broken build or CI). Everything else goes to the follow-up issue and the PR merges. The coordinator does not escalate non-blocking findings to blocking in its decisions. The blocking-only rule is the 2026-11-03 decision; the 3-round cross-run cap is 2026-11-06.
- **Fix rounds** run only the specs affected by the findings, plus typecheck and lint. The builder never runs `scripts/ci-local.sh`: `build-ticket.sh` runs it after every push, in parallel with the review, at most two full suites at a time machine-wide (owner, 2026-11-04: rounds took 1–2 h, mostly repeated full-suite runs failing under load; raised from one to two slots on 2026-11-13, `CI_SLOTS`, because reviewed PRs waited hours for the runner).
- **Second review** (CURSOR_REVIEW_MODEL next to Codex) runs only on money and auth tickets: `RISK` is set automatically from STRIPE or BETTER_AUTH keys, or by hand with `RISK=1`.
- Test doubles must enforce the provider's real rules, and each external path needs a real sandbox test.
- The coordinator still reads the risky code paths itself before merging.

## Rigor tiers (owner-approved 2026-11-01)

- **full** (default; `scripts/build-ticket.sh <n>`): most capable model at high effort, with a three-axis review. Required for money (Stripe, checkout, refunds), auth, RLS/data isolation, migrations and order-state work.
- **light** (`TIER=light scripts/build-ticket.sh <n>`): Sonnet at medium effort. Only for test coverage, docs, CSS, copy and small follow-ups; it is overridden to full for RISK tickets. Review is always the independent step above.
- **fast path** (`FAST=1 scripts/build-ticket.sh <n>`, owner-approved 2026-11-05): for small, low-risk tickets such as test-only fixes, test helpers, docs, copy and single-module follow-ups. It skips `plan-ticket.sh` and its brief review. The builder posts its own short "## Fast-path brief" comment before coding. That comment never counts as a planner brief, so a ticket replanned later still goes through `plan-ticket.sh`. QA is proportionate: the acceptance criteria are proved with as few tests as do the job, with no separate qa pass or mutation run unless user-visible behaviour changes. The independent review and local-ci gates are unchanged. A RISK ticket is never fast: without a planner brief it is refused at preflight. A builder that finds money, auth, RLS, migrations, order state or a provider in scope stops without pushing and writes `.builder/replan-<n>` in its worktree. `build-ticket.sh` then exits 4 before the review loop, and does the same when the branch has no commits, so the coordinator replans the ticket in full. Pass `FAST=1` to `--resume`/`--continue` of a fast ticket too.
- **Analyse before fixing** (owner rule 2026-11-05): every fix round, from the first blocking finding, models the whole behaviour, researches the provider's docs and real-world practice, writes the full scenario matrix as tests, and fixes the class of bug. The model and matrix are posted on the issue before the push. If a ticket blocks twice in the same area, the coordinator stops fix rounds and runs a separate analysis and design step (written to the scratchpad, then handed to the builder) before any more code.
- **CI scope** (`scripts/ci-scope.sh`, owner-requested 2026-11-05): `ci-local.sh` runs only what a change needs. Docs: nothing. Pipeline shell scripts: their `scripts/*.test.sh`. Test files only: typecheck, lint and the changed tests, plus a build for changed e2e specs. Main merged cleanly into a passing commit (`CI_MERGED_FROM`, with the same patch against main): typecheck, lint and `vitest related`. Anything else, or anything unrecognised: the full suite. A new push stops the older run of that branch. Every `CI_MAIN_EVERY` merges (3), `scripts/ci-main.sh` runs the full suite on main in the same queue and opens a bug issue if it fails: hosted CI is off, so this is the only full run after a merge. Tests: `bash scripts/ci-scope.test.sh`.
- **Vitest RPC timeout** (`scripts/vitest-rpc-only.sh`): Vitest's `Timeout calling "onTaskUpdate"` hit about half of the runs on 2026-11-05, always with every test passing unless the summary showed a real failure. A failed run passes only when that timeout is its sole unhandled error and every test and test file is counted as passed, skipped or todo. A timeout with results unproved gets one rerun. The cause in Vitest is not yet known. Tests: `bash scripts/vitest-rpc-only.test.sh`.
- **Review watchdog** (`scripts/review-watch.sh`, owner-requested 2026-11-05): a reviewer that has written its verdict but not exited within `REVIEW_EXIT_GRACE_SEC` (300 s) is stopped with its whole process tree, as is any reviewer running past `REVIEW_TIMEOUT_MIN` (120 min, the only limit for `codex-review.sh`). After each review, Next.js servers still running from the ticket's worktree are stopped. Before this, a hung Codex reviewer froze a lane for hours, twice, and its leftover server broke the next CI run. Tests: `bash scripts/review-watch.test.sh`.
- **Batches:** small follow-ups in one area are grouped under one batch issue ("Batch: …", listing `Closes #a, #b, …`) and built in a single light run.
- **Review engine, owner decision 2026-11-07:** Codex is out of usage, so `REVIEW_ENGINE=claude` runs reviews and brief reviews on the benjamin@lynton.ai profile (`REVIEW_CLAUDE_CONFIG_DIR`), and RISK tickets keep a second review on Cursor Opus. Older Codex lines in this file describe the setup to return to when its usage comes back.
- **Codex:** no external peer on every build (`cross-model.json` mode `host-only`). The coordinator runs `scripts/codex-review.sh` (gpt-6-astra, medium effort) at milestones: before merging a money or auth ticket, and on the main-path PR that completes a phase slice. Codex UI builds also run at Astra medium, via `scripts/codex-ui-build.sh <worktree> <brief>`, without the Windows sandbox (owner-approved 2026-11-02) so Codex can run browsers, tests and builds itself. Its guard rules keep it inside the worktree and away from `.env` files.

## Headless engine (Claude Code or Cursor CLI)

Every pipeline script (`plan-ticket.sh`, `build-ticket.sh`, `review-ticket.sh`, `ship-ticket.sh`) runs its agent through `scripts/agent-cli.sh`. `ENGINE` in `scripts/agent-engine.env` picks the CLI; `AGENT_ENGINE=claude|cursor` overrides it for one run.

- **cursor**: the Cursor CLI (`agent`), installed with `irm 'https://cursor.com/install?win32=true' | iex` and signed in once with `agent login`, so it runs on the Cursor subscription with no API key. Headless flags: `-p --force --trust --approve-mcps --output-format json --workspace <worktree>`. Models come from `CURSOR_*_MODEL` in `agent-engine.env` (names from `agent models`). Builders and reviewers use different model families.
- Cursor cannot load Claude Code plugins, so the SuperMatt skills are vendored in `.cursor/skills/supermatt/` (MIT). A prompt that starts with `/supermatt:<skill>` is rewritten to "read and follow `.cursor/skills/supermatt/skills/<skill>/SKILL.md`". Cursor also reads `CLAUDE.md`, `AGENTS.md` and `.claude/skills/`.
- **Owner 2026-11-10:** builds run as headless Claude sessions on the ben@lynton.ai profile (`CLAUDE_CONFIG_DIR=~/.claude`). The coordinator starts and verifies them, and reviews only the report and the diff. Every role runs on Opus 5.5 at medium effort (`AGENT_CLAUDE_MODEL`, `AGENT_CLAUDE_EFFORT`), never Fable unless the owner asks. `scripts/agent-cli.sh` drops the parent session's `CLAUDE_CODE_*`/`ANTHROPIC_*` variables so a run started from the desktop app bills the chosen profile, not the parent account.
- Session ids are per engine (`.builder/session-<n>.txt` for Claude, `.builder/session-<n>.cursor.txt` for Cursor). A fix round with no saved session starts fresh and rebuilds context from the issue, the PR and `git log`.

## Coordinator runbook (any engine)

The coordinator is one interactive session that never writes product code. Everything it needs is in the repo and the Phase 1 Build Board artifact:

1. **Queue:** open issues labelled `ready-for-agent`, in the order of the Phase 1 Build Board artifact (see `CLAUDE.md`). Keep up to 3 lanes (ports 3000, 3100, 3200) while about 1 GB of RAM stays free. Never start a ticket that edits the same files as a running lane.
2. **Start a lane:** run `scripts/plan-ticket.sh <n>` if the issue has no "Agent brief" comment, then `E2E_PORT=<port> [TIER=light] [RISK=1] scripts/build-ticket.sh <n>`. Each lane gets its own local Postgres database (`lane_t<n>`); lanes never touch Neon.
3. **Review loop:** `build-ticket.sh` runs a fresh independent review (`review-ticket.sh`, plus Codex for RISK tickets) after every build and fix round. One automatic fix follows the first blocking review. After the second review the coordinator writes a decision (findings to fix, scope cuts, deferrals to named follow-up issues) and runs `scripts/build-ticket.sh <n> --resume "<decision>"` once. That review ends the ticket: no automatic fix, and every mode is refused when 3 review logs already exist.
4. **Merge gate:** a review verdict of PASS on the PR head, and a `local-ci` success status on that same head (`build-ticket.sh` runs it beside each review; when it did not, e.g. SKIP_REVIEW=1 or a failed build run, the coordinator runs `E2E_PORT=<port> CI_DB=ci CI_RUNNER=../E-commerce-worktrees/ci-runner scripts/ci-local.sh` in the worktree). Then `scripts/merge-ticket.sh <n>`. The script enforces both halves and takes no verdict from the caller (`scripts/merge-gate.sh`, tests in `scripts/merge-gate.test.sh`): line 1 of the review file must be exactly `VERDICT: PASS`, no line may be `VERDICT: BLOCKING` (the second RISK review is appended to the same file), and `.builder/review-<n>.sha` must equal the PR head. A push after the review, or a repair by `ship-ticket.sh`, needs a new review. The script's own clean merge of main carries the review over (`<new> merged-from <reviewed>`) only when the new head's parents are the reviewed commit and main, and its diff against main has the same patch-id as the reviewed change; the gate checks this again. Otherwise, for example when main already holds part of the PR, the head needs a new review. When the owner decides to merge a reviewed commit with known findings, run it with `OWNER_ACCEPTS_BLOCKING="<the owner's reason>"`; the reason is posted on the PR, and the review must still be of the PR head. Do not add the `run-ci` label before 2026-12-01 (GitHub Actions budget).
5. **Deploys:** production builds only when the squash subject ends with `[deploy]`. Use it only at milestones and only with the owner's go: `DEPLOY=1 scripts/merge-ticket.sh <issue>`, which keeps the review gate and the co-author filter. Batch merges into one deploy. Never put the marker anywhere else in a title.
6. **Records:** update the Phase 1 Build Board `tickets` row, close or edit follow-up issues, and record every decision on the issue, not only in chat.

## Commit attribution

Commits carry no AI co-author and no session link (owner rule, 2026-11-09). `scripts/strip-ai-coauthors.sh` removes `Co-Authored-By:` trailers that credit Claude or Cursor, `Claude-Session:` trailers and the "Generated with Claude Code" line. `.githooks/commit-msg` runs it on every commit once `core.hooksPath` is `.githooks` (`build-ticket.sh` sets this), and `merge-ticket.sh` runs it on the squash message it gives GitHub. Tests: `bash scripts/strip-ai-coauthors.test.sh`.

## Time limits

Every agent session is stopped, with its process tree, when it passes its cap (`run_capped` in `scripts/review-watch.sh`). A stopped session exits 124 and nothing follows it automatically: no review, no fix round.

| Session | Cap | Setting |
|---|---|---|
| Plan | 45 min | `PLAN_TIMEOUT_MIN` |
| Brief review | 30 min | `BRIEF_REVIEW_TIMEOUT_MIN` |
| Build, fix round, `--continue` | 90 min each | `BUILD_TIMEOUT_MIN` |
| Independent review | 120 min | `REVIEW_TIMEOUT_MIN` |
| Ship (merge main in and repair) | 45 min | `SHIP_TIMEOUT_MIN` |

A ticket also has a builder budget: 300 minutes across all of its build, fix and `--continue` sessions (`LANE_BUDGET_MIN`), counted from the logs in `.builder/logs/`. The last session gets only what is left, and at zero `build-ticket.sh` refuses to start one. Raising the budget for one run is the owner's call. Each run prints the lane's age, measured from its plan log.

`build-ticket.sh` refuses every mode once a ticket has 3 review logs. It also stops without a fix round when the review passed and local-ci failed in setup, and when a fix round made no commit. That review still counts toward the 3.

## The local-ci queue

Up to `CI_SLOTS` suites (default 2) run at once, each holding its own slot's lock (`scripts/ci-lock.sh`, tests in `scripts/ci-lock.test.sh`). Slot 1 keeps the caller's checkout, database and port; slot k runs in `ci-runner-k` on `<CI_DB>_k` at port + (k-1)*1000. A hand run without `CI_RUNNER` and `CI_DB` uses only slot 1. With every slot held, a run waits. A waiting run takes over a slot's lock only when that slot's owner has exited. A run still alive after 6 hours is stopped first. A full run on main that reaches the front of the queue after a newer one was queued skips itself.
