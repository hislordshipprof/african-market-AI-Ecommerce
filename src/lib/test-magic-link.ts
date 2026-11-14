/**
 * Tests only. The magic-link email opens the confirm page; its Continue form submits the
 * same params to the verify endpoint. Returns that verify URL, or null if no link.
 */
export function verifyUrlFromEmail(html: string | undefined): string | null {
  const href = html?.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  if (!href) return null;
  const confirm = new URL(href);
  if (confirm.pathname !== "/account/sign-in/confirm") {
    throw new Error(`magic-link email links to ${confirm.pathname}, not the confirm page`);
  }
  return `${confirm.origin}/api/auth/magic-link/verify${confirm.search}`;
}
