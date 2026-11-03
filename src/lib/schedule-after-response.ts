import { after } from "next/server";

function deliveryFailureLog(error: unknown): string {
  const raw = error instanceof Error ? error.message : "delivery failed";
  const message = raw.replace(/[^\s<>"]+@[^\s<>"]+/g, "[redacted]");
  return JSON.stringify({
    event: "magic_link_delivery_failed",
    message,
  });
}

/**
 * Runs work after the response when Next has a request scope (`after`),
 * so a serverless freeze cannot drop the email. Outside a request
 * (auth.handler in vitest) the task still starts without being awaited.
 * Rejections are logged and never include an email address.
 */
export function scheduleAfterResponse(task: () => Promise<unknown>): void {
  const run = () => {
    const pending = task();
    pending.catch((error: unknown) => {
      console.error(deliveryFailureLog(error));
    });
  };

  try {
    after(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("request scope") || message.includes("`after`")) {
      run();
      return;
    }
    throw error;
  }
}
