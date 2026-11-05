import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState, headerAls } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require("node:async_hooks") as {
    AsyncLocalStorage: typeof import("node:async_hooks").AsyncLocalStorage;
  };
  return {
    headerState: new Headers(),
    headerAls: new AsyncLocalStorage<Headers>(),
  };
});

vi.mock("next/headers", () => ({
  headers: async () => headerAls.getStore() ?? headerState,
}));

import { auth } from "../auth";
import { authPrisma, customerScoped } from "../db";
import { clearTestSentEmails, getTestSentEmails } from "../email/send";
import { addAddressAction, editAddressAction, removeAddressAction, savePhoneAction } from "./actions";
import { ADDRESS_NOT_FOUND, SIGN_IN_MESSAGE } from "./address-validation";

const hasDb = Boolean(process.env.DATABASE_URL);
const BASE = "http://localhost:3000/api/auth";
const RUN = `t248-auth-${Date.now()}`;
const password = "AccountAuth-248!";

class CookieJar {
  private readonly jar = new Map<string, string>();

  apply(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const semi = raw.indexOf(";");
      const pair = (semi === -1 ? raw : raw.slice(0, semi)).trim();
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value.length === 0) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function authPost(path: string, body: unknown): Promise<Response> {
  return auth.handler(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function authGet(url: string): Promise<Response> {
  return auth.handler(new Request(url, { redirect: "manual" }));
}

async function customerCookie(email: string, name: string): Promise<{ id: string; cookie: string }> {
  const signup = await authPost("/sign-up/email", { email, password, name });
  expect(signup.status, await signup.clone().text()).toBe(200);
  const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
  clearTestSentEmails();
  const sent = await authPost("/sign-in/magic-link", { email, callbackURL: "/account" });
  expect(sent.status).toBe(200);
  const message = getTestSentEmails().find((item) => item.to === email);
  const href = message?.html.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  expect(href).toBeTruthy();
  const jar = new CookieJar();
  const verify = await authGet(href!);
  expect(verify.status).toBeLessThan(400);
  jar.apply(verify);
  return { id: user.id, cookie: jar.header() };
}

function asUser<T>(cookie: string, run: () => Promise<T>): Promise<T> {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return headerAls.run(headers, run);
}

const home = {
  label: "Home",
  line1: "1 Market St",
  city: "Honolulu",
  state: "HI",
  zip: "96813",
};

describe.skipIf(!hasDb)("account actions use the fresh session user", () => {
  const emails = [`a-${RUN}@example.test`, `b-${RUN}@example.test`];

  afterAll(async () => {
    await authPrisma.user.deleteMany({ where: { email: { in: emails } } });
  });

  it("refuses a signed-out caller and refuses B on A's address", async () => {
    const signedOut = await asUser("", () => addAddressAction(home));
    expect(signedOut.ok).toBe(false);
    if (!signedOut.ok) expect(signedOut.error).toBe(SIGN_IN_MESSAGE);

    const a = await customerCookie(emails[0], "Ada");
    const b = await customerCookie(emails[1], "Bea");
    const created = await asUser(a.cookie, () => addAddressAction(home));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const addressId = created.address.id;

    const edited = await asUser(b.cookie, () => editAddressAction(addressId, { ...home, label: "Stolen" }));
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.error).toBe(ADDRESS_NOT_FOUND);

    const removed = await asUser(b.cookie, () => removeAddressAction(addressId));
    expect(removed.ok).toBe(false);

    const phone = await asUser(b.cookie, () => savePhoneAction("(808) 555-0199"));
    expect(phone.ok).toBe(true);

    const own = await customerScoped(a.id).customerAddress.findUnique({ where: { id: addressId } });
    expect(own?.label).toBe("Home");
    const aPhone = await customerScoped(a.id).platformCustomerProfile.findUnique({ where: { userId: a.id } });
    expect(aPhone?.phone ?? null).toBeNull();
  });
});
