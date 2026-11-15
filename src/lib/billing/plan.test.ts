import { describe, expect, it } from "vitest";
import { effectivePlan } from "./plan";

describe("effectivePlan with a plan override (#547)", () => {
  it("a running Pro override wins over a Stripe Starter plan, a cancelled subscription and no subscription", () => {
    expect(effectivePlan({ plan: "starter", status: "active", overridePlan: "pro" })).toBe("pro");
    expect(effectivePlan({ plan: "pro", status: "canceled", overridePlan: "pro" })).toBe("pro");
    expect(effectivePlan({ plan: "starter", status: "none", overridePlan: "pro" })).toBe("pro");
  });

  it("without a running override the Stripe plan and status decide", () => {
    expect(effectivePlan({ plan: "pro", status: "past_due", overridePlan: null })).toBe("pro");
    expect(effectivePlan({ plan: "pro", status: "canceled", overridePlan: null })).toBe("starter");
    expect(effectivePlan({ plan: "pro", status: "active" })).toBe("pro");
    expect(effectivePlan(null)).toBe("starter");
  });

  it("an unknown override value is ignored", () => {
    expect(effectivePlan({ plan: "starter", status: "active", overridePlan: "enterprise" })).toBe("starter");
  });
});
