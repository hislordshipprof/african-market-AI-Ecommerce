import { scrubCardNumbers } from "../card-scrub";

const MAX = 2000;

export type Outgoing =
  | { ok: true; body: { message: { id: string; role: "user"; parts: [{ type: "text"; text: string }] } } }
  | { ok: false; reason: "empty" | "too_long" };

export function outgoingMessage(input: { id: string; text: string }): Outgoing {
  const scrubbed = scrubCardNumbers(input.text).text.trim();
  if (scrubbed.length < 1) return { ok: false, reason: "empty" };
  if (scrubbed.length > MAX) return { ok: false, reason: "too_long" };
  return {
    ok: true,
    body: {
      message: {
        id: input.id,
        role: "user",
        parts: [{ type: "text", text: scrubbed }],
      },
    },
  };
}

export function createSendLock() {
  let held = false;
  return {
    tryBegin(): boolean {
      if (held) return false;
      held = true;
      return true;
    },
    end(): void {
      held = false;
    },
    get held(): boolean {
      return held;
    },
  };
}
