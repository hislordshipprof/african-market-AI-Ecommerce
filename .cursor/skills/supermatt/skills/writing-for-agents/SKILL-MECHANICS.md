# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (frontmatter, the invocation choice, and router skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Invocation

Two choices trade the two loads. The host-specific syntax, model-side loader, and policy limits live in [`../../references/harnesses.md`](../../references/harnesses.md).

- A **model-invoked** skill keeps a model-facing `description` with the trigger branches, so a model or another skill can discover it. Omit `disable-model-invocation` and the `policy` block in `agents/openai.yaml`.
- A **user-invoked** skill keeps a one-line human-facing `description` without trigger lists. Set `disable-model-invocation: true` and `policy.allow_implicit_invocation: false`.

Claude Code, Codex, and Cursor enforce explicit-only metadata. OMP uses it for catalog hiding, not model authorization. Design explicit-only skills for deliberate human entry, but never put a security boundary behind hidden status.

Pick model invocation only when the agent must reach the skill by itself or another skill depends on it. Shared reference needed by two user-invoked skills belongs in a plain file inside the plugin root.

## Splitting by invocation

Split off a model-invoked skill when it has a distinct trigger or another skill must load and follow it. This spends permanent context on its description, so the independent reach must justify that cost.

A sequence split hides later steps only across a real independent context. Use the host's subagent mechanism when available. Otherwise use a fresh session where possible and state the independence gap when neither exists.

## Router skills

When user-invoked skills multiply past what a person can remember, add one user-invoked router that names them and when to use each. The router suggests the applicable human invocation form from the harness contract.
