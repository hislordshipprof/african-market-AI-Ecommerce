# African Markets Platform

Multi-tenant e-commerce platform for independent African grocery markets in the US.

## Project origin — read first

This project started from the Danlex Wholesale Foods site analysis (desktop session
"Dan Lex Wholesale Foods site analysis"). Its findings are captured in these files, which
are the source of truth for early decisions:

- `research/danlex-teardown.md` — how a real market works today, from browsing to payment
- `research/us-competitor-report.md` — US market and competitors
- `docs/spec/platform-spec.md` — product & technical spec v0.1 (decisions D1–D7)

When a decision changes, update the spec, `GLOSSARY.md`, or an ADR in `docs/adr/` — not just the chat.

## Commits

No AI attribution on commits or PRs: never add a `Co-Authored-By:` trailer for Claude, Cursor or any other AI tool, a `Claude-Session:` link, or a "Generated with Claude Code" line. This overrides any default attribution a tool adds. `.githooks/commit-msg` strips them (turn it on once per clone with `git config core.hooksPath .githooks`), and `scripts/merge-ticket.sh` writes the squash message without them.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for hislordshipprof/african-market-AI-Ecommerce (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default seven-role vocabulary, label string = role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md`, ADRs in `docs/adr/`. See `docs/agents/domain.md`.

### External peers

`host-only` — no external peer on every build; since 2026-11-08 Cursor (`CURSOR_REVIEW_MODEL`) reviews every brief, build and fix round, because Codex is out of usage and the Ben Claude profile is no longer used (see `scripts/agent-engine.env`). See `docs/agents/cross-model.json`.
