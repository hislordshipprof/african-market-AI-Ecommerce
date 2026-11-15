import { describe, expect, it } from "vitest";
import { parseStoreRequest, storeOpenedEmail, storeOpenedText } from "./store-requests";

const base = { zip: "77002", contact: "ada@example.com", consent: true, website: "" };

describe("parseStoreRequest", () => {
  it("takes a ZIP and an email, lowercased", () => {
    expect(parseStoreRequest({ ...base, contact: "  Ada@Example.COM " })).toEqual({ ok: true, zip: "77002", email: "ada@example.com", phone: null });
  });

  it("takes a US mobile number as E.164 and a ZIP+4 as its 5 digits", () => {
    expect(parseStoreRequest({ ...base, zip: "77002-1234", contact: "(713) 555-2368" })).toEqual({ ok: true, zip: "77002", email: null, phone: "+17135552368" });
  });

  it("refuses without explicit consent", () => {
    expect(parseStoreRequest({ ...base, consent: false }).ok).toBe(false);
    expect(parseStoreRequest({ ...base, consent: "true" }).ok).toBe(false);
  });

  it("refuses a bad ZIP, a bad email and a non-US number", () => {
    expect(parseStoreRequest({ ...base, zip: "7700" }).ok).toBe(false);
    expect(parseStoreRequest({ ...base, contact: "ada@" }).ok).toBe(false);
    expect(parseStoreRequest({ ...base, contact: "+44 20 7946 0958" }).ok).toBe(false);
  });

  it("marks a filled honeypot as spam", () => {
    expect(parseStoreRequest({ ...base, website: "http://spam.example" })).toEqual({ ok: false, spam: true });
  });
});

const store = { name: `Mama's <Kitchen>`, city: "Houston", state: "TX", distanceMi: 3.24, href: "https://mamas.example.com/?ref=directory" };

describe("store opened messages", () => {
  it("email names the store, place and distance, escapes the name, and says it is the only one", () => {
    const email = storeOpenedEmail("77002", store);
    expect(email.subject).toBe("A store is open near 77002");
    expect(email.html).toContain("Mama&#39;s &lt;Kitchen&gt;");
    expect(email.html).toContain("Houston, TX");
    expect(email.html).toContain("3.2 miles from 77002");
    expect(email.html).toContain(`href="https://mamas.example.com/?ref=directory"`);
    expect(email.html).toContain("only message");
  });

  it("text fits one line with the link", () => {
    const text = storeOpenedText("77002", store);
    expect(text).toContain("Mama's <Kitchen> (Houston, TX) is open on African Markets, 3.2 mi from 77002");
    expect(text).toContain("https://mamas.example.com/?ref=directory");
  });
});
