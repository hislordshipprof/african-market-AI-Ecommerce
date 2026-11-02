import Image from "next/image";

/**
 * SVG logos must never go through the Next image optimizer (XSS vector, issue #60).
 * A plain <img> is sandboxed by the browser: scripts inside the SVG do not run.
 * Detection is by URL extension; extensionless SVG URLs are a known limitation until R2 (ADR-0013).
 */
export function isSvgLogo(src: string): boolean {
  return /\.svg$/i.test(src.split(/[?#]/)[0]);
}

export function StoreLogo({ src, name }: { src: string; name: string }) {
  const alt = `${name} logo`;
  if (isSvgLogo(src)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} width={44} height={44} className="sf-logo" />;
  }
  return <Image src={src} alt={alt} width={44} height={44} className="sf-logo" />;
}
