import { describe, expect, it } from "vitest";
import { haveAtHomeCovers } from "./constraints";

describe("haveAtHomeCovers (#476)", () => {
  it("matches a plural term to a singular ingredient and back", () => {
    expect(haveAtHomeCovers("tomatoes", "tomato")).toBe(true);
    expect(haveAtHomeCovers("bitter leaves", "bitter leaf")).toBe(true);
    expect(haveAtHomeCovers("scotch bonnet peppers", "scotch bonnet pepper")).toBe(true);
    expect(haveAtHomeCovers("berries", "berry")).toBe(true);
    expect(haveAtHomeCovers("olives", "olive")).toBe(true);
    expect(haveAtHomeCovers("onion", "onions")).toBe(true);
    expect(haveAtHomeCovers("rice", "long grain rice")).toBe(true);
  });

  it("does not cover a different ingredient that shares a word", () => {
    expect(haveAtHomeCovers("tomatoes", "tomato paste")).toBe(false);
    expect(haveAtHomeCovers("leaves", "bay leaf powder")).toBe(false);
    expect(haveAtHomeCovers("long grain rice", "rice")).toBe(false);
  });
});
