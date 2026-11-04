import { Client } from "pg";
import { resolveDirectUrl } from "./env";
import { CatalogPruneRefusal, missingUpsertedIds, type DatabaseIdentity } from "./catalog-prune";

const REFERENCE_SQL = `
SELECT image_ref FROM (
  SELECT image_url AS image_ref FROM master_products
  UNION ALL
  SELECT image_url FROM categories
  UNION ALL
  SELECT image_url FROM store_banners
  UNION ALL
  SELECT image_url FROM store_collections
  UNION ALL
  SELECT logo_url FROM stores
  UNION ALL
  SELECT owner_photo_url FROM stores
  UNION ALL
  SELECT image FROM users
) AS refs
WHERE image_ref IS NOT NULL AND image_ref <> ''
`;

export type ReferenceRead = {
  references: string[];
  masterProductIds: string[];
};

/**
 * One REPEATABLE READ, READ ONLY transaction. The reference columns are a
 * single statement so a commit that moves a URL between columns cannot hide
 * it. Scope is checked inside the transaction: app_user, read-only, and
 * platform admin. A query error aborts; it never becomes an empty list.
 *
 * Not for routes or server actions. The seed CLI is the only production caller.
 */
export async function readCatalogImageReferences(options?: {
  connectionString?: string;
  skipAdmin?: boolean;
  afterSnapshot?: (client: Client) => Promise<void>;
}): Promise<ReferenceRead> {
  return withReferenceReadClient(async (client) => {
    const references = await client.query<{ image_ref: string }>(REFERENCE_SQL);
    const ids = await client.query<{ id: string }>("SELECT id FROM master_products");
    return {
      references: references.rows.map((row) => row.image_ref),
      masterProductIds: ids.rows.map((row) => row.id),
    };
  }, options);
}

export async function withReferenceReadClient<T>(
  fn: (client: Client) => Promise<T>,
  options?: {
    connectionString?: string;
    skipAdmin?: boolean;
    afterSnapshot?: (client: Client) => Promise<void>;
  },
): Promise<T> {
  const client = new Client({
    connectionString: options?.connectionString ?? resolveDirectUrl(),
  });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL ROLE app_user");
    if (!options?.skipAdmin) {
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    }
    const scope = await client.query<{ role: string; ro: string; admin: string | null }>(
      "SELECT current_user AS role, current_setting('transaction_read_only') AS ro, current_setting('app.is_platform_admin', true) AS admin",
    );
    const row = scope.rows[0];
    if (!row || row.role !== "app_user" || row.ro !== "on" || row.admin !== "true") {
      throw new CatalogPruneRefusal(
        "Refusing catalog prune: reference read scope is not platform-admin read-only",
      );
    }
    if (options?.afterSnapshot) await options.afterSnapshot(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function assertUpsertsVisible(presentIds: readonly string[], upsertedIds: readonly string[]): void {
  const missing = missingUpsertedIds(presentIds, upsertedIds);
  if (missing.length > 0) {
    throw new CatalogPruneRefusal(
      "Refusing catalog prune: upserted master products are not all visible",
    );
  }
}

export async function observeDatabaseIdentity(connectionString?: string): Promise<DatabaseIdentity> {
  const client = new Client({ connectionString: connectionString ?? resolveDirectUrl() });
  await client.connect();
  try {
    const result = await client.query<{ database: string; host: string; port: string }>(
      "SELECT current_database() AS database, COALESCE(inet_server_addr()::text, '127.0.0.1') AS host, inet_server_port()::text AS port",
    );
    const row = result.rows[0];
    if (!row?.database || !row.host || !row.port) {
      throw new CatalogPruneRefusal(
        "Refusing catalog prune: the effective database connection was not observed",
      );
    }
    return { host: row.host, port: String(row.port), database: row.database };
  } catch (error) {
    if (error instanceof CatalogPruneRefusal) throw error;
    throw new CatalogPruneRefusal(
      "Refusing catalog prune: the effective database connection was not observed",
    );
  } finally {
    await client.end();
  }
}
