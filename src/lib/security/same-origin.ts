/** Cookie-authenticated route handlers: Origin host must equal Host. */
export function requireSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}
