"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { contrastRatio } from "@/lib/theme";

/** The logo plate's colour, in both themes; the readability check and the plate share it. */
const LOGO_PLATE = "#FFFFFF";

/**
 * SVG logos must never go through the Next image optimizer (XSS vector, issue #60).
 * A plain <img> is sandboxed by the browser: scripts inside the SVG do not run.
 * Detection is by URL extension; extensionless SVG URLs are a known limitation until R2 (ADR-0013).
 */
export function isSvgLogo(src: string): boolean {
  return /\.svg$/i.test(src.split(/[?#]/)[0]);
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** The most common colour among opaque pixels, averaged within its 16-step bucket. */
function dominantColour(rgba: Uint8ClampedArray): string {
  const buckets = new Map<number, [count: number, r: number, g: number, b: number]>();
  let best: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const key = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
    const bucket = buckets.get(key) ?? [0, 0, 0, 0];
    bucket[0]++;
    bucket[1] += rgba[i];
    bucket[2] += rgba[i + 1];
    bucket[3] += rgba[i + 2];
    buckets.set(key, bucket);
    if (bucket[0] > best[0]) best = bucket;
  }
  const [count, r, g, b] = best;
  return hex(Math.round(r / count), Math.round(g / count), Math.round(b / count));
}

/**
 * A logo is readable when at least a fifth of the pixels that differ from its
 * backdrop reach 3:1 against it (the WCAG floor for graphics). Pixels the same
 * colour as the backdrop are not counted. A transparent logo sits on the plate;
 * a logo that is nearly all opaque brings its own panel, so its lettering is
 * measured against that panel's dominant colour. A solid panel with no lettering
 * is the mark itself, so it is measured against the plate.
 */
export function logoReadableOn(rgba: Uint8ClampedArray, plate: string): boolean {
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] >= 128) opaque++;
  if (opaque === 0) return false;
  if (opaque / (rgba.length / 4) >= 0.95) {
    const panel = readableAgainst(rgba, dominantColour(rgba));
    if (panel !== null) return panel;
  }
  return readableAgainst(rgba, plate) ?? false;
}

/** Null when no opaque pixel differs from the backdrop. */
function readableAgainst(rgba: Uint8ClampedArray, backdrop: string): boolean | null {
  let marked = 0;
  let distinct = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const ratio = contrastRatio(hex(rgba[i], rgba[i + 1], rgba[i + 2]), backdrop);
    if (ratio < 1.1) continue;
    marked++;
    if (ratio >= 3) distinct++;
  }
  return marked > 0 ? distinct / marked >= 0.2 : null;
}

export function storeInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

// The logo is decoded only as an image (never inlined or fetched as markup), so an
// embedded SVG script cannot run here either (#60).
function readLogoPixels(src: string): Promise<Uint8ClampedArray | null> {
  return new Promise((resolve) => {
    // The logo stays hidden until a verdict, so a slow or stuck read shows it as supplied.
    setTimeout(() => resolve(null), 300);
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        // No intrinsic size to sample (a viewBox-only SVG in some browsers): keep the logo.
        if (!img.naturalWidth || !img.naturalHeight) return resolve(null);
        const canvas = document.createElement("canvas");
        canvas.width = 80;
        canvas.height = Math.max(1, Math.round((80 * img.naturalHeight) / img.naturalWidth));
        const context = canvas.getContext("2d");
        if (!context) return resolve(null);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height).data);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function StoreLogo({ src, name }: { src: string | null; name: string }) {
  // The verdict belongs to one src; until this src has one, the plate holds its space with the image hidden.
  const [verdict, setVerdict] = useState<{ src: string; unreadable: boolean } | null>(null);
  useEffect(() => {
    if (!src) return;
    let active = true;
    readLogoPixels(src).then((data) => {
      // A logo we cannot inspect (cross-origin without CORS) is shown as supplied.
      if (active) setVerdict({ src, unreadable: data ? !logoReadableOn(data, LOGO_PLATE) : false });
    });
    return () => {
      active = false;
    };
  }, [src]);

  const pending = verdict?.src !== src;
  if (!src || (!pending && verdict?.unreadable)) {
    return (
      <span className="sf-logo-initials" aria-hidden="true">
        {storeInitials(name)}
      </span>
    );
  }
  const alt = `${name} logo`;
  return (
    <span className="sf-logo-plate" style={{ background: LOGO_PLATE, visibility: pending ? "hidden" : undefined }}>
      {isSvgLogo(src) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} width={160} height={64} className="sf-logo" />
      ) : (
        <Image src={src} alt={alt} width={160} height={64} className="sf-logo" />
      )}
    </span>
  );
}
