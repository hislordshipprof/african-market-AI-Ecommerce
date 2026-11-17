import { acpError, acpGate, createSessionSchema, readJson, respond } from "@/lib/acp/http";
import { createCheckoutSession } from "@/lib/acp/checkout-sessions";
import { parseInput } from "@/lib/security/parse-input";

/** ACP: create a checkout session for the items an agent chose (#574). */
export const POST = async (request: Request): Promise<Response> => {
  const gate = await acpGate(request);
  if (gate instanceof Response) return gate;
  const input = parseInput(createSessionSchema, await readJson(request));
  if (!input.ok) return acpError(400, "invalid_request", input.issues.join(" "));
  return respond(await createCheckoutSession(gate.store, gate.origin, { items: input.data.line_items, buyer: input.data.buyer }));
};
