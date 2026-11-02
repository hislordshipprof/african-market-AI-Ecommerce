import { deleteE2eListings } from "./cleanup-listings";

/** Runs after every Playwright run, pass or fail, so e2e listings never linger in the shared database. */
export default async function globalTeardown() {
  const removed = await deleteE2eListings();
  console.log(`e2e teardown: removed ${removed} E2E listing(s)`);
}
