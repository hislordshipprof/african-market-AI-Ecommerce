const PUSH_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "web.push.apple.com"]);

/** True only for an https URL on a real web push service: no userinfo, no IP literal, no port but 443. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** web-push's own rule: p256dh decodes to a 65-byte P-256 point, auth to at least 16 bytes. */
export function isUsablePushKeys(keys: { p256dh: string; auth: string }): boolean {
  return Buffer.from(keys.p256dh, "base64url").length === 65 && Buffer.from(keys.auth, "base64url").length >= 16;
}
