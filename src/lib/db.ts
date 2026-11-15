import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { runtimeDatabaseUrl } from "./env";
import type { QueryRawFn } from "./health";
import { linkCodeMatches, MAX_LINK_CODE_ATTEMPTS } from "./whatsapp/code";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "./system-actor";
import { EARTH_RADIUS_MI } from "./address/geo";
import { VITEST_TRANSACTION_MAX_WAIT_MS } from "./test-prisma";
import { VALID_US_TIMEZONES } from "./admin/timezone";
import type { OrderSearchFilters } from "./admin/order-search";

/** One TTL for preview cleanup and the import-token claim. */
export const IMPORT_TOKEN_TTL_MS = 30 * 60 * 1000;

const sessionTimeZone = new AsyncLocalStorage<string>();
const ALLOWED_SESSION_ZONES = new Set(["UTC", "America/Denver", "Europe/Berlin"]);

/**
 * Run store-scoped transactions with a Postgres session time zone.
 * Production calls leave this unset. Tests use it to prove token expiry
 * does not depend on the database cluster's zone.
 */
export function withSessionTimeZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  if (!ALLOWED_SESSION_ZONES.has(zone)) {
    throw new Error(`Unsupported session time zone: ${zone}`);
  }
  return sessionTimeZone.run(zone, fn);
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

if (!globalForPrisma.prisma) {
  const connectionUrl = process.env.DATABASE_URL
    ? runtimeDatabaseUrl(process.env)
    : undefined;
  // Prisma's pg adapter sends timestamptz values without an offset, so the session zone decides
  // the stored instant. Pin it here, not in the URL: PgBouncer rejects `options` but tracks TimeZone.
  const pool = new Pool({ connectionString: connectionUrl });
  pool.on("connect", (client) => {
    client.query("SET TIME ZONE 'UTC'").catch((error: unknown) => {
      console.error(JSON.stringify({ event: "db_session_time_zone_failed", message: String(error) }));
    });
  });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  // Vitest-only. Production, next start and Vercel keep Prisma's default maxWait.
  const vitest = process.env.VITEST === "true";
  globalForPrisma.prisma = new PrismaClient(vitest ? { adapter, transactionOptions: { maxWait: VITEST_TRANSACTION_MAX_WAIT_MS } } : { adapter });
}

const prisma = globalForPrisma.prisma;

type TxRawMethods = "$queryRaw" | "$executeRaw";
type DelegateKey = {
  [K in keyof PrismaClient]: PrismaClient[K] extends { findMany: unknown } ? K : never;
}[keyof PrismaClient];

/** The listed delegates of a transaction client, plus the raw query methods bound to it. */
function txWithRaw<K extends DelegateKey>(
  tx: Prisma.TransactionClient,
  models: readonly K[],
): Pick<PrismaClient, K | TxRawMethods> {
  const picked: Record<string, unknown> = {};
  for (const model of models) picked[model] = tx[model];
  picked.$queryRaw = tx.$queryRaw.bind(tx);
  picked.$executeRaw = tx.$executeRaw.bind(tx);
  return picked as Pick<PrismaClient, K | TxRawMethods>;
}

function wrapPlatformDelegate<D extends object>(delegate: D): D {
  return new Proxy(delegate as Record<string, unknown>, {
    get(target, prop: string) {
      const val = target[prop];
      if (typeof val !== "function") return val;
      return (...args: unknown[]) => {
        const prismaPromise = (val as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        return prisma
          .$transaction([
            prisma.$executeRaw`SET LOCAL ROLE app_user`,
            prismaPromise as ReturnType<typeof prisma.$queryRaw>,
          ])
          .then(([, result]) => result);
      };
    },
  }) as unknown as D;
}

export const platform = {
  store: wrapPlatformDelegate(prisma.store),
  category: wrapPlatformDelegate(prisma.category),
  masterProduct: wrapPlatformDelegate(prisma.masterProduct),
  productSynonym: wrapPlatformDelegate(prisma.productSynonym),
  recipe: wrapPlatformDelegate(prisma.recipe),
  platformSettings: wrapPlatformDelegate(prisma.platformSettings),
  gazetteerZip: wrapPlatformDelegate(prisma.gazetteerZip),
  gazetteerPlace: wrapPlatformDelegate(prisma.gazetteerPlace),
};

function wrapDelegate<D extends object>(storeId: string, delegate: D): D {
  return new Proxy(delegate as Record<string, unknown>, {
    get(target, prop: string) {
      const val = target[prop];
      if (typeof val !== "function") return val;
      return (...args: unknown[]) => {
        const prismaPromise = (val as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        return prisma
          .$transaction([
            prisma.$executeRaw`SET LOCAL ROLE app_user`,
            prisma.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`,
            prismaPromise as ReturnType<typeof prisma.$queryRaw>,
          ])
          .then(([, , result]) => result);
      };
    },
  }) as unknown as D;
}

/** Store-scoped delegates, one per line in sorted order: adding a model is one line here. */
const STORE_SCOPED_MODELS = [
  "aiAction",
  "aiConversation",
  "aiReviewFlag",
  "assistantChatMonth",
  "assistantUndoReceipt",
  "auditLog",
  "cart",
  "cartLine",
  "copilotAlert",
  "copilotClientMessage",
  "copilotConversation",
  "customer",
  "delivery",
  "deliveryEvent",
  "driverRoute",
  "guestBrowserCart",
  "issueReport",
  "listing",
  "listingDraft",
  "listingImport",
  "listingVariant",
  "notificationLog",
  "order",
  "orderLine",
  "orderPushSubscription",
  "ownerReport",
  "ownerReportItem",
  "ownerWhatsAppLink",
  "pickBatch",
  "pushSubscription",
  "refundRequest",
  "reorderList",
  "reorderListItem",
  "rlsTestFixture",
  "stockEvent",
  "stockProposal",
  "storeBanner",
  "storeCollection",
  "storeCollectionListing",
  "storeCoupon",
  "storeInvite",
  "storeMembership",
  "storeSubscription",
  "substitutionRequest",
  "supportMessage",
  "supportThread",
  "whatsAppCheckoutLink",
  "whatsAppOptOut",
  "whatsAppShopperCart",
] as const;

export function storeScoped(storeId: string) {
  return Object.fromEntries(
    STORE_SCOPED_MODELS.map((model) => [model, wrapDelegate(storeId, prisma[model])]),
  ) as { [K in (typeof STORE_SCOPED_MODELS)[number]]: PrismaClient[K] };
}

export type StoreScopedClient = ReturnType<typeof storeScoped>;

function assertCustomerUserId(userId: string): string {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("A customer id is required");
  }
  return userId;
}

function wrapCustomerDelegate<D extends object>(userId: string, delegate: D): D {
  return new Proxy(delegate as Record<string, unknown>, {
    get(target, prop: string) {
      const val = target[prop];
      if (typeof val !== "function") return val;
      return (...args: unknown[]) => {
        const prismaPromise = (val as (...a: unknown[]) => unknown).apply(target, args);
        return prisma
          .$transaction([
            prisma.$executeRaw`SET LOCAL ROLE app_user`,
            prisma.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`,
            prismaPromise as ReturnType<typeof prisma.$queryRaw>,
          ])
          .then(([, , result]) => result);
      };
    },
  }) as unknown as D;
}

/** Customer-owned rows only. An empty id throws before any query. */
export function customerScoped(userId: string) {
  const id = assertCustomerUserId(userId);
  return {
    platformCustomerProfile: wrapCustomerDelegate(id, prisma.platformCustomerProfile),
    customerAddress: wrapCustomerDelegate(id, prisma.customerAddress),
    cardSaveConsent: wrapCustomerDelegate(id, prisma.cardSaveConsent),
  };
}

export type CustomerScopedClient = ReturnType<typeof customerScoped>;

const CUSTOMER_SCOPED_TX_MODELS = [
  "cardSaveConsent",
  "customerAddress",
  "platformCustomerProfile",
] as const;
type CustomerScopedTxModels = (typeof CUSTOMER_SCOPED_TX_MODELS)[number] | TxRawMethods;

export async function customerScopedTransaction<T>(
  userId: string,
  fn: (
    tx: Pick<PrismaClient, CustomerScopedTxModels>,
  ) => Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  const id = assertCustomerUserId(userId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.user_id', ${id}, true)`;
    return fn(txWithRaw(tx, CUSTOMER_SCOPED_TX_MODELS));
  }, { timeout: opts?.timeout ?? 8_000, maxWait: opts?.maxWait ?? 4_000 });
}

/** Serializes profile, address and Stripe-customer writes for one account. */
export async function lockCustomerAccount(
  tx: Pick<PrismaClient, "$executeRaw">,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('customer-account'), hashtext(${userId}))`;
}

/** Serializes copilot alert pushes for one store, so racing runs cannot spend the push cap. */
export async function lockCopilotPush(
  tx: Pick<PrismaClient, "$executeRaw">,
  storeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('copilot-push'), hashtext(${storeId}))`;
}

/** Advisory lock, insert-if-missing, then row lock. Caller is already inside customerScopedTransaction. */
export async function lockCustomerProfileRow(
  tx: Pick<PrismaClient, "$executeRaw" | "$queryRaw">,
  userId: string,
): Promise<void> {
  await lockCustomerAccount(tx, userId);
  await tx.$executeRaw`
    INSERT INTO platform_customer_profiles (user_id, updated_at)
    VALUES (${userId}, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id) DO NOTHING
  `;
  await tx.$queryRaw`SELECT user_id FROM platform_customer_profiles WHERE user_id = ${userId} FOR UPDATE`;
}

function wrapPlatformAdminDelegate<D extends object>(delegate: D): D {
  return new Proxy(delegate as Record<string, unknown>, {
    get(target, prop: string) {
      const val = target[prop];
      if (typeof val !== "function") return val;
      return (...args: unknown[]) => {
        const prismaPromise = (val as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        return prisma
          .$transaction([
            prisma.$executeRaw`SET LOCAL ROLE app_user`,
            prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
            prismaPromise as ReturnType<typeof prisma.$queryRaw>,
          ])
          .then(([, , result]) => result);
      };
    },
  }) as unknown as D;
}

export const platformAdmin = {
  store: wrapPlatformAdminDelegate(prisma.store),
  auditLog: wrapPlatformAdminDelegate(prisma.auditLog),
  storeMembership: wrapPlatformAdminDelegate(prisma.storeMembership),
  storeInvite: wrapPlatformAdminDelegate(prisma.storeInvite),
  masterProduct: wrapPlatformAdminDelegate(prisma.masterProduct),
  category: wrapPlatformAdminDelegate(prisma.category),
  productSynonym: wrapPlatformAdminDelegate(prisma.productSynonym),
  listingImport: wrapPlatformAdminDelegate(prisma.listingImport),
  attributeProposal: wrapPlatformAdminDelegate(prisma.attributeProposal),
  ingredient: wrapPlatformAdminDelegate(prisma.ingredient),
  storeSubscription: wrapPlatformAdminDelegate(prisma.storeSubscription),
  storeApplication: wrapPlatformAdminDelegate(prisma.storeApplication),
};

/** A transaction as app_user, with the test session time zone applied when one is set. */
export async function appUserQuery<T>(
  fn: (tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    const zone = sessionTimeZone.getStore();
    if (zone) {
      await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
    }
    return fn(tx);
  });
}

const PLATFORM_ADMIN_TX_MODELS = [
  "aiAction",
  "aiConversation",
  "aiReviewFlag",
  "attributeProposal",
  "auditLog",
  "category",
  "copilotConversation",
  "courierIncidentNote",
  "ingredient",
  "ingredientSynonym",
  "masterProduct",
  "masterProductIngredient",
  "order",
  "paymentDispute",
  "paymentDisputeEvent",
  "platformSettings",
  "productSynonym",
  "refundRequest",
  "stockProposal",
  "store",
  "storeApplication",
  "storeInvite",
  "storeMembership",
  "storeSubscription",
  "supportMessage",
  "supportThread",
] as const;
type PlatformAdminTxModels = (typeof PLATFORM_ADMIN_TX_MODELS)[number] | TxRawMethods;

export async function platformAdminTransaction<T>(
  fn: (tx: Pick<PrismaClient, PlatformAdminTxModels>) => Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    const zone = sessionTimeZone.getStore();
    if (zone) {
      await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
    }
    return fn(txWithRaw(tx, PLATFORM_ADMIN_TX_MODELS));
  }, opts);
}

export interface TransactionOptions {
  timeout?: number;
  maxWait?: number;
}

const STORE_SCOPED_TX_MODELS = [
  "aiAction",
  "aiConversation",
  "assistantUndoReceipt",
  "auditLog",
  "cart",
  "cartLine",
  "copilotAlert",
  "copilotClientMessage",
  "copilotConversation",
  "copilotDigest",
  "customer",
  "delivery",
  "deliveryEvent",
  "driverRoute",
  "guestBrowserCart",
  "ingredient",
  "ingredientSynonym",
  "issueReport",
  "listing",
  "listingAttributes",
  "listingDraft",
  "listingImport",
  "listingIngredient",
  "listingVariant",
  "notificationLog",
  "order",
  "orderLine",
  "orderPushSubscription",
  "ownerReport",
  "ownerReportItem",
  "paymentDispute",
  "paymentIntentRelease",
  "pickBatch",
  "platformSettings",
  "pushSubscription",
  "refundRequest",
  "reorderList",
  "reorderListItem",
  "stockEvent",
  "stockProposal",
  "storeCoupon",
  "storeSubscription",
  "substitutionRequest",
  "supportMessage",
  "supportThread",
  "whatsAppCheckoutLink",
  "whatsAppShopperCart",
] as const;
type StoreScopedTxModels = (typeof STORE_SCOPED_TX_MODELS)[number] | TxRawMethods;

export async function storeScopedTransaction<T>(
  storeId: string,
  fn: (tx: Pick<PrismaClient, StoreScopedTxModels>) => Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    const zone = sessionTimeZone.getStore();
    if (zone) {
      await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
    }
    return fn(txWithRaw(tx, STORE_SCOPED_TX_MODELS));
  }, { timeout: opts?.timeout, maxWait: opts?.maxWait });
}

/**
 * Explicit row-lock order. A transaction that takes more than one of these
 * locks takes them in this order:
 *
 *   store row → cart row → cart lines → listing rows (id order) → listing variants (id order)
 *
 * A platform-customer profile lock is taken in its own transaction and
 * released before this order starts. Checkout does not lock the profile
 * while it holds the cart.
 *
 * Upgrade rule: a transaction that will lock a row FOR UPDATE must lock it
 * before it inserts any row that references that row. A foreign-key insert
 * takes FOR KEY SHARE on the parent, and upgrading that key-share to
 * FOR UPDATE deadlocks when another transaction holds the same key-share
 * (two checkouts inserting a customer, then both locking the store).
 *
 * Every transaction that locks a listing row takes the store lock first.
 * The stock ledger holds the store and waits on listings, and a listing save
 * inserts audit and stock rows whose foreign key takes key-share on the store.
 * A save that held the listing without the store would wait on the ledger
 * while the ledger waits on it (40P01).
 *
 * This is the order of explicit competing locks, not every lock Postgres
 * takes. Order-line inserts take an implicit key-share on listing variants
 * after the listing locks. Those implicit locks are not upgraded to FOR UPDATE
 * in the same transaction, so they are not part of this order. Checkout does
 * not lock variants FOR UPDATE, and cart writes do not take a store lock just
 * to match this list.
 *
 * A background job that rewrites many listings holds no store lock, so it must
 * never wait: it locks with SKIP LOCKED and picks up a skipped row on its next run.
 *
 * Copilot confirm and the copilot turn commit take the store lock before any
 * proposal, audit or stock row. A proposal insert takes FOR KEY SHARE on its
 * listing and on the store. Confirm then locks the listing and claims the
 * proposal. The turn commit locks the conversation row only after the store.
 */
export async function lockConversationRow(tx: Pick<PrismaClient, "$queryRaw">, conversationId: string) {
  await tx.$queryRaw`SELECT id FROM ai_conversations WHERE id = ${conversationId} FOR UPDATE`;
}

export interface LockedStoreRow {
  storeDeliveryEnabled: boolean;
  storeDeliveryFeeCents: number;
  deliveryRadiusMi: number;
  lat: number | null;
  lng: number | null;
  hours: unknown;
  timezone: string;
  prepTimeMinutes: number;
  pickupEnabled: boolean;
  pickupSlotSettings: unknown;
  storeDeliverySlotSettings: unknown;
}

export interface GeocodeCacheRow {
  line1: string;
  city: string;
  state: string;
  zip: string;
  formattedAddress: string;
  lat: number;
  lng: number;
}

export async function readAddressGeocode(key: string, cutoff: Date): Promise<GeocodeCacheRow | null> {
  const rows = await prisma.$queryRaw<Array<{
    line1: string;
    city: string;
    state: string;
    zip: string;
    formatted_address: string;
    lat: number;
    lng: number;
  }>>`
    SELECT line1, city, state, zip, formatted_address, lat, lng
    FROM address_geocodes
    WHERE key = ${key} AND cached_at > ${cutoff}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    line1: row.line1,
    city: row.city,
    state: row.state,
    zip: row.zip,
    formattedAddress: row.formatted_address,
    lat: row.lat,
    lng: row.lng,
  };
}

export async function upsertAddressGeocode(
  key: string,
  match: GeocodeCacheRow,
  now: Date,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO address_geocodes (key, line1, city, state, zip, formatted_address, lat, lng, cached_at)
    VALUES (
      ${key},
      ${match.line1},
      ${match.city},
      ${match.state},
      ${match.zip},
      ${match.formattedAddress},
      ${match.lat},
      ${match.lng},
      ${now}
    )
    ON CONFLICT (key) DO UPDATE SET
      line1 = EXCLUDED.line1,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      zip = EXCLUDED.zip,
      formatted_address = EXCLUDED.formatted_address,
      lat = EXCLUDED.lat,
      lng = EXCLUDED.lng,
      cached_at = EXCLUDED.cached_at
  `;
}

export interface LockedStoreAddress {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export async function lockStoreAddress(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
): Promise<LockedStoreAddress | null> {
  const rows = await tx.$queryRaw<Array<{
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  }>>`
    SELECT address_line1, address_line2, city, state, zip
    FROM stores
    WHERE id = ${storeId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    zip: row.zip,
  };
}

/** Locks the one platform settings row, so a concurrent settings save waits for this one (#535). */
export async function lockPlatformSettingsRow(tx: Pick<PrismaClient, "$queryRaw">): Promise<void> {
  await tx.$queryRaw`SELECT id FROM platform_settings WHERE id = 'platform' FOR UPDATE`;
}

/** Locks the store and returns the delivery settings read under that lock. */
export async function lockStoreRow(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
): Promise<LockedStoreRow> {
  const rows = await tx.$queryRaw<Array<{
    store_delivery_enabled: boolean;
    store_delivery_fee_cents: number;
    delivery_radius_mi: unknown;
    lat: number | null;
    lng: number | null;
    hours: unknown;
    timezone: string;
    prep_time_minutes: number;
    pickup_enabled: boolean;
    pickup_slot_settings: unknown;
    store_delivery_slot_settings: unknown;
  }>>`
    SELECT store_delivery_enabled, store_delivery_fee_cents, delivery_radius_mi, lat, lng,
      hours, timezone, prep_time_minutes, pickup_enabled, pickup_slot_settings, store_delivery_slot_settings
    FROM stores
    WHERE id = ${storeId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error("Store not found");
  return {
    storeDeliveryEnabled: row.store_delivery_enabled,
    storeDeliveryFeeCents: row.store_delivery_fee_cents,
    deliveryRadiusMi: Number(row.delivery_radius_mi),
    lat: row.lat,
    lng: row.lng,
    hours: row.hours,
    timezone: row.timezone,
    prepTimeMinutes: row.prep_time_minutes,
    pickupEnabled: row.pickup_enabled,
    pickupSlotSettings: row.pickup_slot_settings,
    storeDeliverySlotSettings: row.store_delivery_slot_settings,
  };
}

/** Tagged SQL on an open transaction. Callers outside this file cannot call $queryRaw. */
export function txQuery<T>(tx: Pick<PrismaClient, "$queryRaw">, query: Prisma.Sql): Promise<T> {
  return tx.$queryRaw<T>(query);
}

export function txExecute(tx: Pick<PrismaClient, "$executeRaw">, query: Prisma.Sql): Promise<number> {
  return tx.$executeRaw(query);
}

/** The store's hours and zone, read inside the caller's transaction (after lockStoreRow, so they cannot change under it). */
export async function readStoreHours(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
): Promise<{ hours: unknown; timezone: string } | null> {
  const rows = await tx.$queryRaw<Array<{ hours: unknown; timezone: string }>>`
    SELECT hours, timezone FROM stores WHERE id = ${storeId}`;
  return rows[0] ?? null;
}

/** Sees an order in any store. The caller is inside a store-scoped transaction and must not insert while this is on. */
export async function orderExistsForPaymentIntent(
  tx: Pick<PrismaClient, "order" | "$executeRaw">,
  paymentIntentId: string,
): Promise<boolean> {
  await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
  const existing = await tx.order.findUnique({
    where: { paymentIntentId },
    select: { id: true },
  });
  await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'false', true)`;
  return Boolean(existing);
}

export async function getNextOrderNumber(tx: Pick<PrismaClient, "$queryRaw">, storeId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ max_num: number | null }>>`
    SELECT MAX(number) AS max_num FROM orders WHERE store_id = ${storeId}
  `;
  return (rows[0]?.max_num ?? 0) + 1;
}

export async function lockListingRow(tx: Pick<PrismaClient, "$queryRaw">, listingId: string) {
  await tx.$queryRaw`SELECT 1 FROM listings WHERE id = ${listingId} FOR UPDATE`;
}

export interface LockedListingStock {
  id: string;
  stockMode: string;
  qty: number | null;
}

/** Locks listing rows in id order and returns the stock read under that lock. */
export async function lockListingRows(
  tx: Pick<PrismaClient, "$queryRaw">,
  listingIds: string[],
): Promise<LockedListingStock[]> {
  if (listingIds.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string; stock_mode: string; qty: number | null }>>`
    SELECT id, stock_mode, qty FROM listings
    WHERE id IN (${Prisma.join(listingIds)})
    ORDER BY id
    FOR UPDATE
  `;
  return rows.map((row) => ({ id: row.id, stockMode: row.stock_mode, qty: row.qty }));
}

/** Writes quantities the ledger computed under `lockListingRows`, in one statement. */
export async function writeListingQuantities(
  tx: Pick<PrismaClient, "$executeRaw">,
  rows: Array<{ id: string; qty: number }>,
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.$executeRaw`
    UPDATE listings AS l
    SET qty = v.qty, updated_at = ${now}
    FROM (VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(${row.id}::text, ${row.qty}::int)`))}) AS v(id, qty)
    WHERE l.id = v.id
  `;
}

export interface StockEventRollup {
  listingId: string;
  type: string;
  /** Sum of deltas since `windowStart`. */
  delta: number;
  /** Newest event of this type, at any age. */
  createdAt: Date;
}

/** One row per listing and type for a store, so the daily job needs no per-listing query. */
export async function readStockEventRollups(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
  types: string[],
  windowStart: Date,
): Promise<StockEventRollup[]> {
  const rows = await tx.$queryRaw<Array<{ listing_id: string; type: string; delta: number; created_at: Date }>>`
    SELECT
      listing_id,
      type,
      COALESCE(SUM(delta) FILTER (WHERE created_at >= ${windowStart}), 0)::int AS delta,
      MAX(created_at) AS created_at
    FROM stock_events
    WHERE store_id = ${storeId} AND type = ANY(${types}::text[])
    GROUP BY listing_id, type
  `;
  return rows.map((row) => ({
    listingId: row.listing_id,
    type: row.type,
    delta: row.delta,
    createdAt: new Date(row.created_at),
  }));
}

/**
 * Locks first and never waits, so the job cannot deadlock with an order holding a listing.
 * A skipped row is picked up on the next daily run. Comparing to the value read keeps an
 * owner's fresh 1.0 without comparing two servers' clocks. The cast drops the ISO string's
 * zone, as the column has none.
 */
export async function writeConfidenceScores(
  tx: Pick<PrismaClient, "$executeRaw">,
  rows: Array<{ id: string; confidence: number; readAt: string }>,
  now: Date,
): Promise<void> {
  const ids = rows.map((row) => row.id);
  const scores = rows.map((row) => row.confidence);
  const readAts = rows.map((row) => row.readAt);
  await tx.$executeRaw`
    WITH scored AS (
      SELECT * FROM unnest(${ids}::text[], ${scores}::float8[], ${readAts}::text[])
        AS input(id, confidence, read_at)
    ), locked AS (
      SELECT l.id, scored.confidence
      FROM listings l
      JOIN scored ON scored.id = l.id
      WHERE l.confidence_updated_at = scored.read_at::timestamp(3)
      ORDER BY l.id
      FOR NO KEY UPDATE OF l SKIP LOCKED
    )
    UPDATE listings l
    SET confidence = locked.confidence, confidence_updated_at = ${now}
    FROM locked
    WHERE l.id = locked.id
  `;
}

/** One page of store ids in id order, for jobs that visit every store. `stores_read` is open to every role. */
export async function findStoreIdsAfter(cursor: string | null, take: number): Promise<string[]> {
  const rows = await platform.store.findMany({
    ...(cursor ? { where: { id: { gt: cursor } } } : {}),
    orderBy: { id: "asc" },
    select: { id: true },
    take,
  });
  return rows.map((row) => row.id);
}

/** Locks variant rows in id order before a removal check, so a concurrent cart insert waits. */
export async function lockListingVariantRows(tx: Pick<PrismaClient, "$queryRaw">, variantIds: string[]) {
  if (variantIds.length === 0) return;
  await tx.$queryRaw`
    SELECT id FROM listing_variants
    WHERE id IN (${Prisma.join(variantIds)})
    ORDER BY id
    FOR UPDATE
  `;
}

export async function findOrphanedAuthorizedOrders(opts?: {
  storeIds?: readonly string[];
}): Promise<Array<{ id: string; storeId: string }>> {
  if (opts?.storeIds && opts.storeIds.length === 0) return [];
  const cutoff = new Date(Date.now() - 60_000);
  const inStores = opts?.storeIds ? Prisma.sql`AND store_id IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; store_id: string }>>`
      SELECT id, store_id FROM orders
      WHERE status = 'AUTHORIZED'
        AND inngest_event_sent_at IS NULL
        AND created_at < ${cutoff}
        ${inStores}
      ORDER BY created_at ASC
      LIMIT 50
    `;
    return rows.map((r) => ({ id: r.id, storeId: r.store_id }));
  });
}

/**
 * ACCEPTED/PICKING orders that may be past the pick timeout: accepted before
 * `acceptedBefore` or created before `createdBefore`. The caller applies the
 * pickup slot, which is free text.
 */
export async function findPickTimeoutCandidates(opts: {
  acceptedBefore: Date;
  createdBefore: Date;
  limit: number;
  storeIds?: readonly string[];
}): Promise<Array<{ id: string; storeId: string; createdAt: Date; acceptedAt: Date; pickupSlot: string | null }>> {
  if (opts.storeIds && opts.storeIds.length === 0) return [];
  const inStores = opts.storeIds ? Prisma.sql`AND store_id IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; store_id: string; created_at: Date; accepted_at: Date; pickup_slot: string | null }>>`
      SELECT id, store_id, created_at, accepted_at, pickup_slot FROM orders
      WHERE status IN ('ACCEPTED', 'PICKING')
        AND accepted_at IS NOT NULL
        AND (accepted_at < ${opts.acceptedBefore} OR created_at < ${opts.createdBefore})
        ${inStores}
      ORDER BY (pickup_slot IS NULL OR created_at < ${opts.createdBefore}) DESC, created_at ASC
      LIMIT ${opts.limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      storeId: r.store_id,
      createdAt: r.created_at,
      acceptedAt: r.accepted_at,
      pickupSlot: r.pickup_slot,
    }));
  });
}

/** An unused card hold is released this long after authorization (owner decision, #422). */
export const ORPHAN_HOLD_GRACE_MS = 60 * 60_000;

/**
 * Carts holding a PaymentIntent with no order and no release tombstone, not
 * written within the grace (a hold cannot be older than that and still unused
 * for longer). Never-checked carts first, then least recently checked, oldest
 * first, so carts that never paid cannot starve a real hold.
 */
export async function findOrphanHoldCarts(opts?: {
  storeIds?: readonly string[];
}): Promise<Array<{ storeId: string; cartId: string; paymentIntentId: string; updatedAt: Date }>> {
  if (opts?.storeIds && opts.storeIds.length === 0) return [];
  const before = new Date(Date.now() - ORPHAN_HOLD_GRACE_MS);
  const inStores = opts?.storeIds ? Prisma.sql`AND c.store_id IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; store_id: string; payment_intent_id: string; updated_at: Date }>>`
      SELECT c.id, c.store_id, c.payment_intent_id, c.updated_at FROM carts c
      WHERE c.payment_intent_id IS NOT NULL
        AND c.updated_at < ${before}
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.payment_intent_id = c.payment_intent_id)
        AND NOT EXISTS (SELECT 1 FROM payment_intent_releases r WHERE r.payment_intent_id = c.payment_intent_id)
        ${inStores}
      ORDER BY c.orphan_checked_at ASC NULLS FIRST, c.updated_at ASC
      LIMIT 50
    `;
    return rows.map((r) => ({
      storeId: r.store_id,
      cartId: r.id,
      paymentIntentId: r.payment_intent_id,
      updatedAt: r.updated_at,
    }));
  });
}

/** Moves a checked cart to the back of the orphan-hold sweep. Raw SQL so `updated_at` is kept. */
export async function markOrphanHoldChecked(storeId: string, cartId: string, paymentIntentId: string): Promise<void> {
  await storeScopedTransaction(storeId, (tx) => tx.$executeRaw`
    UPDATE carts SET orphan_checked_at = now()
    WHERE id = ${cartId} AND store_id = ${storeId} AND payment_intent_id = ${paymentIntentId}
  `);
}

const NOTIFICATION_RESEND_MS = 5 * 60_000;
/** A notification not yet sent to the provider is stale after 2 hours. */
export const NOTIFICATION_EXPIRE_MS = 2 * 60 * 60_000;
/** A `sending` row replays its key until the providers' 24-hour idempotency window closes. */
export const NOTIFICATION_REPLAY_MS = 24 * 60 * 60_000;

/** Substitution prompts past their 10 minutes whose order still waits: the timer's backstop (#13). */
export async function findExpiredSubstitutionRequests(limit: number): Promise<Array<{ id: string; storeId: string }>> {
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; store_id: string }>>`
      SELECT sr.id, sr.store_id FROM substitution_requests sr
      JOIN orders o ON o.id = sr.order_id
      WHERE sr.status = 'pending' AND sr.expires_at <= now() AND o.status = 'SUBSTITUTION_PENDING'
      ORDER BY sr.expires_at ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ id: row.id, storeId: row.store_id }));
  });
}

export async function findPendingOrderNotifications(opts?: {
  storeIds?: readonly string[];
}): Promise<Array<{ storeId: string; orderId: string; event: string }>> {
  if (opts?.storeIds && opts.storeIds.length === 0) return [];
  const newest = new Date(Date.now() - NOTIFICATION_RESEND_MS);
  const oldest = new Date(Date.now() - NOTIFICATION_EXPIRE_MS);
  const inStores = opts?.storeIds ? Prisma.sql`AND store_id IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ store_id: string; order_id: string; event: string }>>`
      SELECT store_id, order_id, event FROM (
        SELECT store_id, order_id, event, MIN(created_at) AS first_at
        FROM notification_logs
        WHERE status IN ('pending', 'sending')
          AND created_at <= ${newest}
          AND created_at > ${oldest}
          ${inStores}
        GROUP BY store_id, order_id, event
      ) pending
      ORDER BY first_at ASC
      LIMIT 50
    `;
    return rows.map((row) => ({ storeId: row.store_id, orderId: row.order_id, event: row.event }));
  });
}

export async function expireStaleOrderNotifications(opts?: {
  storeIds?: readonly string[];
}): Promise<number> {
  if (opts?.storeIds && opts.storeIds.length === 0) return 0;
  const cutoff = new Date(Date.now() - NOTIFICATION_EXPIRE_MS);
  const replayCutoff = new Date(Date.now() - NOTIFICATION_REPLAY_MS);
  const inStores = opts?.storeIds ? Prisma.sql`AND store_id IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  return platformAdminTransaction(async (tx) => {
    const count = await tx.$executeRaw`
      UPDATE notification_logs
      SET status = 'failed', reason = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE ((status = 'pending' AND created_at <= ${cutoff})
          OR (status = 'sending' AND created_at <= ${replayCutoff}))
        ${inStores}
    `;
    return typeof count === "number" ? count : 0;
  });
}

export async function findOrderByPaymentIntent(
  paymentIntentId: string,
): Promise<{ id: string; storeId: string; status: string; refundId: string | null } | null> {
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      store_id: string;
      status: string;
      refund_id: string | null;
    }>>`
      SELECT id, store_id, status, refund_id
      FROM orders
      WHERE payment_intent_id = ${paymentIntentId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, storeId: row.store_id, status: row.status, refundId: row.refund_id };
  });
}

/** The courier delivery a provider webhook names, across stores (the webhook carries no store). */
export async function findDeliveryByExternalId(
  provider: string,
  externalId: string,
): Promise<{ id: string; storeId: string; orderId: string } | null> {
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; store_id: string; order_id: string }>>`
      SELECT id, store_id, order_id
      FROM deliveries
      WHERE provider = ${provider} AND external_id = ${externalId}
      LIMIT 1
    `;
    const row = rows[0];
    return row ? { id: row.id, storeId: row.store_id, orderId: row.order_id } : null;
  });
}

export async function findStuckTransitionalOrders(opts?: {
  storeIds?: readonly string[];
}): Promise<Array<{ id: string; storeId: string }>> {
  if (opts?.storeIds && opts.storeIds.length === 0) return [];
  const cutoff = new Date(Date.now() - 5 * 60_000);
  const storeIds = opts?.storeIds;
  return platformAdminTransaction(async (tx) => {
    const rows = storeIds
      ? await tx.$queryRaw<Array<{ id: string; store_id: string }>>`
          SELECT id, store_id FROM (
            SELECT id, store_id, updated_at FROM orders
            WHERE ((
                status IN ('CAPTURING', 'CANCELLING')
                AND updated_at < ${cutoff}
              )
              OR id IN (
                SELECT order_id FROM refund_requests
                WHERE state IN ('RESERVED', 'UNKNOWN', 'REPLAYING')
                  OR (
                    state = 'CREATED'
                    AND (provider_status IS NULL OR provider_status IN ('pending', 'requires_action'))
                  )
                  OR (provider_status = 'succeeded' AND (service_fee_share_cents > 0 OR platform_tax_share_cents > 0) AND fee_refund_id IS NULL)
              ))
              AND store_id IN (${Prisma.join(storeIds)})
            ORDER BY updated_at ASC
            LIMIT 50
          ) AS in_flight
          UNION
          SELECT id, store_id FROM (
            SELECT id, store_id, updated_at FROM orders
            WHERE (status = 'REFUND_FAILED'
              OR id IN (
                SELECT order_id FROM refund_requests WHERE state = 'ABANDONED'
              ))
              AND store_id IN (${Prisma.join(storeIds)})
            ORDER BY updated_at ASC
            LIMIT 50
          ) AS refund_recovery
        `
      : await tx.$queryRaw<Array<{ id: string; store_id: string }>>`
          SELECT id, store_id FROM (
            SELECT id, store_id, updated_at FROM orders
            WHERE (
                status IN ('CAPTURING', 'CANCELLING')
                AND updated_at < ${cutoff}
              )
              OR id IN (
                SELECT order_id FROM refund_requests
                WHERE state IN ('RESERVED', 'UNKNOWN', 'REPLAYING')
                  OR (
                    state = 'CREATED'
                    AND (provider_status IS NULL OR provider_status IN ('pending', 'requires_action'))
                  )
                  OR (provider_status = 'succeeded' AND (service_fee_share_cents > 0 OR platform_tax_share_cents > 0) AND fee_refund_id IS NULL)
              )
            ORDER BY updated_at ASC
            LIMIT 50
          ) AS in_flight
          UNION
          SELECT id, store_id FROM (
            SELECT id, store_id, updated_at FROM orders
            WHERE status = 'REFUND_FAILED'
              OR id IN (
                SELECT order_id FROM refund_requests WHERE state = 'ABANDONED'
              )
            ORDER BY updated_at ASC
            LIMIT 50
          ) AS refund_recovery
        `;
    return rows.map((r) => ({ id: r.id, storeId: r.store_id }));
  });
}

export interface OrderRecoveryCandidate {
  id: string;
  storeName: string;
  number: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  acceptanceClockStartsAt: Date | null;
  inngestEventSentAt: Date | null;
  acceptedAt: Date | null;
  prepEstimateMinutes: number | null;
  pickupSlot: string | null;
  readyAt: Date | null;
  outForDeliveryAt: Date | null;
  /** First capture_retry/cancel_retry audit row, for CAPTURING/CANCELLING only. */
  firstRetryAt: Date | null;
  hours: unknown;
  timezone: string;
}

/** AUTHORIZED; accepted but not charged (ACCEPTED to CANCELLING); charged (READY onwards). */
export type OrderRecoveryGroup = "authorized" | "uncaptured" | "captured";

/**
 * Candidates for the admin "Orders to check" list, bounded in SQL; the caller applies the
 * per-state limits. Each group has its own cap, so old captured orders cannot crowd out
 * uncaptured ones; `capped` says which groups had more rows than the cap. Within a group, rows SQL
 * already knows are stuck or due sort first, so orders not yet due (a later pickup slot, a store
 * still closed) cannot fill it. A pickup slot is free text, so it is compared as text, not cast:
 * checkout writes `toISOString()`.
 */
export async function findOrderRecoveryCandidates(opts: {
  authorizedBefore: Date;
  holdBefore: Date;
  retryBefore: Date;
  pickingDueBy: Date;
  pickingGraceMinutes: number;
  readyBefore: Date;
  awaitingPickupBefore: Date;
  outForDeliveryBefore: Date;
  limit: number;
  storeIds?: readonly string[];
}): Promise<{ candidates: OrderRecoveryCandidate[]; capped: Record<OrderRecoveryGroup, boolean> }> {
  if (opts.storeIds && opts.storeIds.length === 0) {
    return { candidates: [], capped: { authorized: false, uncaptured: false, captured: false } };
  }
  const inStores = opts.storeIds ? Prisma.sql`AND o.store_id IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  const columns = Prisma.sql`
    o.id, s.name AS store_name, o.number, o.status, o.created_at, o.updated_at,
    o.acceptance_clock_starts_at, o.inngest_event_sent_at, o.accepted_at, o.prep_estimate_minutes,
    o.pickup_slot, o.ready_at, o.out_for_delivery_at, s.hours, s.timezone,
    CASE WHEN o.status IN ('CAPTURING', 'CANCELLING') THEN (
      SELECT MIN(a.created_at) FROM audit_logs a
      WHERE a.entity_type = 'order' AND a.entity_id = o.id
        AND a.action = CASE o.status WHEN 'CAPTURING' THEN 'capture_retry' ELSE 'cancel_retry' END
    ) END AS first_retry_at`;
  type Row = {
    id: string;
    store_name: string;
    number: number;
    status: string;
    created_at: Date;
    updated_at: Date;
    acceptance_clock_starts_at: Date | null;
    inngest_event_sent_at: Date | null;
    accepted_at: Date | null;
    prep_estimate_minutes: number | null;
    pickup_slot: string | null;
    ready_at: Date | null;
    out_for_delivery_at: Date | null;
    first_retry_at: Date | null;
    hours: unknown;
    timezone: string;
  };
  // One row past the cap tells a full group from a capped one.
  const fetchLimit = opts.limit + 1;
  const rows = await platformAdminTransaction(async (tx) => {
    const authorized = await tx.$queryRaw<Row[]>`
      SELECT ${columns}
      FROM orders o JOIN stores s ON s.id = o.store_id
      WHERE o.status = 'AUTHORIZED' AND o.created_at < ${opts.authorizedBefore} ${inStores}
      ORDER BY (o.inngest_event_sent_at IS NULL OR o.created_at < ${opts.holdBefore}) DESC,
        COALESCE(o.acceptance_clock_starts_at, o.created_at) ASC
      LIMIT ${fetchLimit}
    `;
    const uncaptured = await tx.$queryRaw<Row[]>`
      SELECT * FROM (
        SELECT ${columns}
        FROM orders o JOIN stores s ON s.id = o.store_id
        WHERE o.status IN ('ACCEPTED', 'PICKING', 'CAPTURING', 'CANCELLING')
          ${inStores}
          AND (
            o.created_at < ${opts.holdBefore}
            OR (o.status IN ('ACCEPTED', 'PICKING')
              AND o.accepted_at + make_interval(mins => COALESCE(o.prep_estimate_minutes, 0) + ${opts.pickingGraceMinutes}) < ${opts.pickingDueBy})
            OR o.status IN ('CAPTURING', 'CANCELLING')
          )
      ) candidates
      WHERE status NOT IN ('CAPTURING', 'CANCELLING')
        OR COALESCE(first_retry_at, updated_at) < ${opts.retryBefore}
        OR created_at < ${opts.holdBefore}
      ORDER BY (status IN ('CAPTURING', 'CANCELLING') OR created_at < ${opts.holdBefore}
          OR pickup_slot IS NULL OR pickup_slot < ${opts.pickingDueBy.toISOString()}) DESC, created_at ASC
      LIMIT ${fetchLimit}
    `;
    const captured = await tx.$queryRaw<Row[]>`
      SELECT ${columns}
      FROM orders o JOIN stores s ON s.id = o.store_id
      WHERE o.status IN ('READY', 'AWAITING_PICKUP', 'OUT_FOR_DELIVERY')
        ${inStores}
        AND (
          (o.status = 'READY' AND o.ready_at < ${opts.readyBefore})
          OR (o.status = 'AWAITING_PICKUP' AND o.ready_at < ${opts.awaitingPickupBefore})
          OR (o.status = 'OUT_FOR_DELIVERY' AND o.out_for_delivery_at < ${opts.outForDeliveryBefore})
        )
      ORDER BY o.created_at ASC
      LIMIT ${fetchLimit}
    `;
    return { authorized, uncaptured, captured };
  });
  const toCandidate = (r: Row): OrderRecoveryCandidate => ({
    id: r.id,
    storeName: r.store_name,
    number: r.number,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    acceptanceClockStartsAt: r.acceptance_clock_starts_at,
    inngestEventSentAt: r.inngest_event_sent_at,
    acceptedAt: r.accepted_at,
    prepEstimateMinutes: r.prep_estimate_minutes,
    pickupSlot: r.pickup_slot,
    readyAt: r.ready_at,
    outForDeliveryAt: r.out_for_delivery_at,
    firstRetryAt: r.first_retry_at,
    hours: r.hours,
    timezone: r.timezone,
  });
  const groups = [rows.authorized, rows.uncaptured, rows.captured];
  return {
    candidates: groups.flatMap((group) => group.slice(0, opts.limit)).map(toCandidate),
    capped: {
      authorized: rows.authorized.length > opts.limit,
      uncaptured: rows.uncaptured.length > opts.limit,
      captured: rows.captured.length > opts.limit,
    },
  };
}

/**
 * The newest audit row per order and action, newest first. Rows older than `since` stay while
 * their order is not in `finalStatuses`. `capped` says more rows than `limit` exist.
 */
export async function findOrderAlertRows(opts: {
  actions: readonly string[];
  since: Date;
  finalStatuses: readonly string[];
  limit: number;
  storeIds?: readonly string[];
}): Promise<{
  alerts: Array<{ orderId: string; action: string; createdAt: Date; orderNumber: number; orderStatus: string; storeName: string }>;
  capped: boolean;
}> {
  if (opts.storeIds && opts.storeIds.length === 0) return { alerts: [], capped: false };
  const inStores = opts.storeIds ? Prisma.sql`AND a.store_id IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  const rows = await platformAdminTransaction((tx) => tx.$queryRaw<Array<{
    entity_id: string;
    action: string;
    created_at: Date;
    number: number;
    status: string;
    store_name: string;
  }>>`
    SELECT * FROM (
      SELECT DISTINCT ON (a.entity_id, a.action)
        a.entity_id, a.action, a.created_at, o.number, o.status, s.name AS store_name
      FROM audit_logs a
      JOIN orders o ON o.id = a.entity_id AND o.store_id = a.store_id
      JOIN stores s ON s.id = o.store_id
      WHERE a.entity_type = 'order'
        AND a.action IN (${Prisma.join(opts.actions)})
        AND (a.created_at >= ${opts.since} OR o.status NOT IN (${Prisma.join(opts.finalStatuses)}))
        ${inStores}
      ORDER BY a.entity_id, a.action, a.created_at DESC
    ) latest
    ORDER BY created_at DESC
    LIMIT ${opts.limit + 1}
  `);
  return {
    alerts: rows.slice(0, opts.limit).map((r) => ({
      orderId: r.entity_id,
      action: r.action,
      createdAt: r.created_at,
      orderNumber: r.number,
      orderStatus: r.status,
      storeName: r.store_name,
    })),
    capped: rows.length > opts.limit,
  };
}

/** Unknown zones in `stores.timezone` (free text) read as New York, as `formatInZone` does, instead of failing the query. */
const STORE_ZONE = Prisma.sql`(CASE WHEN s.timezone IN (${Prisma.join(VALID_US_TIMEZONES)}) THEN s.timezone ELSE 'America/New_York' END)`;

/** Local midnight of `day` in the order's store zone, as a UTC timestamp like `orders.created_at`. */
const storeMidnight = (day: Prisma.Sql) => Prisma.sql`((${day})::timestamp AT TIME ZONE ${STORE_ZONE}) AT TIME ZONE 'UTC'`;

/** The admin order search (#537): exact filters, store-day dates, newest first on (created_at, id). */
export function orderSearchSql(filters: OrderSearchFilters, limit: number): Prisma.Sql {
  const where: Prisma.Sql[] = [];
  if (filters.storeId) where.push(Prisma.sql`o.store_id = ${filters.storeId}`);
  if (filters.number !== null) where.push(Prisma.sql`o.number = ${filters.number}`);
  if (filters.email) where.push(Prisma.sql`o.customer_id IN (SELECT c.id FROM customers c WHERE c.email = ${filters.email})`);
  if (filters.phone) where.push(Prisma.sql`o.customer_id IN (SELECT c.id FROM customers c WHERE c.phone = ${filters.phone})`);
  if (filters.status) where.push(Prisma.sql`o.status = ${filters.status}`);
  if (filters.fulfillment) where.push(Prisma.sql`o.fulfillment = ${filters.fulfillment}`);
  if (filters.from) {
    const from = Prisma.sql`${filters.from}::date`;
    where.push(Prisma.sql`o.created_at >= (${from} - 1)::timestamp`);
    where.push(Prisma.sql`o.created_at >= ${storeMidnight(from)}`);
  }
  if (filters.to) {
    const next = Prisma.sql`${filters.to}::date + 1`;
    where.push(Prisma.sql`o.created_at < (${next} + 1)::timestamp`);
    where.push(Prisma.sql`o.created_at < ${storeMidnight(next)}`);
  }
  if (filters.cursor) {
    const at = Prisma.sql`(${filters.cursor.createdAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    where.push(Prisma.sql`(o.created_at, o.id) < (${at}, ${filters.cursor.id})`);
  }
  return Prisma.sql`
    SELECT o.id, o.number, o.status, o.fulfillment, o.total_authorized_cents, o.capture_cents, o.created_at,
           s.name AS store_name, s.timezone AS store_timezone
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    WHERE ${where.length > 0 ? Prisma.join(where, " AND ") : Prisma.sql`TRUE`}
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${limit}
  `;
}

export async function findOrderSearchRows(filters: OrderSearchFilters, limit: number) {
  return platformAdminTransaction((tx) => tx.$queryRaw<Array<{
    id: string;
    number: number;
    status: string;
    fulfillment: string;
    total_authorized_cents: number;
    capture_cents: number | null;
    created_at: Date;
    store_name: string;
    store_timezone: string;
  }>>(orderSearchSql(filters, limit)));
}

/** Stores with a listing on this master product, active or not: the storefronts its edits reach. */
export async function storesListingMasterProduct(tx: Pick<PrismaClient, "$queryRaw">, productId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ store_id: string }>>`
    SELECT DISTINCT store_id FROM listings WHERE master_product_id = ${productId}`;
  return rows.map((row) => row.store_id);
}

/** Stores with a listing, active or not, on a master product in any of these categories. */
export async function storesListingCategories(tx: Pick<PrismaClient, "$queryRaw">, categoryIds: string[]): Promise<string[]> {
  if (categoryIds.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ store_id: string }>>`
    SELECT DISTINCT l.store_id FROM listings l
    JOIN master_products mp ON mp.id = l.master_product_id
    WHERE mp.category_id = ANY(${categoryIds}::text[])`;
  return rows.map((row) => row.store_id);
}

/** Row-lock categories in id order for the rest of the transaction; callers re-read them afterwards. */
export async function lockCategoryRows(tx: Pick<PrismaClient, "$queryRaw">, categoryIds: string[]) {
  await tx.$queryRaw`SELECT 1 FROM categories WHERE id = ANY(${categoryIds}::text[]) ORDER BY id FOR UPDATE`;
}

/**
 * Other master products a synonym term already names, through a synonym or their own name.
 * Terms compare whole, case- and accent-folded, as the search's exact match does; never as a pattern.
 */
export async function productsNamedByTerm(
  tx: Pick<PrismaClient, "$queryRaw">,
  term: string,
  exceptProductId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ name: string }>>`
    SELECT DISTINCT mp.name FROM master_products mp
    WHERE mp.id <> ${exceptProductId}
      AND (lower(unaccent(mp.name)) = lower(unaccent(${term}))
        OR EXISTS (SELECT 1 FROM product_synonyms ps WHERE ps.product_id = mp.id AND lower(unaccent(ps.term)) = lower(unaccent(${term}))))
    ORDER BY mp.name`;
  return rows.map((row) => row.name);
}

/** The product's synonyms with the same folded term, other than `exceptSynonymId`. */
export async function sameProductSynonymIds(
  tx: Pick<PrismaClient, "$queryRaw">,
  productId: string,
  term: string,
  exceptSynonymId: string | null,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM product_synonyms
    WHERE product_id = ${productId} AND id IS DISTINCT FROM ${exceptSynonymId}
      AND lower(unaccent(term)) = lower(unaccent(${term}))`;
  return rows.map((row) => row.id);
}

/** A product's synonyms, each with the other master products its term also names. */
export async function productSynonymsWithSharedNames(
  tx: Pick<PrismaClient, "$queryRaw">,
  productId: string,
): Promise<Array<{ id: string; term: string; language: string | null; region: string | null; alsoNames: string[] }>> {
  const rows = await tx.$queryRaw<Array<{ id: string; term: string; language: string | null; region: string | null; also_names: string[] }>>`
    SELECT ps.id, ps.term, ps.language, ps.region,
      COALESCE((
        SELECT array_agg(DISTINCT mp.name ORDER BY mp.name) FROM master_products mp
        WHERE mp.id <> ps.product_id
          AND (lower(unaccent(mp.name)) = lower(unaccent(ps.term))
            OR EXISTS (SELECT 1 FROM product_synonyms o WHERE o.product_id = mp.id AND lower(unaccent(o.term)) = lower(unaccent(ps.term))))
      ), ARRAY[]::text[]) AS also_names
    FROM product_synonyms ps
    WHERE ps.product_id = ${productId}
    ORDER BY lower(ps.term), ps.id`;
  return rows.map(({ also_names, ...row }) => ({ ...row, alsoNames: also_names }));
}

/** Row-lock a master product for the rest of the transaction; callers re-read it afterwards. */
export async function lockMasterProductRow(tx: Pick<PrismaClient, "$queryRaw">, productId: string) {
  await tx.$queryRaw`SELECT 1 FROM master_products WHERE id = ${productId} FOR UPDATE`;
}

/**
 * Row-lock the cart so concurrent mutations of its lines serialize. Needed
 * because FOR UPDATE on cart_lines cannot lock a line that does not exist yet.
 */
export async function lockCart(
  tx: Pick<PrismaClient, "$queryRaw">,
  cartId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cartId} FOR UPDATE`;
}

export async function lockCartLineByVariant(
  tx: Pick<PrismaClient, "$queryRaw">,
  cartId: string,
  variantId: string,
): Promise<{ id: string; qty: number } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; qty: number }>>`
    SELECT id, qty FROM cart_lines
    WHERE cart_id = ${cartId} AND variant_id = ${variantId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function claimImportRow(
  tx: Pick<PrismaClient, "$queryRaw">,
  importToken: string,
  ttlMs: number = IMPORT_TOKEN_TTL_MS,
): Promise<boolean> {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Import token TTL must be a positive integer.");
  }
  // Integer is validated above. Prisma.raw does not bind it as a parameter.
  const ttlInterval = Prisma.raw(`${ttlMs} * INTERVAL '1 millisecond'`);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE listing_imports
    SET status = 'committed', committed_at = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE id = ${importToken}
      AND status = 'pending'
      AND created_at > (clock_timestamp() AT TIME ZONE 'UTC') - ${ttlInterval}
    RETURNING id
  `;
  return rows.length > 0;
}

/** A read as the platform admin, for queries Prisma's query API cannot express. */
export async function platformAdminRawQuery<T>(sql: Prisma.Sql): Promise<T[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return tx.$queryRaw<T[]>(sql);
  });
}

export async function storeScopedRawQuery<T>(
  storeId: string,
  sql: Prisma.Sql,
): Promise<T[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    return tx.$queryRaw<T[]>(sql);
  });
}

export { Prisma };

export { prisma as authPrisma };

/**
 * Login role of the shared client. `SET LOCAL ROLE` changes `current_user`
 * and leaves `session_user` as the role that opened the connection.
 */
export async function platformSessionUser(): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    const rows = await tx.$queryRaw<Array<{ session_user: string }>>`
      SELECT session_user::text AS session_user`;
    return rows[0]?.session_user ?? "";
  });
}

/** Refuses a login that is not app_runtime, or one that bypasses RLS. */
export async function assertAppRuntimeLogin(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    const rows = await tx.$queryRaw<Array<{ session_user: string; rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT session_user::text AS session_user, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = session_user::text
    `;
    const role = rows[0];
    if (!role || role.session_user !== "app_runtime" || role.rolsuper || role.rolbypassrls) {
      throw new Error("The eval refuses evidence unless the database login is app_runtime.");
    }
  });
}

export async function disconnectPlatformClient(): Promise<void> {
  await prisma.$disconnect();
}

export async function findRecentMagicLinkVerifications(): Promise<
  Array<{ identifier: string; value: string }>
> {
  return prisma.$queryRaw<Array<{ identifier: string; value: string }>>`
    SELECT identifier, value FROM verifications
    WHERE identifier LIKE 'magic-link:%'
    ORDER BY created_at DESC
    LIMIT 5`;
}

/** Magic links for this inbox expiring after `after`. Exact match: a LIKE pattern lets `_` match another inbox. */
export async function countMagicLinksForEmail(email: string, after: Date): Promise<number> {
  // CASE keeps the JSON cast off rows of other verification types.
  const [{ count }] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM verifications
    WHERE expires_at > ${after}
      AND CASE WHEN left(identifier, 11) = 'magic-link:'
          THEN lower(value::jsonb->>'email') = lower(${email})
          ELSE false END`;
  return count;
}

/** Minimal slice of a Prisma client needed to run a query under a statement timeout. */
export interface TransactionalClient {
  $transaction<T>(
    fn: (tx: {
      $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
      $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
    }) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T>;
}

/** One counted file turn inside a rolling hour. The lock makes concurrent requests agree. */
export async function takeRollingFileTurn(
  key: string,
  nowMs: bigint,
  windowMs: bigint,
  max: number,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const windowStart = nowMs - windowMs;
    await tx.$executeRaw`DELETE FROM assistant_file_turns WHERE key = ${key} AND at_ms <= ${windowStart}`;
    const rows = await tx.$queryRaw<Array<{ count: number; oldest: bigint | null }>>`
      SELECT COUNT(*)::int AS count, MIN(at_ms) AS oldest
      FROM assistant_file_turns
      WHERE key = ${key} AND at_ms > ${windowStart}
    `;
    const count = Number(rows[0]?.count ?? 0);
    if (count >= max) {
      const oldest = rows[0]?.oldest == null ? nowMs : BigInt(rows[0].oldest);
      const retryAfter = Math.max(1, Math.ceil(Number(oldest + windowMs - nowMs) / 1000));
      return { ok: false, retryAfter };
    }
    await tx.$executeRaw`
      INSERT INTO assistant_file_turns (id, key, at_ms)
      VALUES (gen_random_uuid()::text, ${key}, ${nowMs})
    `;
    return { ok: true };
  });
}

export async function appRateLimitUpsert(
  key: string,
  nowMs: bigint,
  boundary: bigint,
): Promise<{ count: number; windowStart: bigint }> {
  const rows = await prisma.$queryRaw<Array<{ count: number; window_start: bigint }>>`
    INSERT INTO app_rate_limits (key, window_start, count)
    VALUES (${key}, ${nowMs}, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN app_rate_limits.window_start < ${boundary}
        THEN 1
        ELSE app_rate_limits.count + 1
      END,
      window_start = CASE
        WHEN app_rate_limits.window_start < ${boundary}
        THEN ${nowMs}
        ELSE app_rate_limits.window_start
      END
    RETURNING count, window_start
  `;
  const row = rows[0];
  if (!row) throw new Error("rate limit upsert returned no row");
  return { count: Number(row.count), windowStart: BigInt(row.window_start) };
}

export async function appRateLimitCleanup(cutoff: bigint, limit: number): Promise<void> {
  // The outer window_start predicate is checked again after a row-lock wait
  // (READ COMMITTED), so a window refreshed by a concurrent upsert is kept.
  await prisma.$executeRaw`
    DELETE FROM app_rate_limits
    WHERE key IN (
      SELECT key FROM app_rate_limits
      WHERE window_start < ${cutoff}
      LIMIT ${limit}
    )
    AND window_start < ${cutoff}
  `;
}

/**
 * Wraps each query in a transaction that first sets a 5 s server-side statement
 * timeout, so a slow database cancels the query
 * instead of hanging until the function timeout.
 */
export function withStatementTimeout(client: TransactionalClient): QueryRawFn {
  return (strings, ...values) =>
    client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '5000'`;
      return (await tx.$queryRaw(strings, ...values)) as unknown[];
    }, { timeout: 7000, maxWait: 2000 });
}

// No RLS wrapper: health checks read only system catalogs, not store-scoped tables.
export const healthQueryRaw = withStatementTimeout(prisma);

/** Takes the conversation lease only when it is free. Same transaction as the upsert. */
export async function claimConversationLease(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
  cartId: string,
  until: Date,
  at: Date,
): Promise<{ id: string; messages: unknown } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; messages: unknown }>>`
    UPDATE ai_conversations
    SET in_flight_until = ${until}
    WHERE store_id = ${storeId} AND cart_id = ${cartId}
      AND (in_flight_until IS NULL OR in_flight_until < ${at})
    RETURNING id, messages
  `;
  return rows[0] ?? null;
}

/**
 * Deletes one batch of actions older than the naive timestamp.
 * The batch key is written in the same transaction, so a replay returns the
 * committed count instead of deleting the next batch.
 */
export function deleteExpiredAssistantActions(
  cutoff: string,
  batchSize: number,
  batchKey: string,
): Promise<number> {
  return deleteExpiredBatch(batchKey, (tx) =>
    tx.$queryRaw<Array<{ deleted: number }>>`
      WITH doomed AS (
        SELECT id FROM ai_actions
        WHERE created_at < ${cutoff}
        ORDER BY created_at, id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      removed AS (
        DELETE FROM ai_actions
        WHERE id IN (SELECT id FROM doomed)
        RETURNING id
      )
      SELECT count(*)::int AS deleted FROM removed
    `,
  );
}

/**
 * Deletes one batch of idle conversations older than the naive timestamp.
 * A row locked by a live lease is skipped, and the lease is checked again
 * on the row being deleted.
 */
export function deleteExpiredAssistantConversations(
  cutoff: string,
  now: string,
  batchSize: number,
  batchKey: string,
): Promise<number> {
  return deleteExpiredBatch(batchKey, (tx) =>
    tx.$queryRaw<Array<{ deleted: number }>>`
      WITH doomed AS (
        SELECT id FROM ai_conversations
        WHERE created_at < ${cutoff}
          AND (in_flight_until IS NULL OR in_flight_until <= ${now})
        ORDER BY created_at, id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      removed AS (
        DELETE FROM ai_conversations
        WHERE id IN (SELECT id FROM doomed)
          AND (in_flight_until IS NULL OR in_flight_until <= ${now})
        RETURNING id
      )
      SELECT count(*)::int AS deleted FROM removed
    `,
  );
}

/**
 * Deletes one batch of AI review flags (#544) older than the naive timestamp. Shopper flags already went with
 * their conversation; this removes copilot flags, whose conversations have no retention job.
 */
export function deleteExpiredReviewFlags(
  cutoff: string,
  batchSize: number,
  batchKey: string,
): Promise<number> {
  return deleteExpiredBatch(batchKey, (tx) =>
    tx.$queryRaw<Array<{ deleted: number }>>`
      WITH doomed AS (
        SELECT id FROM ai_review_flags
        WHERE created_at < ${cutoff}
        ORDER BY created_at, id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      removed AS (
        DELETE FROM ai_review_flags
        WHERE id IN (SELECT id FROM doomed)
        RETURNING id
      )
      SELECT count(*)::int AS deleted FROM removed
    `,
  );
}

async function deleteExpiredBatch(
  batchKey: string,
  remove: (tx: Pick<PrismaClient, "$queryRaw" | "$executeRaw">) => Promise<Array<{ deleted: number }>>,
): Promise<number> {
  return platformAdminTransaction(async (tx) => {
    const existing = await tx.$queryRaw<Array<{ deleted: number }>>`
      SELECT deleted FROM assistant_retention_batches WHERE id = ${batchKey}
    `;
    const prior = existing[0];
    if (prior) return Number(prior.deleted);
    const rows = await remove(tx);
    const deleted = Number(rows[0]?.deleted ?? 0);
    await tx.$executeRaw`
      INSERT INTO assistant_retention_batches (id, deleted)
      VALUES (${batchKey}, ${deleted})
      ON CONFLICT (id) DO NOTHING
    `;
    return deleted;
  });
}

let spendAckLosses = 0;

/** Test hook: the next n committed ledger writes throw after commit. */
export function loseNextSpendAcks(count: number): void {
  spendAckLosses = count;
}

/** Adds the call cost to the UTC day. The day is a YYYY-MM-DD string, cast in SQL. */
export async function insertAssistantSpend(day: string, amount: bigint, callId: string): Promise<void> {
  await appUserQuery((tx) =>
    tx.$executeRaw`
      WITH claimed AS (
        INSERT INTO assistant_spend_calls (id, day, cost_micros)
        VALUES (${callId}, CAST(${day} AS date), ${amount})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      )
      INSERT INTO assistant_spend_days (day, cost_micros, updated_at)
      SELECT CAST(${day} AS date), ${amount}, now()
      FROM claimed
      ON CONFLICT (day) DO UPDATE
      SET cost_micros = assistant_spend_days.cost_micros + EXCLUDED.cost_micros,
          updated_at = now()
    `,
  );
  if (spendAckLosses > 0) {
    spendAckLosses -= 1;
    throw new Error("ack lost");
  }
}

export async function sumAssistantSpend(): Promise<bigint> {
  const rows = await appUserQuery((tx) =>
    tx.$queryRaw<Array<{ spent: bigint }>>`
      SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM assistant_spend_days
    `,
  );
  return BigInt(rows[0]?.spent ?? 0);
}

/** Inserts the day if needed, then claims the once-per-day alert. */
export async function claimAssistantCapDay(day: string): Promise<boolean> {
  return appUserQuery(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO assistant_spend_days (day, cost_micros, updated_at)
      VALUES (CAST(${day} AS date), 0, now())
      ON CONFLICT (day) DO NOTHING
    `;
    const rows = await tx.$queryRaw<Array<{ day: Date }>>`
      UPDATE assistant_spend_days
      SET cap_alerted_at = now(), updated_at = now()
      WHERE day = CAST(${day} AS date) AND cap_alerted_at IS NULL
      RETURNING day
    `;
    return rows.length > 0;
  });
}

/** Ledger days from `last` back `days` days, newest first, for the admin eval and spend page (#545). */
export async function listAssistantSpendDays(last: string, days: number): Promise<Array<{ day: Date; cost: bigint; alerted: boolean }>> {
  return appUserQuery((tx) =>
    tx.$queryRaw<Array<{ day: Date; cost: bigint; alerted: boolean }>>`
      SELECT day, cost_micros AS cost, cap_alerted_at IS NOT NULL AS alerted
      FROM assistant_spend_days
      WHERE day <= CAST(${last} AS date) AND day > CAST(${last} AS date) - ${days}::int
      ORDER BY day DESC
    `,
  );
}

// ---------------------------------------------------------------------------
// WhatsApp inbound (#143). Called inside one platformAdminTransaction, so the
// claim and the verification write commit or roll back together. Each query
// selects only what the inbound path needs.

type RawTx = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

const WHATSAPP_INBOUND_RETENTION = Prisma.raw("INTERVAL '8 days'");
const WHATSAPP_INBOUND_CLEANUP_BATCH = 100;

/** True for the first delivery of a message id; false for a redelivery. */
export async function claimInboundWhatsAppMessage(tx: RawTx, messageId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO whatsapp_inbound_messages (id, received_at)
    VALUES (${messageId}, (now() AT TIME ZONE 'UTC'))
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) return false;
  await tx.$executeRaw`
    DELETE FROM whatsapp_inbound_messages
    WHERE id IN (
      SELECT id FROM whatsapp_inbound_messages
      WHERE received_at < (now() AT TIME ZONE 'UTC') - ${WHATSAPP_INBOUND_RETENTION}
      LIMIT ${WHATSAPP_INBOUND_CLEANUP_BATCH}
    )
  `;
  return true;
}

/** Undoes a committed claim whose handling failed, so Meta's redelivery is handled. */
export async function releaseInboundWhatsAppMessage(messageId: string): Promise<void> {
  await platformAdminTransaction((tx) => tx.$executeRaw`DELETE FROM whatsapp_inbound_messages WHERE id = ${messageId}`);
}

export type OwnerLinkCodeOutcome =
  | { kind: "no_pending" }
  | { kind: "wrong_or_expired" }
  | { kind: "verified"; storeId: string; userId: string; storeName: string };

/**
 * Tries a 6-digit code against the codes sent to this sender (newest first,
 * at most five rows, at any store, verified rows included when they are
 * changing number). The code decides the store. A match moves the pending
 * number into the link and verifies it in one UPDATE guarded by the database
 * clock; any other verified link for the same sender is deleted first, with
 * an audit row on the store that lost it.
 *
 * A miss counts an attempt on each candidate and voids a code at the limit,
 * unless `countMisses` is false. The inbound path passes false when the
 * sender is already a verified owner: only the holder of the number can send
 * from it, and the code was delivered to that same account, so a miss there
 * is ordinary chat, not guessing. Counting it would let one owner's messages
 * void another store's pending code.
 */
export async function verifyOwnerLinkByCode(
  tx: RawTx,
  waId: string,
  code: string,
  options: { countMisses: boolean } = { countMisses: true },
): Promise<OwnerLinkCodeOutcome> {
  const candidates = await tx.$queryRaw<Array<{
    id: string;
    store_id: string;
    user_id: string;
    verification_code_hash: string | null;
    live: boolean;
  }>>`
    SELECT id, store_id, user_id, verification_code_hash,
      (verification_expires_at > (now() AT TIME ZONE 'UTC')) AS live
    FROM owner_whatsapp_links
    WHERE pending_wa_id = ${waId} AND verification_code_hash IS NOT NULL
    ORDER BY updated_at DESC, id
    LIMIT 5
    FOR UPDATE
  `;
  if (candidates.length === 0) return { kind: "no_pending" };

  const matches = candidates.map((row) =>
    linkCodeMatches({ storeId: row.store_id, userId: row.user_id, codeHash: row.verification_code_hash }, code),
  );
  const match = candidates.find((row, index) => matches[index] && row.live === true);

  if (!match) {
    if (!options.countMisses) return { kind: "wrong_or_expired" };
    const ids = candidates.map((row) => row.id);
    await tx.$executeRaw`
      UPDATE owner_whatsapp_links
      SET verification_attempts = verification_attempts + 1,
        verification_code_hash = CASE
          WHEN verification_attempts + 1 >= ${MAX_LINK_CODE_ATTEMPTS} THEN NULL
          ELSE verification_code_hash END,
        verification_expires_at = CASE
          WHEN verification_attempts + 1 >= ${MAX_LINK_CODE_ATTEMPTS} THEN NULL
          ELSE verification_expires_at END,
        pending_phone_number = CASE
          WHEN verified AND verification_attempts + 1 >= ${MAX_LINK_CODE_ATTEMPTS} THEN NULL
          ELSE pending_phone_number END,
        pending_wa_id = CASE
          WHEN verified AND verification_attempts + 1 >= ${MAX_LINK_CODE_ATTEMPTS} THEN NULL
          ELSE pending_wa_id END,
        updated_at = (now() AT TIME ZONE 'UTC')
      WHERE id IN (${Prisma.join(ids)})
    `;
    return { kind: "wrong_or_expired" };
  }

  const replaced = await tx.$queryRaw<Array<{ id: string; store_id: string }>>`
    DELETE FROM owner_whatsapp_links
    WHERE wa_id = ${waId} AND verified AND id <> ${match.id}
    RETURNING id, store_id
  `;
  const updated = await tx.$queryRaw<Array<{ store_id: string; user_id: string }>>`
    UPDATE owner_whatsapp_links
    SET verified = true,
      verified_at = (now() AT TIME ZONE 'UTC'),
      phone_number = pending_phone_number,
      wa_id = pending_wa_id,
      pending_phone_number = NULL,
      pending_wa_id = NULL,
      verification_code_hash = NULL,
      verification_expires_at = NULL,
      verification_attempts = 0,
      updated_at = (now() AT TIME ZONE 'UTC')
    WHERE id = ${match.id}
      AND pending_wa_id = ${waId}
      AND verification_code_hash = ${match.verification_code_hash}
      AND verification_expires_at > (now() AT TIME ZONE 'UTC')
    RETURNING store_id, user_id
  `;
  const row = updated[0];
  if (!row) return { kind: "wrong_or_expired" };

  const owner = await tx.$queryRaw<Array<{ email: string; name: string }>>`
    SELECT u.email, s.name
    FROM users u, stores s
    WHERE u.id = ${row.user_id} AND s.id = ${row.store_id}
  `;
  await tx.$executeRaw`
    INSERT INTO audit_logs (id, store_id, actor_id, actor_email, action, entity_type, entity_id, created_at)
    VALUES (${crypto.randomUUID()}, ${row.store_id}, ${row.user_id}, ${owner[0]?.email ?? SYSTEM_ACTOR_EMAIL},
      'whatsapp_link.verify', 'owner_whatsapp_link', ${match.id}, (now() AT TIME ZONE 'UTC'))
  `;
  for (const lost of replaced) {
    await tx.$executeRaw`
      INSERT INTO audit_logs (id, store_id, actor_id, actor_email, action, entity_type, entity_id, created_at)
      VALUES (${crypto.randomUUID()}, ${lost.store_id}, ${SYSTEM_ACTOR_ID}, ${SYSTEM_ACTOR_EMAIL},
        'whatsapp_link.replaced', 'owner_whatsapp_link', ${lost.id}, (now() AT TIME ZONE 'UTC'))
    `;
  }
  return { kind: "verified", storeId: row.store_id, userId: row.user_id, storeName: owner[0]?.name ?? "" };
}

/**
 * The verified link for a sender whose membership is still `owner`. Matches
 * Meta's wa_id, or the E.164 number the owner entered.
 */
export async function findVerifiedOwnerLink(
  tx: RawTx,
  waId: string,
): Promise<{ storeId: string; userId: string; role: string; storeName: string } | null> {
  const e164 = `+${waId}`;
  const rows = await tx.$queryRaw<Array<{ store_id: string; user_id: string; role: string; name: string }>>`
    SELECT l.store_id, l.user_id, m.role, s.name
    FROM owner_whatsapp_links l
    JOIN store_memberships m ON m.store_id = l.store_id AND m.user_id = l.user_id
    JOIN stores s ON s.id = l.store_id
    WHERE l.verified AND (l.wa_id = ${waId} OR l.phone_number = ${e164}) AND m.role = 'owner'
    ORDER BY l.verified_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { storeId: row.store_id, userId: row.user_id, role: row.role, storeName: row.name };
}

/**
 * Starts a code for `phoneNumber`: sets the pending number and a fresh code
 * hash expiring on the database clock, plus an audit row. A verified link
 * keeps its number and stays verified until the new code is answered; a row
 * that was never verified shows the new number. Returns the row id.
 */
export async function upsertPendingOwnerLink(input: {
  storeId: string;
  userId: string;
  actorEmail: string;
  phoneNumber: string;
  waId: string;
  codeHash: string;
  ttlMinutes: number;
  auditAfter: Prisma.InputJsonValue;
}): Promise<string> {
  if (!Number.isInteger(input.ttlMinutes) || input.ttlMinutes <= 0) {
    throw new Error("Link code TTL must be a positive integer.");
  }
  // Integer is validated above. Prisma.raw does not bind it as a parameter.
  const ttl = Prisma.raw(`INTERVAL '${input.ttlMinutes} minutes'`);
  return storeScopedTransaction(input.storeId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO owner_whatsapp_links (
        id, store_id, user_id, phone_number, wa_id, pending_phone_number, pending_wa_id, verified, verified_at,
        verification_code_hash, verification_expires_at, verification_attempts, created_at, updated_at
      ) VALUES (
        ${crypto.randomUUID()}, ${input.storeId}, ${input.userId}, ${input.phoneNumber}, ${input.waId},
        ${input.phoneNumber}, ${input.waId}, false, NULL,
        ${input.codeHash}, (now() AT TIME ZONE 'UTC') + ${ttl}, 0, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
      )
      ON CONFLICT (store_id, user_id) DO UPDATE SET
        phone_number = CASE WHEN owner_whatsapp_links.verified
          THEN owner_whatsapp_links.phone_number ELSE EXCLUDED.phone_number END,
        wa_id = CASE WHEN owner_whatsapp_links.verified
          THEN owner_whatsapp_links.wa_id ELSE EXCLUDED.wa_id END,
        pending_phone_number = EXCLUDED.pending_phone_number,
        pending_wa_id = EXCLUDED.pending_wa_id,
        verification_code_hash = EXCLUDED.verification_code_hash,
        verification_expires_at = EXCLUDED.verification_expires_at,
        verification_attempts = 0,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("owner link upsert returned no row");
    await tx.auditLog.create({
      data: {
        storeId: input.storeId,
        actorId: input.userId,
        actorEmail: input.actorEmail,
        action: "whatsapp_link.start",
        entityType: "owner_whatsapp_link",
        entityId: id,
        after: input.auditAfter,
      },
    });
    return id;
  });
}

/** Deletes the member's link, with an audit row when one existed. */
export async function deleteOwnerLinkForMember(storeId: string, userId: string, actorEmail: string): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    const removed = await tx.$queryRaw<Array<{ id: string }>>`
      DELETE FROM owner_whatsapp_links
      WHERE store_id = ${storeId} AND user_id = ${userId}
      RETURNING id
    `;
    if (!removed[0]) return;
    await tx.auditLog.create({
      data: {
        storeId,
        actorId: userId,
        actorEmail,
        action: "whatsapp_link.remove",
        entityType: "owner_whatsapp_link",
        entityId: removed[0].id,
      },
    });
  });
}

/** The member's link for the store admin page; `code_live` is judged on the database clock. */
export async function readOwnerLink(storeId: string, userId: string): Promise<{
  phoneNumber: string;
  pendingPhoneNumber: string | null;
  verified: boolean;
  verifiedAt: Date | null;
  codeLive: boolean;
} | null> {
  const rows = await storeScopedTransaction(storeId, (tx) =>
    tx.$queryRaw<Array<{
      phone_number: string;
      pending_phone_number: string | null;
      verified: boolean;
      verified_at: Date | null;
      code_live: boolean;
    }>>`
      SELECT phone_number, pending_phone_number, verified, verified_at,
        (verification_code_hash IS NOT NULL
          AND verification_expires_at > (now() AT TIME ZONE 'UTC')) AS code_live
      FROM owner_whatsapp_links
      WHERE store_id = ${storeId} AND user_id = ${userId}
    `,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    phoneNumber: row.phone_number,
    pendingPhoneNumber: row.pending_phone_number,
    verified: row.verified,
    verifiedAt: row.verified_at,
    codeLive: row.code_live === true,
  };
}

// ---------------------------------------------------------------------------
// Store WhatsApp numbers (#558). The business token is ciphertext sealed by
// src/lib/whatsapp/token-box.ts; nothing here returns it.

export interface StoreWhatsAppNumberRow {
  wabaId: string;
  phoneNumberId: string;
  displayNumber: string | null;
  status: "pending" | "registered" | "failed" | "disconnected";
  coexistence: boolean;
  failureCode: string | null;
  updatedAt: Date;
}

/** The phone_number_id is held by another store's pending or registered row, or this store has a link in flight. */
export class StoreWhatsAppNumberTakenError extends Error {
  constructor() {
    super("WhatsApp number is linked to another store");
    this.name = "StoreWhatsAppNumberTakenError";
  }
}

/** A raw-query unique violation on the platform-wide phone_number_id index. */
function isPhoneNumberIdTaken(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown; constraint?: { index?: unknown } } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.originalCode === "23505" && cause.constraint?.index === "store_whatsapp_numbers_phone_number_id_key";
}

/**
 * Starts a link under the store row's lock. The same ids already registered
 * return "linked" untouched (a retry keeps the token). Otherwise the row goes
 * `pending` with these ids, its token cleared, plus an audit row; committed
 * before Meta is called. A pending row younger than LINK_IN_FLIGHT is another
 * link still running and refuses this one; an older one is a run that died,
 * which the owner links again.
 */
export async function beginStoreWhatsAppNumberLink(input: {
  storeId: string;
  actorId: string;
  actorEmail: string;
  wabaId: string;
  phoneNumberId: string;
  coexistence: boolean;
}): Promise<"begun" | "linked"> {
  try {
    return await storeScopedTransaction(input.storeId, async (tx) => {
      const existing = await tx.$queryRaw<Array<{ status: string; waba_id: string; phone_number_id: string; coexistence: boolean }>>`
        SELECT status, waba_id, phone_number_id, coexistence FROM store_whatsapp_numbers
        WHERE store_id = ${input.storeId}
        FOR UPDATE
      `;
      const row = existing[0];
      if (row?.status === "registered" && row.waba_id === input.wabaId
        && row.phone_number_id === input.phoneNumberId && row.coexistence === input.coexistence) {
        return "linked";
      }
      // Provider calls are 5 at most, each with a 10 s timeout, so a live link is pending well under this.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO store_whatsapp_numbers (
          id, store_id, waba_id, phone_number_id, display_number, status, coexistence,
          business_token, failure_code, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}, ${input.storeId}, ${input.wabaId}, ${input.phoneNumberId}, NULL, 'pending',
          ${input.coexistence}, NULL, NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
        )
        ON CONFLICT (store_id) DO UPDATE SET
          waba_id = EXCLUDED.waba_id,
          phone_number_id = EXCLUDED.phone_number_id,
          display_number = NULL,
          status = 'pending',
          coexistence = EXCLUDED.coexistence,
          business_token = NULL,
          failure_code = NULL,
          updated_at = EXCLUDED.updated_at
        WHERE store_whatsapp_numbers.status <> 'pending'
          OR store_whatsapp_numbers.updated_at < EXCLUDED.updated_at - ${LINK_IN_FLIGHT}::interval
        RETURNING id
      `;
      const id = rows[0]?.id;
      if (!id) throw new StoreWhatsAppNumberTakenError();
      await tx.auditLog.create({
        data: {
          storeId: input.storeId,
          actorId: input.actorId,
          actorEmail: input.actorEmail,
          action: "whatsapp_number.link",
          entityType: "store_whatsapp_number",
          entityId: id,
          after: { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, coexistence: input.coexistence },
        },
      });
      return "begun";
    });
  } catch (error) {
    if (isPhoneNumberIdTaken(error)) throw new StoreWhatsAppNumberTakenError();
    throw error;
  }
}

const LINK_IN_FLIGHT = "2 minutes";

/**
 * Finishes a pending link. Keyed on the phone id, so a newer link for another
 * number is never overwritten. False when no pending row matched: the link was
 * superseded or disconnected meanwhile, so the caller must not report success.
 */
export async function finishStoreWhatsAppNumberLink(
  storeId: string,
  phoneNumberId: string,
  result:
    | { status: "registered"; displayNumber: string; sealedToken: string }
    | { status: "failed"; failureCode: string },
): Promise<boolean> {
  const updated = await storeScopedTransaction(storeId, (tx) =>
    result.status === "registered"
      ? tx.$executeRaw`
          UPDATE store_whatsapp_numbers
          SET status = 'registered', display_number = ${result.displayNumber},
            business_token = ${result.sealedToken}, failure_code = NULL, updated_at = (now() AT TIME ZONE 'UTC')
          WHERE store_id = ${storeId} AND phone_number_id = ${phoneNumberId} AND status = 'pending'
        `
      : tx.$executeRaw`
          UPDATE store_whatsapp_numbers
          SET status = 'failed', business_token = NULL, failure_code = ${result.failureCode},
            updated_at = (now() AT TIME ZONE 'UTC')
          WHERE store_id = ${storeId} AND phone_number_id = ${phoneNumberId} AND status = 'pending'
        `,
  );
  return updated === 1;
}

/** Marks the store's number disconnected and drops its token, with an audit row when one existed. */
export async function disconnectStoreWhatsAppNumberRow(storeId: string, actorId: string, actorEmail: string): Promise<void> {
  await storeScopedTransaction(storeId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE store_whatsapp_numbers
      SET status = 'disconnected', business_token = NULL, updated_at = (now() AT TIME ZONE 'UTC')
      WHERE store_id = ${storeId} AND status <> 'disconnected'
      RETURNING id
    `;
    if (!rows[0]) return;
    await tx.auditLog.create({
      data: {
        storeId,
        actorId,
        actorEmail,
        action: "whatsapp_number.disconnect",
        entityType: "store_whatsapp_number",
        entityId: rows[0].id,
      },
    });
  });
}

export async function readStoreWhatsAppNumber(storeId: string): Promise<StoreWhatsAppNumberRow | null> {
  const rows = await storeScopedTransaction(storeId, (tx) =>
    tx.$queryRaw<Array<{
      waba_id: string;
      phone_number_id: string;
      display_number: string | null;
      status: StoreWhatsAppNumberRow["status"];
      coexistence: boolean;
      failure_code: string | null;
      updated_at: Date;
    }>>`
      SELECT waba_id, phone_number_id, display_number, status, coexistence, failure_code, updated_at
      FROM store_whatsapp_numbers
      WHERE store_id = ${storeId}
    `,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayNumber: row.display_number,
    status: row.status,
    coexistence: row.coexistence,
    failureCode: row.failure_code,
    updatedAt: row.updated_at,
  };
}

/** The store a registered number belongs to, by exact phone_number_id. Inside the inbound platformAdminTransaction. */
export async function findStoreByWhatsAppPhoneNumberId(
  tx: RawTx,
  phoneNumberId: string,
): Promise<{ storeId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ store_id: string }>>`
    SELECT store_id FROM store_whatsapp_numbers
    WHERE phone_number_id = ${phoneNumberId} AND status = 'registered'
  `;
  return rows[0] ? { storeId: rows[0].store_id } : null;
}

/** The store's registered number and its sealed token, for sending from it (#560). Only src/lib/whatsapp opens the token. */
export async function readStoreWhatsAppSender(
  storeId: string,
): Promise<{ phoneNumberId: string; sealedToken: string } | null> {
  const rows = await storeScopedTransaction(storeId, (tx) =>
    tx.$queryRaw<Array<{ phone_number_id: string; business_token: string | null }>>`
      SELECT phone_number_id, business_token FROM store_whatsapp_numbers
      WHERE store_id = ${storeId} AND status = 'registered'
    `,
  );
  const row = rows[0];
  return row?.business_token ? { phoneNumberId: row.phone_number_id, sealedToken: row.business_token } : null;
}

/** True when the store has a registered number, so checkout offers WhatsApp updates (#560). Pass the order's transaction to read under it. */
export async function storeHasWhatsAppNumber(storeId: string, tx?: Pick<PrismaClient, "$queryRaw">): Promise<boolean> {
  const read = (client: Pick<PrismaClient, "$queryRaw">) => client.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM store_whatsapp_numbers WHERE store_id = ${storeId} AND status = 'registered'
  `;
  const rows = tx ? await read(tx) : await storeScopedTransaction(storeId, read);
  return rows.length > 0;
}

/** A customer sent STOP to this store's number (#560). A repeat is a no-op. */
export async function recordWhatsAppOptOut(storeId: string, waId: string): Promise<void> {
  await storeScopedTransaction(storeId, (tx) => tx.$executeRaw`
    INSERT INTO whatsapp_opt_outs (id, store_id, wa_id, created_at)
    VALUES (${crypto.randomUUID()}, ${storeId}, ${waId}, (now() AT TIME ZONE 'UTC'))
    ON CONFLICT (store_id, wa_id) DO NOTHING
  `);
}

/** Exact wa_id match at this store only. */
export async function isWhatsAppOptedOut(storeId: string, waId: string): Promise<boolean> {
  const row = await storeScoped(storeId).whatsAppOptOut.findUnique({
    where: { storeId_waId: { storeId, waId } },
    select: { id: true },
  });
  return row !== null;
}

/** Creates the store's billing row if missing and locks it for this transaction (#494). */
export async function lockStoreSubscriptionRow(tx: Pick<PrismaClient, "$executeRaw" | "$queryRaw">, storeId: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO store_subscriptions (store_id) VALUES (${storeId}) ON CONFLICT (store_id) DO NOTHING`;
  await tx.$queryRaw`SELECT store_id FROM store_subscriptions WHERE store_id = ${storeId} FOR UPDATE`;
}

/** Serialises finding or creating one WhatsApp sender's cart at one store (#559). */
export async function lockWhatsAppShopper(tx: Pick<PrismaClient, "$executeRaw">, storeId: string, senderKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`whatsapp-shopper:${storeId}:${senderKey}`}))`;
}

/** Serialises pilot-offer changes so the 5-store cap holds under concurrency. */
export async function lockPilotOffer(tx: Pick<PrismaClient, "$executeRaw">): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('store_subscriptions.pilot'))`;
}

/** Records a Stripe billing event id. False means it was already applied. */
export async function claimStripeBillingEvent(
  tx: Pick<PrismaClient, "$queryRaw">,
  eventId: string,
  storeId: string | null,
  type: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO stripe_billing_events (id, store_id, type)
    VALUES (${eventId}, ${storeId}, ${type})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Records a charge.dispute.* event id (#539). False means it was already applied. */
export async function claimPaymentDisputeEvent(
  tx: Pick<PrismaClient, "$queryRaw">,
  eventId: string,
  stripeDisputeId: string,
  type: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO payment_dispute_events (id, stripe_dispute_id, type)
    VALUES (${eventId}, ${stripeDisputeId}, ${type})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Locks a dispute's row until the transaction ends, so two of its events apply one after the other. */
export async function lockPaymentDispute(tx: Pick<PrismaClient, "$queryRaw">, stripeDisputeId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM payment_disputes WHERE stripe_dispute_id = ${stripeDisputeId} FOR UPDATE`;
}

/** Adds one assistant chat to the store's month unless it is at `cap`. Null when capped. */
export async function incrementAssistantChatMonth(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
  month: string,
  cap: number,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ chats: number }[]>`
    INSERT INTO assistant_chat_months (store_id, month, chats)
    VALUES (${storeId}, ${month}::date, 1)
    ON CONFLICT (store_id, month) DO UPDATE SET chats = assistant_chat_months.chats + 1
    WHERE assistant_chat_months.chats < ${cap}
    RETURNING chats`;
  return rows[0]?.chats ?? null;
}

export type StorePlanRow = { storeId: string; plan: string; status: string; overridePlan: string | null; overrideEndsAt: Date | null };

/**
 * The plan gate's input (#547). The override comes back only while it runs, judged by the database
 * clock, so every gate agrees on the moment it ends. Rows the caller's RLS context hides are skipped.
 */
export async function readStorePlanRows(tx: Pick<PrismaClient, "$queryRaw">, storeIds: string[]): Promise<StorePlanRow[]> {
  if (storeIds.length === 0) return [];
  return tx.$queryRaw<StorePlanRow[]>`
    SELECT store_id AS "storeId", plan, status,
           CASE WHEN override_ends_at > now() THEN override_plan END AS "overridePlan",
           CASE WHEN override_ends_at > now() THEN override_ends_at END AS "overrideEndsAt"
    FROM store_subscriptions
    WHERE store_id = ANY(${storeIds})
  `;
}

/** Where a plan override's end falls against the database clock: after now, and within the cap. */
export async function overrideEndWindow(
  tx: Pick<PrismaClient, "$queryRaw">,
  endsAt: Date,
  maxDays: number,
): Promise<{ future: boolean; withinMax: boolean }> {
  const [row] = await tx.$queryRaw<{ future: boolean; withinMax: boolean }[]>`
    SELECT ${endsAt}::timestamptz > now() AS future,
           ${endsAt}::timestamptz <= now() + make_interval(days => ${maxDays}) AS "withinMax"`;
  return row!;
}

export type SubscriptionOverviewRow = {
  storeId: string;
  storeName: string;
  storeSlug: string;
  plan: string;
  status: string;
  pilot: boolean;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  paymentFailedAt: Date | null;
  overridePlan: string | null;
  overrideEndsAt: Date | null;
  overrideReason: string | null;
  /** The pilot's or a trial's free months are still running, by the database clock. */
  inFreeMonths: boolean;
};

/** Every store with its billing row, for the platform admin's subscriptions overview (#547). A store that never subscribed shows "none". */
export async function listSubscriptionOverviewRows(): Promise<SubscriptionOverviewRow[]> {
  return platformAdminTransaction((tx) =>
    tx.$queryRaw<SubscriptionOverviewRow[]>`
      SELECT s.id AS "storeId", s.name AS "storeName", s.slug AS "storeSlug",
             COALESCE(sub.plan, 'starter') AS plan, COALESCE(sub.status, 'none') AS status,
             COALESCE(sub.pilot, false) AS pilot,
             sub.trial_ends_at AS "trialEndsAt", sub.current_period_end AS "currentPeriodEnd",
             COALESCE(sub.cancel_at_period_end, false) AS "cancelAtPeriodEnd",
             sub.payment_failed_at AS "paymentFailedAt",
             CASE WHEN sub.override_ends_at > now() THEN sub.override_plan END AS "overridePlan",
             CASE WHEN sub.override_ends_at > now() THEN sub.override_ends_at END AS "overrideEndsAt",
             CASE WHEN sub.override_ends_at > now() THEN sub.override_reason END AS "overrideReason",
             COALESCE(sub.trial_ends_at > now(), false) AS "inFreeMonths"
      FROM stores s
      LEFT JOIN store_subscriptions sub ON sub.store_id = s.id
      ORDER BY s.name, s.id
    `,
  );
}

export type AssistantChatMonthRow = {
  storeId: string;
  storeName: string;
  chats: number;
  subscriptionPlan: string | null;
  subscriptionStatus: string | null;
  overridePlan: string | null;
};

/** Every store with chats in the month, with its subscription, for the platform admin (#545). */
export async function listAssistantChatMonthRows(month: string): Promise<AssistantChatMonthRow[]> {
  return platformAdminTransaction((tx) =>
    tx.$queryRaw<AssistantChatMonthRow[]>`
      SELECT m.store_id AS "storeId", s.name AS "storeName", m.chats,
             sub.plan AS "subscriptionPlan", sub.status AS "subscriptionStatus",
             CASE WHEN sub.override_ends_at > now() THEN sub.override_plan END AS "overridePlan"
      FROM assistant_chat_months m
      JOIN stores s ON s.id = m.store_id
      LEFT JOIN store_subscriptions sub ON sub.store_id = m.store_id
      WHERE m.month = CAST(${month} AS date) AND m.chats > 0
    `,
  );
}

/** Marks the month's owner warning sent. False when it already was. */
export async function claimAssistantChatWarning(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
  month: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ store_id: string }[]>`
    UPDATE assistant_chat_months SET warned_at = now()
    WHERE store_id = ${storeId} AND month = ${month}::date AND warned_at IS NULL
    RETURNING store_id`;
  return rows.length > 0;
}

/** Great-circle miles from the point to the row's lat/lng columns, in SQL (no PostGIS, ADR-0012). */
function haversineMilesSql(point: { lat: number; lng: number }, alias: "s" | "z"): Prisma.Sql {
  const lat = Prisma.raw(`${alias}.lat`);
  const lng = Prisma.raw(`${alias}.lng`);
  return Prisma.sql`(2 * ${EARTH_RADIUS_MI}::float8 * asin(sqrt(LEAST(1,
    power(sin(radians(${lat} - ${point.lat}::float8) / 2), 2)
    + cos(radians(${point.lat}::float8)) * cos(radians(${lat})) * power(sin(radians(${lng} - ${point.lng}::float8) / 2), 2)))))`;
}

/** Listed, active, located stores nearest the point first (Store directory near me, #452). */
export function listedStoresByDistance(
  point: { lat: number; lng: number },
  limit: number,
): Promise<{ slug: string; distance: number }[]> {
  return appUserQuery((tx) => tx.$queryRaw<{ slug: string; distance: number }[]>`
    SELECT slug, distance FROM (
      SELECT s.slug, ${haversineMilesSql(point, "s")} AS distance
      FROM stores s
      WHERE s.listed AND s.status = 'active' AND s.lat IS NOT NULL AND s.lng IS NOT NULL
    ) d
    ORDER BY distance, slug
    LIMIT ${limit}`);
}

/** True when the point is within some Gazetteer ZIP's reach; bandDeg bounds the latitude scan (#452). */
export async function pointWithinZipReach(point: { lat: number; lng: number }, bandDeg: number): Promise<boolean> {
  const rows = await appUserQuery((tx) => tx.$queryRaw<{ hit: number }[]>`
    SELECT 1 AS hit FROM gazetteer_zips z
    WHERE z.lat BETWEEN ${point.lat - bandDeg}::float8 AND ${point.lat + bandDeg}::float8
      AND ${haversineMilesSql(point, "z")} <= z.reach_mi
    LIMIT 1`);
  return rows.length > 0;
}

/** One courier incident row as the incident log query returns it (#536). */
export type CourierIncidentRaw = {
  orderId: string;
  storeId: string;
  storeName: string;
  orderNumber: number;
  orderStatus: string;
  providers: string[] | null;
  kinds: string[];
  openedAt: Date;
  lastAt: Date;
  resolvedAt: Date | null;
  deliveryStatus: string | null;
};

type RawQueryable = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * The courier incident log (#536): incidents derived on read from delivery_events, one row per order, newest first,
 * in one query. Every filter compares exactly. What `tx` may see decides the stores: RLS applies.
 */
export async function findCourierIncidentRows(
  tx: RawQueryable,
  q: {
    storeId?: string;
    orderId?: string;
    provider?: string;
    kind?: string;
    from?: Date;
    toExclusive?: Date;
    cursor?: { at: Date; orderId: string };
    limit: number;
  },
): Promise<CourierIncidentRaw[]> {
  const eventScope = [
    q.storeId ? Prisma.sql`AND e.store_id = ${q.storeId}` : Prisma.empty,
    q.orderId ? Prisma.sql`AND e.order_id = ${q.orderId}` : Prisma.empty,
  ];
  const where = [
    q.provider ? Prisma.sql`AND ${q.provider} = ANY(p.providers)` : Prisma.empty,
    q.kind ? Prisma.sql`AND ${q.kind} = ANY(i.kinds)` : Prisma.empty,
    q.from ? Prisma.sql`AND i.opened_at >= ${q.from}::timestamp(3)` : Prisma.empty,
    q.toExclusive ? Prisma.sql`AND i.opened_at < ${q.toExclusive}::timestamp(3)` : Prisma.empty,
    q.cursor ? Prisma.sql`AND (i.opened_at, i.order_id) < (${q.cursor.at}::timestamp(3), ${q.cursor.orderId})` : Prisma.empty,
  ];
  return tx.$queryRaw<CourierIncidentRaw[]>`
    WITH signals AS (
      SELECT e.store_id, e.order_id, e.created_at AS at,
        CASE
          WHEN e.type = 'failover_triggered' THEN 'failover'
          WHEN e.type = 'both_failed' THEN 'both_failed'
          WHEN e.type = 'returned'
            OR (e.type = 'cancelled' AND COALESCE(e.payload->>'cancellation_reason', e.payload->>'reason') = 'failed_to_return')
            THEN 'returned'
          -- A cancel the platform made itself (failover replaced the delivery, a pushed ready time rebooked it, or the
          -- order was cancelled) is not the provider's.
          WHEN e.type = 'cancelled' AND o.status <> 'CANCELLED' AND NOT EXISTS (
              SELECT 1 FROM delivery_events f
              WHERE f.store_id = e.store_id AND f.order_id = e.order_id AND f.delivery_id = e.delivery_id
                AND (f.type = 'failover_triggered' OR (f.type = 'cancelled' AND f.payload->>'by' = 'platform'))
            ) THEN 'provider_cancelled'
          -- The deadline the assignment timer uses: the later of the timeout after booking and the ready time.
          WHEN e.type = 'courier_assigned'
            AND e.created_at > GREATEST(d.created_at + make_interval(secs => ps.courier_assignment_timeout_s), d.pickup_ready_at)
            THEN 'assigned_late'
          WHEN e.type = 'delivered' AND d.proof_url IS NULL AND d.pin IS NULL THEN 'delivered_no_proof'
        END AS kind
      FROM delivery_events e
      JOIN orders o ON o.id = e.order_id AND o.store_id = e.store_id
      LEFT JOIN deliveries d ON d.id = e.delivery_id AND d.store_id = e.store_id
      CROSS JOIN (SELECT courier_assignment_timeout_s FROM platform_settings WHERE id = 'platform') ps
      WHERE e.type IN ('failover_triggered', 'both_failed', 'cancelled', 'returned', 'courier_assigned', 'delivered')
        AND o.fulfillment = 'courier'
        ${eventScope[0]} ${eventScope[1]}
    ),
    incidents AS (
      SELECT store_id, order_id, min(at) AS opened_at, max(at) AS last_at, array_agg(DISTINCT kind ORDER BY kind) AS kinds
      FROM signals
      WHERE kind IS NOT NULL
      GROUP BY store_id, order_id
    )
    SELECT i.order_id AS "orderId", i.store_id AS "storeId", s.name AS "storeName", o.number AS "orderNumber",
      o.status AS "orderStatus", p.providers, i.kinds, i.opened_at AS "openedAt", i.last_at AS "lastAt",
      r.resolved_at AS "resolvedAt", ld.status AS "deliveryStatus"
    FROM incidents i
    JOIN orders o ON o.id = i.order_id AND o.store_id = i.store_id
    JOIN stores s ON s.id = i.store_id
    LEFT JOIN LATERAL (
      SELECT array_agg(provider ORDER BY first_at) AS providers
      FROM (
        SELECT provider, min(at) AS first_at
        FROM (
          SELECT d.provider, d.created_at AS at FROM deliveries d WHERE d.store_id = i.store_id AND d.order_id = i.order_id
          UNION ALL
          -- A create error leaves no delivery row; its failover event names the courier that refused.
          SELECT f.payload->>'fromProvider', f.created_at FROM delivery_events f
          WHERE f.store_id = i.store_id AND f.order_id = i.order_id AND f.type = 'failover_triggered' AND f.delivery_id IS NULL
        ) tried
        WHERE provider IS NOT NULL
        GROUP BY provider
      ) firsts
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT max(n.created_at) AS resolved_at FROM courier_incident_notes n
      WHERE n.store_id = i.store_id AND n.order_id = i.order_id AND n.resolves
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT d.status FROM deliveries d WHERE d.store_id = i.store_id AND d.order_id = i.order_id ORDER BY d.created_at DESC LIMIT 1
    ) ld ON true
    WHERE true ${where[0]} ${where[1]} ${where[2]} ${where[3]} ${where[4]}
    ORDER BY i.opened_at DESC, i.order_id DESC
    LIMIT ${q.limit}
  `;
}

/** Every delivery event on one order, oldest first, with its courier (#536). Payloads are raw: redact before render. */
export async function findCourierIncidentEvents(tx: RawQueryable, storeId: string, orderId: string) {
  return tx.$queryRaw<Array<{ id: string; type: string; at: Date; payload: unknown; provider: string | null }>>`
    SELECT e.id, e.type, e.created_at AS at, e.payload, COALESCE(d.provider, e.payload->>'fromProvider') AS provider
    FROM delivery_events e
    LEFT JOIN deliveries d ON d.id = e.delivery_id AND d.store_id = e.store_id
    WHERE e.store_id = ${storeId} AND e.order_id = ${orderId}
    ORDER BY e.created_at, e.id
  `;
}

/** The admins' notes on one courier incident, oldest first (#536). */
export async function findCourierIncidentNotes(tx: RawQueryable, storeId: string, orderId: string) {
  return tx.$queryRaw<Array<{ id: string; authorEmail: string; body: string; resolves: boolean; createdAt: Date }>>`
    SELECT id, author_email AS "authorEmail", body, resolves, created_at AS "createdAt"
    FROM courier_incident_notes
    WHERE store_id = ${storeId} AND order_id = ${orderId}
    ORDER BY created_at, id
  `;
}

/** Great-circle miles between two rows' lat/lng columns, in SQL (#455). */
function haversineColumnsSql(a: "z", b: "s"): Prisma.Sql {
  const [aLat, aLng, bLat, bLng] = [`${a}.lat`, `${a}.lng`, `${b}.lat`, `${b}.lng`].map((c) => Prisma.raw(c));
  return Prisma.sql`(2 * ${EARTH_RADIUS_MI}::float8 * asin(sqrt(LEAST(1,
    power(sin(radians(${bLat} - ${aLat}) / 2), 2)
    + cos(radians(${aLat})) * cos(radians(${bLat})) * power(sin(radians(${bLng} - ${aLng}) / 2), 2)))))`;
}

/** A shopper's "tell me when a store opens" request (#455). The insert policy lets any app_user add one; a repeat is ignored. */
export async function insertDirectoryStoreRequest(row: { id: string; zip: string; email: string | null; phone: string | null; consentText: string }): Promise<void> {
  await appUserQuery((tx) => tx.$executeRaw`
    INSERT INTO directory_store_requests (id, zip, email, phone, consent_text)
    VALUES (${row.id}, ${row.zip}, ${row.email}, ${row.phone}, ${row.consentText})
    ON CONFLICT DO NOTHING`);
}

export interface DirectoryRequestMatch {
  id: string;
  zip: string;
  email: string | null;
  phone: string | null;
  storeId: string;
  slug: string;
  name: string;
  city: string | null;
  state: string | null;
  distance: number;
}

/** Waiting requests with a listed, active store within `miles` of their ZIP, each with its nearest such store, in id order after the cursor. */
export function findDirectoryRequestMatches(afterId: string, miles: number, limit: number): Promise<DirectoryRequestMatch[]> {
  return platformAdminRawQuery<DirectoryRequestMatch>(Prisma.sql`
    SELECT DISTINCT ON (r.id) r.id, r.zip, r.email, r.phone, s.id AS "storeId", s.slug, s.name, s.city, s.state,
      ${haversineColumnsSql("z", "s")} AS distance
    FROM directory_store_requests r
    JOIN gazetteer_zips z ON z.zip = r.zip
    JOIN stores s ON s.listed AND s.status = 'active' AND s.lat IS NOT NULL AND s.lng IS NOT NULL
      AND s.lat BETWEEN z.lat - ${miles / 69}::float8 AND z.lat + ${miles / 69}::float8
    WHERE r.notified_at IS NULL AND r.id > ${afterId} AND ${haversineColumnsSql("z", "s")} <= ${miles}::float8
    ORDER BY r.id, distance, s.slug
    LIMIT ${limit}`);
}

/** The one message went out: keep the ZIP and dates, erase the contact. False when another run got there first. */
export async function markDirectoryRequestNotified(id: string, storeId: string): Promise<boolean> {
  const rows = await platformAdminRawQuery<{ id: string }>(Prisma.sql`
    UPDATE directory_store_requests SET notified_at = now(), notified_store_id = ${storeId}, email = NULL, phone = NULL
    WHERE id = ${id} AND notified_at IS NULL
    RETURNING id`);
  return rows.length > 0;
}

export interface DirectoryRequestCount {
  zip: string;
  waiting: number;
  notified: number;
  latest: Date;
}

/** Request counts per ZIP (#455). Never returns a contact. */
export function directoryRequestCounts(): Promise<DirectoryRequestCount[]> {
  return platformAdminRawQuery<DirectoryRequestCount>(Prisma.sql`
    SELECT r.zip,
      count(*) FILTER (WHERE r.notified_at IS NULL)::int AS waiting,
      count(*) FILTER (WHERE r.notified_at IS NOT NULL)::int AS notified,
      max(r.created_at) AS latest
    FROM directory_store_requests r
    GROUP BY r.zip`);
}

/** For each ZIP, the nearest Gazetteer place in the given state (a nearest place anywhere can be across a state line). */
export async function nearestPlacesInState(zips: { zip: string; state: string }[]): Promise<Map<string, string>> {
  if (zips.length === 0) return new Map();
  const rows = await appUserQuery((tx) => tx.$queryRaw<{ zip: string; name: string }[]>`
    SELECT q.zip, p.name
    FROM unnest(${zips.map((z) => z.zip)}::text[], ${zips.map((z) => z.state)}::text[]) AS q(zip, state)
    JOIN gazetteer_zips z ON z.zip = q.zip
    JOIN LATERAL (
      SELECT g.name FROM gazetteer_places g
      WHERE g.state = q.state
      ORDER BY power(g.lat - z.lat, 2) + power((g.lng - z.lng) * cos(radians(z.lat)), 2)
      LIMIT 1
    ) p ON true`);
  return new Map(rows.map((row) => [row.zip, row.name]));
}
