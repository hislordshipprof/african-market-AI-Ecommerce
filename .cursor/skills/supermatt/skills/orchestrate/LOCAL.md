# Local Markdown tracker

GitHub hosts the code PRs; the configured local files hold the issue queue. Keep one canonical tracker in the main checkout, shared by every lane, so closing a ticket immediately unblocks its dependents.

## Setup and selection

1. Resolve ROOT from `docs/agents/issue-tracker.md`, usually `.scratch/`, relative to the main checkout. Require the configured layout: `ROOT/<feature>/spec.md` and `ROOT/<feature>/issues/<NN>-<slug>.md`, including `inbox/issues/` for standalone reports. Record the initial inventory of ticket paths for the run's filing report. Ignore `decisions/`, maps, and other planning files.
2. These are local, untracked artifacts. Run `git ls-files -- ROOT`; if any tracker file is tracked, stop with those paths rather than editing the main branch or dropping tracked changes. Ensure ROOT is ignored in the main checkout, adding its repository-relative directory to `.git/info/exclude` when needed. Do not change the project's shared ignore rules.
3. Run `RUN <skill directory>/scripts/next-issue.mjs --local ROOT READY BUG TRIAGE` in the main checkout. The first column is a repository-relative path, which is the queue key. Resolve it against the main checkout to form the absolute REF passed to workers. Never identify local tickets by number alone: numbering restarts in each feature.

The selector reads `Status:`, `Category:`, and optional `Assignee:` metadata before the first level-two heading. A nonempty `Closed:` date or `Status: closed` closes a file. READY selects implementation work; BUG plus TRIAGE selects triage work. An `Assignee:` value excludes a ticket. `Blocked by: NN, NN` resolves within the same feature's `issues/` directory. Missing, malformed, or duplicate numbers fail selection instead of treating an unknown blocker as closed. The sibling `spec.md` is the parent of those tickets and enters verification only when it has at least one ticket and all are closed.

## Worker access and ownership

On every launch and restart, send the absolute tracker configuration path, ROOT, REF, and the sibling spec path when present. Tell the worker:

> Read and update the canonical local tracker at these absolute paths. They are shared files in the main checkout, outside your code worktree. Keep code edits and git commands in your assigned worktree. Include the repository-relative ticket path in commit messages and the PR body. Do not copy the tracker into the worktree or commit it. Close the canonical ticket only after its code PR merges, using the configured Close operation. This lane owns only its assigned ticket; other ticket and spec files are read-only unless the orchestrator grants a tracker write slot.

Give this context before `/implement`, `/qa`, `/code-review`, `/fix-findings`, `/ship-pr`, or any other worker task. A fresh session has none of the preceding session's path or ownership context. Quoted REF paths must survive spaces and shell metacharacters just like WT.

The lane owns its assigned ticket until completion or parking. A worker that needs to create gap tickets, file another bug, or edit another tracker file requests a tracker write slot from the orchestrator. Grant one such writer at a time across all lanes; it re-reads the target directory, chooses unused numbers, writes the files, and reports their canonical paths before releasing the slot. Parked workers retain any slot they still use. Reads and writes to distinct owned tickets can continue. This is separate from the ship slot.

## Triage, verification, and completion

Use the configured Read, comment, status, and Close operations on REF instead of `gh issue` commands. In triage, `Status:` provides the triage role and `Closed:` provides closure. Spec gap tickets go into that spec's `issues/` directory through the tracker write slot, with READY status and acceptance criteria. Re-read the canonical files after each mutation.

For spec verification, use the repository-relative child ticket paths as commit references when finding the fixed point. If squash history has no reliable reference, use recorded child merge commits; if neither establishes the fixed point, park with the evidence gap. Do not invent a baseline.

After a code PR merges, ensure the canonical ticket is closed even if the shipping worker omitted it. Preserve local files through worktree removal and report-only retrospectives. A queue read failure stops selection with its diagnostic; it is not evidence that all work is done.
