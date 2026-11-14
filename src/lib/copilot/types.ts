export const FIXED_ERROR = "Sorry, something went wrong. Please try again.";
export const UNAVAILABLE_MESSAGE = "The copilot is not available right now.";
export const RESTING_MESSAGE =
  "The copilot is resting right now. You can still confirm a change that's already on screen.";

export const MESSAGE_MAX = 1_000;
export const PROPOSAL_MAX = 5;
export const QUANTITY_MAX = 100_000;
export const QTY_COLUMN_MAX = 2_147_483_647;
export const HISTORY_MAX = 20;
export const CONVERSATION_MAX = 100;
export const SENDS_PER_HOUR = 30;
export const HOUR_MS = 60 * 60 * 1000;
export const MODEL_TIMEOUT_MS = 45_000;
export const STEP_CAP = 6;
export const MAX_OUTPUT_TOKENS = 1024;
export const WRITE_TRANSACTION = { timeout: 20_000, maxWait: 8_000 };

export const PROPOSAL_KINDS = ["restock", "counter_sale", "recount", "set_status"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const STOCK_STATUSES = ["in_stock", "low", "out_of_stock"] as const;
export type StockStatusValue = (typeof STOCK_STATUSES)[number];

export type ProposalDisplayState = "pending" | "confirmed" | "rejected" | "expired";

export interface StockProposalCard {
  id: string;
  listingId: string;
  listingName: string;
  kind: ProposalKind;
  quantity: number | null;
  statusValue: string | null;
  beforeQty: number | null;
  beforeStatus: string | null;
  afterQty: number | null;
  afterStatus: string | null;
  state: ProposalDisplayState;
}

/** One listing the owner can tap when a report matched several. */
export interface ChoiceCandidate {
  listingId: string;
  name: string;
}

/** A report that matched several listings. Stored on the assistant message; nothing is drafted until a tap. */
export interface ListingChoice {
  candidates: ChoiceCandidate[];
  kind: ProposalKind;
  quantity: number | null;
  statusValue: string | null;
  /** True when no listing matched every word and these are look-alikes. */
  nearOnly: boolean;
  /** Database clock, UTC. */
  createdAt: string;
  expiresAt: string;
}

export interface ChoiceCard extends ListingChoice {
  chosenListingId: string | null;
  open: boolean;
}

export interface PanelMessage {
  role: "owner" | "assistant";
  text: string;
  messageId?: string;
  choices?: ChoiceCard[];
}

export type SendCode =
  | "not_found"
  | "busy"
  | "rate_limited"
  | "copilot_resting"
  | "copilot_unavailable"
  | "invalid_request";

export type SendResult =
  | {
    ok: true;
    conversationId: string;
    reply: string;
    proposals: StockProposalCard[];
    choices: ChoiceCard[];
  }
  | { ok: false; code: SendCode; message: string; retryAfter?: number };

export type ConfirmCode = "not_found" | "expired" | "stale" | "too_large";

export type ConfirmResult =
  | { ok: true; proposal: StockProposalCard; listing: { qty: number | null; status: string | null } }
  | { ok: false; code: ConfirmCode };

export type ChooseResult =
  | { ok: true; proposal: StockProposalCard }
  | { ok: false; code: "not_found" | "expired" | "stale" };

export type RejectResult = { ok: true } | { ok: false; code: "not_found" };

export interface CopilotActor {
  id: string;
  email: string;
}

export function isProposalKind(value: string): value is ProposalKind {
  return (PROPOSAL_KINDS as readonly string[]).includes(value);
}

export function isDisplayState(value: string): value is ProposalDisplayState {
  return value === "pending" || value === "confirmed" || value === "rejected" || value === "expired";
}
