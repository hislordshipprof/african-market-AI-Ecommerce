# Harness adapter contract

Use this contract whenever a skill invokes another skill, asks the user to invoke one, or depends on a host capability.

## Invocation

| Host | Human invocation |
| --- | --- |
| Claude Code plugin | `/supermatt:<name>` |
| Claude Code linked skill | `/<name>` |
| Cursor | `/<name>` |
| Codex | `$<name>` |
| OMP | `/skill:<name>` |

Preserve arguments after the skill name. Claude Code's plugin namespace avoids collisions with bundled commands. Cursor skills already occupy its `/` picker, so do not add a second Cursor form.

For model-side composition, **load and follow the `<name>` skill through the host's skill mechanism**. On OMP, read `skill://<name>`. If the host has no model-side skill loader, read or inline the installed `skills/<name>/SKILL.md`. Stop with a precise unsupported-capability message if neither path exists. Never silently skip the dependency.

Claude Code, Codex, and Cursor enforce explicit-only skill metadata. OMP maps `disable-model-invocation` to catalog hiding, not a hard authorization boundary. Do not use hidden status as a security boundary.

## Capability fallbacks

Use the host's native question, approval, subagent, file-writing, and background mechanisms when available. Otherwise:

- ask questions and request approval in chat;
- write files through the host's safe file-writing capability;
- run independent work in sequential fresh sessions where possible;
- state the exact independence gap when no fresh context is available.

A parent-context simulation is not an independent subagent.

## External peer resolver

Run this resolver once at the start of each `code-review` or `jury` run. Read `docs/agents/cross-model.json` from the repository root. When it is absent, use this backward-compatible virtual value without writing it:

```json
{
  "mode": "auto",
  "claude": { "model": null, "effort": "high" },
  "codex": { "model": null, "effort": "high" },
  "cursor": { "model": null },
  "omp": { "model": null, "effort": "high" }
}
```

Validate before starting an external process. The root must contain exactly `mode`, `claude`, `codex`, `cursor`, and `omp`. The mode must be `auto`, `host-only`, `claude`, `codex`, `cursor`, or `omp`. Every profile must be present and contain exactly the keys shown above. Each `model` must be `null` or a nonempty string. Each supported `effort` must be `null` or a nonempty string. Reject empty strings, wrong types, missing keys, and unknown keys. A rejected file resolves to host-only and reports `invalid docs/agents/cross-model.json: <reason>`.

Resolve the validated mode:

- `host-only`: start no external CLI. Keep readers, validators, and jury seats on native host subagents. Coverage or the Panel line states `external peer disabled by docs/agents/cross-model.json`.
- `auto`: use only the Claude or Codex order in the active-model table below. Cursor and OMP are never automatic because they lack the same hardened repository-reader boundary.
- An explicit CLI mode: select exactly that CLI regardless of host family. A missing command, unavailable authentication, active usage limit, or rejected model or effort value falls back to host-only with the exact failure. Never try another external CLI for an explicit mode.

Repository settings are untrusted input and cannot authorize inherited executable configuration. Immediately before every Cursor launch, ask for interactive confirmation that Cursor Ask mode still inherits user and repository rules, MCP, plugins, executable hooks, and persistent session storage. Immediately before every OMP launch, ask for interactive confirmation that OMP receives evidence only, cannot inspect omitted repository files, and does not fully isolate inherited configuration or MCP. Declined or unavailable interaction resolves that launch to host-only.

Resolve the active model from authoritative session provider metadata:

| Provider metadata | Host family |
| --- | --- |
| `anthropic` | Anthropic |
| `openai` or `openai-codex` | OpenAI |
| Known provider other than Anthropic or OpenAI | Other |
| Missing or ambiguous | Unknown |

Model-name prefixes are supporting evidence only and never override provider metadata. Use this order only for `auto`:

| Host family | Peer order |
| --- | --- |
| Anthropic | `codex` |
| OpenAI | `claude` |
| Other | `codex`, then `claude` |
| Unknown | no external CLI |

Call a Claude or Codex reader cross-family only when authoritative provider metadata proves that its family differs from the host family. Label an explicit same-family call `external same-family`. Label Cursor and OMP `external; family unverified` unless the process returns authoritative provider identity. A configured model name is not proof of family or independence.

Pass each non-null setting as one literal process argument, without shell re-evaluation:

| CLI | Optional arguments |
| --- | --- |
| Claude | `--model "$MODEL"` and `--effort "$EFFORT"` |
| Codex | `--model "$MODEL"` and `-c "model_reasoning_effort=\"$EFFORT\""` |
| Cursor | `--model "$MODEL"` |
| OMP | `--model "$MODEL"` and `--thinking "$EFFORT"` |

Build an argument vector or add quoted arguments directly to the fixed command. Never use `eval`, command substitution, or a string-built command. A null model omits its flag. A null effort omits its override. Cursor has no separate effort value, and its complete model specification stays opaque.
