import { expect, test } from "@playwright/test";
import { laneSmokePort, reservePort, startSpawnedServer } from "./spawned-server";

// The lane server has no root domain, so this boots one with PLATFORM_ROOT_DOMAIN=localhost (#449).
test("the root domain serves the Store directory and store hosts still serve their storefront", async ({ page }) => {
  test.setTimeout(180_000);
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
      VERCEL_ENV: "",
      E2E_STORE_OVERRIDE: "",
      STRIPE_SECRET_KEY: "",
      PLATFORM_ROOT_DOMAIN: "localhost",
      BETTER_AUTH_URL: `http://localhost:${port}`,
      BETTER_AUTH_TRUSTED_ORIGINS: `http://localhost:${port}`,
    },
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthOk: (status) => status === 200 || status === 503,
  });
  try {
    await page.goto(`http://localhost:${port}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Store not found")).toHaveCount(0);
    const card = page.getByRole("link", { name: /Mama Ngozi African Market/ });
    await expect(card).toHaveAttribute("href", `http://mama-ngozi.localhost:${port}/`);
    await expect(page.getByText("Tante Marie Caribbean Grocer")).toHaveCount(0);
    await expect(page).toHaveTitle(/Store directory/);

    await card.click();
    await expect(page).toHaveURL(`http://mama-ngozi.localhost:${port}/`);
    await expect(page).toHaveTitle("Mama Ngozi African Market");
  } finally {
    await running.stop();
  }
});
