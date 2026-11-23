import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const lookups = vi.hoisted(() => ({ report: vi.fn(), substitutions: vi.fn() }));
const NOT_FOUND = vi.hoisted(() => new Error("NEXT_NOT_FOUND"));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
  useParams: () => ({ token: "tok 1" }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/storefront/storefront-shell", () => ({
  StorefrontShell: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/customer-flow/server", () => ({
  getFlowContext: async () => ({ store: { id: "s1", name: "Mama Ngozi" }, enabled: false, settings: {}, catalog: [] }),
}));
vi.mock("@/lib/notifications/lookup", () => ({ findOrderForIssueReport: lookups.report }));
vi.mock("@/lib/order/substitution", () => ({ substitutionPromptsForToken: lookups.substitutions }));

import ReportPage from "./report/page";
import SubstitutionsPage from "./substitutions/page";
import ReportError from "./report/error";
import SubstitutionsError from "./substitutions/error";

const params = Promise.resolve({ token: "tok 1" });

beforeEach(() => {
  lookups.report.mockReset();
  lookups.substitutions.mockReset();
});

describe("report page lookup", () => {
  it("lets a lookup failure reach the error boundary instead of the closed notice", async () => {
    lookups.report.mockRejectedValue(new Error("db down"));
    await expect(ReportPage({ params })).rejects.toThrow("db down");
  });

  it("keeps today's page for a token with no order", async () => {
    lookups.report.mockResolvedValue(null);
    expect(renderToStaticMarkup(await ReportPage({ params }))).toContain("Checkout opens soon");
  });
});

describe("substitutions page lookup", () => {
  it("lets a lookup failure reach the error boundary instead of a 404", async () => {
    lookups.substitutions.mockRejectedValue(new Error("db down"));
    await expect(SubstitutionsPage({ params })).rejects.toThrow("db down");
  });

  it("keeps the 404 for a token with no order", async () => {
    lookups.substitutions.mockResolvedValue(null);
    await expect(SubstitutionsPage({ params })).rejects.toBe(NOT_FOUND);
  });
});

describe.each([
  ["report", ReportError],
  ["substitutions", SubstitutionsError],
])("%s lookup failure", (_name, ErrorPage) => {
  it("explains the failure inline with Retry and Back to order", () => {
    const html = renderToStaticMarkup(createElement(ErrorPage, { reset: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("couldn’t load this order");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(html).toContain('href="/order/tok%201"');
    expect(html).toContain("Back to order");
  });
});
