import { describe, expect, it } from "vitest";
import { markdownToPlain, parseMarkdown } from "./markdown";

describe("assistant markdown subset", () => {
  it("turns **bold** and *italics* into marks, without the asterisks", () => {
    expect(parseMarkdown("Try **egusi** with *pounded yam*.")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Try " },
          { type: "strong", children: [{ type: "text", text: "egusi" }] },
          { type: "text", text: " with " },
          { type: "em", children: [{ type: "text", text: "pounded yam" }] },
          { type: "text", text: "." },
        ],
      },
    ]);
  });

  it("reads bullet and numbered lists", () => {
    expect(parseMarkdown("You need:\n- Egusi\n- **Palm oil**\n\n1. Fry\n2. Stir")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "You need:" }] },
      {
        type: "list",
        ordered: false,
        items: [
          [{ type: "text", text: "Egusi" }],
          [{ type: "strong", children: [{ type: "text", text: "Palm oil" }] }],
        ],
      },
      { type: "list", ordered: true, items: [[{ type: "text", text: "Fry" }], [{ type: "text", text: "Stir" }]] },
    ]);
  });

  it("keeps https and same-site links", () => {
    const [block] = parseMarkdown("See [Yam](/listings/abc) or [recipe](https://example.com/egusi).");
    expect(block).toMatchObject({
      children: [
        { type: "text", text: "See " },
        { type: "link", href: "/listings/abc", external: false },
        { type: "text", text: " or " },
        { type: "link", href: "https://example.com/egusi", external: true },
        { type: "text", text: "." },
      ],
    });
  });

  it("never makes javascript:, data:, plain http or protocol-relative links active", () => {
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "//evil.example", "http://evil.test", "/\\evil.example/x", "/\\/evil.example", "/ok\u0000x", "/..//evil.example/x", "/.//evil.example", "/%2e%2e//evil.example", "/a/..//evil.example"]) {
      const [block] = parseMarkdown(`[click](${href})`);
      expect(block).toEqual({ type: "paragraph", children: [{ type: "text", text: "click" }] });
    }
  });

  it("keeps a same-site link's href exactly as written", () => {
    const [block] = parseMarkdown("[Yam](/listings/abc?pack=2#sizes)");
    expect(block).toMatchObject({ children: [{ type: "link", href: "/listings/abc?pack=2#sizes", external: false }] });
  });

  it("keeps raw HTML as literal text, never as an element", () => {
    const html = '<img src=x onerror="alert(1)"> and <script>alert(2)</script>';
    expect(parseMarkdown(html)).toEqual([{ type: "paragraph", children: [{ type: "text", text: html }] }]);
  });

  it("leaves an unclosed marker as it was typed", () => {
    expect(parseMarkdown("2 ** 3 is 8")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "2 ** 3 is 8" }] },
    ]);
  });

  it("gives screen readers the words without markup", () => {
    expect(markdownToPlain("**Egusi** soup:\n- [Yam](/listings/1)\n- *Okra*")).toBe("Egusi soup: Yam Okra");
  });
});

describe("completion announcement", () => {
  it("reads the reply without markdown markers", async () => {
    const { completionAnnouncement } = await import("./announce");
    expect(completionAnnouncement({ parts: [{ type: "text", text: "**Egusi soup** needs *palm oil*." }] })).toBe("Egusi soup needs palm oil.");
  });
});
