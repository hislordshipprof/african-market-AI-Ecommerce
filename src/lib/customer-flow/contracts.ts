import type { CartItem, CartLine } from "@/lib/storefront/cart-store";

export const STORE_NOT_TAKING_ORDERS = "This store isn't taking orders right now";

export type SwapRule =
  | { kind: "exact" }
  | { kind: "suggest" }
  | { kind: "chosen"; item: CartItem };
export type Fulfillment = "pickup" | "store-delivery" | "courier" | "ship";
export type OrderStatus =
  | "AUTHORIZED"
  | "ACCEPTED"
  | "PICKING"
  | "SUBSTITUTION_PENDING"
  | "READY"
  | "AWAITING_PICKUP"
  | "COURIER_REQUESTED"
  | "COURIER_ASSIGNED"
  | "PICKED_UP"
  | "DELIVERED"
  | "COMPLETED"
  | "CANCELLED";
export interface FlowStore {
  id: string;
  slug: string;
  name: string;
  address: string;
  minimumOrderCents: number;
  pickupEnabled: boolean;
  storeDeliveryEnabled: boolean;
  deliveryRadiusMi: number;
  prepTimeMinutes: number;
  storeDeliveryFeeCents: number;
  autoRefundLimitCents: number;
  insulatedPackaging: boolean;
  /** A Pro store registered with a courier, with a pickup point (#527). Each order's eligibility comes with its quote. */
  courierOffered: boolean;
  /** The store ships parcels: it set handling days (#567). Each basket's eligibility comes with its quote. */
  shippingOffered?: boolean;
  /** Closed now, and an order placed now is queued for the next opening. */
  closed: boolean;
  /** "Wed 9:00 AM CT" while closed, else empty. */
  opensAt: string;
  /** Opening + prep, "9:30 AM" while closed, else empty. */
  readyAt: string;
  /** False when no opening is close enough to hold a card for: checkout refuses. */
  takingOrders: boolean;
}
export interface FlowCatalogItem extends CartItem {
  categoryId: string;
  /** Stored weight, for order weight and the courier limit. */
  weightG: number;
  /** Weight shoppers see a unit price for; absent when the stored weight is a placeholder (#752). */
  shownWeightG?: number;
  frozen: boolean;
  /** Prepared food (#570): exact item only; hot is handed over, never left at the door. */
  prepared?: "hot" | "cold" | null;
  /** Catering (#571): ordered this many hours ahead, at least this many. */
  catering?: { leadHours: number; minQty: number } | null;
  maxPerOrder: number;
  available: boolean;
}
export interface FlowAddress {
  id: string;
  label: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  distanceMi: number;
}
export interface Contact {
  name: string;
  phone: string;
  email: string;
}
export interface CheckoutInput {
  lines: readonly CartLine[];
  fulfillment: Fulfillment;
  contact: Contact;
  address?: FlowAddress;
  notes: string;
  leaveAtDoor: boolean;
  slot: string;
  promoCode: string;
  tipCents: number;
}
export type FlowErrorCode =
  | "payment-failed"
  | "out-of-stock"
  | "outside-radius"
  | "session-expired"
  | "minimum-order"
  | "max-quantity"
  | "ineligible"
  | "quote-changed"
  | "invalid-contact";
export interface FlowProblem {
  code: FlowErrorCode;
  message: string;
  lineKey?: string;
}
export interface CheckoutQuote {
  id: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  courierFeeCents: number;
  courierProvider?: "Uber Direct" | "DoorDash Drive";
  /** The cheapest parcel rate for a shipped order (#567), included in totalCents. */
  shipping?: { feeCents: number; carrier: string; service: string; days: number | null; handlingDays: number };
  /** Customer service fee (ADR-0021), included in totalCents. */
  serviceFeeCents: number;
  taxCents: number;
  tipCents: number;
  discountCents: number;
  /** The store coupon code on the cart (#557): what it took off goods, or why it gave nothing. */
  coupon?: { code: string; discountCents: number; message?: string };
  totalCents: number;
  bufferCents: number;
  holdCents: number;
  expiresAt: string;
  problems: FlowProblem[];
}
export interface PaymentAuthorization {
  id: string;
  amountCents: number;
}
export interface OrderEvent {
  status: OrderStatus;
  at: string;
  note?: string;
}
export interface Substitution {
  id: string;
  lineKey: string;
  original: CartLine;
  proposed: CartItem;
  deltaCents: number;
  expiresAt: string;
  decision?: "swap" | "refund";
  timedOut?: boolean;
}
export interface FlowOrder {
  id: string;
  token: string;
  number: string;
  storeId: string;
  storeName: string;
  createdAt: string;
  completedAt?: string;
  status: OrderStatus;
  lines: CartLine[];
  fulfillment: Fulfillment;
  contact: Contact;
  address?: FlowAddress;
  pickupAddress: string;
  notes: string;
  leaveAtDoor: boolean;
  slot: string;
  quote: CheckoutQuote;
  finalCents?: number;
  etaLabel: string;
  events: OrderEvent[];
  substitutions: Substitution[];
  courier?: { provider: string; name: string; etaLabel: string };
  proof?: { imageUrl: string; caption: string; pin?: string };
}
export interface CheckoutService {
  quote(input: CheckoutInput): Promise<CheckoutQuote>;
  place(
    input: CheckoutInput,
    quote: CheckoutQuote,
    authorization: PaymentAuthorization,
  ): Promise<FlowOrder>;
}
/** UI adapter seam for a future Stripe Payment Element. Accepts no card data. */
export interface PaymentForm {
  authorize(
    quote: CheckoutQuote,
    outcome?: "success" | "declined",
  ): Promise<PaymentAuthorization>;
}
export interface AddressLookup {
  search(query: string): Promise<FlowAddress[]>;
}
export interface OrderTracking {
  get(token: string): Promise<FlowOrder | null>;
  list(): Promise<FlowOrder[]>;
  advance(token: string, status?: OrderStatus): Promise<FlowOrder>;
}
export interface SubstitutionService {
  resolve(
    token: string,
    id: string,
    decision: "swap" | "refund",
  ): Promise<FlowOrder>;
}
export interface CustomerProfile extends Contact {
  id: string;
  addresses: FlowAddress[];
}
export interface AuthService {
  requestCode(
    channel: "sms" | "email",
    destination: string,
  ): Promise<{ challengeId: string; demoCode: string }>;
  verify(challengeId: string, code: string): Promise<CustomerProfile>;
  profile(): Promise<CustomerProfile | null>;
  saveProfile(profile: CustomerProfile): Promise<CustomerProfile>;
  signOut(): Promise<void>;
}
export type IssueType = "missing" | "wrong" | "damaged" | "quality" | "other";
export interface IssueInput {
  token: string;
  type: IssueType;
  lineKeys: string[];
  description: string;
  photo?: string;
}
export interface IssueResult {
  id: string;
  refundCents: number;
  needsReview: boolean;
}
export interface IssueService {
  submit(input: IssueInput): Promise<IssueResult>;
}
export interface FlowServices {
  checkout: CheckoutService;
  payment: PaymentForm;
  addresses: AddressLookup;
  tracking: OrderTracking;
  substitutions: SubstitutionService;
  auth: AuthService;
  issues: IssueService;
}
