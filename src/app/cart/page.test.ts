import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

const flow = vi.hoisted(() => ({ enabled: false, status: "active", onboarding: "complete" }));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/components/storefront/storefront-shell", () => ({
  StorefrontShell: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/storefront/flow/cart-page", () => ({ CartPage: () => null }));
vi.mock("@/lib/customer-flow/server", () => ({
  getFlowContext: async () => ({
    store: { id: "s1", status: flow.status, stripeOnboardingStatus: flow.onboarding },
    settings: {},
    catalog: [],
    enabled: flow.enabled,
  }),
}));

const { default: CartRoute } = await import("./page");
const { CartPage } = await import("@/components/storefront/flow/cart-page");
const { ClosedFlow } = await import("@/components/storefront/flow/common");

async function rendered() {
  const shell = (await CartRoute()) as ReactElement<{ children: ReactElement }>;
  const child = shell.props.children;
  expect(isValidElement(child)).toBe(true);
  return child as ReactElement<{ realCheckout?: boolean }>;
}

describe("/cart with demo flows off (a live store)", () => {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  beforeEach(() => {
    flow.enabled = false;
    flow.status = "active";
    flow.onboarding = "complete";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_live_store";
  });
  afterEach(() => {
    process.env.STRIPE_PUBLISHABLE_KEY = key;
  });

  it("shows the basket when checkout takes payment, as checkout does", async () => {
    const child = await rendered();
    expect(child.type).toBe(CartPage);
    expect(child.props.realCheckout).toBe(true);
  });

  it("shows the closed notice when checkout cannot take payment", async () => {
    flow.onboarding = "pending";
    expect((await rendered()).type).toBe(ClosedFlow);
  });

  it("shows the closed notice without a publishable key", async () => {
    process.env.STRIPE_PUBLISHABLE_KEY = "";
    expect((await rendered()).type).toBe(ClosedFlow);
  });
});
