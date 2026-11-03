---
description: Rank a codebase by change frequency crossed with complexity, to decide what to refactor first. Read at project scope, before listing findings.
---

# Hotspots

Complexity alone does not predict maintenance pain. Churn alone does not either. Their product
does: code that is both complicated and edited constantly is where the cost lands.

This ranks what to look at first. It does not say anything is wrong; that is still Step 2's job.

## Churn

Count how often each file has been touched, over a window that matches the project's pace:

```bash
git log --since="12 months ago" --name-only --pretty=format: \
  | grep -v '^$' | sort | uniq -c | sort -rn | head -30
```

Two corrections that keep the numbers honest:

- Exclude automated commits, or the ranking measures your bot: add
  `--perl-regexp --author='^(?!.*(bot|\[bot\])).*$'`.
- A bulk move or a formatting sweep touches hundreds of files in one commit and inflates every one
  of them. Find those commits and drop them from the window:
  `git log --since="12 months ago" --pretty='%h %s' --name-only | ...`, or simply exclude the
  known reformat commit by hash.

Recent churn beats total churn. A file rewritten heavily two years ago and untouched since is
settled, not hot.

## Complexity

Use whatever the project already has. If it has nothing, line count is a usable first pass:

```bash
git ls-files '*.<ext>' | xargs wc -l | sort -rn | head -30
```

Prefer cognitive complexity over cyclomatic when a tool offers both: it penalizes nesting depth,
which is what makes code hard to read, while cyclomatic only counts branches. A flat switch with
twenty cases scores badly on cyclomatic and reads fine.

## The Cross

Rank by the intersection, not by either list. A file high on both is the first candidate. A file
high on complexity and low on churn is stable: leave it alone, however ugly it looks.

Take the top few. A ranked list of thirty findings is a list nobody acts on.

## Coupling

Files that keep changing in the same commit are coupled, even when nothing imports anything:

```bash
git log --since="12 months ago" --name-only --pretty=format:--%h \
  | awk '/^--/{c=$0; next} NF{print c, $0}'
```

Group by commit and count the pairs. A pair that changes together most of the time, in files that
have no code-level relationship, is a boundary problem, which is architecture, not refactoring.
Route it to Step 2's architecture signal.

## The Limit

Every number here is a proxy. A hotspot is a place to look, and the answer after looking is often
that the code is fine. Do not let the ranking manufacture a verdict.
