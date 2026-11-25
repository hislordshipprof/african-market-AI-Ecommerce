import { randomBytes } from "crypto";
import type { BrowserContext, Route } from "@playwright/test";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";

// #766: until PLATFORM_ROOT_DOMAIN is set, the production alias serves the marketplace and stores by ?store=.
export const ALIAS = "african-market-ai-ecommerce.vercel.app";

// Nothing may reach the real vercel.app hosts: they resolve to this machine (with ALIAS_LAUNCH), and every request to
// them is answered by the local server with the Host header Vercel would send.
export const ALIAS_LAUNCH = { launchOptions: { args: ["--host-resolver-rules=MAP *.vercel.app 127.0.0.1"] } };

export async function serveVercelHostsFrom(context: BrowserContext, port: number) {
  await context.route(
    (url) => url.hostname.endsWith(".vercel.app"),
    async (route) => {
      try {
        await answerFromLocal(route, port);
      } catch (error) {
        // A prefetch still in flight when the test ends: its context is gone, so there is nothing left to answer.
        if (/context disposed|Target .*closed|has been closed/i.test(String(error))) return;
        throw error;
      }
    },
  );
}

async function answerFromLocal(route: Route, port: number) {
  const url = new URL(route.request().url());
  const response = await route.fetch({
    url: `http://127.0.0.1:${port}${url.pathname}${url.search}`,
    headers: { ...route.request().headers(), host: url.hostname, "x-forwarded-proto": "https" },
    maxRedirects: 0,
  });
  // Chromium sends the target of a fulfilled redirect to the network, past the route, so the redirect
  // is replayed as a page that moves on; its cookies are kept.
  const location = response.headers().location;
  if (response.status() >= 300 && response.status() < 400 && location) {
    const target = new URL(location, url).toString();
    const headers = response.headers();
    delete headers.location;
    await route.fulfill({ status: 200, headers: { ...headers, "content-type": "text/html" }, body: `<meta http-equiv="refresh" content="0;url=${target}">` });
    return;
  }
  await route.fulfill({ response });
}

/** `next start` configured as production's single vercel.app address. `authSecret` encrypts 2FA secrets there. */
export async function startAliasServer(authSecret = randomBytes(32).toString("base64")) {
  const port = await reservePort(laneSmokePort());
  const running = await startSpawnedServer({
    command: `pnpm exec next start -p ${port}`,
    shell: true,
    cwd: process.cwd(),
    port,
    env: {
      ...process.env,
      CI: "true",
      VERCEL: "",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: ALIAS,
      PLATFORM_ROOT_DOMAIN: "",
      E2E_STORE_OVERRIDE: "",
      STRIPE_SECRET_KEY: "",
      // A production deployment refuses the committed test secret.
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: `https://${ALIAS}`,
      BETTER_AUTH_TRUSTED_ORIGINS: "",
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
  return { port, stop: () => running.stop() };
}
