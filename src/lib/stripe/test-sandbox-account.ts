import type Stripe from "stripe";

type Capabilities = Stripe.Account["capabilities"];

function ready(capabilities: Capabilities | undefined): boolean {
  return capabilities?.transfers === "active" && capabilities.card_payments === "active";
}

/**
 * The sandbox connected account that Stripe tests charge through. Tests reuse it and never
 * create accounts (#160). STRIPE_TEST_CONNECTED_ACCOUNT_ID pins it and skips the slow scan.
 */
export async function sandboxConnectedAccountId(stripe: Stripe): Promise<string> {
  const pinned = process.env.STRIPE_TEST_CONNECTED_ACCOUNT_ID?.trim();
  if (pinned) {
    const account = await stripe.accounts.retrieve(pinned);
    if (!ready(account.capabilities)) {
      throw new Error(
        `STRIPE_TEST_CONNECTED_ACCOUNT_ID ${pinned} lacks active transfers and card_payments capabilities.`,
      );
    }
    return pinned;
  }
  for await (const account of stripe.accounts.list({ limit: 100 })) {
    // The list can report card_payments stale for an account whose transfers are active.
    if (ready(account.capabilities)) return account.id;
    if (account.capabilities?.transfers === "active") {
      const fresh = await stripe.accounts.retrieve(account.id);
      if (ready(fresh.capabilities)) return account.id;
    }
  }
  throw new Error(
    "No sandbox connected account has active transfers and card_payments capabilities; finish hosted onboarding for one store (see #64 step 1).",
  );
}
