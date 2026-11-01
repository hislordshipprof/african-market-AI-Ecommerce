import { getFlowContext } from "@/lib/customer-flow/server";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { AccountSignIn } from "@/components/storefront/flow/account-flow";
export default async function SignInPage() {
  const { store, settings, catalog, enabled } = await getFlowContext();
  return (
    <StorefrontShell store={store}>
      <AccountSignIn settings={settings} catalog={catalog} enabled={enabled} />
    </StorefrontShell>
  );
}
