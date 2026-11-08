import { describe, expect, it } from "vitest";
import { safeAttachmentName } from "./attachments";
import { luhnValid, scrubCardNumbers, scrubFileNameCards, scrubKnownStrings } from "./card-scrub";
import { postedPhotoName } from "./ui/client-files";

function luhnTwelve(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return digits.length === 12 && sum % 10 === 0 && !luhnValid(digits);
}

const VISA = "4242 4242 4242 4242";

describe("card number scrubber", () => {
  it("masks a card number in a filename however its digits are split, and keeps camera names", () => {
    const split = [
      "4242 - 4242 - 4242 - 4242.png",
      "4242__4242__4242__4242.png",
      "4242(4242)4242(4242).png",
      "4242–4242–4242–4242.png",
      "4242+4242,4242:4242~.png",
      "4242_4242_4242_4242.png",
      "4242.4242.4242.4242.png",
      "4242424242424242 (1).png",
      "4242424242424242_2.png",
    ];
    for (const name of split) {
      expect(postedPhotoName(name)).toMatch(/^\[card number removed\]/);
      expect(postedPhotoName(name)).not.toContain("4242");
      expect(safeAttachmentName(name, 1, "image/jpeg")).not.toContain("4242");
    }
    // A Luhn-valid YYYYMMDD_HHMMSS is a camera name, not a card: nothing written that way is one.
    expect(luhnValid("20240115000000")).toBe(true);
    expect(postedPhotoName("IMG_20240115_000000.jpg")).toBe("IMG_20240115_000000.jpg");
    expect(scrubFileNameCards("2024-01-15 00.00.00.jpg").text).toBe("2024-01-15 00.00.00.jpg");
    expect(scrubFileNameCards("IMG_20240115_000000 (1).jpg").text).toBe("IMG_20240115_000000 (1).jpg");
    expect(scrubFileNameCards("20240115_000000_4242424242424242.jpg").removed).toBe(1);
    expect(scrubFileNameCards("20240115000000.jpg").removed).toBe(1);
  });

  it("masks a Luhn-valid card and leaves the surrounding text", () => {
    expect(scrubCardNumbers(`my card is ${VISA} exp 12/29`).text).toBe(
      "my card is [card number removed] exp 12/29",
    );
    expect(scrubCardNumbers(`my card is ${VISA} exp 12/29`).removed).toBe(1);
  });

  it("keeps Luhn-invalid numbers, phone and order numbers", () => {
    const text = "4242 4242 4242 4241 call (555) 123-4567 order 100045";
    expect(scrubCardNumbers(text).text).toBe(text);
    expect(scrubCardNumbers(text).removed).toBe(0);
  });

  it("renames card-number keys and keeps a second one distinct", () => {
    const visa = "4242424242424242";
    const mastercard = "5555555555554444";
    const result = scrubKnownStrings({
      [visa]: "first",
      [mastercard]: "second",
      listing_id: { [visa]: "nested" },
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(visa);
    expect(encoded).not.toContain(mastercard);
    expect(encoded).toContain("[card number removed]");
    expect(encoded).toContain("[card number removed] (2)");
    expect(encoded).toContain("first");
    expect(encoded).toContain("second");
    expect(encoded).toContain("nested");
  });

  it("keeps a Luhn-valid 12-digit run", () => {
    const twelve = "000000000000";
    expect(luhnTwelve(twelve)).toBe(true);
    expect(scrubCardNumbers(`code ${twelve}`).text).toBe(`code ${twelve}`);
    expect(scrubCardNumbers(`code ${twelve}`).removed).toBe(0);
  });
});
