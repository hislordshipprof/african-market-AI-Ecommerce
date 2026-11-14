import { deleteE2eListings } from "./cleanup-listings";

/** Runs after every Playwright run, pass or fail, so e2e listings never linger in the shared database. */
export default async function globalTeardown() {
  const { listings, orders, customers } = await deleteE2eListings();
  console.log(
    `e2e teardown: removed ${listings} E2E listing(s), ${orders} emptied order(s), ${customers} orphaned customer(s)`,
  );
}
