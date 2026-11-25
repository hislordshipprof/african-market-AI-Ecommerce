# 25. Platform admin assistant tool tiers

Date: 2026-11-25 · Status: accepted (#831 builds the read tier)

## Context

The owner wants one assistant in the platform admin console that answers anything about the platform, by voice or text, and later does the steps an admin now does by hand: store creation, request checks, product and catalogue work (owner decision 2026-11-25, Build Board decision 2026-11-25-01). The store copilot (spec §8.2) already reads freely and changes nothing until the owner confirms a draft. Shopify Sidekick works the same way for merchants: it reads the store, uses the staff member's own permissions, and "can't change your live store without your approval". OWASP's LLM06 (excessive agency) and LLM01 (prompt injection) ask for least privilege, authorization outside the model, human approval before a high-impact action, and logs.

## Decision

Tools are tiered by what they can change. A tier is added by its own ticket; none skips the one before.

1. **Read (built in #831).** Reads only, through the same server function the admin screen uses (`src/lib/admin/*`, `src/lib/store-application/*`, `src/lib/support/platform-actions.ts`), never a second copy and never raw SQL. No confirm. Every call writes an `audit_logs` row (`admin_assistant.tool`, admin, tool, parameters) before it reads.
2. **Draft and confirm (later tickets).** A change is a draft card the admin confirms with one tap, on the store copilot's draft and confirm pattern (`src/lib/copilot/drafts.ts`, `confirm.ts`, `draft-rows.ts`). The confirm calls the admin screen's own action, which re-checks the platform admin. The draft, the confirm and the reject each write an `audit_logs` row. A change that cannot be undone (a refund, a go-live, an email to a store) shows that on the card.
3. **Never.** No tool exists, in any tier, to create or remove platform admins, change 2FA or security settings, change Stripe or payout settings, read or set secrets, or delete stores or users. The prompt tells the admin so; the absence of the tool is the control.

Every tier runs only behind `requirePlatformAdmin` (signed in, platform admin, 2FA verified), on the copilot engine's spend gate, rate limit, lease, history and step caps. Tool results are data, never instructions. The model writes no links and no numbers of its own: links are built from tool rows, and a reply with a number no tool returned is refused.

## Consequences

- Each later ticket adds draft tools without changing the read tools or the engine.
- Proactive suggestions (Sidekick's Pulse) are not built yet; when built they arrive as draft cards, never as changes.
- `platform_totals` is the one read with no admin screen of its own; it adds the store analytics figures (`salesRows`, `salesView`, #498) across stores rather than computing sales a second way.
