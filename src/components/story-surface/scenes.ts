import type { StaticImageData } from "next/image";
import depth from "../../../public/images/story/bodija-wide-depth.webp";
import tall from "../../../public/images/story/bodija-tall.webp";
import wide from "../../../public/images/story/bodija-wide.webp";

export type StoryScene = {
  /** 768px and up. Also the photo the depth scene renders, so the two line up exactly. */
  posterWide: StaticImageData;
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
  posterTall: tall,
  depth,
  focus: { x: 0.42, y: 0.5 },
  line: "Tatashe by the heap, tomatoes by the basin.",
  place: "Bodija Market, Ibadan",
  photographer: "Tunde Buremo",
};
