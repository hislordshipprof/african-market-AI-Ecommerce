import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { heroFocus, heroPhotos } from "./editorial";

const credits = readFileSync(join(process.cwd(), "public/images/CREDITS.md"), "utf8");

describe("storefront hero photographs (#836)", () => {
  const photos = Object.values(heroPhotos);

  it("serves every hero photo from public/images/hero, not a remote host", () => {
    expect(photos.length).toBeGreaterThanOrEqual(6);
    for (const { src } of photos) {
      expect(src).toMatch(/^\/images\/hero\/[a-z-]+\.webp$/);
      expect(existsSync(join(process.cwd(), "public", src))).toBe(true);
    }
  });

  it("credits each hero photo with its source page, author and licence on one row", () => {
    for (const { src } of photos) {
      const row = credits.split("\n").find(line => line.includes(src.replace("/images/", "")));
      expect(row, src).toBeDefined();
      expect(row).toMatch(/commons\.wikimedia\.org\/wiki\/File:/);
      expect(row).toMatch(/\[(CC BY(-SA)? \d\.\d|CC0)\]\(https:\/\/creativecommons\.org\//);
    }
  });

  it("keeps each photo's focal point and falls back to the centre for any other image", () => {
    expect(heroFocus(heroPhotos.mamaNgoziYams.src)).toBe(heroPhotos.mamaNgoziYams.focus);
    expect(heroFocus("https://cdn.example.com/owner-upload.jpg")).toBe("50% 50%");
  });
});
