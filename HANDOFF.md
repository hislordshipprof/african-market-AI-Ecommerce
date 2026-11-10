# Handoff: African Markets Platform

Updated 2026-11-09, evening. Main is at `dc69434`. Every branch below is pushed. Nothing is running anywhere: the cloud session that wrote this has stopped, and so has every pipeline lane on the old Windows dev machine.

Read first: `CLAUDE.md`, then this file, then `docs/agents/` (builder, orchestration). The spec, `GLOSSARY.md` and `docs/adr/` are the source of truth for product decisions.

## Mac state (2026-11-09, read this before "Start here")

Steps 1 to 3 below are done on the Mac; don't repeat them. Continue at step 4, item 1 (#408).

- **GitHub:** use only the `hislordshipprof` account (`gh auth status` must show it active). Never use `agentlynt` or `blyntonai`.
- **Shell:** run `source ~/.local/share/african-markets-tools/mac-env.sh` before any script. It sets Node 22 and pnpm 10 (CI's versions; the Mac's default pnpm 9 rewrites the lockfile), `LC_ALL` (Postgres won't start without it), `PGBIN`, `LANE_PG_DATA`, `AGENT_ENGINE=claude`, `REVIEW_ENGINE=claude`, GNU `date`/`stat`/`sed`, and a `claude` wrapper. The wrapper points `/supermatt:code-review` at the repo's vendored skill, because this plugin isn't installed in the Claude profile.
- **Postgres:** after a reboot, source that file and run step 2's `pg_ctl` start command.
- **Review worktree:** `.env.local` points at Neon, so a worktree must never copy it directly. Before `scripts/review-ticket.sh <n>`, from `~/E-commerce-worktrees/ticket-<n>`:

  ```bash
  pnpm install --frozen-lockfile
  bash -c '. ~/E-com/scripts/lane-env.sh; prepare_lane_env <n> ~/E-com/.env.local "$PWD/.env.local" ~/E-com/scripts/ticket-env.txt'
  bash ~/E-com/scripts/lane-db.sh t<n> "$PWD/.env.local"
  ```

  Then confirm `grep -c neon.tech .env.local` prints 0. Run `review-ticket.sh` from `~/E-com`.
- **#408:** the seven `scripts/*.test.sh` files pass on macOS with the GNU tools; four tests fail without them. Review round 1 of `9f21111` was BLOCKING: a ship session could merge an unreviewed head. Round 2 denies `gh pr merge` in that session, makes `ship-ticket.sh` and `merge-ticket.sh` exit 6 if the PR got merged anyway, and adds `merge-ticket.sh --pr <pr-number>`. Round 2 (`e582f1e`) review was BLOCKING on a new finding, and `local-ci` failed. Both details are below. Round 3 is the last: per the owner rule, stop and diagnose the whole behaviour, brief the owner, and wait for the go before starting it. Any later commit makes a review stale.
  - **Blocking finding:** a session killed at its cap is charged 0 minutes against the 300-minute budget, because `ticket_builder_minutes` (`build-ticket.sh:67`) uses the log's mtime and the log is only written at exit. Full text: `.builder/review-408.md`.
  - **`local-ci` failure:** 1 of 2,173 tests, `e2e/spawned-server.unit.ts` "stop kills the listener", fails every time on the Mac. `ssListeners` in `e2e/spawned-server.ts` runs `ss`, which macOS doesn't have, so the lookup returns no PIDs and the listener survives. It is the same code on main, and it will fail every full `local-ci` here until fixed; `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` is available. Each failing run leaves a `detached-listener.mjs` process to stop.
- **PRs not on a `ticket-<n>-` branch (#408, #411, #412):** run `review-ticket.sh <pr-number>`, then `merge-ticket.sh --pr <pr-number>`. Review files and the worktree use the PR number.
- **Mac-fix PR, after #408 merges (owner's choice):** replace the GNU-only calls, then drop GNU tools from the shell setup. `date -d` in `build-ticket.sh:57`; `stat -c` in `ci-lock.sh:25`, `build-ticket.sh:67`, `review-watch.sh:65`; `sed -i` in `review-ticket.sh:67,75,77` and `ci-scope.test.sh`.

## Start here (a new agent session on the owner's Mac)

You are continuing work in `~/E-com` on the owner's MacBook. The owner's `.env.local` is in that folder; never print its values. Work through the steps in order and report to the owner after each PR, before merging anything.

### 1. Set up the checkout (once)

If `~/E-com` has no `.git` yet (it held only `.env.local`):

```bash
cd ~/E-com && git init && git remote add origin https://github.com/hislordshipprof/african-market-AI-Ecommerce.git && git fetch origin && git checkout -t origin/claude/focused-johnson-8op40i
```

That branch is PR #408, which carries this file and the pipeline fixes. Then:

```bash
pnpm install && git config core.hooksPath .githooks
```

- `gh auth status` must show the owner signed in; the scripts call `gh`.
- Other worktrees go in `~/E-commerce-worktrees/` (the scripts expect that sibling folder).

### 2. Local Postgres on :5434 (the scripts assume Windows)

`scripts/local-pg.sh`, `lane-db.sh` and `ci-local.sh` default to `C:\Program Files\PostgreSQL\18\bin`, and start the server through PowerShell. On the Mac:

1. Install Postgres 18 (CI runs 18): `brew install postgresql@18`.
2. Before any script, set in the shell:
   - `export PGBIN="$(brew --prefix postgresql@18)/bin"`
   - `export LANE_PG_DATA="$HOME/.local/share/african-markets-pg/data"`
   - `LANE_PG_PORT` stays 5434.
3. Run `bash scripts/local-pg.sh` once. It creates the cluster, then fails at the PowerShell start. That is expected.
4. Start the server yourself:
   `"$PGBIN/pg_ctl" -D "$LANE_PG_DATA" -l "$LANE_PG_DATA/server.log" -w start`
5. Run `bash scripts/local-pg.sh` again. It creates the `app_owner` / `app_runtime` roles and, now that the server is up, skips the start.

After a reboot, repeat step 4. Never point a lane or CI at Neon. If you change these scripts to work on macOS, do it in a small separate PR.

### 3. Agent engines on the Mac

- `scripts/agent-cli.sh` finds the Cursor CLI under Windows paths (`AppData/Local`, `node.exe`), so `ENGINE=cursor` will not start on the Mac.
- Use `AGENT_ENGINE=claude REVIEW_ENGINE=claude` for any script that runs an agent (`review-ticket.sh`, `build-ticket.sh`), unless the owner sets the Cursor path.
- The reviewer must not be the session that wrote the code.

### 4. Work order

Run CI one PR at a time. Each PR's CI runs in its own worktree:

```bash
git worktree add ~/E-commerce-worktrees/ticket-<n> origin/<branch>
```

Then, from that worktree, using the main checkout's script:

```bash
E2E_PORT=3100 CI_DB=ci CI_RUNNER="$HOME/E-commerce-worktrees/ci-runner" bash ~/E-com/scripts/ci-local.sh
```

That posts the `local-ci` status the merge gate reads.

The merge gate (`scripts/merge-ticket.sh <n>`, from #408) needs `.builder/review-<n>.md` with line 1 exactly `VERDICT: PASS`, and `.builder/review-<n>.sha` equal to the PR head. The reviews listed below ran in a cloud session and left no such files. So, for each PR, get a fresh one:

```bash
AGENT_ENGINE=claude REVIEW_ENGINE=claude scripts/review-ticket.sh <n>
```

Or ask the owner. Never write a review file by hand.

1. **#408, pipeline fixes and this file.** Branch `claude/focused-johnson-8op40i`.
   - Run `for t in scripts/*.test.sh; do bash "$t"; done`. They passed on Linux only, never on macOS.
   - It has not had an independent review. Get one before merging.
   - Merge it first: the merge gate it adds applies to every merge after it.
   - After the first merge, check that the squash commit on main carries no AI co-author line.
2. **#411, test clients wait 15 s for a transaction (closes #401).** Branch `fix-401-main-ci-failures`. Review PASS. Needs `local-ci`.
3. **#412, Stripe async-refund test (closes #389).** Branch `fix-389-stripe-refund-contract`. Review PASS. Needs `local-ci`, plus the sandbox half with the owner's Stripe keys:

   ```bash
   pnpm exec vitest run src/lib/stripe/contract.test.ts src/lib/stripe/pi-sandbox.test.ts
   ```

   Expect 34 passing, and note how long the combined pi-sandbox test takes.
4. **#405, store delivery checkout (#133).** Branch `ticket-133-store-delivery-checkout-settings-address`, head `0b63d43`.
   - Two reviews PASS; the browser spec `e2e/customer-journey.spec.ts` passed 4/4.
   - Needs `local-ci`.
   - Owner decision: keep store delivery off for real stores until #15 ships, because a paid delivery order stops at READY.
5. **#404, store copilot v1 (#142).** Branch `ticket-142-store-copilot-v1-text-owner-reports-with`, head `a6cc5b7`.
   - Round 3 of 3 is done, and its review passed. Do not start another round; follow-ups are in #406.
   - Needs `local-ci` and the live model test with the owner's key:

     ```bash
     ASSISTANT_LIVE_TESTS=1 pnpm exec vitest run src/lib/copilot/copilot.sandbox.test.ts
     ```

     It passes when "live Haiku turns owner reports into the right proposals" shows ✓ and is not skipped. Put the output in the PR.
6. **#410, WhatsApp transport (#143).** Branch `ticket-143-whatsapp-transport-layer`, head `8691093`.
   - Three reviews PASS. Needs `local-ci`.
   - Leave it unmerged until the real-key steps in the PR are done (it is titled `[needs keys]`). Follow-ups are in #409.
7. **Older PRs** in the table below: #402, #384, then the owner decisions.

### 5. What the cloud session saw (for comparison)

- On Postgres 16 in the cloud, the full suite on these heads failed only in tests that fail the same way on main there:
  - `src/lib/listing-isolation.test.ts` (expects SQLSTATE 23001, got 23503: a 16-vs-18 difference);
  - `src/lib/listing/listing-imports-index-migration.test.ts` (drift check against that database);
  - `e2e/spawned-server.unit.ts` (process kill).
- `src/lib/cart/cart-user-orphan-migration.test.ts` failed once under full-suite load and passed 3/3 alone.
- On Postgres 18, the first two should pass. Treat a failure there as real.

### 6. Owner decisions waiting

- #142 / #406 R7: should an exact own name ("Gari" next to "Garri") also ask when look-alikes exist?
- #143 / #409 F2: how the per-number WhatsApp code limit should work across stores.
- #133: delivery off for real stores until #15 (above).
- #389: if the Stripe refund test still flakes, switch to asserting on an earlier failed refund (`events.list({ type: "refund.failed" })`).
- The older ones under "Owner decisions still open" below.

## Open PRs and where each one stands

`local-ci` is the status on the PR's current head, read on 2026-11-09. None of the PRs opened or changed on 2026-11-09 has a `local-ci` status.

| PR | Ticket | Head | local-ci | State | What's left |
|---|---|---|---|---|---|
| #408 | Pipeline fixes, this file | `claude/focused-johnson-8op40i` | none | Script tests pass on Linux. No independent review yet. | Script tests on macOS, a review, local-ci, merge first. |
| #411 | #401 test Prisma clients wait 15 s | `0e7bdfb` | none | Review PASS. A stall test fails on main and passes here. | local-ci, merge. |
| #412 | #389 Stripe async-refund test | `2479670` | none | Review PASS. The sandbox half has not run. | Sandbox run with keys, local-ci, merge. |
| #405 | #133 Store delivery checkout | `0b63d43` | stale pending | Two reviews PASS. Fix round done. e2e passed. | local-ci, delivery-off decision, merge. |
| #404 | #142 Store copilot v1 | `a6cc5b7` | stale pending | Round 3 of 3 done. Review PASS. | Live model test with key, local-ci, merge. Follow-ups #406. |
| #410 | #143 WhatsApp transport | `8691093` | none | Three reviews PASS. `[needs keys]`. | local-ci; real-key steps in the PR before merge. Follow-ups #409. |
| #402 | #128 Customer notifications (email + SMS) | `eb7ab40` | passed | Review **PASS** on this head (`.builder/review-128.md` on the old Windows machine). | The review file is not on the Mac and predates the commit binding; rerun `scripts/review-ticket.sh 128`. Follow-ups are in #403. |
| #384 | #167 Closed-store checkout queueing + `CHECKOUT_LIVE_MODE` | `5702432` | **failed: test** (2026-11-08 15:30 UTC) | Review passed. | Run local CI again. If the test step fails again, fix it before merging. Follow-ups are in #383. |
| #371 | #367 Low-stock explicit add | `5be0bda` | passed | Waiting on an owner decision: one extra round, or merge as is. | Owner decision. |
| #359 | #247 Shopper assistant A3 agentic checkout | `1285960` | passed | Waiting on an owner decision. | Owner decision. |
| #341 | #146 Golden evaluation set | `bd0b775` | none on this head | Waiting on an owner decision about the recipe test rule. | Owner decision, then local CI on the new head. |
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
- **Unblocked and ready:** #134 (after #405 merges), #124, #65, plus the follow-up issues labeled `ready-for-agent`. #144 is unblocked once #410 merges.
- **Main health:** #401 and #389 have fixes in #411 and #412. Why new Postgres connections stalled on the Windows machine (#401) is still unknown.

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
- No AI attribution on commits or PRs: no `Co-Authored-By:` trailer for Claude, Cursor or any other tool, no `Claude-Session:` link and no "Generated with Claude Code" line. It is stripped by `.githooks/commit-msg` (run `git config core.hooksPath .githooks` once on the dev machine; `build-ticket.sh` also sets it) and left out of the squash message by `merge-ticket.sh`. Until 2026-11-09 nothing stopped it, and most commits on main carry one; history was not rewritten. The open ticket PRs still have it in their commits, which is fine: the squash message drops it. Check the first merge, because it is not yet confirmed that GitHub adds none of its own when the message is given.
- Never commit `.claude/settings.json`. Never print `.env` values. The owner adds all keys.
- The gtm-queue repo's failing workflow is not part of this project. Ignore it.

## Pipeline (how tickets were built)

- `scripts/build-ticket.sh <n>`: plan, brief review, build, independent review and fix rounds, in worktree `C:\E-commerce-worktrees\ticket-<n>`. Reviews go to `.builder/review-<n>.md` and logs to `.builder/logs/` on the dev machine (gitignored).
- `scripts/agent-engine.env` picks the agent CLI and models. It's currently set to the Cursor CLI for build and review. Change it to whatever provider the next team uses.
- `scripts/ci-local.sh` runs local CI and posts the `local-ci` status.
- `scripts/merge-ticket.sh <n>` merges. It reads the review file itself and takes no verdict from the caller (see "Pipeline fixes" below). It starts a full main CI run every 3 merges.
- `scripts/ticket-env.txt` lists which env key names each ticket needs. Every PR appends a line, so it causes merge conflicts.

## Known problems

- The pipeline fixes below have passed their script tests on Linux only. They have not run on macOS or Windows, or against a real ticket yet.
- The pipeline scripts assume the Windows dev machine (Postgres and Cursor paths, PowerShell). See "Start here" for the Mac workarounds.
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
- **No fix round runs** when the review passed and CI failed in setup, or when a fix round made no commit. That review still counts toward the 3.
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
