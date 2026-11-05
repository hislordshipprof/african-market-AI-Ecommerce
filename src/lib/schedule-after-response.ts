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
 * Runs work after the response when Next has a request scope (`after`),
 * so a serverless freeze cannot drop the email. Outside a request
 * (auth.handler in vitest) the task still starts without being awaited.
 * Rejections are logged and never include an email address.
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
