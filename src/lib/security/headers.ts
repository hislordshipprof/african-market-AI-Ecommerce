const BASE_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/** An SVG opened directly is a document; this keeps any script in it from running (#124). */
export const NO_SCRIPT_CSP = `${BASE_CSP}; script-src 'none'; sandbox`;

// report-uri only: with report-to present Chromium ignores report-uri, and its Reporting API sent nothing in 70 s (#712).
const REPORTING = ["report-uri /api/csp-report"];

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

export function staticSecurityHeaders(
  env: Record<string, string | undefined> = process.env,
): Array<{ key: string; value: string }> {
  return [
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: 'camera=(), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com")' },
    { key: "Content-Security-Policy", value: enforcedPolicy(env) },
  ];
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

/** Every directive but script-src, shared by the enforced and the report-only policy. */
function sharedDirectives(env: Record<string, string | undefined>): string[] {
  const images = imageHosts(env).map((host) => `https://${host}`).join(" ");
  const imgSrc = [
    "'self'",
    "data:",
    "blob:",
    "https://images.unsplash.com",
    "https://upload.wikimedia.org",
    "https://*.stripe.com",
    images,
  ].filter(Boolean).join(" ");
  return [
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src 'self'",
    "connect-src 'self' https://api.stripe.com",
    "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com",
    "worker-src 'self' blob:",
    // The payouts dashboard form is answered with a 303 to connect.stripe.com, and form-action covers redirects.
    "form-action 'self' https://connect.stripe.com",
    BASE_CSP,
    ...REPORTING,
  ];
}

function scriptSrc(withEval: boolean): string {
  return `script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.js.stripe.com${withEval ? " 'unsafe-eval'" : ""}`;
}

/**
 * Enforced. script-src blocks nothing the app runs until nonces work (see reportOnlyPolicy):
 * a bundled vm polyfill on /admin pages calls eval, which the report-only policy still reports.
 */
export function enforcedPolicy(env: Record<string, string | undefined>): string {
  return ["default-src 'self'", scriptSrc(true), ...sharedDirectives(env)].join("; ");
}

export function reportOnlyPolicy(
  nonce: string,
  env: Record<string, string | undefined>,
): string {
  return [
    "default-src 'self'",
    // Next 16.4.3 emits inline scripts with no nonce attribute, and its production
    // runtime does not read the request CSP. A nonce in script-src disables
    // 'unsafe-inline', and 'strict-dynamic' ignores 'self', so either one reports
    // every framework script. The rotating nonce lives on script-src-attr instead.
    scriptSrc(env.NODE_ENV === "development"),
    `script-src-attr 'nonce-${nonce}'`,
    ...sharedDirectives(env),
  ].join("; ");
}
