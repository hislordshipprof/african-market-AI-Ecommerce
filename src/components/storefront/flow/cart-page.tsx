"use client";

import Link from "next/link";
import { useState, useTransition, useSyncExternalStore } from "react";
import { Trash2, ArrowRight } from "lucide-react";
import { QuickAddStepper } from "../quick-add-stepper";
import { useCart } from "../cart-provider";
import { Button, Chip, EmptyState } from "../primitives";
import { ProductImage } from "../product-image";
import { ListingCard } from "../listing-card";
import { RailScroller } from "../rail-scroller";
import { Sheet } from "../sheet";
import { cartItemKey, type CartLine } from "@/lib/storefront/cart-store";
import type {
  FlowCatalogItem,
  FlowStore,
  SwapRule,
} from "@/lib/customer-flow/contracts";
import { setSwapRule as serverSetSwapRule } from "@/lib/cart/actions";
import type { SwapRuleValue } from "@/lib/cart/service";
import { toast } from "sonner";
import {
  DemoNotice,
  FeeLine,
  FlowCard,
  FlowHeading,
  FlowLoading,
} from "./common";
import styles from "./cart-checkout.module.css";

import { money } from "@/lib/format";
export { money };
const subscribe = () => () => {};
export function useCartReady() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
export interface ShoppingFlowProps {
  settings: FlowStore;
  catalog: FlowCatalogItem[];
  enabled: boolean;
}

function swapRuleLabel(line: CartLine, catalog: FlowCatalogItem[]): string {
  const rule = line.swapRule ?? "exact_only";
  if (rule === "named_substitute" && line.substituteVariantId) {
    const sub = catalog.find((c) => c.variantId === line.substituteVariantId);
    return sub ? sub.name : "Named substitute chosen";
  }
  if (rule === "store_suggests") return "Store suggests";
  return "Exact item only";
}

function clientRuleToServer(rule: SwapRule): {
  swapRule: SwapRuleValue;
  substituteVariantId: string | null;
} {
  if (rule.kind === "chosen" && rule.item.variantId) {
    return {
      swapRule: "named_substitute",
      substituteVariantId: rule.item.variantId,
    };
  }
  if (rule.kind === "suggest") {
    return { swapRule: "store_suggests", substituteVariantId: null };
  }
  return { swapRule: "exact_only", substituteVariantId: null };
}

export function CartPage({ settings, catalog }: ShoppingFlowProps) {
  const { lines, subtotal, count, store, refreshCart } = useCart();
  const ready = useCartReady();
  const [selected, select] = useState<CartLine | null>(null);
  const [, startTransition] = useTransition();
  const remaining = Math.max(0, settings.minimumOrderCents - subtotal);
  const invalid = lines.some((line) => {
    const item = catalog.find(
      (item) => cartItemKey(item) === cartItemKey(line),
    );
    return !item?.available || line.quantity > item.maxPerOrder;
  });
  function choose(rule: SwapRule) {
    if (!selected || !selected.serverLineId) return;
    const { swapRule, substituteVariantId } = clientRuleToServer(rule);
    const lineId = selected.serverLineId;
    select(null);
    startTransition(async () => {
      const result = await serverSetSwapRule(
        lineId,
        swapRule,
        substituteVariantId,
      );
      if (!result.ok) {
        toast.error(result.error);
      } else {
        await refreshCart();
      }
    });
  }
  if (!ready) return <FlowLoading />;
  const selectedItem =
    selected &&
    catalog.find((item) => cartItemKey(item) === cartItemKey(selected));
  const related = catalog
    .filter(
      (item) =>
        item.available &&
        !lines.some((line) => cartItemKey(line) === cartItemKey(item)),
    )
    .slice(0, 4);
  return (
    <div className={styles.page}>
      <FlowHeading
        title="Your basket"
        description={`${count} ${count === 1 ? "item" : "items"} from ${settings.name}`}
        backHref="/"
        backLabel="Keep shopping"
      />
      <DemoNotice />
      {!lines.length ? (
        <EmptyState
          title="A good meal starts with a full basket"
          description="Explore your market and bring home something familiar."
        />
      ) : (
        <div className={styles.layout}>
          <div className={styles.stack}>
            <FlowCard title={settings.name}>
              <p className={styles.muted}>
                Prepared with care · About {settings.prepTimeMinutes} minutes{" "}
                {settings.closed && `after opening at ${settings.opensAt}`}
              </p>
              <ul className={styles.lines}>
                {lines.map((line) => {
                  const key = cartItemKey(line),
                    item = catalog.find((item) => cartItemKey(item) === key);
                  return (
                    <li className={styles.line} key={key}>
                      <div className={styles.photo}>
                        <ProductImage
                          src={line.imageUrl}
                          name={line.name}
                          sizes="88px"
                        />
                      </div>
                      <div className={styles.lineBody}>
                        <h3>{line.name}</h3>
                        <p className={styles.muted}>
                          {money(line.price)}
                          {line.packLabel && ` / ${line.packLabel}`}
                        </p>
                        {!item?.available && (
                          <p className={styles.error}>
                            Unavailable. Remove this item before checkout.
                          </p>
                        )}
                        {item && line.quantity > item.maxPerOrder && (
                          <p className={styles.error}>
                            Maximum {item.maxPerOrder} per order. Reduce the
                            quantity.
                          </p>
                        )}
                        <button
                          className={styles.swap}
                          onClick={() => select(line)}
                        >
                          Replace with{" "}
                          <span>{swapRuleLabel(line, catalog)}</span>
                          <ArrowRight size={15} />
                        </button>
                        <div className={styles.lineActions}>
                          <QuickAddStepper
                            item={line}
                            maxQuantity={
                              item?.available ? item.maxPerOrder : 0
                            }
                          />
                          <button
                            className={styles.iconButton}
                            aria-label={`Remove ${line.name}`}
                            onClick={() => store.remove(key)}
                          >
                            <Trash2 size={17} />
                          </button>
                        </div>
                      </div>
                      <strong>{money(line.price * line.quantity)}</strong>
                    </li>
                  );
                })}
              </ul>
            </FlowCard>
            {!!related.length && (
              <FlowCard>
                <RailScroller
                  title="Often bought together"
                  label="Often bought together"
                >
                  {related.map((item) => (
                    <div className="sf-rail-item" key={cartItemKey(item)}>
                      <ListingCard
                        listing={{
                          id: item.listingId,
                          variantId: item.variantId,
                          displayName: item.name,
                          startingPrice: item.price,
                          imageUrl: item.imageUrl,
                          packLabel: item.packLabel,
                          weightG: item.weightG,
                          frozen: item.frozen,
                          perishable: item.frozen,
                          badge: "in-stock",
                        }}
                      />
                    </div>
                  ))}
                </RailScroller>
              </FlowCard>
            )}
          </div>
          <aside className={styles.sticky}>
            <FlowCard title="Basket summary">
              <FeeLine label="Subtotal" cents={subtotal} />
              <FeeLine
                label="Estimated pickup tax"
                cents={Math.round(subtotal * 0.06)}
              />
              <FeeLine label="Pickup fee" cents={0} />
              <FeeLine
                label="Default tip · 15%, editable"
                cents={Math.round(subtotal * 0.15)}
              />
              <p className={styles.muted}>
                Delivery starts at {money(settings.storeDeliveryFeeCents)} with
                the store, or a simulated {money(699)} courier quote. Tip
                defaults to 15% at checkout and is editable. Final fees depend
                on your choices.
              </p>
              <FeeLine
                label="Estimated pickup total"
                cents={
                  subtotal +
                  Math.round(subtotal * 0.06) +
                  Math.round(subtotal * 0.15)
                }
                strong
              />
              {settings.minimumOrderCents > 0 && (
                <>
                  <progress
                    className={styles.progress}
                    max={settings.minimumOrderCents}
                    value={Math.min(subtotal, settings.minimumOrderCents)}
                    aria-label="Minimum order progress"
                  />
                  <p className={styles.muted}>
                    {remaining
                      ? `${money(remaining)} more to reach the ${money(settings.minimumOrderCents)} minimum.`
                      : "You've reached the minimum order."}
                  </p>
                </>
              )}
              {invalid && (
                <p className={styles.error}>
                  Review unavailable items and quantities above.
                </p>
              )}
              {remaining || invalid ? (
                <Button disabled className={styles.full}>
                  Continue to checkout
                </Button>
              ) : (
                <Link className={`sf-button ${styles.full}`} href="/checkout">
                  Checkout <ArrowRight size={18} />
                </Link>
              )}
              <p className={styles.muted}>
                Your swap preferences stay with each item.
              </p>
            </FlowCard>
          </aside>
        </div>
      )}
      {!!lines.length && (
        <div className={styles.mobileAction}>
          <div>
            <small>Subtotal</small>
            <strong>{money(subtotal)}</strong>
          </div>
          {remaining || invalid ? (
            <Button disabled>Checkout</Button>
          ) : (
            <Link className="sf-button" href="/checkout">
              Checkout <ArrowRight size={18} />
            </Link>
          )}
        </div>
      )}
      <Sheet
        open={!!selected}
        onClose={() => select(null)}
        title="If this item is sold out"
      >
        <div className={styles.stack}>
          <p>
            Choose how {settings.name} should handle {selected?.name}. Any
            higher-priced swap still needs your approval.
          </p>
          <Chip onClick={() => choose({ kind: "exact" })}>
            Exact item only · refund if unavailable
          </Chip>
          <Chip onClick={() => choose({ kind: "suggest" })}>
            Let the store suggest a swap
          </Chip>
          <h3>Choose a swap from the same aisle</h3>
          {catalog
            .filter(
              (item) =>
                item.available &&
                item.categoryId === selectedItem?.categoryId &&
                cartItemKey(item) !== (selected && cartItemKey(selected)),
            )
            .map((item) => (
              <button
                className={styles.swapChoice}
                key={cartItemKey(item)}
                onClick={() => choose({ kind: "chosen", item })}
              >
                <span className={styles.smallPhoto}>
                  <ProductImage
                    src={item.imageUrl}
                    name={item.name}
                    sizes="54px"
                  />
                </span>
                <span>
                  {item.name}
                  <small>{item.packLabel}</small>
                </span>
                <strong>{money(item.price)}</strong>
              </button>
            ))}
          {!catalog.some(
            (item) =>
              item.available &&
              item.categoryId === selectedItem?.categoryId &&
              cartItemKey(item) !== (selected && cartItemKey(selected)),
          ) && (
            <p className={styles.muted}>
              No same-aisle alternatives right now. Keep the exact item or ask
              the store to suggest.
            </p>
          )}
        </div>
      </Sheet>
    </div>
  );
}
