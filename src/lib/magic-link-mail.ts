import type { EmailMessage } from "./email/send";
import { quotedFrom } from "./notifications/messages";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function magicLinkMessage(input: {
  to: string;
  url: string;
  storeName: string | null;
  fromAddress: string;
}): EmailMessage {
  // Control characters (line breaks) would split the subject header.
  const storeName =
    input.storeName?.replace(/[<>"]/g, "").replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim() ||
    null;
  const subject = storeName ? `Sign in to ${storeName}` : "Your sign-in link";
  const safeUrl = escapeHtml(input.url);
  const lead = storeName
    ? `Sign in to ${escapeHtml(storeName)}. This link expires in 15 minutes.`
    : "Use this link to sign in. It expires in 15 minutes.";
  const html = `<p>${lead}</p><p><a href="${safeUrl}">Sign in</a></p><p style="font-size:12px">Powered by the Platform</p>`;
  return { to: input.to, subject, html, from: quotedFrom(storeName ?? "", input.fromAddress) };
}
