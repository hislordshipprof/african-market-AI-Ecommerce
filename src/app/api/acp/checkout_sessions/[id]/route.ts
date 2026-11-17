import { acpError, acpGate, readJson, respond, sessionIdSchema, updateSessionSchema } from "@/lib/acp/http";
import { getCheckoutSession, updateCheckoutSession } from "@/lib/acp/checkout-sessions";
import { parseInput } from "@/lib/security/parse-input";

type Params = { params: Promise<{ id: string }> };

/** ACP: read a checkout session (#574). */
export const GET = async (request: Request, { params }: Params): Promise<Response> => {
  const gate = await acpGate(request);
  if (gate instanceof Response) return gate;
  const id = parseInput(sessionIdSchema, (await params).id);
  if (!id.ok) return acpError(404, "not_found", "No checkout session with that id at this store.");
  return respond(await getCheckoutSession(gate.store, gate.origin, id.data));
};

/** ACP: change a session's items or buyer (#574). */
export const POST = async (request: Request, { params }: Params): Promise<Response> => {
  const gate = await acpGate(request);
  if (gate instanceof Response) return gate;
  const id = parseInput(sessionIdSchema, (await params).id);
  if (!id.ok) return acpError(404, "not_found", "No checkout session with that id at this store.");
  const input = parseInput(updateSessionSchema, await readJson(request));
  if (!input.ok) return acpError(400, "invalid_request", input.issues.join(" "));
  return respond(await updateCheckoutSession(gate.store, gate.origin, id.data, { items: input.data.line_items, buyer: input.data.buyer }));
};
