---
name: orchestrate
description: "Work through GitHub issues or local Markdown tickets unattended in parallel lanes, with workers in Herdr panes and git worktrees."
argument-hint: "[parallel runs]"
disable-model-invocation: true
compatibility: Designed for Claude Code, Codex, Cursor, and OMP. Requires the matching host CLI and Herdr integration, gh for GitHub PR shipping, and Bun or Node.js 18.17 or later (built-in modules only). Supports GitHub issues and local Markdown trackers. The notification uses osascript, so it shows on macOS only.
license: MIT
---

# orchestrate

You are the orchestrator. You do not write code. You pick issues, drive workers in the same harness that runs you, and check their results. The work runs in LANES parallel lanes: each lane is a herdr pane beside yours and a git worktree of its own, and works one issue at a time. A spec whose tickets are all closed comes first: one worker session **V** checks the whole spec against the code (see [SPEC.md](SPEC.md)). Bugs come next, then the other tickets. Each ticket runs through up to four worker sessions, each with a fresh context:

1. **T**: `/triage REF`, only for a bug that is not triaged yet, to make it ready for an agent.
2. **A**: `/implement REF`, which QAs, reviews, and fixes its own work, then any fixes it left.
3. **B**: `/refactor`, then `/ship-pr` to merge.
4. **C**: `/retro` over A and B, reporting candidates for the operator without applying them.

Repeat until a stop condition is met. Never ask the user anything, through a question tool or otherwise: answer every question and dialog as below.

## Setup

1. Run `test "${HERDR_ENV:-}" = 1`. If it fails, say you are not inside herdr and stop.
   Check the host's execution restrictions before the first Herdr, GitHub, or Git write call. This run needs access to the local Herdr socket, GitHub, and the checkout's Git metadata. Use the host's permission mechanism for access outside its sandbox, retaining any approval already granted. Confirm socket access with `herdr agent list` and GitHub access with the default-branch query in step 6. Stop if required access is denied or unavailable; report the exact blocked operation.
2. PROJECT is the repo folder name (`basename "$(git rev-parse --show-toplevel)"`) made into a valid herdr agent name: lowercase it, change each character outside `a-z`, `0-9`, `_` and `-` to `-`, drop leading characters that are not letters, and keep at most 20 characters. Choose K as the lowest positive number unused by live `PROJECT-orch-K` or `PROJECT-work-K-L` agents and by any registered or existing `.claude/worktrees/orch-K-L` path. Check `herdr agent list`, `git worktree list --porcelain`, and the worktree directory before naming this run. Retained lanes reserve their K until separately cleaned up. Now, before any check that can stop, run `herdr agent rename "$HERDR_PANE_ID" PROJECT-orch-K` and `herdr pane report-metadata "$HERDR_PANE_ID" --source orchestrate --display-agent orchestrator`.
3. Set KIND from the harness running this skill: `claude`, `codex`, `cursor`, or `omp`. Use authoritative current-session harness metadata first. When unavailable, read `herdr agent get "$HERDR_PANE_ID"` `.result.agent.agent`; accept only those four values. If that does not identify it, `CLAUDE_CODE_CHILD_SESSION=1` identifies Claude Code, and any of `CODEX_SANDBOX`, `CODEX_SESSION_ID`, or `CODEX_THREAD_ID` identifies Codex. `CLAUDECODE`, `OMP_PROFILE`, `OMPCODE`, and model or provider names do not identify the host. Set CLI to `agent` for Cursor and to KIND otherwise, then require `command -v "$CLI"`. Every worker and restart uses KIND; a failed launch parks its lane instead of switching harnesses.
   For Cursor and OMP, require the matching kind in `herdr agent start --help` and an enabled matching integration in `herdr integration status`. Report the exact unsupported integration or missing CLI and stop without upgrading or installing it. Claude Code uses SESSION_ROOT `$CLAUDE_CONFIG_DIR/projects/`, or `~/.claude/projects/` when unset. Codex uses `$CODEX_HOME/sessions/`, or `~/.codex/sessions/` when unset. Cursor and OMP use only Herdr-reported session IDs or paths because their storage can move. Send skills using the notation below.
4. Run `herdr --skill` and follow its rules. Parse every ID from JSON output. Never close a tab or pane you did not create.
5. Read `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`. If either is missing, or the tracker is neither GitHub nor local Markdown, say so and stop. READY, BUG, and TRIAGE are the label strings that `triage-labels.md` maps to the ready-for-agent, bug, and needs-triage roles. For local Markdown, read [LOCAL.md](LOCAL.md) now and retain its tracker ownership rules for every worker. GitHub remains the PR host in either mode.
6. Your working directory is the repo's main checkout. It stays on DEFAULT for the whole run; the workers work in the lanes' worktrees. DEFAULT is the output of `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`. Run `git switch DEFAULT && git -c pull.rebase=false pull --ff-only`. The command-local setting keeps a user's rebase default out of this fast-forward operation. The tree must be clean. If it is not, stop. If `git check-ignore -q .claude/worktrees/x` fails, append the line `.claude/worktrees/` to `.git/info/exclude`, so the worktrees stay out of `git status`.
7. LANES is the number in the arguments, or 1 when there is none. RUN_START is `date -u +%Y-%m-%dT%H:%M:%SZ`. RUN is `bun` when `command -v bun` finds it, else `node`. QUEUE is `RUN <this skill's directory>/scripts/next-issue.mjs READY BUG TRIAGE`; for local Markdown insert `--local ROOT` before the labels, with ROOT from LOCAL.md. Run QUEUE and print its output so the operator sees what will run. A nonzero result is a failed queue read, never an empty queue.
8. Open the lanes (see Lanes).

### Skill notation

Every `/name` skill reference below and in the linked procedures is notation: translate it before sending a worker prompt. Claude Code uses `/supermatt:name` when this skill comes from the installed plugin, or `/name` when linked into its skill directory. A bare `/code-review` from that plugin would run Claude Code's bundled review instead. Cursor uses `/name`. Codex uses `$name`, including from its plugin. OMP uses `/skill:<name>`. Preserve all arguments. Shell-quote prompts, paths, and values; quote Codex prompts so `$name` reaches the worker literally, for example `herdr agent prompt WORKER '$implement #123' --wait`. Native commands such as `/exit` keep their spelling in all four harnesses.

For Cursor and OMP, require the SuperMatt skill commands to be discoverable by the worker before work starts. Resolve each required `/name` or `/skill:name` to SuperMatt, including existing `~/.agents/skills` discovery where the host supports it. A missing or conflicting same-named skill parks the lane; never substitute a bare command or another harness.

## Lanes

Lane L, from 1 to LANES, has a pane, a worker agent named `PROJECT-work-K-L`, and a worktree at `<repo root>/.claude/worktrees/orch-K-L`, inside the repo so Claude Code's folder trust carries over. Every host uses the same worktree location. Below, PANE, WORKER, and WT are the current lane's, and every git command about the lane's work runs as `git -C WT`. IN_FLIGHT is the set of issue keys the lanes hold, parked lanes included: GitHub numbers or repository-relative Markdown paths. REF is `#N` for GitHub or the absolute canonical file path for local Markdown; DISPLAY is `#N` or the repository-relative path. Use REF in worker prompts and DISPLAY in phase names and reports.

- **Open the lanes** once, at setup, as shell panes stacked in one column right of yours, with equal heights. Lane 1: `herdr pane split "$HERDR_PANE_ID" --direction right --no-focus --cwd "$PWD"`. Lane L above 1: `herdr pane split <lane L-1's pane> --direction down --ratio R --no-focus --cwd "$PWD"`, where R is 1/(LANES-L+2), the share lane L-1 keeps. Save each `.result.pane.pane_id`. The panes stay for the whole run.
- **Create the worktree** on branch B: `git fetch origin && git worktree add -b B WT origin/DEFAULT`, or `git worktree add --detach WT origin/DEFAULT` with no branch. Leave `.env*` files uncopied by default. Have the worker try the repository's checks and local preview without credentials. Supply environment values only when a required operation reports that it needs them and existing user authorization permits access. Preserve user restrictions on reading, copying, linking, or loading environment files; if a required value cannot be supplied within those restrictions, park the lane with the exact requirement.
- **Remove the worktree**: stop any live worker and confirm its harness process has exited, so its hooks no longer need WT. If WT exists, `git worktree remove WT`, and delete each still-local branch recorded for this lane only after its PR is confirmed merged and its local head matches the recorded PR head (B plus any CI repair branches). Retain unmerged or externally changed branches for inspection. A worker that has not exited or a worktree with changes parks the lane.
- **Park the lane**: stop driving it, ignore its later notifications, and leave its pane, worker, and worktree as they are. Its issue stays in IN_FLIGHT. If it holds the ship slot, release it; a failed or blocked post-merge workflow keeps the separate default-branch merge hold set. Send the notification (see On stop) with the title `PROJECT lane L needs you` and the reason as its body, and add the reason to the friction log. The other lanes go on.

## Run the lanes

Each lane runs the Loop on its own issue. Start by running Pick the issue for lanes 1 to LANES in order, so lane 1 takes the first issue in the queue. Then act on whichever lane's background wait notifies you, take that lane through its next steps up to its next wait, and wait again.

Before dispatching concurrent lanes, read [Parallel resources](../../references/parallel-resources.md). Keep resource ownership with lane state, pass the assignment on every worker launch and restart, and recheck it when a phase introduces a new resource. A parked lane retains resources its live processes still use. This resource gate is separate from the ship slot below.

- A lane whose Pick finds nothing goes idle. Whenever an issue closes or a lane goes back to Pick, run Pick for every idle lane too: a closed issue can unblock others.
- The ship slot: one lane at a time runs from Sync through CI recovery, post-merge workflow verification, and Close out. A lane that reaches Sync while another holds the slot waits for it. A failed or blocked default-branch workflow sets a separate merge hold; releasing a parked lane's slot does not clear that hold. Other lanes may finish work through Refactor, but start no new issue and perform no Sync or merge while the hold remains. If recovery parks, retain those waiting lanes for inspection and stop once every other busy lane reaches that boundary.
- When every lane is idle or parked, stop (see Stop conditions).

## Worker

Claude Code sessions use these models and efforts:

| Session | Phases | Model | Effort |
|---|---|---|---|
| V | verify | `opus` | `xhigh` |
| T | triage | `opus` | `high` |
| A | implement, the QA and review restarts in step 3, fix | `sonnet` | `high` |
| B | refactor, ship | `opus` | `high` |
| C | retro | `opus` | `high` |

Codex sessions use these models and reasoning efforts:

| Session | Phases | Model | Effort |
|---|---|---|---|
| V | verify | `gpt-6-astra` | `high` |
| T | triage | `gpt-6-astra` | `high` |
| A | implement, QA restart in step 3 | `gpt-6.1-sol` | `medium` |
| A | review restart in step 3, fix | `gpt-6-astra` | `high` |
| B | refactor, ship | `gpt-6-astra` | `high` |
| C | retro | `gpt-6-astra` | `high` |

For Cursor and OMP, read the current session's authoritative model ID into ACTIVE_MODEL and pass that exact ID to every new worker. If authoritative metadata does not expose it, omit `--model` and record that the harness default is inherited. Never infer a model from provider family. Cursor receives no effort flag. OMP uses these phase-specific thinking levels:

| Session | Phases | Thinking |
|---|---|---|
| V, T, B, C | verify, triage, refactor, ship, retro | `high` |
| A | implement, QA restart | `medium` |
| A | review restart, fix | `high` |

Select the Claude or Codex row, or the OMP thinking row, for every launch and restart. In Codex, Cursor, and OMP, defer the review inside `/implement` to the fresh review worker in step 3. If Codex findings reach step 4 from a Sol worker, restart on the fix row before prompting `/fix-findings`; include each finding's full text, prior reports and checked commits, and the issue reference, since the fresh session has no record of them.

For OMP, resolve OMP_WORKER_CONFIG to the absolute path of [omp-worker.yml](omp-worker.yml) beside this skill, not relative to WT. This read-only launch overlay disables configured auto-resume without changing user or project settings. A missing or invalid overlay is a launch failure. `--no-prewalk` prevents an automatic model handoff. Retain normal skill discovery and permission controls; add no auto-approval, resume, or continue flags.

- **Start the worker**: run `herdr pane run PANE "cd WT"` with WT shell-quoted, then use the matching recipe. Claude: `herdr agent start "$WORKER" --kind claude --pane "$PANE" -- --model "$MODEL" --effort "$EFFORT"`. Codex: `herdr agent start "$WORKER" --kind codex --pane "$PANE" -- --model "$MODEL" -c "model_reasoning_effort=$EFFORT"`. Cursor: `herdr agent start "$WORKER" --kind cursor --pane "$PANE" --` plus `--model "$ACTIVE_MODEL"` only when known. OMP: `herdr agent start "$WORKER" --kind omp --pane "$PANE" --` plus `--model "$ACTIVE_MODEL"` only when known, then `--thinking "$THINKING" --no-prewalk --config "$OMP_WORKER_CONFIG"`. If the active OMP model rejects the thinking level, retry once without `--thinking` and record the fallback. Shell-quote every substituted path and value. Then run `herdr pane report-metadata PANE --source orchestrate --display-agent "worker L"`. If `agent start` returns `agent_pane_busy` or says the name is in use, wait three seconds and retry up to five times. If it returns `agent_not_ready`, answer the visible startup dialog.
- **Stop the worker**: read `herdr agent get WORKER` `.result.agent.agent_session`. Retain every Herdr-reported session ID or path in SESSIONS. A `kind: path` value must be absolute and is retained directly. For Claude and Codex IDs, also retain the transcript path under SESSION_ROOT when found. For Cursor, never manufacture a transcript path from an ID. Capture evidence before `herdr agent prompt WORKER "/exit"`. The pane and recorded transcripts remain.
- **Restart the worker**: stop it and confirm its harness process has exited, then start it. Use a fresh launch, not `/restart`.
- **Show phase P**: at the start of each phase below, set the lane's phase to `DISPLAY P` and run `herdr tab rename "$HERDR_TAB_ID" "<each busy lane's phase, joined by ' | '>"`.
- **Wait for the worker**: run every `herdr agent prompt ... --wait` as a background command, so the other lanes go on meanwhile. When it returns, run `herdr agent wait WORKER --until idle --until done --until blocked` in the background and let it notify you. The wait can return `done` between two turns while sub-agents are still running, so then run `sleep 15` and `herdr agent get WORKER`: if it is `working`, wait for the worker again. If the worker is `blocked`, answer the dialog (see Answer a dialog) and wait for the worker again.
- **Read the worker's reply**: check its current state with `herdr agent get WORKER`. Use `herdr agent read WORKER --source visible --lines <n>` while it is working, blocked, or unknown; use `--source recent-unwrapped` for history only after it settles at idle or done. Capturing alternate-screen history can require scrolling, which Herdr refuses while a worker is active. If a history read returns `agent_not_idle` because the state changed, read with `--source visible` and continue; this read-mode mismatch is recoverable and does not park the lane.
  After an OMP worker's first completed turn, require `.result.agent.agent_session` with `kind: path` and an absolute value, then retain it in SESSIONS. After a Cursor worker's first completed turn, require an authoritative Herdr session ID or path; a path must be absolute. A missing or invalid reference parks the lane with the exact evidence gap. Session creation is lazy, so do not require a reference before the first turn.
  If the pane does not show the reply, read a reported `kind: path` transcript directly. Otherwise locate only Claude or Codex IDs under SESSION_ROOT: Claude Code uses `<session>.jsonl`; Codex rollout filenames include the session ID in dated subdirectories. For OMP, take the last assistant text from `type: "message"` records with `message.role: "assistant"`, joining only text content blocks and skipping thinking, tool calls, and the physical title record. For a Cursor ID without a path, do not derive storage during orchestration. When no matching readable transcript exists, ask the idle worker to write its last reply to a temporary file and return the path.

## Answers

When a worker is `blocked`, or has an open question (QUESTION is not NONE, or it ended its turn on a question), read [ANSWER.md](ANSWER.md): its Answer a dialog and Answer a question are the procedures the steps below name, and its Safe actions decide what you may approve.

## Loop

### 1. Pick the issue

If the operator asked you to pause, the lane goes idle. Otherwise run QUEUE in the main checkout. It lists the open, unassigned issues to work on, with an open blocker (native, or a `Blocked by:` line) dropped: specs whose tickets are all closed, then bugs, then the rest, lowest number first, then path for tied local numbers. Each line is `key<TAB>title<TAB>spec|ready|triage`. GitHub specs and TRIAGE bugs count only when the repo's own team filed them. Local files use the repository's trusted tracker; malformed or missing blocker references fail the read.

Take the first line whose key is not in IN_FLIGHT. If there is none, the lane goes idle. Add its key to IN_FLIGHT, set REF and DISPLAY, and say `lane L: DISPLAY title`. Empty SESSIONS. Create the worktree: with no branch for a `spec`; otherwise on branch `fix/ID-<slug>` for an issue labelled BUG and `feat/ID-<slug>` for any other, where slug is the title in lowercase kebab case, at most 40 characters. ID is N for GitHub; for local files use K-L plus a counter incremented on each pick in that lane, so repeated numbers and titles cannot collide. If its last column is `spec`, verify it: read [SPEC.md](SPEC.md). If it is `triage`, triage it first: read [TRIAGE.md](TRIAGE.md).

### 2. Implement (session A)

1. Show phase `implement`. Start the worker.
2. `herdr agent prompt WORKER "/implement REF" --wait` with no `--timeout`, then wait for the worker. Substitute and quote REF before sending. For Codex, Cursor, and OMP, append to the translated prompt: `Complete implementation and QA, then stop before code-review. The orchestrator will run code-review and fix its findings in a fresh session.` This can take a long time.
3. Run `git -C WT log --oneline origin/DEFAULT..HEAD`. If it is empty, ask the five-line question from step 3. If QUESTION is not NONE, answer it, wait for the worker, and run this check again. Otherwise read the pane, report what the worker said, and park the lane.

### 3. Check the worker

Keep the latest QA and review reports with their checked commits in the lane's state; request them from the worker if its handoff gives only verdicts. A fresh worker's `NONE` means that session has no result; it does not erase an earlier result or its open findings. Before reusing one, inspect changes since its checked commit: retain unaffected QA evidence and review dispositions, and pass the prior reports and intervening diff to any follow-up. Review is current only when the intervening diff is empty or a completed follow-up covers it. Missing reports or changes that invalidate coverage require verification. Ask the worker, do not guess from scrollback:

```bash
herdr agent prompt WORKER "Reply with exactly five lines and nothing else. Line 1: BUSY=<yes if a background task or sub-agent you started is still running, else no>. Line 2: QA=<the verdict line of the last QA pass in this session, or NONE if none ran>. Line 3: REVIEW=<the verdict line of the code-review you ran in this session, or NONE if you did not run it>. Line 4: UNFIXED=<the code, or file:line if it has no code, of each verified finding and each QA fail that is still open: not fixed, and not settled by an answer to your question, or NONE>. Line 5: QUESTION=<a question you asked the user in this session that has no answer yet, or NONE>." --wait
herdr agent read WORKER --source recent-unwrapped --lines 40
```

- BUSY=yes: run `sleep 60` in the background, then ask again. If BUSY is still yes after 30 minutes, park the lane.
- QUESTION is not NONE: answer it (see Answer a question).
- QA=NONE with no reusable lane result: run `git -C WT log --format=%s origin/DEFAULT..HEAD`. If every subject has the type `refactor`, the branch changes nothing a user can see: QA is `skipped, refactor only`. Otherwise show phase `qa`, restart the worker, prompt it with `/qa origin/DEFAULT REF` (`--wait`, no timeout), and wait for the worker. Ask it the same five-line question.
- REVIEW=NONE with no reusable lane result: show phase `review`, restart the worker, prompt it with `/code-review` (`--wait`, no timeout), and wait for the worker. Ask it the same five-line question.

### 4. Fix findings

If UNFIXED is not NONE, show phase `fix`, prompt the current worker with `/fix-findings <the UNFIXED value>` (`--wait`), the prior reports and their checked commits, and instructions to use [implement's follow-up verification](../implement/SKILL.md#follow-up-verification). Wait for the worker. Then ask the five-line question again, and answer any open question. A finding that `/fix-findings` settled with no edit, because the option it applied (its own recommendation, or what the issue asks for) keeps the code as it is, counts as fixed. If UNFIXED still names a finding that is open, park the lane. Then prompt `/commit` (`--wait`) and wait for the worker, so the tree is clean for session B.

### 5. Refactor (session B)

1. Show phase `refactor`. Restart the worker.
2. Prompt `/refactor the changes on this branch since origin/DEFAULT` (`--wait`, no timeout) and wait for the worker. Its questions and plan approval go through Answer a dialog and Answer a question.
3. If `git -C WT status --porcelain` prints anything, prompt `/commit` (`--wait`) and wait for the worker.

### 6. Sync

Other lanes may have merged since this branch started. Wait for the ship slot (see Run the lanes), then bring the branch onto the current DEFAULT. The branch is not pushed yet, so a rebase rewrites nothing shared.

1. Show phase `sync`. Run `git -C WT fetch origin && git -C WT rebase origin/DEFAULT`. If it rebased clean, go to Ship.
2. It stopped on conflicts: add `DISPLAY rebase conflicts in <files>` to the friction log, prompt the current worker with `/resolving-merge-conflicts` (`--wait`, no timeout), and wait for the worker. The rebase is done when `git -C WT status` no longer reports a rebase in progress and `git -C WT status --porcelain` prints nothing. If it is not, park the lane.
3. The resolved code is code that no QA pass ran: prompt `/qa origin/DEFAULT REF` (`--wait`, no timeout), wait for the worker, and ask the five-line question from step 3. If its QA line has a fail, park the lane. That QA line replaces the one from step 3 in Ship.

### 7. Ship

1. Show phase `ship`. Prompt the current worker with `/ship-pr QA of this branch stands: <the QA line from Sync, or else from step 3>` (`--wait`, no timeout), including the prior QA/review reports and checked commits, current resource assignment, and any existing shipping record. First apply Check the worker's evidence-reuse rules to the final head after Refactor and Sync, including a clean rebase: complete affected follow-up QA and review when changes invalidate their coverage, and pass the resulting reports. Session B otherwise has no record of session A's QA. Let it complete the bounded [CI recovery](../ship-pr/CI.md) procedure, including follow-up PRs and post-merge verification; keep the ship slot throughout. A failed check during that procedure is progress to diagnose, not an immediate park condition.
2. Read its report and shipping record. Retain all original/repair PR URLs, branch names, merge and checked commits, run IDs/attempts, recovery counters, and the latest QA/review reports in lane state. Show phase `repair` while recovery is active. A new session or dispatch carries the same record and budget, never a fresh allowance. Record each diagnosis, rerun, repair and outcome in the friction log. Set the default-branch merge hold as soon as a failed or blocked post-merge workflow is reported.
3. Independently confirm each reported merge with `gh pr view <url> --json state,mergedAt,mergeCommit` and the reported CI outcomes with `gh`. Proceed only when the original and any repair PRs are MERGED and the applicable post-merge workflows at the latest repair merge (the original merge when no repair was needed) have succeeded, or configuration proves none apply. A verified repair resolves the historical failure; retain its failed run without requiring a rerun or changing its recorded result. Clear the merge hold only with that evidence for current DEFAULT. If the worker returned only the original merge result, have it finish post-merge verification with the existing record. Park when CI recovery stops with an unresolved failure or blocker, or a push/merge is refused. Preserve successful merges separately from failed recovery; do not restart an exhausted repair loop.

### 8. Close out

1. Read REF with the configured tracker's **Read an issue** operation. If still open, use its **Close** operation with `Merged in <PR URL>.` For local Markdown, verify the canonical file has its `Closed:` date and comment. A closed issue unblocks the issues that wait on it.
2. Stop the worker and confirm its harness process has exited.
3. In the main checkout: `git -c pull.rebase=false pull --ff-only`. The tree must be clean.
4. Remove the clean worktree and release the ship slot.
5. Create a detached worktree for the read-only retrospective.

### 9. Retro (session C)

1. Show phase `retro`. Start the worker.
2. Prompt `/retro the sessions <SESSIONS>. Report candidates only. Leave this repository and external sources unchanged; do not apply candidates, create checks, file issues, or publish a lessons PR.` (`--wait`, no timeout). Pass OMP's recorded absolute transcript paths and Cursor's authoritative Herdr session IDs or paths. For Claude and Codex, use resolved paths when recorded, otherwise include `with transcripts under <SESSION_ROOT>` with the actual root. Wait for the worker.
3. Record each surviving candidate in the friction log with its source and proposed fix. LESSONS is `none` or `<count> candidates reported`. Applying candidates is separate work for an explicit user request, not another step in this loop.
4. Stop the worker and confirm its harness process has exited. Confirm `git -C WT status --porcelain` is empty. Unexpected changes park the lane for inspection; do not commit or discard them. Remove the clean worktree and go to Report.

### 10. Report

1. Drop the key from IN_FLIGHT.
2. For GitHub, run `gh issue list --state all --search "created:>=RUN_START" --json number,title`. For local Markdown, compare current ticket paths with the initial inventory from LOCAL.md. Add each new issue not yet in the friction log as `filed DISPLAY title`. Workers file bugs they find outside their issue; the next pick takes them first.
3. Report one line: `lane L: DISPLAY -> <PR URLs, including repairs>, merged, post-merge CI <outcome>, QA <verdict>, review <verdict>, lessons <LESSONS>`. Retain recovery evidence before cleanup.
4. Go back to Pick the issue.

## Operator

- **Pause**: the operator can type into your pane while you work. A request to pause or stop means every busy lane finishes its current issue through Report and no lane picks a new one; then stop. A request to stop now means stop at once.
- **Friction log**: keep a running list across issues, each entry with its lane and issue: each dialog and question you answered (phase, what you chose), each `--wait` that returned `timeout` or `agent_prompt_stalled`, each restart of the worker outside Refactor and Retro, each rebase conflict, each parked lane and its reason, each reported retro candidate, each triage outcome other than READY, and each issue filed during the run. Print it when you stop; it is the operator's input for tuning this skill.
- **On stop**: send one macOS notification, then print the reason and the friction log, including reported retrospective candidates. The operator is notified only here and when a lane parks: when the run is finished, or when it needs them.
  - No lane is parked: title `PROJECT done`, body `<count> issues merged, <count> filed`.
  - A lane is parked, or Setup failed: title `PROJECT needs you`, body the reason, or each parked lane with its issue and reason.

  Pass the text as arguments, so quotes in a reason cannot break the script: `osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"' -e 'end run' "TITLE" "BODY"`.

## Stop conditions

Park the lane when: triage left a bug untriaged, a spec found gaps on its second verification, `/implement` made no commits, a question stays open after three answer rounds, a dialog stays open after two answers, the worker asks to run an unsafe action, findings stay unfixed after `/fix-findings`, a rebase stays unfinished after `/resolving-merge-conflicts` or its QA fails, CI recovery stops with an unresolved failure or blocker, a push or merge is refused, the read-only retrospective changes files, a worktree with changes refuses removal, or a herdr, gh, or git control command about the lane fails outside a handled recovery path. A nonzero CI check result follows CI recovery instead of this command-failure stop.

Stop the run when every lane is idle or parked (including lanes retained at the merge hold after another lane's recovery stopped): the queue has nothing left that no lane holds, or the operator paused. Stop it at once when a Setup step fails or a herdr command about the run itself fails. On stop, close the panes of idle lanes, and leave the panes and worktrees of parked lanes open, so the operator can inspect them.

## Rules

- One issue per lane, so at most LANES in flight. A lane starts its next issue after its issue is merged and its retrospective candidates are reported.
- One lane at a time holds the ship slot.
- Never remove a worktree the run did not create.
- Run unattended. Never hand a question or dialog to the user; answer it as above.
- If a `--wait` returns `timeout` or `agent_prompt_stalled`, read the pane before you do anything, since the prompt may have landed.
