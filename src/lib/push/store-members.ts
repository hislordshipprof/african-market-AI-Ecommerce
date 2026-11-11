import { storeScoped } from "../db";
import { isPushServiceEndpoint } from "./endpoint";
import { pushSender, PushSendError, type PushMessage } from "./sender";

const GONE = new Set([404, 410]);
let warnedNoKeys = false;

/**
 * One push to each current member's subscribed device in this store. The device groups
 * notifications by `message.tag`. Never throws for a push failure; a gone subscription is deleted.
 * `roles` limits the push to members with one of those roles.
 */
export async function pushToStoreMembers(
  storeId: string,
  message: PushMessage,
  env: Record<string, string | undefined> = process.env,
  options: { roles?: string[] } = {},
): Promise<void> {
  const sender = pushSender(env);
  if (!sender) {
    if (!warnedNoKeys) {
      warnedNoKeys = true;
      console.warn(JSON.stringify({ event: "push_skipped_no_vapid_keys" }));
    }
    return;
  }

  const scoped = storeScoped(storeId);
  const subscriptions = await scoped.pushSubscription.findMany();
  if (subscriptions.length === 0) return;

  const members = await scoped.storeMembership.findMany({
    where: {
      userId: { in: [...new Set(subscriptions.map((s) => s.userId))] },
      ...(options.roles ? { role: { in: options.roles } } : {}),
    },
    select: { userId: true },
  });
  const memberIds = new Set(members.map((m) => m.userId));
  const tag = message.tag;

  async function dropSubscription(id: string) {
    try {
      await scoped.pushSubscription.deleteMany({ where: { id } });
    } catch {
      console.error(JSON.stringify({ event: "push_delete_failed", storeId, tag, subscriptionId: id }));
    }
  }

  await Promise.allSettled(
    subscriptions
      .filter((subscription) => memberIds.has(subscription.userId))
      .map(async (subscription) => {
        if (!isPushServiceEndpoint(subscription.endpoint)) {
          await dropSubscription(subscription.id);
          return;
        }
        try {
          await sender.send(subscription, message);
        } catch (err) {
          const status = err instanceof PushSendError ? err.status : 0;
          if (GONE.has(status)) {
            await dropSubscription(subscription.id);
            return;
          }
          console.error(JSON.stringify({ event: "push_send_failed", storeId, tag, subscriptionId: subscription.id, status }));
        }
      }),
  );
}
