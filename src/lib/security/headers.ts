export const ENFORCED_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/** An SVG opened directly is a document; this keeps any script in it from running (#124). */
export const NO_SCRIPT_CSP = `${ENFORCED_CSP}; script-src 'none'; sandbox`;

/** Matches the decoded path, as the static server does; an undecodable path counts as SVG. */
export function isSvgPath(pathname: string): boolean {
  try {
    return decodeURIComponent(pathname).toLowerCase().endsWith(".svg");
  } catch {
    return true;
  }
}

/** SVG paths, and every catalog image: a stored body under any key may be SVG or HTML. */
export function needsNoScriptCsp(pathname: string): boolean {
  if (isSvgPath(pathname)) return true;
  return decodeURIComponent(pathname).startsWith("/api/catalog-image/");
}

const STATIC_HEADERS: Array<{ key: string; value: string }> = [
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: ENFORCED_CSP },
];

export function staticSecurityHeaders(): Array<{ key: string; value: string }> {
  return STATIC_HEADERS.map((header) => ({ ...header }));
}

export function newCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hostnameOf(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw || raw === "undefined") return null;
  try {
    const withScheme = raw.includes("://") ? raw : `https://${raw}`;
    const host = new URL(withScheme).hostname;
    if (!host || host === "undefined") return null;
    return host;
  } catch {
    return null;
  }
}

/** Hosts added to img-src. Empty, blank, and unparseable values are omitted. */
export function imageHosts(env: Record<string, string | undefined>): string[] {
  const hosts = new Set<string>();
  const r2 = hostnameOf(env.R2_PUBLIC_URL);
  if (r2) hosts.add(r2);
  for (const part of (env.LOGO_HOSTS ?? "").split(",")) {
    const host = hostnameOf(part);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

export function reportOnlyPolicy(
  nonce: string,
  env: Record<string, string | undefined>,
): string {
  const devEval = env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const images = imageHosts(env).map((host) => `https://${host}`).join(" ");
  const imgSrc = [
    "'self'",
    "data:",
    "blob:",
    "https://images.unsplash.com",
    "https://*.stripe.com",
    images,
  ].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    // Next 16.4.3 emits inline scripts with no nonce attribute, and its production
    // runtime does not read the request CSP. A nonce in script-src disables
    // 'unsafe-inline', and 'strict-dynamic' ignores 'self', so either one reports
    // every framework script. The rotating nonce lives on script-src-attr instead.
    `script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.js.stripe.com${devEval}`,
    `script-src-attr 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src 'self'",
    "connect-src 'self' https://api.stripe.com",
    "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}
