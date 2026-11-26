"use client";

import { Check, Plus } from "lucide-react";
import { money } from "@/lib/format";
import type { CookTonightDish } from "@/lib/storefront/cook-tonight";
import { cartItemKey } from "@/lib/storefront/cart-store";
import { useCart } from "./cart-provider";
import { ProductImage } from "./product-image";

const THUMBS = 5;

/** Home's Cook tonight (#862 AC5): dishes from the recipe base, each one tap from the basket. */
export function CookTonight({ dishes }: { dishes: CookTonightDish[] }) {
  const { lines, store } = useCart();
  if (!dishes.length) return null;
  const inBasket = new Set(lines.map(cartItemKey));
  return (
    <section className="sf-cook" data-testid="cook-tonight" aria-labelledby="cook-tonight-title">
      <h2 id="cook-tonight-title">Cook tonight</h2>
      <ul className="sf-dishes">
        {dishes.map((dish) => {
          const toAdd = dish.items.filter((item) => !inBasket.has(cartItemKey(item)));
          const n = dish.items.length;
          return (
            <li key={dish.name} className="sf-dish" data-testid="dish">
              <div className="sf-dish-thumbs" aria-hidden>
                {dish.items.slice(0, THUMBS).map((item) => (
                  <span key={item.variantId} className="sf-dish-thumb">
                    <ProductImage src={item.imageUrl} name={item.name} category={item.categorySlug} sizes="56px" />
                  </span>
                ))}
                {n > THUMBS && <span className="sf-dish-more">+{n - THUMBS}</span>}
              </div>
              <div className="sf-dish-text">
                <h3>{dish.name}</h3>
                <p>
                  Serves {dish.servings} · {n} {n === 1 ? "item" : "items"} · <span className="sf-dish-price">{money(dish.totalCents)}</span>
                </p>
              </div>
              {toAdd.length ? (
                <button
                  type="button"
                  className="sf-dish-add"
                  aria-label={`Add all ${n} ${dish.name} items to basket`}
                  onClick={() => toAdd.forEach((item) => store.adjust(item, 1, item.maxPerOrder))}
                >
                  <Plus size={18} aria-hidden />
                  Add all {n}
                </button>
              ) : (
                <span className="sf-dish-add" data-done>
                  <Check size={18} aria-hidden />
                  In basket
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
