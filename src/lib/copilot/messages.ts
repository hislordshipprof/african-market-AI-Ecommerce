import { HISTORY_MAX } from "./types";

export interface StoredMessage {
  role: "owner" | "assistant";
  text: string;
  summary?: string;
}

export function parseStoredMessages(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: StoredMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    const summary = (item as { summary?: unknown }).summary;
    if ((role !== "owner" && role !== "assistant") || typeof text !== "string") continue;
    messages.push({
      role,
      text,
      ...(typeof summary === "string" && summary ? { summary } : {}),
    });
  }
  return messages;
}

/** The last 20 stored turns, starting at an owner message so a pair is never split. */
export function modelHistory(messages: readonly StoredMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const recent = messages.slice(-HISTORY_MAX);
  const start = recent.findIndex((message) => message.role === "owner");
  if (start < 0) return [];
  return recent.slice(start).map((message) => ({
    role: message.role === "owner" ? "user" : "assistant",
    content: message.summary ? `${message.text}\n${message.summary}` : message.text,
  }));
}
