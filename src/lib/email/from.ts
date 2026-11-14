export function stripHeaderChars(value: string): string {
  return value.replace(/["\\]/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

/** RFC 5322 quoted display name so a comma or parenthesis is not a second address. */
export function quotedFrom(storeName: string, fromAddress: string): string {
  const wrapped = fromAddress.match(/<([^>]+)>/);
  const address = (wrapped?.[1] ?? fromAddress).trim();
  const name = stripHeaderChars(storeName);
  if (!name) return address;
  return `"${name}" <${address}>`;
}
