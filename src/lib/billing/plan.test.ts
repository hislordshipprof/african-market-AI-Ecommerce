import { describe, expect, it } from "vitest";
import { effectivePlan, featureLive, planComparisonRows, PRO_FEATURES } from "./plan";

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

describe("featureLive (#809)", () => {
  it("names the Pro features that are not built yet", () => {
    expect(PRO_FEATURES.filter((f) => !featureLive(f))).toEqual(["own-domain", "whatsapp", "analytics-dashboard"]);
  });
});

describe("planComparisonRows (#838)", () => {
  const rows = planComparisonRows();
  const row = (label: string) => rows.find((r) => r.label === label);

  it("courier delivery and the store assistant are Pro only; pickup and own delivery are on both", () => {
    expect(row("Courier delivery")).toMatchObject({ starter: false, pro: true });
    expect(row("Store assistant (AI chat)")).toMatchObject({ starter: false, pro: true });
    expect(row("Pickup and your own delivery")).toMatchObject({ starter: true, pro: true });
  });

  it("gives staff, chats and support as each plan's own value", () => {
    expect(row("Staff")).toMatchObject({ starter: "Owner + 2 staff", pro: "Unlimited staff" });
    expect(row("Shopping-assistant chats a month")).toMatchObject({ starter: "1,000", pro: "5,000" });
    expect(row("Support")).toMatchObject({ starter: "Email, next business day", pro: "Priority, same day" });
  });

  it("marks only the features not built yet as coming soon", () => {
    expect(rows.filter((r) => r.comingSoon).map((r) => r.label)).toEqual([
      "Your own domain",
      "WhatsApp for copilot and alerts",
      "Analytics dashboard",
    ]);
  });
});
