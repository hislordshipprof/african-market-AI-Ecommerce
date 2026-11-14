import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/admin/catalog-actions", () => ({
  approveProduct: vi.fn(),
  rejectProduct: vi.fn(),
  updateReviewProduct: vi.fn(),
}));

import { ReviewTable } from "./review-table";

const render = (total: number, page: number) =>
  renderToStaticMarkup(createElement(ReviewTable, { products: [], total, page, pageSize: 10 }));

describe("ReviewTable empty states", () => {
  it("celebrates only when nothing is left to review (total 0)", () => {
    expect(render(0, 1)).toContain("All caught up!");
  });

  it("an empty page with items remaining elsewhere is not 'All caught up'", () => {
    const html = render(10, 2);
    expect(html).not.toContain("All caught up");
    expect(html).toContain("No items on this page");
    expect(html).toContain("Back to page 1");
  });
});
