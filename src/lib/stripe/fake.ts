import type {
  StripeProvider,
  ConnectAccount,
  AccountLinkResult,
  WebhookEvent,
} from "./types";

const VALID_WEBHOOK_SIGNATURE = "fake_valid_sig";

const accounts = new Map<string, ConnectAccount>();

function reset() {
  accounts.clear();
}

function getAccounts(): Map<string, ConnectAccount> {
  return accounts;
}

const fakeStripeProvider: StripeProvider = {
  async createConnectAccount({ storeId }) {
    const accountId = `acct_fake_${storeId}`;
    const account: ConnectAccount = {
      accountId,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsCurrentlyDue: ["business_profile", "external_account"],
    };
    accounts.set(accountId, account);
    return account;
  },

  async createAccountLink({ accountId }) {
    if (!accounts.has(accountId)) {
      throw new Error(`No account found with id ${accountId}`);
    }
    return {
      url: `https://connect.stripe.com/fake-onboarding/${accountId}`,
    } satisfies AccountLinkResult;
  },

  async getAccount(accountId) {
    const account = accounts.get(accountId);
    if (!account) {
      throw new Error(`No account found with id ${accountId}`);
    }
    return account;
  },

  verifyWebhookSignature({ payload, signature }) {
    if (signature !== VALID_WEBHOOK_SIGNATURE) {
      throw new Error(
        "No signatures found matching the expected signature for payload.",
      );
    }
    const parsed = JSON.parse(payload);
    return {
      type: parsed.type as string,
      accountId: (parsed.accountId ?? parsed.data?.object?.id ?? "") as string,
    } satisfies WebhookEvent;
  },
};

export { fakeStripeProvider, reset, getAccounts, VALID_WEBHOOK_SIGNATURE };
