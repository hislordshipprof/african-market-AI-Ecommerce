import { platform, storeScoped } from "../db";
import { resolveAuthBaseUrl } from "../auth";
import { escapeHtml, money } from "../format";
import { FULFILLMENT_LABELS } from "../order/status-labels";
import { ProviderSendError } from "../notifications/provider-error";
import { sendEmail } from "./send";

/** Whether this member gets the new-order email (#785). Owners have it on until they turn it off. */
export async function newOrderEmailOn(storeId: string, userId: string): Promise<boolean> {
  const membership = await storeScoped(storeId).storeMembership.findUnique({
    where: { storeId_userId: { storeId, userId } },
    select: { newOrderEmail: true },
  });
  return membership?.newOrderEmail ?? false;
}

/** A member turns their own new-order email on or off. */
export async function setNewOrderEmail(storeId: string, userId: string, on: boolean): Promise<void> {
  await storeScoped(storeId).storeMembership.updateMany({ where: { userId }, data: { newOrderEmail: on } });
}

/**
 * One email per owner who has it on, for a new order, with a link that opens it in Orders to accept (#785).
 * Sent after the order commits; a failed send is logged and never throws. The key makes a retry send nothing new.
 */
export async function sendNewOrderOwnerEmail(
  storeId: string,
  orderId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const scoped = storeScoped(storeId);
  const [order, store, owners] = await Promise.all([
    scoped.order.findUnique({
      where: { id: orderId },
      select: { number: true, fulfillment: true, totalCents: true, customer: { select: { name: true } }, _count: { select: { lines: true } } },
    }),
    platform.store.findUnique({ where: { id: storeId }, select: { name: true, slug: true } }),
    scoped.storeMembership.findMany({
      where: { role: "owner", newOrderEmail: true },
      select: { user: { select: { id: true, email: true } } },
    }),
  ]);
  if (!order || !store || owners.length === 0) return;

  const fulfillment = FULFILLMENT_LABELS[order.fulfillment] ?? "Delivery";
  const url = `${resolveAuthBaseUrl(env).replace(/\/$/, "")}/store-admin/orders?store=${encodeURIComponent(store.slug)}&order=${encodeURIComponent(orderId)}`;
  const items = order._count.lines === 1 ? "1 item" : `${order._count.lines} items`;
  const subject = `New order #${order.number} at ${store.name}`;
  const html = [
    `<h1>New order #${order.number}</h1>`,
    `<p>${escapeHtml(order.customer.name)} placed a ${escapeHtml(fulfillment.toLowerCase())} order at ${escapeHtml(store.name)}: ${items}, ${money(order.totalCents)}.</p>`,
    `<p><a href="${escapeHtml(url)}">Open the order to accept it</a></p>`,
    `<p>You get this email for each new order. To stop it, turn off "New-order email" on your Orders page.</p>`,
  ].join("\n");

  await Promise.all(
    owners.map(async ({ user }) => {
      try {
        await sendEmail({ to: user.email, subject, html, idempotencyKey: `new-order:${orderId}:${user.id}` });
      } catch (err) {
        // The provider's status and code only: its message can echo the address.
        const status = err instanceof ProviderSendError ? err.status : null;
        const code = err instanceof ProviderSendError ? err.code : "send_threw";
        console.error(JSON.stringify({ event: "new_order_email_failed", storeId, orderId, userId: user.id, status, code }));
      }
    }),
  );
}
