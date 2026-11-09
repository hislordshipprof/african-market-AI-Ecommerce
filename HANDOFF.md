# Handoff: African Markets Platform

Written 2026-11-08, updated 2026-11-09 from GitHub (PR heads and `local-ci` statuses). Main is at `dc69434` (the handoff commit, #407; code is unchanged since `f8e5f02`). All branches are pushed. Every build lane, CI run and queue has been stopped. Nothing is running on the dev machine except the local dev server on port 3005.

Read first: `CLAUDE.md`, `docs/spec/platform-spec.md`, `GLOSSARY.md`, `docs/adr/`, `docs/agents/` (builder, orchestration, issue tracker, labels).

## What changed in the 2026-11-09 update

- **#402 is ready to merge.** `local-ci` passed on `eb7ab40` at 23:58 UTC on 2026-11-08, the same head the review passed on. The first version of this file said CI had not run.
- **#404 and #405 show a `pending` local-ci status that is stale.** They were posted at 00:56 and 00:58 UTC on 2026-11-09, just before everything was stopped ("running" on #405, "queued for the machine-wide local-ci lock" on #404). No run is behind them. Nothing clears a pending status when a run is killed, so they will sit there until the next run on that head.
- **The PR numbers on four rows were attached to the wrong tickets.** Corrected below: #371 is #367, #359 is #247, #341 is #146, #313 is #207.
- No PR has merged and no head has moved since the handoff was written. #401 and #389 are still open.

## Open PRs and where each one stands

`local-ci` is the status on the PR's current head, read on 2026-11-09.

| PR | Ticket | Head | local-ci | State | What's left |
|---|---|---|---|---|---|
| #402 | #128 Customer notifications (email + SMS) | `eb7ab40` | passed | Review **PASS** on this head (`.builder/review-128.md` on the dev machine). | The review predates the commit binding, so `merge-ticket.sh 128` will ask for `.builder/review-128.sha`. Either rerun `scripts/review-ticket.sh 128`, or, if the review file is the PASS described here, write `eb7ab4042d0df5a54df04a48d63525ff27762776` into that file by hand. Follow-ups are in #403. |
| #384 | #167 Closed-store checkout queueing + `CHECKOUT_LIVE_MODE` | `5702432` | **failed: test** (2026-11-08 15:30 UTC) | Review passed. A later CI run was in progress when everything stopped and posted nothing. | Run local CI again. If the test step fails again, fix it before merging. Follow-ups are in #383. |
| #404 | #142 Store copilot v1 (text reports, one-tap confirm) | `8cfd3f8` | stale pending | Stopped mid fix round after about 5 hours. The rounds kept churning on one case: the owner's report matches several listings and the model asks which one. | Diagnose that case properly before any more rounds (max 3 rounds per ticket). Follow-ups are in #406. |
| #405 | #133 Store delivery checkout (settings, address, frozen-item guard) | `174d0a6` | stale pending | Stopped mid build/fix after about 4 hours. | Review the current head, fix what's real, and finish. The address lookup is Photon + US Census per ADR-0017 (comment on #133). |
| #371 | #367 Low-stock explicit add | `5be0bda` | passed | Waiting on an owner decision: one extra round, or merge as is. | Owner decision. |
| #359 | #247 Shopper assistant A3 agentic checkout | `1285960` | passed | Waiting on an owner decision. | Owner decision. |
| #341 | #146 Golden evaluation set | `bd0b775` | none on this head | Waiting on an owner decision about the recipe test rule. The head is the main-merge commit pushed on 2026-11-08. | Owner decision, then local CI on the new head. |
| #313 | #207 Migrate-diff fail-closed | `03f91e2` | passed (2026-11-05) | Open. The branch is well behind main. | Review, then merge. |
| #46 | #5 Custom domains | `7930905` | not checked | Labeled `needs keys`. | Needs Vercel custom-domain setup from the owner. |

## Blocked tickets and what unblocks them

- **#129 Web push** needs VAPID keys. #12 depends on #129, and #18, #13 and #19 depend on #12.
- **#135, #139, #140** (DoorDash, Uber Direct, courier selection) need DoorDash and Uber keys.
- **#269** needs Stripe webhook endpoints and Inngest keys set on Vercel.
- **#270** needs a read-only R2 token.
- Other dependency chains:
  - #144 is blocked by #143.
  - #22 and #21 are blocked by #20.
  - #26 is blocked by #19 and #24.
  - #25 is blocked by #24.
- **Unblocked and ready:** #143, #134, #124, #65, plus the follow-up issues labeled `ready-for-agent`.
- **Main health:** #401 and #389 are still open. Check these first. Both failed at the test step after one retry:
  - #401 (`5410838`): `src/lib/admin/catalog-actions.test.ts` could not start a Prisma transaction in time, in `beforeAll` and `afterAll`. This looks like connection-pool pressure under the full run, not a product bug.
  - #389 (`46c9927`): `src/lib/stripe/contract.test.ts`, the asynchronously failing refund stayed `succeeded` on the Stripe sandbox. This depends on sandbox timing.

## Owner decisions still open

- #367, #247 and #146, as listed in the table above.
- #376: add low-cost embeddings to search, after measuring search misses.
- Rotate the Anthropic API key.
- #398: revisit the Photon + US Census address choice later.
- Vercel is on the Hobby plan. Whether to upgrade, and the #309 firewall, are undecided.

## Owner rules (these apply to whoever continues)

- Merge a PR only when the review's first or last line is exactly `VERDICT: PASS` **and** local CI passed on the same head. Match that exact line, never a loose pattern. PR #390 merged with a BLOCKING review because of a loose match and was fixed in #394.
- **No GitHub Actions runs until 2026-12-01.** Don't add the `run-ci` label. The `local-ci` commit status from `scripts/ci-local.sh` is the CI gate. Run CI one PR at a time. Don't rerun CI when only the merge is left and the code at that head is unchanged.
- Production deploys only through a squash commit whose subject ends in `[deploy]`, and only with the owner's say.
- **Max 3 rounds per ticket.** After round 2, stop and diagnose the whole behaviour before round 3. `build-ticket.sh` now refuses every mode at 3 review logs.
- **Watch session length:**
  - Cap a builder session at about 90 minutes, and stop it if it churns.
  - Measure a lane's age from its start (the plan log timestamp), not from the current fix round.
  - The pipeline now stops every session at its cap (see "Pipeline fixes").
- Only necessary tests: no tests for UI-only changes, and no one-test-per-edge-case.
- No regex or word lists for product matching. Use Postgres search and structured model input.
- Lanes use a private local Postgres on `:5434`, never Neon. Don't delete Neon branches; the owner does that.
- Never split tickets. No agent reviews its own work.
- Never commit `.claude/settings.json`. Never print `.env` values. The owner adds all keys.
- The gtm-queue repo's failing workflow is not part of this project. Ignore it.

## Pipeline (how tickets were built)

- `scripts/build-ticket.sh <n>`: plan, brief review, build, independent review and fix rounds, in worktree `C:\E-commerce-worktrees\ticket-<n>`. Reviews go to `.builder/review-<n>.md` and logs to `.builder/logs/` on the dev machine (gitignored).
- `scripts/agent-engine.env` picks the agent CLI and models. It's currently set to the Cursor CLI for build and review. Change it to whatever provider the next team uses.
- `scripts/ci-local.sh` runs local CI and posts the `local-ci` status.
- `scripts/merge-ticket.sh <n>` merges. It reads the review file itself and takes no verdict from the caller (see "Pipeline fixes" below). It starts a full main CI run every 3 merges.
- `scripts/ticket-env.txt` lists which env key names each ticket needs. Every PR appends a line, so it causes merge conflicts.

## Known problems

- The pipeline fixes below have passed their script tests on Linux only. They have not run on the Windows dev machine or against a real ticket yet. Run `for t in scripts/*.test.sh; do bash "$t"; done` there first.
- Old ticket worktrees contain regenerated screenshots and scratch scripts that were never committed. Their branches are already merged, so nothing is lost. `ticket-146` has an untracked `src/lib/assistant/eval/ticket-spend.json`, a generated spend counter.
- Killing a local-ci run from outside leaves its `pending` status on the commit (see #404 and #405).

## Pipeline fixes (2026-11-09)

These close the merge-gate holes and the causes of stalled lanes found in the audit below. Details and settings are in `docs/agents/orchestration.md` ("Merge gate", "Time limits", "The local-ci queue").

- **Merge gate.** `merge-ticket.sh` reads `.builder/review-<n>.md` and refuses unless line 1 is exactly `VERDICT: PASS`, no line is `VERDICT: BLOCKING`, and `.builder/review-<n>.sha` (written by `review-ticket.sh`) equals the PR head. This is stricter than "first or last line": a PASS on the last line of a BLOCKING review does not merge.
- **Owner decisions to merge as is** (#367, #247, #146) go through `OWNER_ACCEPTS_BLOCKING="<reason>" scripts/merge-ticket.sh <n>`. The reason is posted on the PR. The review must still be of the PR head, and CI must still be green.
- **`ship-ticket.sh` no longer merges.** It rebases and repairs, then the new head needs a review and `merge-ticket.sh` again.
- **Second-reviewer verdict** is matched exactly, not by prefix.
- **Every agent session has a cap** and is stopped at it: plan 45 min, brief review 30, build and each fix round 90, ship 45. A ticket has 300 builder minutes in total, so `--continue` cannot restart the clock.
- **The 3-round cap applies to every mode**, not only `--resume`.
- **No round is spent** when the review passed and CI failed in setup, or when a fix round made no commit.
- **The local-ci lock** can no longer be held by two runs. A lock is taken over only from a run that has exited; a run hung for 6 hours is stopped first.
- **Full runs on main no longer pile up.** One that reaches the front of the queue after a newer one was queued skips itself.
- **`scripts/ticket-env.txt`** now merges by union (`.gitattributes`), so two PRs that each append a line no longer conflict in a local rebase. GitHub's own merge does not read this setting.

Not done: the second review on a RISK ticket still runs the same model as the first (`CURSOR_REVIEW_MODEL`), which is a setting in `scripts/agent-engine.env` for the owner to choose.

## State machine audit (2026-11-09, main at `dc69434`)

A read of the code on main. Work on unmerged branches (#384, #402, #404, #359) was not audited. The pipeline findings have been fixed; the order lifecycle findings have not.

### Build pipeline

Fixed on 2026-11-09; see "Pipeline fixes" above. One item is left: under the current `agent-engine.env` both reviews on a RISK ticket run the same model, so the second is not independent.

### Order lifecycle (`src/lib/order/service.ts`)

Transitions are atomic (store row lock, then re-check in the same transaction). The problems are missing paths, not races.

- **Recovery depends on Inngest.** With no `INNGEST_EVENT_KEY` in production the order event is not sent, so there is no auto-cancel timer (#269 is the ticket for the keys). Alert audit rows (`reconcile_failed`, `capture_released`, `acceptance_alert`) are written but nothing reads them; admin only sees `REFUND_FAILED`.
- **Orders placed while the store is closed are auto-cancelled at 30 minutes** (`src/lib/inngest/functions.ts:126`). #384 fixes this. Auto-accept only fires from an open staff browser.
- **No cancel and no timeout out of `ACCEPTED` or `PICKING`.** An abandoned order keeps its stock reservation and card hold. The Stripe webhook does not handle `payment_intent.canceled`.
- **The `short` line status is a dead end.** Nothing moves a line out of it, so the order can never be marked ready. No UI reaches it yet; it will when #13 adds the button.
- **A card hold can exist with no order** if the shopper closes the tab between confirming the card and `placeOrder`. No webhook or sweep cleans it up.
- `evaluateOrderRefundState` calls Stripe while holding the store lock (`src/lib/order/refund-requests.ts:409-422`).
- **Three state lists disagree:** spec section 9, `OrderStatus` in the order service, and a second `OrderStatus` in `src/lib/customer-flow/contracts.ts`. `READY` is unreachable. The status column is a free string with no CHECK constraint, and status writes sit in about 12 places with no transition table.

### Smaller

- Assistant turn lease is released without an owner check (`src/lib/assistant/chat-handler.ts:657`), so a turn longer than 90 seconds can clear the next turn's lease.
- Invite accept is read-then-write; a double submit errors instead of succeeding.
- Stock events, refund requests, listing import and the capture retry ladder were read and look sound.

### Suggested order for what is left

1. Health check for the Inngest key and an admin list of stuck orders.
2. Store and customer cancel plus `payment_intent.canceled`, before the Short button ships.
3. One order transition table, CHECK constraints, and a spec update.
