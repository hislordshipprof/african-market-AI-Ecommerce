import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render as the browser does after hydration: the cart is ready.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("../cart-provider", () => ({
  useCart: () => ({
    lines: [{ listingId: "l1", name: "Egusi", price: 899, quantity: 1, available: true, maxPerOrder: 10 }],
    subtotal: 899,
    count: 1,
    store: null,
    refreshCart: async () => {},
    syncing: false,
    loading: false,
    loadFailed: false,
    pendingKeys: new Set(),
  }),
}));
vi.mock("../assistant/assistant-slot", () => ({ AssistantSlot: () => null }));
vi.mock("../quick-add-stepper", () => ({ QuickAddStepper: () => null }));
vi.mock("@/lib/cart/actions", () => ({ setSwapRule: vi.fn() }));
vi.mock("@/lib/checkout/actions", () => ({
  applyCouponAction: vi.fn(),
  quoteCheckoutAction: vi.fn(),
  removeCouponAction: vi.fn(),
}));

const { CartPage } = await import("./cart-page");

const settings = {
  id: "s1",
  slug: "mama-ngozi",
  name: "Mama Ngozi",
  address: "1 Main St",
  minimumOrderCents: 0,
  pickupEnabled: true,
  storeDeliveryEnabled: false,
  deliveryRadiusMi: 0,
  prepTimeMinutes: 30,
  storeDeliveryFeeCents: 0,
  autoRefundLimitCents: 0,
  insulatedPackaging: false,
  courierOffered: false,
  shipsTo: [],
  closed: false,
  opensAt: "",
  readyAt: "",
  takingOrders: true,
  deliveryPausedUntil: "",
};
const catalog = [{ listingId: "l1", name: "Egusi", price: 899, available: true, maxPerOrder: 10 }];

function render(enabled: boolean, realCheckout: boolean) {
  return renderToStaticMarkup(
    createElement(CartPage, { settings, catalog, enabled, realCheckout } as never),
  );
}

describe("CartPage on a live store (demo flows off, checkout takes payment)", () => {
  it("shows the basket and its checkout action, with no demo notice", () => {
    const html = render(false, true);
    expect(html).toContain("Your basket");
    expect(html).toContain('href="/checkout"');
    expect(html).not.toContain("Explore the demo");
  });

  it("still shows the demo notice when checkout is the demo", () => {
    expect(render(true, false)).toContain("Explore the demo");
  });
});
