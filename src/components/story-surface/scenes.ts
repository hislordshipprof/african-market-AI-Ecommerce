import type { StaticImageData } from "next/image";
import depth from "../../../public/images/story/bodija-wide-depth.webp";
import mid from "../../../public/images/story/bodija-mid.webp";
import tall from "../../../public/images/story/bodija-tall.webp";
import wide from "../../../public/images/story/bodija-wide.webp";

// Which poster file shows at which width; the depth scene reads POSTER_WIDE_MEDIA too, so it
// decodes the file the poster already loaded. In <picture> the first match wins, so the mid
// source needs no upper bound and no fractional width falls through. Preloads must not overlap,
// so they carry .98 bounds, and a fractional width only skips its preload. min-width rather
// than range syntax, which Safari before 16.4 ignores.
export const POSTER_WIDE_MEDIA = "(min-width: 1280px)";
export const POSTER_MID_MEDIA = "(min-width: 768px)";
export const POSTER_MID_PRELOAD_MEDIA = "(min-width: 768px) and (max-width: 1279.98px)";
export const POSTER_TALL_PRELOAD_MEDIA = "(max-width: 767.98px)";

export type StoryScene = {
  /** 1280px and up. The depth scene renders whichever wide poster is showing, so they line up. */
  posterWide: StaticImageData;
  /** 768 to 1279px: `posterWide` scaled down, since the poster is the LCP element there. */
  posterMid: StaticImageData;
  /** Under 768px. This viewport never loads the depth scene. */
  posterTall: StaticImageData;
  /** Same crop as `posterWide`. Light is near, black is far. */
  depth: StaticImageData;
  /** CSS object-position of `posterWide`, as fractions. The depth scene uses the same crop. */
  focus: { x: number; y: number };
  /** Set in display type beside the form on large screens. */
  line: string;
  place: string;
  photographer: string;
};

export const BODIJA_MARKET: StoryScene = {
  posterWide: wide,
  posterMid: mid,
  posterTall: tall,
  depth,
  focus: { x: 0.42, y: 0.5 },
  line: "Tatashe by the heap, tomatoes by the basin.",
  place: "Bodija Market, Ibadan",
  photographer: "Tunde Buremo",
};
