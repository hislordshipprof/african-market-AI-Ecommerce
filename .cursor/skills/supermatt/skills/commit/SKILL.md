---
name: commit
description: "Commit all changes on the current branch, main included."
argument-hint: "[message hint]"
disable-model-invocation: true
license: MIT
---

Commit every change in the working tree on the current branch. Do not switch or create a branch, even on main. The arguments, if any, are a hint at what the change is about, not the message itself.

1. Run `git status --short --branch`, `git diff HEAD --stat` and `git log --oneline -10`. Read the full diff (`git diff HEAD`) and every untracked file `git status` lists before writing anything.
2. Scan it for credentials, tokens, private keys, and any value that does not belong in this repository. If you find one, stop, commit nothing, and report what you found.
3. An untracked directory that holds a local tool's state (an index, cache, or database, such as `.codegraph/`) belongs in the root `.gitignore`, even when it ships its own `.gitignore`: add its path there, commit that line with the rest, and say so in the report.
4. Stage the changes. Prefer explicit paths over `git add -A`.
5. Write a Conventional Commit `type(scope): description`, matching the subject style already in `git log`. When the `oss-writing` skill is installed, load and follow it through the host's skill mechanism for the wording.
6. Commit. Report the subject and the short hash, plus the `.gitignore` line from step 3 if you added one, nothing else.

Split into several commits when the diff covers unrelated changes.
