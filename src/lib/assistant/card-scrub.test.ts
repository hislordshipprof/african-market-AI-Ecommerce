import { describe, expect, it } from "vitest";
import { luhnValid, scrubCardNumbers } from "./card-scrub";

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

  it("keeps a Luhn-valid 12-digit run", () => {
    const twelve = "000000000000";
    expect(luhnTwelve(twelve)).toBe(true);
    expect(scrubCardNumbers(`code ${twelve}`).text).toBe(`code ${twelve}`);
    expect(scrubCardNumbers(`code ${twelve}`).removed).toBe(0);
  });
});
