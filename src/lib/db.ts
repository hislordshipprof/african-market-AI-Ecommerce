import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runtimeDatabaseUrl } from "./env";
import type { QueryRawFn } from "./health";

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
  const adapter = new PrismaPg(connectionUrl!);
  globalForPrisma.prisma = new PrismaClient({ adapter });
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
    aiConversation: wrapDelegate(storeId, prisma.aiConversation),
    aiAction: wrapDelegate(storeId, prisma.aiAction),
    assistantUndoReceipt: wrapDelegate(storeId, prisma.assistantUndoReceipt),
    guestBrowserCart: wrapDelegate(storeId, prisma.guestBrowserCart),
    assistantCheckoutDraft: wrapDelegate(storeId, prisma.assistantCheckoutDraft),
    assistantCheckoutAttempt: wrapDelegate(storeId, prisma.assistantCheckoutAttempt),
    assistantCheckoutToken: wrapDelegate(storeId, prisma.assistantCheckoutToken),
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
  fn: (tx: Pick<PrismaClient, "store" | "order" | "auditLog" | "storeMembership" | "storeInvite" | "masterProduct" | "category" | "productSynonym" | "aiConversation" | "aiAction" | "$queryRaw" | "$executeRaw">) => Promise<T>,
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
      storeMembership: tx.storeMembership,
      storeInvite: tx.storeInvite,
      masterProduct: tx.masterProduct,
      category: tx.category,
      productSynonym: tx.productSynonym,
      aiConversation: tx.aiConversation,
      aiAction: tx.aiAction,
      $queryRaw: tx.$queryRaw.bind(tx),
      $executeRaw: tx.$executeRaw.bind(tx),
    });
  });
}

export interface TransactionOptions {
  timeout?: number;
  maxWait?: number;
}

export async function storeScopedTransaction<T>(
  storeId: string,
  fn: (tx: Pick<PrismaClient, "listing" | "listingVariant" | "listingImport" | "stockEvent" | "auditLog" | "cart" | "cartLine" | "customer" | "order" | "orderLine" | "paymentIntentRelease" | "refundRequest" | "aiConversation" | "aiAction" | "assistantUndoReceipt" | "guestBrowserCart" | "assistantCheckoutDraft" | "assistantCheckoutAttempt" | "assistantCheckoutToken" | "$queryRaw" | "$executeRaw">) => Promise<T>,
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
      aiConversation: tx.aiConversation,
      aiAction: tx.aiAction,
      assistantUndoReceipt: tx.assistantUndoReceipt,
      guestBrowserCart: tx.guestBrowserCart,
      assistantCheckoutDraft: tx.assistantCheckoutDraft,
      assistantCheckoutAttempt: tx.assistantCheckoutAttempt,
      assistantCheckoutToken: tx.assistantCheckoutToken,
      $queryRaw: tx.$queryRaw.bind(tx),
      $executeRaw: tx.$executeRaw.bind(tx),
    });
  }, { timeout: opts?.timeout, maxWait: opts?.maxWait });
}

/**
 * Explicit row-lock order. A transaction that takes more than one of these
 * locks takes them in this order:
 *
 *   store row → cart row → cart lines → listing row → listing variants (id order)
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
 * This is the order of explicit competing locks, not every lock Postgres
 * takes. Order-line inserts take an implicit key-share on listing variants
 * after the cart lock. A listing save may take an implicit key-share on the
 * store row (audit-log foreign key) after the listing lock. Those implicit
 * locks are not upgraded to FOR UPDATE in the same transaction, so they are
 * not part of this order. Checkout does not lock variants FOR UPDATE, and
 * cart or listing writes do not take a store lock just to match this list.
 */
export async function lockConversationRow(tx: Pick<PrismaClient, "$queryRaw">, conversationId: string) {
  await tx.$queryRaw`SELECT id FROM ai_conversations WHERE id = ${conversationId} FOR UPDATE`;
}

export async function lockStoreRow(tx: Pick<PrismaClient, "$queryRaw">, storeId: string) {
  await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${storeId} FOR UPDATE`;
}

/** UTC wall time from the database, read after the store and cart locks. */
export async function readDatabaseNow(tx: Pick<PrismaClient, "$queryRaw">): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now
  `;
  const now = rows[0]?.now;
  if (!now) throw new Error("Database clock is unavailable");
  return now;
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

export async function findOrphanedAuthorizedOrders(): Promise<Array<{ id: string; storeId: string }>> {
  const cutoff = new Date(Date.now() - 60_000);
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; store_id: string }>>`
      SELECT id, store_id FROM orders
      WHERE status = 'AUTHORIZED'
        AND inngest_event_sent_at IS NULL
        AND created_at < ${cutoff}
      ORDER BY created_at ASC
      LIMIT 50
    `;
    return rows.map((r) => ({ id: r.id, storeId: r.store_id }));
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

export async function findStuckTransitionalOrders(): Promise<Array<{ id: string; storeId: string }>> {
  const cutoff = new Date(Date.now() - 5 * 60_000);
  return platformAdminTransaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; store_id: string }>>`
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

export interface StoreCheckoutShift {
  status: string;
  pickupEnabled: boolean;
  minimumOrderCents: number;
  prepTimeMinutes: number;
  timezone: string;
  hours: Prisma.JsonValue;
  stripeOnboardingStatus: string;
  stripeAccountId: string | null;
}

export async function readStoreCheckoutShift(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
): Promise<StoreCheckoutShift | null> {
  const rows = await tx.$queryRaw<Array<{
    status: string;
    pickup_enabled: boolean;
    minimum_order_cents: number;
    prep_time_minutes: number;
    timezone: string;
    hours: Prisma.JsonValue;
    stripe_onboarding_status: string;
    stripe_account_id: string | null;
  }>>`
    SELECT status, pickup_enabled, minimum_order_cents, prep_time_minutes, timezone, hours,
           stripe_onboarding_status, stripe_account_id
    FROM stores WHERE id = ${storeId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    pickupEnabled: row.pickup_enabled,
    minimumOrderCents: row.minimum_order_cents,
    prepTimeMinutes: row.prep_time_minutes,
    timezone: row.timezone,
    hours: row.hours,
    stripeOnboardingStatus: row.stripe_onboarding_status,
    stripeAccountId: row.stripe_account_id,
  };
}

export async function orderCancelWindowOpen(tx: Pick<PrismaClient, "$queryRaw">, orderId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ open: boolean }>>`
    SELECT (cancellable_until IS NOT NULL AND cancellable_until > (clock_timestamp() AT TIME ZONE 'UTC')) AS open
    FROM orders WHERE id = ${orderId}
  `;
  return rows[0]?.open === true;
}

export async function visibleStoreOrderIds(
  tx: Pick<PrismaClient, "$queryRaw">,
  storeId: string,
  statuses: readonly string[],
  resolvedIds: readonly string[],
): Promise<string[]> {
  if (statuses.length === 0 && resolvedIds.length === 0) return [];
  const statusClause = statuses.length > 0
    ? Prisma.sql`status IN (${Prisma.join([...statuses])})`
    : Prisma.sql`FALSE`;
  const resolvedClause = resolvedIds.length > 0
    ? Prisma.sql`OR (id IN (${Prisma.join([...resolvedIds])}) AND status = 'CANCELLED')`
    : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM orders
    WHERE store_id = ${storeId}
      AND (cancellable_until IS NULL OR cancellable_until <= (clock_timestamp() AT TIME ZONE 'UTC'))
      AND (${statusClause} ${resolvedClause})
  `;
  return rows.map((row) => row.id);
}

export async function stampCancelWindow(
  tx: Pick<PrismaClient, "$executeRaw">,
  orderId: string,
  minutes: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE orders
    SET cancellable_until = (clock_timestamp() AT TIME ZONE 'UTC') + (${minutes} * INTERVAL '1 minute')
    WHERE id = ${orderId}
  `;
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

export async function rateLimitUpsert(
  key: string,
  now: bigint,
  windowStart: bigint,
): Promise<{ count: number; lastRequest: bigint }> {
  const rows = await prisma.$queryRaw<Array<{ count: number; last_request: bigint }>>`
    INSERT INTO rate_limits (id, key, count, last_request)
    VALUES (gen_random_uuid()::text, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.last_request < ${windowStart}
        THEN 1
        ELSE rate_limits.count + 1
      END,
      last_request = CASE
        WHEN rate_limits.last_request < ${windowStart}
        THEN ${now}
        ELSE rate_limits.last_request
      END
    RETURNING count, last_request
  `;
  return { count: Number(rows[0].count), lastRequest: BigInt(rows[0].last_request) };
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
  return deleteExpiredBatch(batchKey, async (tx) => {
    const doomed = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ai_conversations
      WHERE created_at < ${cutoff}
        AND (in_flight_until IS NULL OR in_flight_until <= ${now})
      ORDER BY created_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;
    if (doomed.length === 0) return [{ deleted: 0 }];
    const ids = doomed.map((row) => row.id);
    await tx.$executeRaw`
      UPDATE assistant_checkout_attempts
      SET status = CASE WHEN status = 'open' THEN 'superseded' ELSE status END,
          conversation_id = NULL,
          contact_name = CASE WHEN status IN ('reserved', 'awaiting_payment') THEN contact_name ELSE NULL END,
          contact_email = CASE WHEN status IN ('reserved', 'awaiting_payment') THEN contact_email ELSE NULL END,
          contact_phone = CASE WHEN status IN ('reserved', 'awaiting_payment') THEN contact_phone ELSE NULL END
      WHERE conversation_id IN (${Prisma.join(ids)})
    `;
    return tx.$queryRaw<Array<{ deleted: number }>>`
      WITH removed AS (
        DELETE FROM ai_conversations
        WHERE id IN (${Prisma.join(ids)})
          AND (in_flight_until IS NULL OR in_flight_until <= ${now})
        RETURNING id
      )
      SELECT count(*)::int AS deleted FROM removed
    `;
  });
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
