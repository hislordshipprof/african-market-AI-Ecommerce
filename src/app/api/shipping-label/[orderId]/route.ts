import { z } from "zod";
import { storeScoped } from "@/lib/db";
import { streamShippingLabel } from "@/lib/r2";
import { parseInput } from "@/lib/security/parse-input";
import { requireStoreMember } from "@/lib/store-admin/session";

const orderIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+$/);

function notFound() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

/** A shipped order's label PDF is for the store's members only (#568): another store's order is a 404. */
export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await requireStoreMember();
  const { orderId } = await context.params;
  const parsed = parseInput(orderIdSchema, orderId);
  if (!parsed.ok) return notFound();
  const order = await storeScoped(session.store.id).order.findUnique({
    where: { id: parsed.data },
    select: { shippingLabelKey: true, shippingLabelStatus: true, number: true },
  });
  if (!order?.shippingLabelKey || order.shippingLabelStatus !== "bought") return notFound();
  const label = await streamShippingLabel(order.shippingLabelKey);
  if (!label) return notFound();
  return new Response(label.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="label-${order.number}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
