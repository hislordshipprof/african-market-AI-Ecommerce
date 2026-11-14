import { describe, expect, it } from "vitest";
import { affectedTablesInMigrateDiff } from "./migrate-diff-tables";

const ELEVEN = `
ALTER TABLE "accounts" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "categories" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "listings" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "master_products" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "product_synonyms" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "sessions" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "store_banners" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "store_collections" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "stores" ADD COLUMN "unexpected" TEXT;
ALTER TABLE "two_factors" ADD COLUMN "unexpected" TEXT;
`;

const TWELVE = [
  "accounts",
  "audit_logs",
  "categories",
  "listings",
  "master_products",
  "orders",
  "product_synonyms",
  "sessions",
  "store_banners",
  "store_collections",
  "stores",
  "two_factors",
];

const ordersMap = new Map([["idx", "orders"]]);

const rows: Array<{
  name: string;
  script: string;
  indexToTable?: ReadonlyMap<string, string>;
  names?: string[];
  error?: RegExp;
}> = [
  {
    name: "eleven alters plus an orders alter",
    script: `${ELEVEN}ALTER TABLE "orders" ADD COLUMN "unexpected" TEXT;\n`,
    names: TWELVE,
  },
  {
    name: "orders behind a continued escape string",
    script: `ALTER TABLE "stores" ADD COLUMN "probe" TEXT DEFAULT E'prefix'
'can\\'t';
ALTER TABLE "orders" ADD COLUMN "unexpected" TEXT;
`,
    names: ["orders", "stores"],
  },
  {
    name: "orders behind a unicode dollar tag",
    script: `ALTER TABLE "stores" ADD COLUMN "probe" TEXT DEFAULT $é$can't$é$;
ALTER TABLE "orders" ADD COLUMN "unexpected" TEXT;
`,
    names: ["orders", "stores"],
  },
  {
    name: "stores after a nested comment, and listing_imports inside it",
    script: `/* ALTER TABLE "listing_imports" ADD COLUMN "x" TEXT;
/* nested */
' still comment
*/
ALTER TABLE "stores" ADD COLUMN "y" TEXT;
`,
    names: ["listing_imports", "stores"],
  },
  {
    name: "a statement inside a string literal",
    script: `ALTER TABLE "stores" ADD COLUMN "probe" TEXT DEFAULT 'ALTER TABLE "orders" ADD COLUMN "x" TEXT;';\n`,
    names: ["orders", "stores"],
  },
  {
    name: "a dash-dash header line",
    script: `-- ALTER TABLE "orders" ADD COLUMN "x" TEXT;
ALTER TABLE "stores" ADD COLUMN "y" TEXT;
`,
    names: ["stores"],
  },
  {
    name: "create type",
    script: `CREATE TYPE "mood" AS ENUM ('sad');\n`,
    error: /unhandled statement: CREATE TYPE/,
  },
  {
    name: "an unknown dropped index",
    script: `DROP INDEX "orders_unexpected_idx";\n`,
    error: /index has no table: orders_unexpected_idx/,
  },
  {
    name: "an empty diff",
    script: "",
    names: [],
  },
  {
    name: "create table",
    script: `CREATE TABLE IF NOT EXISTS "orders" ("id" TEXT);\n`,
    names: ["orders"],
  },
  {
    name: "drop table",
    script: `DROP TABLE IF EXISTS ONLY "orders";\n`,
    names: ["orders"],
  },
  {
    name: "truncate",
    script: `TRUNCATE TABLE ONLY "orders";\n`,
    names: ["orders"],
  },
  {
    name: "comment on table",
    script: `COMMENT ON TABLE "public"."orders" IS 'hi';\n`,
    names: ["orders"],
  },
  {
    name: "create index on a schema-qualified table",
    script: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx" ON ONLY "public"."orders"("status");\n`,
    names: ["orders"],
  },
  {
    name: "alter index mapped to its table",
    script: `ALTER INDEX IF EXISTS "idx" RENAME TO "idx2";\n`,
    indexToTable: ordersMap,
    names: ["orders"],
  },
  {
    name: "drop index mapped to its table",
    script: `DROP INDEX CONCURRENTLY IF EXISTS "public"."idx";\n`,
    indexToTable: ordersMap,
    names: ["orders"],
  },
  {
    name: "a referenced table",
    script: `ALTER TABLE "accounts" ADD CONSTRAINT "c" FOREIGN KEY ("user_id") REFERENCES "users"("id");\n`,
    names: ["accounts"],
  },
  {
    name: "the same table twice",
    script: `ALTER TABLE "stores" ADD COLUMN "a" TEXT;\nALTER TABLE "stores" ADD COLUMN "b" TEXT;\n`,
    names: ["stores"],
  },
  {
    name: "a statement with no semicolon",
    script: `ALTER TABLE "stores" ADD COLUMN "probe" TEXT`,
    error: /statement has no semicolon/,
  },
  {
    name: "insert",
    script: `INSERT INTO "orders" ("id") VALUES (1);\n`,
    error: /unhandled statement: INSERT/,
  },
];

describe("affected tables in a migrate diff", () => {
  it.each(rows)("$name", ({ script, indexToTable, names, error }) => {
    const run = () => affectedTablesInMigrateDiff(script, indexToTable);
    if (error) {
      expect(run).toThrow(error);
      return;
    }
    expect(run()).toEqual(names);
  });
});
