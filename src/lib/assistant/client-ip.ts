/**
 * First `x-forwarded-for` value, then `x-real-ip`, otherwise one shared
 * "unknown" bucket.
 *
 * Trustworthy only because Vercel overwrites `x-forwarded-for` before the
 * app sees the request. Off Vercel the header is client-controlled, so it
 * is not an identity.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}
