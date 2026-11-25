import { describe, expect, it } from "vitest";
import { checkoutSuccessUrl } from "./provider";

describe("checkoutSuccessUrl", () => {
  it("adds Stripe's session id template to the return URL, keeping its query", () => {
    expect(checkoutSuccessUrl("https://shop.test/store-admin/plan?store=mama-ngozi")).toBe(
      "https://shop.test/store-admin/plan?store=mama-ngozi&session_id={CHECKOUT_SESSION_ID}",
    );
    expect(checkoutSuccessUrl("https://shop.test/plan")).toBe("https://shop.test/plan?session_id={CHECKOUT_SESSION_ID}");
  });
});
