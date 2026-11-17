import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const BAD = ["/\\evil.com", "/%5Cevil.com", "/%2F%2Fevil.com", "//evil.com", "https://evil.com/"];

function verify(callbackURL: string) {
  const url = new URL("http://localhost:3000/api/auth/magic-link/verify?token=t");
  url.searchParams.set("callbackURL", callbackURL);
  return GET(new NextRequest(url));
}

function send(callbackURL: string) {
  return POST(new NextRequest("http://localhost:3000/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json", "x-store-slug": "mama-ngozi" },
    body: JSON.stringify({ email: "shopper@example.test", callbackURL }),
  }));
}

describe("auth route callbackURL", () => {
  for (const value of BAD) {
    it(`refuses ${JSON.stringify(value)} on GET and POST`, async () => {
      for (const res of [await verify(value), await send(value)]) {
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "callbackURL must be a relative path" });
      }
    });
  }
});
