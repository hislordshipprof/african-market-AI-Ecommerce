"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { getStore } from "../get-store";
import { parseInput } from "../security/parse-input";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { clientIp } from "../assistant/client-ip";
import { resolveSubstitutionByToken, substitutionPromptsForToken, type SubstitutionPromptView } from "./substitution";

const answerSchema = z.strictObject({
  token: z.string().min(1).max(200),
  requestId: z.string().min(1).max(64),
  decision: z.enum(["swap", "refund"]),
});
const TOKEN_LIMIT = 20;
const IP_LIMIT = 60;
const WINDOW_MS = 60 * 60 * 1000;

const ERRORS = {
  not_found: "We couldn't find that item on your order.",
  already_answered: "This item was already answered.",
  not_waiting: "This order is no longer waiting for an answer.",
  no_swap_offered: "No swap is offered for this item. You can take the refund.",
  not_due: "We couldn't save your choice. Try again.",
  too_many: "Too many tries. Wait a while, then try again.",
} as const;

export type AnswerSubstitutionResult =
  | { ok: true; prompts: SubstitutionPromptView[]; orderStatus: string }
  | { ok: false; error: string; prompts?: SubstitutionPromptView[]; orderStatus?: string };

/** Public: the tracking token is the only credential, so it is rate limited per token and per IP. */
export async function answerSubstitutionAction(input: { token: string; requestId: string; decision: string }): Promise<AnswerSubstitutionResult> {
  const parsed = parseInput(answerSchema, input);
  if (!parsed.ok) return { ok: false, error: ERRORS.not_found };
  const ip = clientIp(await headers());
  const [byToken, byIp] = await Promise.all([
    takeRateLimit(`substitution:token:${parsed.data.token}`, TOKEN_LIMIT, WINDOW_MS),
    takeRateLimit(`substitution:ip:${ip}`, IP_LIMIT, WINDOW_MS),
  ]);
  if (!byToken.ok || !byIp.ok) return { ok: false, error: ERRORS.too_many };

  const store = await getStore();
  const result = await resolveSubstitutionByToken(store.id, parsed.data.token, parsed.data.requestId, parsed.data.decision);
  if (!result.ok && result.error === "not_found") return { ok: false, error: ERRORS.not_found };
  const view = await substitutionPromptsForToken(store.id, parsed.data.token);
  if (!view) return { ok: false, error: ERRORS.not_found };
  if (!result.ok) return { ok: false, error: ERRORS[result.error], prompts: view.prompts, orderStatus: view.status };
  return { ok: true, prompts: view.prompts, orderStatus: view.status };
}
