import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { runtimeDatabaseUrl } from "./env";
import type { QueryRawFn } from "./health";
import { VITEST_TRANSACTION_MAX_WAIT_MS } from "./test-prisma";

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

export function storeScoped(storeId: string) {
  return {
    rlsTestFixture: wrapDelegate(storeId, prisma.rlsTestFixture),
    storeMembership: wrapDelegate(storeId, prisma.storeMembership),
    storeInvite: wrapDelegate(storeId, prisma.storeInvite),
    listing: wrapDelegate(storeId, prisma.listing),
    listingVariant: wrapDelegate(storeId, prisma.listingVariant),
    listingImport: wrapDelegate(storeId, prisma.listingImport),
    stockEvent: wrapDelegate(storeId, prisma.stockEvent),
    auditLog: wrapDelegate(storeId, prisma.auditLog),
    storeBanner: wrapDelegate(storeId, prisma.storeBanner),
    storeCollection: wrapDelegate(storeId, prisma.storeCollection),
    storeCollectionListing: wrapDelegate(storeId, prisma.storeCollectionListing),
    cart: wrapDelegate(storeId, prisma.cart),
    cartLine: wrapDelegate(storeId, prisma.cartLine),
    customer: wrapDelegate(storeId, prisma.customer),
    order: wrapDelegate(storeId, prisma.order),
    orderLine: wrapDelegate(storeId, prisma.orderLine),
    refundRequest: wrapDelegate(storeId, prisma.refundRequest),
    issueReport: wrapDelegate(storeId, prisma.issueReport),
    substitutionRequest: wrapDelegate(storeId, prisma.substitutionRequest),
    aiConversation: wrapDelegate(storeId, prisma.aiConversation),
    aiAction: wrapDelegate(storeId, prisma.aiAction),
    assistantUndoReceipt: wrapDelegate(storeId, prisma.assistantUndoReceipt),
    guestBrowserCart: wrapDelegate(storeId, prisma.guestBrowserCart),
    copilotConversation: wrapDelegate(storeId, prisma.copilotConversation),
    copilotClientMessage: wrapDelegate(storeId, prisma.copilotClientMessage),
    stockProposal: wrapDelegate(storeId, prisma.stockProposal),
    copilotAlert: wrapDelegate(storeId, prisma.copilotAlert),
    ownerReport: wrapDelegate(storeId, prisma.ownerReport),
    ownerReportItem: wrapDelegate(storeId, prisma.ownerReportItem),
    notificationLog: wrapDelegate(storeId, prisma.notificationLog),
    delivery: wrapDelegate(storeId, prisma.delivery),
    deliveryEvent: wrapDelegate(storeId, prisma.deliveryEvent),
    pushSubscription: wrapDelegate(storeId, prisma.pushSubscription),
    supportThread: wrapDelegate(storeId, prisma.supportThread),
    supportMessage: wrapDelegate(storeId, prisma.supportMessage),
    storeSubscription: wrapDelegate(storeId, prisma.storeSubscription),
    assistantChatMonth: wrapDelegate(storeId, prisma.assistantChatMonth),
  };
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

export async function customerScopedTransaction<T>(
  userId: string,
  fn: (
    tx: Pick<
      PrismaClient,
      "platformCustomerProfile" | "customerAddress" | "cardSaveConsent" | "$queryRaw" | "$executeRaw"
    >,
  ) => Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  const id = assertCustomerUserId(userId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.user_id', ${id}, true)`;
    return fn({
      platformCustomerProfile: tx.platformCustomerProfile,
      customerAddress: tx.customerAddress,
      cardSaveConsent: tx.cardSaveConsent,
      $queryRaw: tx.$queryRaw.bind(tx),
      $executeRaw: tx.$executeRaw.bind(tx),
    });
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

export async function platformAdminTransaction<T>(
  fn: (tx: Pick<PrismaClient, "store" | "order" | "auditLog" | "refundRequest" | "storeMembership" | "storeInvite" | "masterProduct" | "category" | "productSynonym" | "ingredient" | "ingredientSynonym" | "masterProductIngredient" | "attributeProposal" | "aiConversation" | "aiAction" | "supportThread" | "supportMessage" | "storeSubscription" | "$queryRaw" | "$executeRaw">) => Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    const zone = sessionTimeZone.getStore();
    if (zone) {
      await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
    }
    return fn({
      store: tx.store,
      order: tx.order,
      auditLog: tx.auditLog,
      refundRequest: tx.refundRequest,
      storeMembership: tx.storeMembership,
      storeInvite: tx.storeInvite,
      masterProduct: tx.masterProduct,
      category: tx.category,
      productSynonym: tx.productSynonym,
      ingredient: tx.ingredient,
      ingredientSynonym: tx.ingredientSynonym,
      masterProductIngredient: tx.masterProductIngredient,
      attributeProposal: tx.attributeProposal,
      aiConversation: tx.aiConversation,
      aiAction: tx.aiAction,
      supportThread: tx.supportThread,
      supportMessage: tx.supportMessage,
      storeSubscription: tx.storeSubscription,
      $queryRaw: tx.$queryRaw.bind(tx),
      $executeRaw: tx.$executeRaw.bind(tx),
    });
  }, opts);
}

export interface TransactionOptions {
  timeout?: number;
  maxWait?: number;
}

export async function storeScopedTransaction<T>(
  storeId: string,
  fn: (tx: Pick<PrismaClient, "listing" | "listingVariant" | "listingImport" | "stockEvent" | "auditLog" | "cart" | "cartLine" | "customer" | "order" | "orderLine" | "paymentIntentRelease" | "refundRequest" | "issueReport" | "substitutionRequest" | "aiConversation" | "aiAction" | "assistantUndoReceipt" | "guestBrowserCart" | "copilotConversation" | "copilotClientMessage" | "stockProposal" | "copilotAlert" | "copilotDigest" | "ownerReport" | "ownerReportItem" | "notificationLog" | "delivery" | "deliveryEvent" | "pushSubscription" | "supportThread" | "supportMessage" | "listingAttributes" | "listingIngredient" | "ingredient" | "ingredientSynonym" | "storeSubscription" | "$queryRaw" | "$executeRaw">) => Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`;
    const zone = sessionTimeZone.getStore();
    if (zone) {
      await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
    }
    return fn({
      listing: tx.listing,
      listingVariant: tx.listingVariant,
      listingImport: tx.listingImport,
      stockEvent: tx.stockEvent,
      auditLog: tx.auditLog,
      cart: tx.cart,
      cartLine: tx.cartLine,
      customer: tx.customer,
      order: tx.order,
      orderLine: tx.orderLine,
      paymentIntentRelease: tx.paymentIntentRelease,
      refundRequest: tx.refundRequest,
      issueReport: tx.issueReport,
      substitutionRequest: tx.substitutionRequest,
      aiConversation: tx.aiConversation,
      aiAction: tx.aiAction,
      assistantUndoReceipt: tx.assistantUndoReceipt,
      guestBrowserCart: tx.guestBrowserCart,
      copilotConversation: tx.copilotConversation,
      copilotClientMessage: tx.copilotClientMessage,
      stockProposal: tx.stockProposal,
      copilotAlert: tx.copilotAlert,
      copilotDigest: tx.copilotDigest,
      ownerReport: tx.ownerReport,
      ownerReportItem: tx.ownerReportItem,
      notificationLog: tx.notificationLog,
      delivery: tx.delivery,
      deliveryEvent: tx.deliveryEvent,
      pushSubscription: tx.pushSubscription,
      supportThread: tx.supportThread,
      supportMessage: tx.supportMessage,
      listingAttributes: tx.listingAttributes,
      listingIngredient: tx.listingIngredient,
      storeSubscription: tx.storeSubscription,
      ingredient: tx.ingredient,
      ingredientSynonym: tx.ingredientSynonym,
      $queryRaw: tx.$queryRaw.bind(tx),
      $executeRaw: tx.$executeRaw.bind(tx),
    });
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
  }>>`
    SELECT store_delivery_enabled, store_delivery_fee_cents, delivery_radius_mi, lat, lng
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
const NOTIFICATION_EXPIRE_MS = 2 * 60 * 60_000;

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
  const inStores = opts?.storeIds ? Prisma.sql`AND store_id IN (${Prisma.join(opts.storeIds)})` : Prisma.empty;
  return platformAdminTransaction(async (tx) => {
    const count = await tx.$executeRaw`
      UPDATE notification_logs
      SET status = 'failed', reason = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'sending')
        AND created_at <= ${cutoff}
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

/** Creates the store's billing row if missing and locks it for this transaction (#494). */
export async function lockStoreSubscriptionRow(tx: Pick<PrismaClient, "$executeRaw" | "$queryRaw">, storeId: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO store_subscriptions (store_id) VALUES (${storeId}) ON CONFLICT (store_id) DO NOTHING`;
  await tx.$queryRaw`SELECT store_id FROM store_subscriptions WHERE store_id = ${storeId} FOR UPDATE`;
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
