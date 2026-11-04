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
  };
}

export type StoreScopedClient = ReturnType<typeof storeScoped>;

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

export async function platformAdminTransaction<T>(
  fn: (tx: Pick<PrismaClient, "store" | "auditLog" | "storeMembership" | "storeInvite" | "masterProduct" | "category" | "productSynonym" | "$queryRaw">) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn({ store: tx.store, auditLog: tx.auditLog, storeMembership: tx.storeMembership, storeInvite: tx.storeInvite, masterProduct: tx.masterProduct, category: tx.category, productSynonym: tx.productSynonym, $queryRaw: tx.$queryRaw.bind(tx) });
  });
}

export interface TransactionOptions {
  timeout?: number;
  maxWait?: number;
}

export async function storeScopedTransaction<T>(
  storeId: string,
  fn: (tx: Pick<PrismaClient, "listing" | "listingVariant" | "listingImport" | "stockEvent" | "auditLog" | "cart" | "cartLine" | "customer" | "order" | "orderLine" | "$queryRaw" | "$executeRaw">) => Promise<T>,
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
export async function lockStoreRow(tx: Pick<PrismaClient, "$queryRaw">, storeId: string) {
  await tx.$queryRaw`SELECT 1 FROM stores WHERE id = ${storeId} FOR UPDATE`;
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
      SELECT id, store_id FROM orders
      WHERE status IN ('CAPTURING', 'CANCELLING')
        AND updated_at < ${cutoff}
      ORDER BY updated_at ASC
      LIMIT 50
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
    SET status = 'committed', committed_at = (NOW() AT TIME ZONE 'UTC')
    WHERE id = ${importToken}
      AND status IN ('pending', 'failed')
      AND created_at > (NOW() AT TIME ZONE 'UTC') - ${ttlInterval}
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
): Promise<{ count: number }> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
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
    RETURNING count
  `;
  return { count: Number(rows[0].count) };
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
