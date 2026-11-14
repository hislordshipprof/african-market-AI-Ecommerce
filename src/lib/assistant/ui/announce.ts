import { cardsFromParts, type AssistantCard } from "./cards";
import { markdownToPlain } from "./markdown";

type Part = Parameters<typeof cardsFromParts>[0][number];

/** One completion announcement: the reply text, then a short card summary. */
export function completionAnnouncement(message: { parts: readonly Part[] }): string {
  const text = message.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" && part.text.trim() ? [markdownToPlain(part.text)] : []).join(" ");
  const cards = cardsFromParts(message.parts);
  const summary = cardSummary(cards);
  const spoken = [text, summary].filter((part) => part.length > 0).join(" ");
  return spoken.slice(0, 240) || "Reply ready";
}

function cardSummary(cards: readonly AssistantCard[]): string {
  const products = cards.filter((card) => card.kind === "product").length;
  if (products > 0) return `${products} ${products === 1 ? "product" : "products"} shown`;
  if (cards.some((card) => card.kind === "added")) return "Added to cart";
  if (cards.some((card) => card.kind === "choices")) return "Choices shown";
  if (cards.some((card) => card.kind === "summary")) return "Basket summary shown";
  return "";
}
