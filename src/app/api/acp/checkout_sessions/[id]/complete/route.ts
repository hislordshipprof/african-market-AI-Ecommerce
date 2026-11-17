import { acpError, acpGate, completeSessionSchema, readJson, respond, sessionIdSchema } from "@/lib/acp/http";
import { completeCheckoutSession } from "@/lib/acp/checkout-sessions";
import { parseInput } from "@/lib/security/parse-input";

/** ACP: pay with the agent's shared payment token and place the order (#574). */
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
  const gate = await acpGate(request);
  if (gate instanceof Response) return gate;
  const id = parseInput(sessionIdSchema, (await params).id);
  if (!id.ok) return acpError(404, "not_found", "No checkout session with that id at this store.");
  const input = parseInput(completeSessionSchema, await readJson(request));
  if (!input.ok) return acpError(400, "invalid_request", input.issues.join(" "));
  return respond(await completeCheckoutSession(gate.store, gate.origin, id.data, {
    token: input.data.payment_data.instrument.credential.token,
    buyer: input.data.buyer,
  }));
};
