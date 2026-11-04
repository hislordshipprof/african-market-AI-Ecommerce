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
    let buffering = false;
    let buffer = "";
    let blockId = "";
    return new TransformStream({
      transform(part, controller) {
        if (part && typeof part === "object" && "type" in part) {
          const type = (part as { type: string }).type;
          if (type === "tool-result" || type === "tool-call") {
            allowed = new Set([...allowed, ...collectAllowedCents(part)]);
          }
          if (type === "text-start") {
            buffering = true;
            buffer = "";
            blockId = String((part as { id?: string }).id ?? "");
            controller.enqueue(part);
            return;
          }
          if (type === "text-delta" && buffering) {
            const piece = part as { text?: string; delta?: string };
            buffer += piece.text ?? piece.delta ?? "";
            return;
          }
          if (type === "text-end" && buffering) {
            const grounded = groundAmounts(buffer, allowed);
            for (const amount of grounded.stripped) options.onStrip?.(amount);
            if (grounded.text) {
              controller.enqueue({ type: "text-delta", id: blockId, text: grounded.text });
            }
            buffering = false;
            buffer = "";
            controller.enqueue(part);
            return;
          }
          if (type === "error" && buffering) {
            buffering = false;
            buffer = "";
            controller.enqueue(part);
            return;
          }
        }
        controller.enqueue(part);
      },
    });
  };
}
