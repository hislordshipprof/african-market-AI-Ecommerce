import { describe, expect, it } from "vitest";
import { TelnyxSender } from "./sms";

const apiKey = process.env.TELNYX_API_KEY;
const from = process.env.TELNYX_FROM_NUMBER;
const testTo = process.env.TELNYX_TEST_TO;

describe.skipIf(!apiKey)("Telnyx sandbox", () => {
  it("a rejected SMS becomes a reason code with no digits from either number", async () => {
    const sender = new TelnyxSender(apiKey!, "+15555550100");
    const destination = "+15555550199";
    await expect(sender.send({
      to: destination,
      from: "+15555550100",
      text: "Ada's Market: order #1 Cancelled. Track it: https://example.com/order/token",
    }, {
      idempotencyKey: `notif_reject_${Date.now()}`,
    })).rejects.toSatisfy((error: { code?: string; message?: string }) => {
      const reason = `${error.code ?? ""} ${error.message ?? ""}`;
      expect(["40310", "40305", "10015", "40002", "40300"].some((code) => reason.includes(code)) || /\b\d{5}\b/.test(reason)).toBe(true);
      expect(reason).not.toContain("5555550100");
      expect(reason).not.toContain("5555550199");
      return true;
    });
  }, 20_000);

  it.skipIf(!from || !testTo)("the same idempotency key replays one accepted SMS", async () => {
    const sender = new TelnyxSender(apiKey!, from!);
    const key = `notif_replay_${Date.now()}`;
    const message = {
      to: testTo!,
      from: from!,
      text: "Ada's Market: order #1 Order placed. Track it: https://example.com/order/token Reply STOP to opt out.",
      idempotencyKey: key,
    };
    const first = await sender.send(
      { to: message.to, from: message.from, text: message.text },
      { idempotencyKey: message.idempotencyKey },
    );
    const second = await sender.send(
      { to: message.to, from: message.from, text: message.text },
      { idempotencyKey: message.idempotencyKey },
    );
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
  }, 20_000);
});
