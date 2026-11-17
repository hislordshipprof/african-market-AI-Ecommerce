/** Orders a shopper places within 30 days of arriving from a directory link count for the directory (#454). */
export const ATTRIBUTION_COOKIE = "came_from";
export const ATTRIBUTION_MAX_AGE = 60 * 60 * 24 * 30;
export const DIRECTORY_REF = "directory";
/** The cart source of a cart an AI agent built over MCP, and the order placed from it (#573). Wins over a directory visit. */
export const AGENT_REF = "agent";

export type AcquisitionSource = typeof DIRECTORY_REF | typeof AGENT_REF;

/** A storefront link from the directory, tagged so the store's site can set the cookie. */
export function directoryLink(href: string): string {
  const url = new URL(href);
  url.searchParams.set("ref", DIRECTORY_REF);
  return url.toString();
}

export function acquisitionSource(cookieValue: string | undefined): AcquisitionSource | null {
  return cookieValue === DIRECTORY_REF ? DIRECTORY_REF : null;
}
