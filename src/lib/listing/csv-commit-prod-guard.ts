import { isIP } from "node:net";

/**
 * Loaded before database and auth clients. A blank or whitespace DATABASE_URL
 * must fail here: db.ts otherwise parses it and throws Invalid URL first.
 * Importing this module also runs the checks, so it stays free of those clients.
 */
export function isSingleIpv4(value: string | undefined): value is string {
  return typeof value === "string" && isIP(value) === 4;
}

export const CSV_COMMIT_REQUIRED_KEYS = ["DATABASE_URL", "DIRECT_URL", "APP_RUNTIME_PASSWORD", "BETTER_AUTH_SECRET"] as const;

export function missingCsvCommitKeys(): string[] {
  return CSV_COMMIT_REQUIRED_KEYS.filter((key) => {
    const value = process.env[key];
    return value === undefined || value.trim() === "";
  });
}

const omittedKeys = (process.env.CSV_COMMIT_OMITTED_KEYS ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter((key) => key.length > 0);
for (const key of omittedKeys) {
  const value = process.env[key];
  if (value !== undefined && value.trim() !== "") {
    // test-setup refills a deleted key from .env.local. The parent omitted it on purpose.
    throw new Error(`csv commit error suite requires ${key}`);
  }
}

if (process.env.REQUIRE_CSV_COMMIT_ERRORS === "1" || process.env.CSV_COMMIT_PROD_CHECK === "1") {
  const missing = missingCsvCommitKeys();
  if (missing.length > 0) {
    throw new Error(`csv commit error suite requires ${missing.join(", ")}`);
  }
}

if (process.env.CSV_COMMIT_PROD_CHECK === "1" && !isSingleIpv4(process.env.CSV_COMMIT_AUTH_IP)) {
  throw new Error("csv commit error suite requires CSV_COMMIT_AUTH_IP");
}
