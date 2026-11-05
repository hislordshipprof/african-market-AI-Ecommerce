import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { CartPage } from "@/components/storefront/flow/cart-page";
import { ClosedFlow } from "@/components/storefront/flow/common";
import { getFlowContext } from "@/lib/customer-flow/server";
import styles from "@/components/storefront/flow/cart-checkout.module.css";

export default async function CartRoute() {
  const { store, settings, catalog, enabled } = await getFlowContext();
  return (
    <StorefrontShell store={store}>
      {enabled ? (
        <CartPage settings={settings} catalog={catalog} enabled={enabled} />
      ) : (
        <div className={styles.withAssistant}>
          <ClosedFlow />
        </div>
      )}
    </StorefrontShell>
  );
}
