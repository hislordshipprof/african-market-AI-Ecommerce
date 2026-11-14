/**
 * Lists sandbox connected accounts that never finished onboarding, so the owner can tidy
 * them by hand (#160). Read-only: it never closes or deletes an account.
 * Run: pnpm exec dotenv -e .env.local -- node scripts/stripe-sandbox-accounts.mjs
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!key.startsWith("sk_test_")) {
  console.error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_).");
  process.exit(1);
}

const stripe = new Stripe(key);
let total = 0;
let unonboarded = 0;
for await (const account of stripe.accounts.list({ limit: 100 })) {
  total += 1;
  if (account.details_submitted) continue;
  unonboarded += 1;
  const created = new Date(account.created * 1000).toISOString().slice(0, 10);
  console.log(`${account.id}\t${created}\t${account.metadata?.platform_store_id ?? ""}`);
}
console.error(`${unonboarded} of ${total} connected accounts have not finished onboarding.`);
