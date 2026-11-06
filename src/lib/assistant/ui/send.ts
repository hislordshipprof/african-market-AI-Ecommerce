import { scrubCardNumbers } from "../card-scrub";

const MAX = 2000;

export type OutgoingFile = { type: "file"; mediaType: string; filename: string; url: string };

export type Outgoing =
  | { ok: true; body: { message: { id: string; role: "user"; parts: Array<{ type: "text"; text: string } | OutgoingFile> } } }
  | { ok: false; reason: "empty" | "too_long" };

export function outgoingMessage(input: { id: string; text: string; files?: OutgoingFile[] }): Outgoing {
  const scrubbed = scrubCardNumbers(input.text).text.trim();
  const files = input.files ?? [];
  if (scrubbed.length < 1 && files.length === 0) return { ok: false, reason: "empty" };
  if (scrubbed.length > MAX) return { ok: false, reason: "too_long" };
  return {
    ok: true,
    body: {
      message: {
        id: input.id,
        role: "user",
        parts: [
          ...files,
          ...(scrubbed.length > 0 ? [{ type: "text" as const, text: scrubbed }] : []),
        ],
      },
    },
  };
}

export type SettleAction = "revoke" | "restore" | "keep" | "ignore";

/** One decision for one in-flight send. Close has already cleared a changed generation. */
export function settleSend(input: {
  outcome: "success" | "rejected";
  generation: number;
  revision: number;
  flight: { generation: number; revision: number } | null;
}): { action: SettleAction } {
  if (!input.flight || input.flight.generation !== input.generation) return { action: "ignore" };
  if (input.outcome === "success") return { action: "revoke" };
  if (input.revision !== input.flight.revision) return { action: "keep" };
  return { action: "restore" };
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
