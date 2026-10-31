export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export { sendEmail, getTestSentEmails, clearTestSentEmails } from "./send";
export type { EmailMessage, EmailSender } from "./send";
