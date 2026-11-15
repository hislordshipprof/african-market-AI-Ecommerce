/** WhatsApp keys are missing. Thrown at call time, never at import. */
export class WhatsAppNotConfiguredError extends Error {
  constructor() {
    super("WhatsApp is not configured");
    this.name = "WhatsAppNotConfiguredError";
  }
}

/**
 * A Graph API failure. Carries the numeric Graph code and HTTP status only:
 * Meta's error message and error_data can echo the recipient's number.
 * `status` 0 means the request never got a response (network or timeout).
 */
export class WhatsAppApiError extends Error {
  readonly code: number | null;
  readonly status: number;

  constructor(code: number | null, status: number) {
    super(`WhatsApp API error ${code ?? "unknown"} (HTTP ${status})`);
    this.name = "WhatsAppApiError";
    this.code = code;
    this.status = status;
  }
}

/** Numeric code for logs. Never the message of a non-WhatsApp error. */
export function whatsappErrorCode(error: unknown): string {
  if (error instanceof WhatsAppApiError) return String(error.code ?? `http_${error.status}`);
  if (error instanceof WhatsAppNotConfiguredError) return "not_configured";
  return "unexpected";
}
