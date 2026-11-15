import { describe, expect, it } from "vitest";
import { groceryStoreJsonLd, jsonLdHtml } from "./json-ld";

const STORE = {
  name: "Mama Ngozi African Market",
  href: "https://mama-ngozi.example.com/",
  logoUrl: "/logos/mama-ngozi-logo.svg",
  listingBlurb: "Yam, egusi and palm oil.",
  city: "Houston",
  state: "TX",
};

describe("groceryStoreJsonLd", () => {
  it("describes the store as a schema.org GroceryStore with only its city and state", () => {
    expect(groceryStoreJsonLd(STORE)).toEqual({
      "@context": "https://schema.org",
      "@type": "GroceryStore",
      name: "Mama Ngozi African Market",
      url: "https://mama-ngozi.example.com/",
      image: "https://mama-ngozi.example.com/logos/mama-ngozi-logo.svg",
      description: "Yam, egusi and palm oil.",
      address: { "@type": "PostalAddress", addressLocality: "Houston", addressRegion: "TX", addressCountry: "US" },
    });
  });

  it("leaves out a missing logo and blurb rather than writing null", () => {
    const data = groceryStoreJsonLd({ ...STORE, logoUrl: null, listingBlurb: null });
    expect(data).not.toHaveProperty("image");
    expect(data).not.toHaveProperty("description");
  });
});

describe("jsonLdHtml", () => {
  it("cannot close its script tag, whatever the owner writes", () => {
    const html = jsonLdHtml(groceryStoreJsonLd({ ...STORE, listingBlurb: "</script><script>alert(1)</script>" }));
    expect(html).not.toContain("<");
    expect(JSON.parse(html).description).toBe("</script><script>alert(1)</script>");
  });
});
