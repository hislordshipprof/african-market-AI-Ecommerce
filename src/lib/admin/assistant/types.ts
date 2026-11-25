import type { SendCode } from "../../copilot/types";
import type { AdminDraftCard } from "./drafts";

/** A screen the reply points to, built from a tool result. The model never writes links. */
export interface AssistantLink {
  label: string;
  href: string;
}

export interface AdminAssistantMessage {
  role: "admin" | "assistant";
  text: string;
  /** The admin's client message id for the turn this reply answers. */
  messageId?: string;
  links?: AssistantLink[];
  /** What this reply cost. Never sent to the page. */
  costMicros?: number;
}

export type AdminAssistantResult =
  | { ok: true; conversationId: string; reply: string; links: AssistantLink[]; drafts: AdminDraftCard[] }
  | { ok: false; code: Exclude<SendCode, "plan_locked">; message: string; retryAfter?: number };

/** At most this many rows per tool result, and links per reply. */
export const ROWS_MAX = 20;
export const LINKS_MAX = 20;
