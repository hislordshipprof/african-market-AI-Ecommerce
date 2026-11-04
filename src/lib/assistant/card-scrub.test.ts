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
const NINETEEN = "4242424242424242006";

describe("card number scrubber", () => {
  it("masks Luhn-valid 13 to 19 digit numbers with spaces or dashes", () => {
    expect(scrubCardNumbers(`my card is ${VISA} exp 12/29`).text).toBe(
      "my card is [card number removed] exp 12/29",
    );
    expect(scrubCardNumbers("4242-4242-4242-4242").text).toBe("[card number removed]");
    expect(scrubCardNumbers("4242424242424242").text).toBe("[card number removed]");
    expect(scrubCardNumbers("378282246310005").text).toBe("[card number removed]");
    expect(scrubCardNumbers(NINETEEN).text).toBe("[card number removed]");
    expect(scrubCardNumbers(`my card is ${VISA} exp 12/29`).removed).toBe(1);
  });

  it("masks full-width digits", () => {
    const full = "４２４２ ４２４２ ４２４２ ４２４２";
    expect(scrubCardNumbers(full).text).toBe("[card number removed]");
  });

  it("masks a valid window inside a longer run", () => {
    expect(scrubCardNumbers(`00${"4242424242424242"}000`).text).toBe("[card number removed]");
  });

  it("keeps Luhn-invalid numbers, phone and order numbers", () => {
    const text = "4242 4242 4242 4241 call (555) 123-4567 order 100045";
    expect(scrubCardNumbers(text).text).toBe(text);
    expect(scrubCardNumbers(text).removed).toBe(0);
  });

  it("masks every card in one message", () => {
    const result = scrubCardNumbers(`${VISA} and 378282246310005`);
    expect(result.text).toBe("[card number removed] and [card number removed]");
    expect(result.removed).toBe(2);
  });

  it("keeps a Luhn-valid 12-digit run", () => {
    const twelve = "000000000000";
    expect(luhnTwelve(twelve)).toBe(true);
    expect(scrubCardNumbers(`code ${twelve}`).text).toBe(`code ${twelve}`);
    expect(scrubCardNumbers(`code ${twelve}`).removed).toBe(0);
  });

  it("masks mixed separators and keeps a double space", () => {
    expect(scrubCardNumbers("4242 4242-4242 4242").text).toBe("[card number removed]");
    const doubled = "4242  4242  4242  4242";
    expect(scrubCardNumbers(doubled).text).toBe(doubled);
    expect(scrubCardNumbers(doubled).removed).toBe(0);
  });

  it("finishes a 10,000-character message with no digits in under 50ms", () => {
    const input = "a".repeat(10_000);
    const started = performance.now();
    const result = scrubCardNumbers(input);
    expect(performance.now() - started).toBeLessThan(50);
    expect(result.text).toBe(input);
    expect(result.removed).toBe(0);
  });

  it("runs in linear time on long input", () => {
    const input = "9".repeat(200_000);
    const started = Date.now();
    const result = scrubCardNumbers(input);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.text).toBe(input);
    expect(result.removed).toBe(0);
  });
});
