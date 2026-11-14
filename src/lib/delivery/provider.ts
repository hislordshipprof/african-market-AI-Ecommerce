/**
 * Courier provider seam. DoorDash Drive (#135) and Uber Direct (#139) implement it;
 * the platform picks the provider per order (#140). Fees are the provider's quote, no markup (ADR-0006, ADR-0021).
 */

export type DeliveryProviderName = "doordash" | "uber";

/** Platform delivery event types a courier webhook maps to (delivery_events.type). */
export type CourierEventType = "courier_assigned" | "picked_up" | "delivered" | "cancelled" | "returned";

export interface DeliveryAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface DeliveryRequest {
  /** Our id for this delivery attempt; the provider keys the quote and delivery on it. */
  externalDeliveryId: string;
  pickup: {
    businessName: string;
    address: DeliveryAddress;
    /** E.164. */
    phone?: string;
    /** The store's registration with the provider, when it has one. */
    providerBusinessId?: string;
    providerStoreId?: string;
  };
  dropoff: {
    address: DeliveryAddress;
    /** E.164. */
    phone: string;
    givenName?: string;
    familyName?: string;
    instructions?: string;
    contactless?: boolean;
  };
  orderValueCents: number;
  tipCents: number;
  /** A PIN the customer gives the courier at drop-off; null asks for a photo (spec §11.3). */
  dropoffPin?: string | null;
}

export interface DeliveryQuote {
  quoteId: string;
  /** The provider's fee in cents, exactly as quoted. */
  feeCents: number;
  currency: string;
  pickupEta: Date | null;
  dropoffEta: Date | null;
  expiresAt: Date;
}

export interface CreatedDelivery {
  externalId: string;
  trackingUrl: string | null;
  /** The drop-off PIN the provider will check, when the request asked for one. */
  pin?: string | null;
}

export interface DeliveryWebhookEvent {
  provider: DeliveryProviderName;
  externalDeliveryId: string;
  /** Stable across the provider's retries of the same event. */
  externalEventId: string;
  /** null for provider events the platform does not act on. */
  type: CourierEventType | null;
  occurredAt: Date;
  trackingUrl: string | null;
  actualFeeCents: number | null;
  courier: { name: string | null; vehicle: string | null; dropoffEta: Date | null } | null;
  /** The drop-off photo URL and the PIN the courier entered, when the provider sends them. */
  proof: { photoUrl: string | null; pinEntered: string | null };
  payload: Record<string, unknown>;
}

export interface DeliveryProvider {
  readonly name: DeliveryProviderName;
  quote(req: DeliveryRequest): Promise<DeliveryQuote>;
  create(quoteId: string, req: DeliveryRequest): Promise<CreatedDelivery>;
  cancel(externalId: string): Promise<void>;
  handleWebhook(raw: string, headers: Headers): DeliveryWebhookEvent;
}

export class DeliveryProviderError extends Error {
  constructor(
    readonly provider: DeliveryProviderName,
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryProviderError";
  }
}
