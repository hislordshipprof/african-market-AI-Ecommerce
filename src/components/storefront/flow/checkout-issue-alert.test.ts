import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CheckoutIssue } from "@/lib/checkout/checkout-issue";
import { CheckoutIssueAlert } from "./checkout-issue-alert";

function render(issue: CheckoutIssue, actions: Parameters<typeof CheckoutIssueAlert>[0]["actions"] = {}) {
  return renderToStaticMarkup(createElement(CheckoutIssueAlert, { issue, id: "issue", actions }));
}

const issue = (section: CheckoutIssue["section"]): CheckoutIssue => ({ section, message: "Something went wrong.", lineKeys: [] });

describe("checkout issue recovery actions (#717 AC3)", () => {
  it("is an alert that keeps the server's message", () => {
    const html = render(issue("payment"), { useAnotherCard: () => {} });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong.");
  });

  it("offers the recovery that matches where the problem is", () => {
    expect(render(issue("payment"), { useAnotherCard: () => {} })).toMatch(/<button[^>]*>Use another card<\/button>/);
    expect(render(issue("basket"))).toMatch(/<a[^>]*href="\/cart"[^>]*>Review basket<\/a>/);
    expect(render(issue("session"), { refresh: () => {} })).toMatch(/<button[^>]*>Refresh checkout<\/button>/);
    expect(render(issue("network"), { retry: () => {} })).toMatch(/<button[^>]*>Try again<\/button>/);
  });

  it("offers pickup beside an address only when pickup is possible", () => {
    expect(render(issue("address"), { editAddress: () => {}, choosePickup: () => {} })).toContain("Choose pickup");
    expect(render(issue("address"), { editAddress: () => {} })).not.toContain("Choose pickup");
  });

  it("offers no action it cannot carry out", () => {
    const html = render(issue("general"));
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a");
  });
});
