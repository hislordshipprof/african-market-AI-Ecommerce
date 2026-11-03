---
name: fix-findings
description: "Apply every finding from the most recent review, audit, verification, or check in this session."
argument-hint: "[which findings, e.g. 2-4 or S1 C1, or the findings' own text]"
disable-model-invocation: true
license: MIT
---

Apply the findings from the most recent review, audit, verification, lint run, test run, or other check reported earlier in this session, whatever produced it. Arguments that name findings (codes or numbers) narrow which ones; arguments that carry a finding's own text are the report, even when it came from another session. No arguments means every finding, at every severity. A finding the report left as a choice for the user: apply the option the arguments name, else the one the report recommended in so many words ("I recommend X"), worded exactly as it was offered. An option listed first or labelled "proposed" is not a recommendation. With none named, skip the finding as waiting on that choice.

1. No such report in this session and no finding text in the arguments: say so and stop. Do not go looking for problems to invent.
2. Fix root causes, not the symptom each finding names. Grep every caller before editing a shared function: one guard where the callers converge beats a guard in each of them.
3. Do not expand scope. A finding is a fix, not an invitation to refactor around it. When the finding proposes a fix, apply that fix, together with any change it cannot work without, and name that change on the finding's report line. If it cannot work even so, skip the finding and say why instead of choosing another. If it works at only some of the places the finding names, apply it there and report the finding as partly fixed.
4. For every repository you edited, this one or another, read its `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md`. Run the checks they name, and make the other edits they require of a change (a version bump, a changelog entry). Done when each edited repository has its checks run, or is named in the report as having none after you read those files.
5. Report one line per finding: `<code>: fixed`, `<code>: partly fixed, <what is left and why>`, or `<code>: skipped, <why>`. Then one line per edited repository with the checks run. Say plainly when a finding was wrong.

Do not commit. The user commits with `/commit` or `/ship-pr` in Claude linked installs or Cursor, `/supermatt:commit` or `/supermatt:ship-pr` from the Claude plugin, `$commit` or `$ship-pr` in Codex, or `/skill:commit` or `/skill:ship-pr` in OMP.
