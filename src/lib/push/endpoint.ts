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
