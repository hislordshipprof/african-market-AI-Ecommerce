/** Port the e2e server listens on. Matches playwright.config.ts. */
export const E2E_PORT = process.env.E2E_PORT || "3000";

/**
 * Origin of the app under test. With a slug, the store subdomain
 * (`{slug}.localhost:{port}`); without, bare `localhost:{port}`.
 */
export function storeUrl(slug?: string): string {
  return `http://${slug ? `${slug}.` : ""}localhost:${E2E_PORT}`;
}
