import { after } from "next/server";

function deliveryFailureLog(eventName: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : "delivery failed";
  const message = raw.replace(/[^\s<>"]+@[^\s<>"]+/g, "[redacted]");
  return JSON.stringify({
    event: eventName,
    message,
  });
}

/**
 * Starts the task at once and does not await it, so the caller (checkout,
 * a magic-link email) returns while the task is still pending. With a
 * request scope, `after` keeps the invocation alive until it settles, so a
 * serverless freeze cannot drop it. Outside a request (auth.handler in
 * vitest) nothing waits for it. Rejections are logged and never include an
 * email address.
 */
export function scheduleAfterResponse(
  task: () => Promise<unknown>,
  eventName = "magic_link_delivery_failed",
): void {
  // Start the send during the request, and hand that same promise to
  // after() so waitUntil keeps the invocation alive until it settles.
  // A callback that does not return the promise lets the runtime freeze
  // while the send is still in flight.
  const pending = task().catch((error: unknown) => {
    console.error(deliveryFailureLog(eventName, error));
  });

  try {
    after(pending);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("request scope") ||
      message.includes("`after`") ||
      message.includes("waitUntil")
    ) {
      return;
    }
    throw error;
  }
}
