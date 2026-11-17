import { acpError, acpGate, respond, sessionIdSchema } from "@/lib/acp/http";
import { cancelCheckoutSession } from "@/lib/acp/checkout-sessions";
import { parseInput } from "@/lib/security/parse-input";

/** ACP: cancel an open checkout session (#574). The agent's reason is not kept. */
export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> => {
  const gate = await acpGate(request);
  if (gate instanceof Response) return gate;
  const id = parseInput(sessionIdSchema, (await params).id);
  if (!id.ok) return acpError(404, "not_found", "No checkout session with that id at this store.");
  return respond(await cancelCheckoutSession(gate.store, gate.origin, id.data));
};
