import { scrubCardNumbers, scrubKnownStrings } from "./card-scrub";

const AMOUNT = /(?:US)?\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;

export function groundAmounts(
  text: string,
  allowedCents: Set<number>,
): { text: string; stripped: string[] } {
  const stripped: string[] = [];
  const next = text.replace(AMOUNT, (match) => {
    const cents = amountToCents(match);
    if (cents != null && allowedCents.has(cents)) return match;
    stripped.push(match);
    return "(see card)";
  });
  return { text: next, stripped };
}

function amountToCents(match: string): number | null {
  const body = match.replace(/^US/, "").replace("$", "").replace(/\s/g, "").replace(/,/g, "");
  const [whole, frac = ""] = body.split(".");
  if (frac.length > 2) return null;
  const dollars = Number(whole);
  if (!Number.isInteger(dollars)) return null;
  if (frac.length === 0) return dollars * 100;
  if (frac.length === 1) return dollars * 100 + Number(frac) * 10;
  return dollars * 100 + Number(frac);
}

export function collectAllowedCents(value: unknown, into = new Set<number>()): Set<number> {
  if (Array.isArray(value)) {
    for (const item of value) collectAllowedCents(item, into);
    return into;
  }
  if (!value || typeof value !== "object") return into;
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Cents") && typeof child === "number" && Number.isInteger(child)) {
      into.add(child);
    }
    collectAllowedCents(child, into);
  }
  return into;
}

export interface GroundingTransformOptions {
  onStrip?: (amount: string) => void;
  getAllowedCents?: () => Set<number>;
}

/**
 * Buffers each text block and grounds it before any of that block is emitted.
 * Tool and other parts pass through immediately.
 */
export function groundingTransform(options: GroundingTransformOptions = {}) {
  return () => {
    let allowed = new Set<number>(options.getAllowedCents?.() ?? []);
    const buffers = new Map<string, string>();
    return new TransformStream({
      transform(part, controller) {
        if (part && typeof part === "object" && "type" in part) {
          const type = (part as { type: string }).type;
          const id = String((part as { id?: string }).id ?? "");
          if (type === "tool-result") {
            allowed = new Set([...allowed, ...collectAllowedCents(part)]);
          }
          if (type === "text-start") {
            buffers.set(id, "");
            controller.enqueue(part);
            return;
          }
          if (type === "text-delta" && buffers.has(id)) {
            const piece = part as { text?: string; delta?: string };
            buffers.set(id, `${buffers.get(id) ?? ""}${piece.text ?? piece.delta ?? ""}`);
            return;
          }
          if (type === "text-end" && buffers.has(id)) {
            const grounded = groundAmounts(scrubCardNumbers(buffers.get(id) ?? "").text, allowed);
            buffers.delete(id);
            for (const amount of grounded.stripped) options.onStrip?.(amount);
            if (grounded.text) {
              controller.enqueue({ type: "text-delta", id, text: grounded.text });
            }
            controller.enqueue(part);
            return;
          }
          if (type === "tool-call") {
            const input = (part as { input?: unknown }).input;
            const scrubbed = typeof input === "string"
              ? scrubCardNumbers(input).text
              : JSON.stringify(scrubKnownStrings(input ?? {}));
            controller.enqueue({ ...part, input: scrubbed });
            return;
          }
          if (type === "error") {
            if (id && buffers.has(id)) buffers.delete(id);
            else buffers.clear();
            controller.enqueue(part);
            return;
          }
        }
        controller.enqueue(part);
      },
    });
  };
}
