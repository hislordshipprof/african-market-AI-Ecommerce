import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { smsChannel } from "./channels";
import { ProviderSendError } from "./provider-error";
import { setSmsSenderForTests } from "./sms";

const ENV = { NODE_ENV: "test" };
const MESSAGE = { to: "+13014482210", from: "+13015550100", text: "Ada's Market: order #1 Accepted." };

function telnyxRejects(status: number, code: string) {
  setSmsSenderForTests({
    async send() {
      throw new ProviderSendError(status, code);
    },
  });
}

describe("Telnyx error mapping", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => {
    setSmsSenderForTests(null);
    vi.restoreAllMocks();
  });

  it("a 429 rate limit is retried, a STOP is skipped, and a 422 that is not an idempotency conflict keeps its code", async () => {
    telnyxRejects(429, "10011");
    await expect(smsChannel.send(MESSAGE, { idempotencyKey: "notif_a" }, ENV)).rejects.toThrow();

    telnyxRejects(403, "40300");
    await expect(smsChannel.send(MESSAGE, { idempotencyKey: "notif_s" }, ENV)).resolves.toEqual({ outcome: "skipped", reason: "opted_out" });

    telnyxRejects(422, "40001");
    await expect(smsChannel.send(MESSAGE, { idempotencyKey: "notif_b" }, ENV)).resolves.toEqual({
      outcome: "failed",
      reason: "telnyx_40001",
      retryable: false,
    });

    telnyxRejects(422, "idempotency_conflict");
    await expect(smsChannel.send(MESSAGE, { idempotencyKey: "notif_c" }, ENV)).resolves.toEqual({
      outcome: "failed",
      reason: "idempotency_conflict",
      retryable: false,
    });
  });
});
