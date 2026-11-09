# Handoff: African Markets Platform

Written 2026-11-08. Main is at `f8e5f02`. All branches are pushed. Every build lane, CI run and queue has been stopped. Nothing is running on the dev machine except the local dev server on port 3005.

Read first: `CLAUDE.md`, `docs/spec/platform-spec.md`, `GLOSSARY.md`, `docs/adr/`, `docs/agents/` (builder, orchestration, issue tracker, labels).

## Open PRs and where each one stands

| PR | Ticket | State | What's left |
|---|---|---|---|
| #402 | #128 Customer notifications (email + SMS) | Review **PASS** on head `eb7ab40` (`.builder/review-128.md` on the dev machine). Local CI has not run yet. | Run local CI on `eb7ab40`, then merge. Follow-ups are in #403. |
| #384 | #167 Closed-store checkout queueing + `CHECKOUT_LIVE_MODE` | Review passed. A local CI run was in progress when everything stopped. An older local-ci status on the PR is a failure. | Run local CI again, then merge. Follow-ups are in #383. |
| #404 | #142 Store copilot v1 (text reports, one-tap confirm) | Stopped mid fix round after about 5 hours. The rounds kept churning on one case: the owner's report matches several listings and the model asks which one. | Diagnose that case properly before any more rounds (max 3 rounds per ticket). Follow-ups are in #406. |
| #405 | #133 Store delivery checkout (settings, address, frozen-item guard) | Stopped mid build/fix after about 4 hours. Latest commit `174d0a6`. | Review the current head, fix what's real, and finish. The address lookup is Photon + US Census per ADR-0017 (comment on #133). |
| #359 | #367 Low-stock explicit add | Waiting on an owner decision: one extra round, or merge as is. | Owner decision. |
| #341 | #247 Shopper assistant A3 agentic checkout | Waiting on an owner decision. | Owner decision. |
| #313 | #146 Golden evaluation set | Waiting on an owner decision about the recipe test rule. A main-merge commit was pushed today. | Owner decision. |
| #371 | #207 Migrate-diff fail-closed | Open. | Review and CI, then merge. |
| #46 | #5 Custom domains | Labeled `needs keys`. | Needs Vercel custom-domain setup from the owner. |

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
- **Main health:** #401 and #389 report main failing the full local CI on `5410838` and `46c9927`. Check these first.

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
- **Max 3 rounds per ticket.** After round 2, stop and diagnose the whole behaviour before round 3.
- **Watch session length:**
  - Cap a builder session at about 90 minutes, and stop it if it churns.
  - Measure a lane's age from its start (the plan log timestamp), not from the current fix round.
  - The pipeline has no hard timeout yet. Add one.
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
- `scripts/merge-ticket.sh <n> "VERDICT: PASS"` merges. It also starts a full main CI run after each merge, which made the queue slow. Consider removing that.
- `scripts/ticket-env.txt` lists which env key names each ticket needs. Every PR appends a line, so it causes merge conflicts.

## Known problems

- Builders on fix rounds churned for hours (#70 ran 8 hours, #142 about 5 hours) because nothing enforced a time cap.
- The machine-wide ci-local lock let CI runs overlap at least once.
- Old ticket worktrees contain regenerated screenshots and scratch scripts that were never committed. Their branches are already merged, so nothing is lost. `ticket-146` has an untracked `src/lib/assistant/eval/ticket-spend.json`, a generated spend counter.
