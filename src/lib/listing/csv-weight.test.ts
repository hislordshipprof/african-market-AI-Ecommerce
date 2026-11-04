import { describe, expect, it } from "vitest";
import { parseCsvText } from "./csv-import";

const NEEDS_UNIT = "Weight needs a unit: lb, oz, g or kg (for example 5 lb)";
const INVALID = "Invalid weight";
const TOO_SMALL = "Weight must be greater than 0";
const TOO_LARGE = "Weight looks too large. Check the unit";
const ONE_COLUMN = "Use one weight column";
const EMPTY_FILE = "File is empty or contains only headers.";
const TOO_MANY = "File exceeds the maximum of 5000 rows.";

describe("parseCsvText weight column", () => {
  it("converts lb, oz, g and kg cells to whole grams", () => {
    const csv = [
      "name,price,weight",
      "Garri 50lb,45.00,50 lb",
      "Ogbono,9.99,16 oz",
      "Egusi,6.50,500g",
      "Rice,30,1.5 kg",
      "Yam,4,0.5005 kg",
    ].join("\n");
    const { rows, errors, unknownColumns } = parseCsvText(csv);
    expect(errors).toEqual([]);
    expect(unknownColumns).toEqual([]);
    expect(rows.map((row) => row.weightG)).toEqual([22680, 454, 500, 1500, 501]);
  });

  it("a header unit applies to bare numbers and a cell unit overrides it", () => {
    const pounds = parseCsvText("name,price,Weight (lb)\nPalm Oil,12,2.2\n");
    expect(pounds.errors).toEqual([]);
    expect(pounds.rows[0]?.weightG).toBe(998);

    const override = parseCsvText("name,price,Weight (kg)\nEgusi,6.50,500 g\n");
    expect(override.errors).toEqual([]);
    expect(override.rows[0]?.weightG).toBe(500);
  });

  it("recognises weight header spellings and leaves weight_class unknown", () => {
    const spellings: Array<[string, string, number]> = [
      ["weight", "50 lb", 22680],
      ["Weight (lb)", "2.2", 998],
      ["Weight(kg)", "1.5", 1500],
      ["weight_kg", "1", 1000],
      ["Weight-OZ", "16", 454],
      ["WEIGHT G", "500", 500],
      ["Weight (lbs)", "2", 907],
    ];
    for (const [header, cell, grams] of spellings) {
      const parsed = parseCsvText(`name,price,${header}\nRice,1.00,${cell}\n`);
      expect(parsed.errors, header).toEqual([]);
      expect(parsed.unknownColumns, header).toEqual([]);
      expect(parsed.rows[0]?.weightG, header).toBe(grams);
    }

    const unknown = parseCsvText("name,price,weight_class\nRice,30,heavy\n");
    expect(unknown.unknownColumns).toEqual(["weight_class"]);
    expect(unknown.errors).toEqual([]);
    expect(unknown.rows[0]?.weightG).toBeUndefined();

    const pounds = parseCsvText("name,price,Weight (pounds)\nRice,30,5\n");
    expect(pounds.unknownColumns).toEqual(["Weight (pounds)"]);
    expect(pounds.rows[0]?.weightG).toBeUndefined();

    const stuck = parseCsvText("name,price,weightlb\nRice,30,5\n");
    expect(stuck.unknownColumns).toEqual(["weightlb"]);
    expect(stuck.rows[0]?.weightG).toBeUndefined();
  });

  it("rejects bad weight cells with the exact message and keeps valid rows", () => {
    const csv = [
      "name,price,weight",
      "Bare,1.00,5",
      'Comma,1.00,"1,5 kg"',
      "Tiny,1.00,0.3 g",
      "Huge,1.00,1001 lb",
      "Dot,1.00,5 lb.",
      "Ok,1.00,2 lb",
    ].join("\n");
    const { rows, errors } = parseCsvText(csv);
    expect(errors).toEqual([
      { row: 2, csvName: "Bare", reason: NEEDS_UNIT },
      { row: 3, csvName: "Comma", reason: INVALID },
      { row: 4, csvName: "Tiny", reason: TOO_SMALL },
      { row: 5, csvName: "Huge", reason: TOO_LARGE },
      { row: 6, csvName: "Dot", reason: INVALID },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row: 7, name: "Ok", weightG: 907 });
  });

  it("a short first row still applies later weight cells", () => {
    const csv = ["name,price,weight", "First,1", "Heavy,45,50 lb", "Invalid,1,1001 lb"].join("\n");
    const { rows, errors, unknownColumns } = parseCsvText(csv);
    expect(unknownColumns).toEqual([]);
    expect(errors).toEqual([{ row: 4, csvName: "Invalid", reason: TOO_LARGE }]);
    expect(rows.map((row) => ({ name: row.name, weightG: row.weightG }))).toEqual([
      { name: "First", weightG: undefined },
      { name: "Heavy", weightG: 22680 },
    ]);
  });

  it("two weight columns, even identical or case-different, reject the file", () => {
    for (const header of ["name,price,weight,weight", "name,price,weight,Weight (kg)", "name,price,Weight,weight"]) {
      const parsed = parseCsvText(`${header}\nRice,1.00,2 lb,3 lb\n`);
      expect(parsed.rows, header).toEqual([]);
      expect(parsed.errors, header).toEqual([{ row: 0, reason: ONE_COLUMN }]);
    }
  });

  it("a header-only file reports empty before duplicate weight columns (regression guard)", () => {
    const parsed = parseCsvText("name,price,weight,weight\n");
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toEqual([{ row: 0, reason: EMPTY_FILE }]);
  });

  it("weight boundaries round half up and cap at 1000 lb", () => {
    const csv = [
      "name,price,weight",
      "A,1.00,0.5005 kg",
      "B,1.00,2.2 lb",
      "C,1.00,16 oz",
      "D,1.00,0.5 g",
      "E,1.00,0.4 g",
      "F,1.00,1 oz",
      "G,1.00,1000 lb",
      "H,1.00,1000.01 lb",
      "I,1.00,453592 g",
      "J,1.00,453593 g",
      "K,1.00,453.5925 kg",
    ].join("\n");
    const { rows, errors } = parseCsvText(csv);
    expect(rows.map((row) => row.weightG)).toEqual([501, 998, 454, 1, 28, 453592, 453592]);
    expect(errors.map((error) => error.reason)).toEqual([TOO_SMALL, TOO_LARGE, TOO_LARGE, TOO_LARGE]);
    expect(errors.map((error) => error.csvName)).toEqual(["E", "H", "J", "K"]);
  });

  it("accepts unit case and spacing variants and rejects signs, exponents and unknown units", () => {
    const nbsp = "\u00A0";
    const csv = [
      "name,price,weight",
      "A,1.00,5 LBS",
      "B,1.00,16 Oz",
      "C,1.00,5lb",
      `D,1.00,5${nbsp}lb`,
      `E,1.00,${nbsp}5 lb${nbsp}`,
      "F,1.00,.5 kg",
      "G,1.00,-5 lb",
      "H,1.00,-0 g",
      "I,1.00,+5 lb",
      "J,1.00,1e3 g",
      "K,1.00,lb",
      "L,1.00,5 pounds",
    ].join("\n");
    const { rows, errors } = parseCsvText(csv);
    expect(rows.map((row) => ({ name: row.name, weightG: row.weightG }))).toEqual([
      { name: "A", weightG: 2268 },
      { name: "B", weightG: 454 },
      { name: "C", weightG: 2268 },
      { name: "D", weightG: 2268 },
      { name: "E", weightG: 2268 },
      { name: "F", weightG: 500 },
    ]);
    expect(errors).toEqual([
      { row: 8, csvName: "G", reason: TOO_SMALL },
      { row: 9, csvName: "H", reason: TOO_SMALL },
      { row: 10, csvName: "I", reason: INVALID },
      { row: 11, csvName: "J", reason: INVALID },
      { row: 12, csvName: "K", reason: INVALID },
      { row: 13, csvName: "L", reason: NEEDS_UNIT },
    ]);
  });

  it("a 32-character weight cell parses and a 33-character cell is invalid", () => {
    const cell32 = `${"0".repeat(28)}5 lb`;
    expect(cell32).toHaveLength(32);
    const ok = parseCsvText(`name,price,weight\nPad,1.00,${cell32}\n`);
    expect(ok.errors).toEqual([]);
    expect(ok.rows[0]?.weightG).toBe(2268);

    const cell33 = `${"0".repeat(29)}5 lb`;
    expect(cell33).toHaveLength(33);
    const bad = parseCsvText(`name,price,weight\nLong,1.00,${cell33}\n`);
    expect(bad.rows).toEqual([]);
    expect(bad.errors).toEqual([{ row: 2, csvName: "Long", reason: INVALID }]);
  });

  it("files without weights or with empty weight cells parse as before", () => {
    const noColumn = parseCsvText("name,price\nEgusi,12.50\n");
    expect(noColumn.errors).toEqual([]);
    expect(noColumn.unknownColumns).toEqual([]);
    expect(noColumn.rows[0]).toMatchObject({ name: "Egusi", price: 1250 });
    expect(noColumn.rows[0]?.weightG).toBeUndefined();

    const blanks = parseCsvText("name,price,weight\nEgusi,12.50,\nPalm,8.99,   \n");
    expect(blanks.errors).toEqual([]);
    expect(blanks.unknownColumns).toEqual([]);
    expect(blanks.rows.map((row) => row.weightG)).toEqual([undefined, undefined]);
    expect(blanks.rows.map((row) => row.price)).toEqual([1250, 899]);

    const headerOnly = parseCsvText("name,price\n");
    expect(headerOnly.rows).toEqual([]);
    expect(headerOnly.errors).toEqual([{ row: 0, reason: EMPTY_FILE }]);
  });

  it("5000 rows with weights all convert and 5001 rows are rejected", () => {
    const header = "name,price,weight";
    const fiveThousand = [header];
    for (let i = 0; i < 5000; i++) fiveThousand.push(`Item ${i},1.00,1 g`);
    const full = parseCsvText(fiveThousand.join("\n"));
    expect(full.errors).toEqual([]);
    expect(full.rows).toHaveLength(5000);
    expect(full.rows.every((row) => row.weightG === 1)).toBe(true);

    const over = [header];
    for (let i = 0; i < 5001; i++) over.push(`Item ${i},1.00,1 g`);
    const rejected = parseCsvText(over.join("\n"));
    expect(rejected.rows).toEqual([]);
    expect(rejected.errors).toEqual([{ row: 0, reason: TOO_MANY }]);
  });

  it("weight parsing leaves price cents unchanged (regression guard)", () => {
    const withWeight = parseCsvText("name,price,weight\nGarri,45.00,50 lb\nOgbono,9.99,16 oz\n");
    const without = parseCsvText("name,price\nGarri,45.00\nOgbono,9.99\n");
    expect(withWeight.rows.map((row) => row.price)).toEqual([4500, 999]);
    expect(without.rows.map((row) => row.price)).toEqual([4500, 999]);
    expect(withWeight.errors).toEqual([]);
    expect(without.rows[0]?.weightG).toBeUndefined();
  });
});
