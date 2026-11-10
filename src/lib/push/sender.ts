import { sendNotification, WebPushError } from "web-push";
import { resolveAuthBaseUrl } from "../auth";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  /** A newer push with the same tag replaces the waiting notification on the device. */
  tag: string;
}

/** `status` is the push service's HTTP status, 0 for a network failure. */
export class PushSendError extends Error {
  constructor(readonly status: number) {
    super(`push_${status || "network"}`);
  }
}

export interface PushSender {
  send(target: PushTarget, message: PushMessage): Promise<void>;
}

/** Push services accept at most 4 KB of payload. */
const MAX_PAYLOAD_BYTES = 4096;

function vapidSubject(env: Record<string, string | undefined>): string {
  const root = env.PLATFORM_ROOT_DOMAIN?.trim();
  if (root) return `https://${root}`;
  const base = resolveAuthBaseUrl(env);
  return base.startsWith("https://") ? base : "https://localhost";
}

export class WebPushSender implements PushSender {
  constructor(private readonly vapid: { publicKey: string; privateKey: string; subject: string }) {}

  async send(target: PushTarget, message: PushMessage): Promise<void> {
    try {
      await sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        { vapidDetails: this.vapid, TTL: 3600, timeout: 10_000 },
      );
    } catch (err) {
      throw new PushSendError(err instanceof WebPushError ? err.statusCode : 0);
    }
  }
}

/** Records instead of sending. Enforces the push service's rules; `failWith` makes an endpoint answer with a status. */
export class PushTestSender implements PushSender {
  readonly sent: Array<PushTarget & { message: PushMessage }> = [];
  private readonly failures = new Map<string, number>();

  failWith(endpoint: string, status: number): void {
    this.failures.set(endpoint, status);
  }

  async send(target: PushTarget, message: PushMessage): Promise<void> {
    if (!target.endpoint.startsWith("https://")) throw new PushSendError(400);
    if (!target.p256dh || !target.auth) throw new PushSendError(400);
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_PAYLOAD_BYTES) throw new PushSendError(413);
    const status = this.failures.get(target.endpoint);
    if (status) throw new PushSendError(status);
    this.sent.push({ ...target, message });
  }
}

let testSender: PushSender | null = null;

export function setPushSenderForTests(next: PushSender | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setPushSenderForTests is only available when NODE_ENV=test");
  }
  testSender = next;
}

/** The key a browser subscribes with. Null unless both keys are set, so no device subscribes to alerts that never send. */
export function vapidPublicKey(env: Record<string, string | undefined> = process.env): string | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  return publicKey && env.VAPID_PRIVATE_KEY?.trim() ? publicKey : null;
}

/** Null when the VAPID keys are missing: sending is skipped. */
export function pushSender(env: Record<string, string | undefined> = process.env): PushSender | null {
  const publicKey = vapidPublicKey(env);
  if (!publicKey) return null;
  if (testSender) return testSender;
  if (env.NEXT_PHASE === "phase-production-build" || env.NODE_ENV === "test" || env.CI === "true") {
    return new PushTestSender();
  }
  return new WebPushSender({ publicKey, privateKey: env.VAPID_PRIVATE_KEY!.trim(), subject: vapidSubject(env) });
}
