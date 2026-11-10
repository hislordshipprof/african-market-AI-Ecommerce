import { z } from "zod";
import { unstable_cache } from "next/cache";
import { getStore } from "@/lib/get-store";
import { parseInput } from "@/lib/security/parse-input";
import { orderMessagesTag, readCustomerMessages } from "@/lib/support/thread";

const tokenSchema = z.string().min(1).max(200);
const NO_STORE = { "Cache-Control": "private, no-store" };

/** The tracking page polls this every 10 s (ADR-0016). Cached on the server until a send or reply clears the tag. */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const parsed = parseInput(tokenSchema, token);
  if (!parsed.ok) return new Response(null, { status: 404, headers: NO_STORE });
  const store = await getStore();
  const messages = await unstable_cache(
    () => readCustomerMessages(store.id, parsed.data),
    ["order-messages", store.id, orderMessagesTag(parsed.data)],
    { revalidate: 60, tags: [orderMessagesTag(parsed.data)] },
  )();
  if (!messages) return new Response(null, { status: 404, headers: NO_STORE });
  return Response.json({ messages }, { headers: NO_STORE });
}
