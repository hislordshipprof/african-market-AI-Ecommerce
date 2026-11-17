import { expect, test, type APIRequestContext } from "@playwright/test";
import { storeOwnerSignIn } from "./store-owner-auth";

/** Where /api/stripe/return sends this client. The proxy first turns ?store= into a cookie (one hop). */
async function returnTarget(ctx: APIRequestContext): Promise<{ status: number; target: string }> {
  let res = await ctx.get("/api/stripe/return?store=mama-ngozi", { maxRedirects: 0 });
  let url = new URL(res.headers().location ?? "", "http://localhost");
  if (url.pathname === "/api/stripe/return") {
    res = await ctx.get(`${url.pathname}${url.search}`, { maxRedirects: 0 });
    url = new URL(res.headers().location ?? "", "http://localhost");
  }
  return { status: res.status(), target: `${url.pathname}${url.search}` };
}

// /api/stripe/return uses requireStoreOwner() (#710); its redirect() must be a real 307 under next start.
test("Stripe return sends a signed-out visitor to store sign-in and a verified owner to store admin", async ({ page, request }) => {
  expect(await returnTarget(request)).toEqual({ status: 307, target: "/store-admin/sign-in?store=mama-ngozi" });

  await storeOwnerSignIn(page);
  expect(await returnTarget(page.request)).toEqual({ status: 307, target: "/store-admin?store=mama-ngozi" });
});
