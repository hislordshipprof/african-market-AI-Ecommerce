"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { contrastRatio } from "@/lib/theme";

/** The logo plate is the same light backdrop in both themes, so one check covers both. */
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

/**
 * A logo is readable on the plate when at least a fifth of its visible pixels
 * reach 3:1 against it (the WCAG floor for graphics).
 */
export function logoReadableOn(rgba: Uint8ClampedArray, backdrop: string): boolean {
  let visible = 0;
  let distinct = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    visible++;
    if (contrastRatio(hex(rgba[i], rgba[i + 1], rgba[i + 2]), backdrop) >= 3) distinct++;
  }
  return visible > 0 && distinct / visible >= 0.2;
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
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 80;
        canvas.height = Math.max(1, Math.round((80 * img.naturalHeight) / (img.naturalWidth || 80)));
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
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    if (!src) return;
    let active = true;
    readLogoPixels(src).then((data) => {
      // A logo we cannot inspect (cross-origin without CORS) is shown as supplied.
      if (active) setUnreadable(data ? !logoReadableOn(data, LOGO_PLATE) : false);
    });
    return () => {
      active = false;
    };
  }, [src]);

  if (!src || unreadable) {
    return (
      <span className="sf-logo-initials" aria-hidden="true">
        {storeInitials(name)}
      </span>
    );
  }
  const alt = `${name} logo`;
  return (
    <span className="sf-logo-plate">
      {isSvgLogo(src) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} width={160} height={64} className="sf-logo" />
      ) : (
        <Image src={src} alt={alt} width={160} height={64} className="sf-logo" />
      )}
    </span>
  );
}
