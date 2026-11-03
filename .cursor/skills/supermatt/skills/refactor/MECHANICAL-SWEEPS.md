---
description: Apply one repeated change across many sites with structural tooling instead of by hand. Read in Step 4 when a single move repeats across more than a handful of files.
---

# Mechanical Sweeps

The same edit made by hand fifty times will differ in two or three places, and those are the ones
that reach production. When a change is genuinely uniform, let a tool make it uniformly.

## Size It First

Before choosing anything, count the sites. The number decides the approach:

- **A handful**: edit them by hand and move on. Setting up tooling costs more than the edits.
- **Dozens**: structural search and replace, reviewed as one diff.
- **Hundreds**: structural tooling, and split the result into reviewable commits.

Count with the same pattern you intend to rewrite, so the count is the real blast radius rather
than a text-match estimate.

## The Ladder

Stop at the first rung that handles the change:

1. **The language's own rename/extract**, through the IDE or language server. It understands
   scope, so it will not touch a same-named symbol in an unrelated file. Use it for renames and
   moves whenever it exists.
2. **`ast-grep`**: pattern-matches on syntax, not text. `ast-grep --pattern 'foo($A)' --rewrite
   'bar($A)' --lang ts`. Run it without `--update-all` first and read the diff.
3. **`comby`**: the same idea with lighter syntax and broader language coverage; good when
   `ast-grep` has no grammar for the language.
4. **The ecosystem's codemod runner** where the project already uses one.
5. **The linter's `--fix`**, if the change is something the linter already understands.
6. **`sed`/`awk`**: only for changes that are genuinely textual, such as a comment header. Text
   tools cannot see scope and will happily edit a string literal.
7. **By hand.**

## What A Sweep Will Miss

A syntactic tool sees syntax. Check these by hand afterwards, every time:

- **Dynamic references**: `obj[funcName]`, reflection, dependency-injection registries, anything
  that builds a name at runtime.
- **String literals**: a symbol name inside a query, a config file, a serialized payload.
- **Comments and docs**: not broken by the change, but now wrong.
- **Templates and generated code**: the generator still emits the old form.
- **Anything outside the working tree**: other repos, database columns, external callers.

A rename that compiles is not a rename that worked.

## Rules

- **Commit before the sweep.** A clean baseline turns a bad sweep into one `git checkout`.
- **The sweep is its own commit**, containing nothing else.
- **Prefer idempotent transformations.** Running it twice should produce the same result; if the
  second run changes something, the pattern is wrong.
- **Review the diff, not the summary.** "412 files changed" is not a result you can check.
