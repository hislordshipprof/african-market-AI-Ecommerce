import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect, type Page, type Request } from "@playwright/test";
import { resolveDirectUrl } from "../src/lib/env";
import { storeUrl } from "./urls";
import { generateTOTP } from "./totp";

const ADMIN_EMAIL = "admin@platform.test";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "CiTestPass99!";
const SEED_TOTP_SECRET = process.env.SEED_ADMIN_TOTP_SECRET ?? "JBSWY3DPEHPK3PXP";

function generateTotpCode(): string {
  return generateTOTP(SEED_TOTP_SECRET);
}

async function adminSignIn(page: import("@playwright/test").Page) {
  await page.goto("/admin/sign-in");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.click("button[type='submit']");

  await page.getByLabel("Verification code").waitFor({ state: "visible", timeout: 10000 });

  const code = generateTotpCode();
  await page.getByLabel("Verification code").fill(code);
  await page.click("button[type='submit']");

  try {
    await page.waitForURL("**/admin/stores", { timeout: 15000 });
  } catch {
    const url = page.url();
    const errText = await page.locator(".bg-red-50").textContent().catch(() => "");
    const bodySnippet = await page.locator("body").textContent().catch(() => "");
    throw new Error(
      `Post-TOTP redirect failed | url: ${url} | error: "${errText}" | body: ${bodySnippet?.slice(0, 300)}`,
    );
  }
}

test.describe("Platform admin console", () => {
  test("sign-in page renders email and password fields", async ({ page }) => {
    await page.goto("/admin/sign-in");
    await expect(page.locator("h1")).toHaveText("Platform Admin");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.locator("button[type='submit']")).toHaveText("Sign in");
  });

  test("unauthenticated access to /admin redirects to sign-in", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/sign-in/);
  });

  test("unauthenticated access to /admin/stores redirects to sign-in (not 500)", async ({
    page,
  }) => {
    const response = await page.goto("/admin/stores");
    expect(response?.status()).not.toBe(500);
    await expect(page).toHaveURL(/\/admin\/sign-in/);
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("sign-in with valid credentials and TOTP reaches stores", async ({
    page,
  }) => {
    await adminSignIn(page);
    await expect(page.locator("h1")).toHaveText("Stores");
  });

  test("sign-in form works over the poster when WebGL is unavailable", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const realGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        if (type === "webgl" || type === "webgl2") return null;
        return realGetContext.call(this, type, ...(rest as []));
      } as typeof HTMLCanvasElement.prototype.getContext;
    });

    await page.goto("/admin/sign-in");
    await expect(page.getByTestId("story-poster")).toBeVisible();
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.click("button[type='submit']");

    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("canvas")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  // Reproduced: on software rendering the scene ran at 3 to 12 fps and typing 19
  // characters took 3 to 14 seconds. failIfMajorPerformanceCaveat doesn't catch it.
  test("a software WebGL renderer stays on the poster", async ({ page }) => {
    await page.addInitScript(() => {
      const UNMASKED_RENDERER_WEBGL = 0x9246;
      const realGetParameter = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (
        this: WebGL2RenderingContext,
        parameter: number,
      ) {
        if (parameter === UNMASKED_RENDERER_WEBGL) return "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))";
        return realGetParameter.call(this, parameter);
      };
    });

    await page.goto("/admin/sign-in");
    await expect(page.getByTestId("story-poster")).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page.locator("canvas")).toHaveCount(0);
  });
});

test.describe("Store management (authenticated)", () => {
  test.beforeEach(async ({ page }) => {
    await adminSignIn(page);
  });

  test("stores list page shows seeded stores", async ({ page }) => {
    await expect(page.locator("h1")).toHaveText("Stores");
    await expect(page.locator("text=mama-ngozi")).toBeVisible();
    await expect(page.locator("text=tante-marie")).toBeVisible();
  });

  test("create store form validates unique slug", async ({ page }) => {
    await page.click("text=Create store");
    await expect(page).toHaveURL(/\/admin\/stores\/new/);

    await page.getByLabel("Slug").fill("mama-ngozi");
    await page.getByLabel("Store name").fill("Duplicate Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=already exists")).toBeVisible();
  });

  test("create store form rejects reserved slug", async ({ page }) => {
    await page.click("text=Create store");
    await page.getByLabel("Slug").fill("admin");
    await page.getByLabel("Store name").fill("Reserved Slug Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=reserved")).toBeVisible();
  });

  test("create store form rejects all-digit slug", async ({ page }) => {
    await page.click("text=Create store");
    await page.getByLabel("Slug").fill("123");
    await page.getByLabel("Store name").fill("Digit Slug Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=not allowed")).toBeVisible();
  });

  test("create store form rejects localhost slug", async ({ page }) => {
    await page.click("text=Create store");
    await page.getByLabel("Slug").fill("localhost");
    await page.getByLabel("Store name").fill("Localhost Slug Test");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=not allowed")).toBeVisible();
  });

  test("form preserves entered values after validation error", async ({ page }) => {
    await page.click("text=Create store");
    await expect(page).toHaveURL(/\/admin\/stores\/new/);

    const testName = `Preserved Store ${Date.now()}`;
    await page.getByLabel("Slug").fill("mama-ngozi");
    await page.getByLabel("Store name").fill(testName);
    await page.getByLabel("Pickup enabled").check();
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=already exists")).toBeVisible();
    await expect(page.getByLabel("Store name")).toHaveValue(testName);
    await expect(page.getByLabel("Pickup enabled")).toBeChecked();
  });

  test("create store with zero prep time and delivery radius", async ({ page }) => {
    const slug = `e2e-zero-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Zero Values");
    await page.getByLabel("Prep time (minutes)").fill("0");
    await page.getByLabel("Delivery radius (miles)").fill("0");
    await page.click("button[type='submit']:has-text('Create store')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    await expect(page.locator(`text=${slug}`)).toBeVisible();
  });

  test("create and then edit a store", async ({ page }) => {
    const slug = `e2e-edit-${Date.now()}`;
    const updatedName = `E2E Edited ${slug}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Test Store");
    await page.click("button[type='submit']:has-text('Create store')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    await expect(page.locator(`text=${slug}`)).toBeVisible();

    await page.locator(`tr:has-text("${slug}") a:has-text("Edit")`).click();
    await page.waitForURL(/\/admin\/stores\//, { timeout: 5000 });

    await page.getByLabel("Store name").fill(updatedName);
    await page.click("button[type='submit']:has-text('Save changes')");

    await page.waitForURL("**/admin/stores", { timeout: 10000 });
    const row = page.locator(`tr:has-text("${slug}")`);
    await expect(row.getByText(updatedName)).toBeVisible();
  });

  test("storefront is reachable after store creation", async ({ page }) => {
    const slug = `e2e-live-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Live Store");
    await page.click("button[type='submit']:has-text('Create store')");
    await page.waitForURL("**/admin/stores", { timeout: 10000 });

    await page.goto(`${storeUrl(slug)}/`);
    await expect(page.locator("h1")).toHaveText("E2E Live Store");
  });

  test("suspending a store takes its storefront offline", async ({ page }) => {
    const slug = `e2e-suspend-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Suspend Store");
    await page.click("button[type='submit']:has-text('Create store')");
    await page.waitForURL("**/admin/stores", { timeout: 10000 });

    await page
      .locator(`tr:has-text("${slug}") button:has-text("Suspend")`)
      .click();
    await expect(
      page.locator("tr", { hasText: slug }).getByText("suspended"),
    ).toBeVisible({ timeout: 5000 });

    await page.goto(`${storeUrl(slug)}/`);
    await expect(page.locator("text=temporarily offline")).toBeVisible();
  });

  test("brand color nudge notice shows when color is adjusted", async ({
    page,
  }) => {
    const slug = `e2e-nudge-${Date.now()}`;

    await page.click("text=Create store");
    await page.getByLabel("Slug").fill(slug);
    await page.getByLabel("Store name").fill("E2E Nudge Store");
    await page.getByLabel("Brand color").fill("#EEEEEE");
    await page.click("button[type='submit']:has-text('Create store')");

    await expect(page.locator("text=adjusted")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=contrast")).toBeVisible();
  });
});

// The review list is confidence desc (nulls first), then name asc, 25 per page.
// A null confidence sorts ahead of the seeded medium/low queue and ahead of
// the active catalog, whose nulls would otherwise fill page 1. "!" sorts
// before those names, so the row stays on page 1 after a rename. A name like
// AAA-E2E-* does not: 25 earlier needs_review names hide it.
let reviewNameSeq = 0;

function reviewProductName(label: string): string {
  reviewNameSeq += 1;
  const rank = String(Number.MAX_SAFE_INTEGER - Date.now()).padStart(16, "0");
  return `!${rank}-${reviewNameSeq} ${label}`;
}

async function withPlatformCatalog<T>(
  run: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg(resolveDirectUrl()) });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      return run(tx);
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function insertReviewProduct(name: string): Promise<string> {
  const row = await withPlatformCatalog((tx) =>
    tx.masterProduct.create({
      data: { name, status: "needs_review", confidence: null },
    }),
  );
  return row.id;
}

async function deleteReviewProduct(id: string): Promise<void> {
  await withPlatformCatalog(async (tx) => {
    await tx.auditLog.deleteMany({ where: { entityId: id } });
    await tx.masterProduct.deleteMany({ where: { id } });
  });
}

function reviewRow(page: Page, name: string) {
  return page.locator("table tbody tr").filter({ hasText: name });
}

function isActionPost(request: Request): boolean {
  return request.method() === "POST" && !!request.headers()["next-action"];
}

async function reloadReview(page: Page): Promise<void> {
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Catalog review", { timeout: 15000 });
}

type ClosingTarget = { kind: "save" } | { kind: "edit"; name: string };

/** Click Cancel, then click `target` in the same turn `data-closed` appears. */
async function clickWhileDialogCloses(page: Page, target: ClosingTarget): Promise<void> {
  await page.evaluate((wanted) => {
    const popup = document.querySelector("[data-slot=dialog-content]");
    if (!(popup instanceof HTMLElement)) {
      throw new Error("edit dialog is not open");
    }
    const labelOf = (button: Element) => button.textContent?.trim() ?? "";
    const findTarget = (): HTMLElement | null => {
      if (wanted.kind === "save") {
        const save = [...popup.querySelectorAll("button")].find((button) => labelOf(button) === "Save");
        return save instanceof HTMLElement ? save : null;
      }
      const row = [...document.querySelectorAll("table tbody tr")].find((candidate) =>
        candidate.textContent?.includes(wanted.name),
      );
      const edit = row
        ? [...row.querySelectorAll("button")].find((button) => labelOf(button) === "Edit")
        : undefined;
      return edit instanceof HTMLElement ? edit : null;
    };
    return new Promise<void>((resolve, reject) => {
      let timer = 0;
      const observer = new MutationObserver(() => {
        if (!popup.hasAttribute("data-closed")) return;
        observer.disconnect();
        window.clearTimeout(timer);
        const button = findTarget();
        if (!button) {
          reject(new Error("closing-phase target is missing"));
          return;
        }
        button.click();
        resolve();
      });
      timer = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("data-closed never appeared"));
      }, 2000);
      observer.observe(popup, { attributes: true, attributeFilter: ["data-closed"] });
      const cancel = [...popup.querySelectorAll("button")].find((button) => labelOf(button) === "Cancel");
      if (!(cancel instanceof HTMLElement)) {
        observer.disconnect();
        window.clearTimeout(timer);
        reject(new Error("Cancel is missing"));
        return;
      }
      cancel.click();
    });
  }, target);
}

test.describe("Catalog review (authenticated)", () => {
  // Sign-in uses one shared admin. Keep the cases serial so two TOTP submits
  // do not overlap. Each case still targets a product it created.
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ page }) => {
    await adminSignIn(page);
    await page.goto("/admin/catalog/review");
    await expect(page.locator("h1")).toHaveText("Catalog review", { timeout: 15000 });
  });

  test("approve moves product to active tab", async ({ page }) => {
    const name = reviewProductName("approve");
    const id = await insertReviewProduct(name);
    try {
      await page.goto("/admin/catalog/review?status=needs_review");
      const row = reviewRow(page, name);
      await expect(row).toBeVisible({ timeout: 10000 });
      await row.getByRole("button", { name: "Approve" }).click();
      await expect(row).toHaveCount(0, { timeout: 10000 });

      await page.goto("/admin/catalog/review?status=active");
      await expect(reviewRow(page, name)).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteReviewProduct(id);
    }
  });

  test("edit-then-approve updates name and moves to active", async ({ page }) => {
    const original = reviewProductName("edit");
    const editedName = reviewProductName("edited");
    const id = await insertReviewProduct(original);
    try {
      await page.goto("/admin/catalog/review?status=needs_review");
      const row = reviewRow(page, original);
      await expect(row).toBeVisible({ timeout: 10000 });
      await row.getByRole("button", { name: "Edit" }).click();

      const dialog = page.getByRole("dialog", { name: "Edit product" });
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await dialog.getByLabel("Name").fill(editedName);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).not.toBeVisible({ timeout: 5000 });

      await reloadReview(page);

      const editedRow = reviewRow(page, editedName);
      await expect(editedRow).toBeVisible({ timeout: 10000 });
      await editedRow.getByRole("button", { name: "Approve" }).click();
      await expect(editedRow).toHaveCount(0, { timeout: 10000 });

      await page.goto("/admin/catalog/review?status=active");
      await expect(reviewRow(page, editedName)).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteReviewProduct(id);
    }
  });

  test("edit modal is an accessible dialog: role, aria-modal, focus trap, Escape", async ({ page }) => {
    await page.locator("table tbody tr").first().getByRole("button", { name: "Edit" }).click();

    const dialog = page.getByRole("dialog", { name: "Edit product" });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Focus moves into the dialog on open.
    await expect(dialog.locator(":focus")).toHaveCount(1);

    // Tab (and Shift+Tab) through more stops than the dialog has controls: focus must wrap inside it.
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press(key);
        const inside = await page.evaluate(() => !!document.activeElement?.closest("[role='dialog']"));
        expect(inside, `${key} #${i + 1} left the dialog`).toBe(true);
      }
    }

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("reject moves product to rejected tab", async ({ page }) => {
    const name = reviewProductName("reject");
    const id = await insertReviewProduct(name);
    try {
      await page.goto("/admin/catalog/review?status=needs_review");
      const row = reviewRow(page, name);
      await expect(row).toBeVisible({ timeout: 10000 });
      await row.getByRole("button", { name: "Reject" }).click();
      await expect(row).toHaveCount(0, { timeout: 10000 });

      await page.goto("/admin/catalog/review?status=rejected");
      await expect(reviewRow(page, name)).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteReviewProduct(id);
    }
  });

  test("non-admin access to catalog review redirects to sign-in", async ({ browser }) => {
    const context = await browser.newContext();
    const freshPage = await context.newPage();
    await freshPage.goto(`${storeUrl()}/admin/catalog/review`);
    await expect(freshPage).toHaveURL(/\/admin\/sign-in/, { timeout: 10000 });
    await context.close();
  });

  test("edit dialog never carries one product's typed values to another", async ({ page }) => {
    test.setTimeout(90_000);
    const nameA = reviewProductName("product-a");
    const nameB = reviewProductName("product-b");
    const savedB = reviewProductName("saved-b");
    const typed = reviewProductName("typed");
    const idA = await insertReviewProduct(nameA);
    const idB = await insertReviewProduct(nameB);
    try {
      await page.goto("/admin/catalog/review?status=needs_review");
      let dialog = page.getByRole("dialog", { name: "Edit product" });

      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await dialog.getByLabel("Name").fill(typed);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(page.locator("[data-slot=dialog-content]")).toHaveCount(0);

      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog.getByLabel("Name")).toHaveValue(nameA);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();

      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Name").fill("x".repeat(501));
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();

      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog.getByLabel("Name")).toHaveValue(nameA);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();

      await reviewRow(page, nameB).getByRole("button", { name: "Edit" }).click();
      await expect(dialog.getByLabel("Name")).toHaveValue(nameB);
      await dialog.getByLabel("Name").fill(savedB);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden({ timeout: 5000 });

      await reloadReview(page);
      await expect(reviewRow(page, savedB)).toBeVisible({ timeout: 10000 });
      await expect(reviewRow(page, nameA)).toBeVisible();

      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      dialog = page.getByRole("dialog", { name: "Edit product" });
      await expect(dialog.getByLabel("Name")).toHaveValue(nameA);
    } finally {
      await deleteReviewProduct(idA);
      await deleteReviewProduct(idB);
    }
  });

  test("reopening during the closing phase starts from saved values", async ({ page }) => {
    test.setTimeout(90_000);
    const nameA = reviewProductName("closing-a");
    const nameB = reviewProductName("closing-b");
    const savedB = reviewProductName("closing-saved-b");
    const typed = reviewProductName("closing-typed");
    const idA = await insertReviewProduct(nameA);
    const idB = await insertReviewProduct(nameB);
    try {
      await page.goto("/admin/catalog/review?status=needs_review");
      const dialog = page.getByRole("dialog", { name: "Edit product" });

      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await dialog.getByLabel("Name").fill(typed);
      await clickWhileDialogCloses(page, { kind: "edit", name: nameB });
      await expect(dialog.getByLabel("Name")).toHaveValue(nameB);
      await dialog.getByLabel("Name").fill(savedB);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden({ timeout: 5000 });

      await reloadReview(page);
      await expect(reviewRow(page, savedB)).toBeVisible({ timeout: 10000 });
      await expect(reviewRow(page, nameA)).toBeVisible();
      await expect(reviewRow(page, typed)).toHaveCount(0);

      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await dialog.getByLabel("Name").fill(typed);
      await clickWhileDialogCloses(page, { kind: "edit", name: nameA });
      await expect(dialog.getByLabel("Name")).toHaveValue(nameA);
    } finally {
      await deleteReviewProduct(idA);
      await deleteReviewProduct(idB);
    }
  });

  test("a cancelled edit cannot be saved during the closing phase", async ({ page }) => {
    test.setTimeout(90_000);
    const nameA = reviewProductName("cancel-save");
    const typed = reviewProductName("cancel-typed");
    const idA = await insertReviewProduct(nameA);
    let actionPosts = 0;
    try {
      await page.goto("/admin/catalog/review?status=needs_review");
      const dialog = page.getByRole("dialog", { name: "Edit product" });
      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await dialog.getByLabel("Name").fill(typed);

      await page.route("**/*", async (route) => {
        const request = route.request();
        if (isActionPost(request)) actionPosts += 1;
        await route.continue();
      });
      await clickWhileDialogCloses(page, { kind: "save" });
      await expect(page.locator("[data-slot=dialog-content]")).toHaveCount(0);
      expect(actionPosts).toBe(0);

      await reloadReview(page);
      await expect(reviewRow(page, nameA)).toBeVisible({ timeout: 10000 });
      await expect(reviewRow(page, typed)).toHaveCount(0);
    } finally {
      await page.unroute("**/*").catch(() => {});
      await deleteReviewProduct(idA);
    }
  });

  test("a pending save cannot be dismissed, even by Cancel in the same turn", async ({ page }) => {
    test.setTimeout(90_000);
    const nameA = reviewProductName("pending");
    const saved = reviewProductName("pending-saved");
    const idA = await insertReviewProduct(nameA);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    try {
      await page.goto("/admin/catalog/review?status=needs_review");
      const dialog = page.getByRole("dialog", { name: "Edit product" });
      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await dialog.getByLabel("Name").fill(saved);

      await page.route("**/*", async (route) => {
        const request = route.request();
        if (!held && isActionPost(request)) {
          held = true;
          await gate;
        }
        try {
          await route.continue();
        } catch {
          /* the page closed the request */
        }
      });
      // Playwright's click waits until the button is enabled, and the gate keeps Save and Cancel pending.
      const clickControl = (name: string) =>
        dialog.getByRole("button", { name }).evaluate((button) => {
          if (button instanceof HTMLElement) button.click();
        });
      // Cancel in the same turn as Save, before isPending is true.
      await dialog.getByRole("button", { name: "Save" }).evaluate((save) => {
        const cancel = [...(save.parentElement?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent?.trim() === "Cancel",
        );
        if (!(save instanceof HTMLElement) || !(cancel instanceof HTMLElement)) throw new Error("Save or Cancel is missing");
        save.click();
        cancel.click();
      });
      await expect.poll(() => held, { timeout: 10000 }).toBe(true);
      await expect(dialog.getByRole("button", { name: "Saving…" })).toBeVisible();
      await expect(page.locator("[data-slot=dialog-content]")).not.toHaveAttribute("data-closed", /.*/);

      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(page.locator("[data-slot=dialog-content]")).not.toHaveAttribute("data-closed", /.*/);
      await page.mouse.click(8, 8);
      await expect(dialog).toBeVisible();
      await expect(page.locator("[data-slot=dialog-content]")).not.toHaveAttribute("data-closed", /.*/);
      await clickControl("Cancel");
      await expect(dialog).toBeVisible();
      await expect(page.locator("[data-slot=dialog-content]")).not.toHaveAttribute("data-closed", /.*/);
      await expect(dialog.getByLabel("Name")).toHaveValue(saved);

      release();
      await expect(dialog).toBeHidden({ timeout: 10000 });
      await reloadReview(page);
      await expect(reviewRow(page, saved)).toBeVisible({ timeout: 10000 });
    } finally {
      release();
      await page.unroute("**/*").catch(() => {});
      await deleteReviewProduct(idA);
    }
  });

  test("a second Save in the same turn writes one audit row", async ({ page }) => {
    test.setTimeout(90_000);
    const nameA = reviewProductName("double");
    const saved = reviewProductName("double-saved");
    const idA = await insertReviewProduct(nameA);
    let actionPosts = 0;
    try {
      await page.goto("/admin/catalog/review?status=needs_review");
      const dialog = page.getByRole("dialog", { name: "Edit product" });
      await reviewRow(page, nameA).getByRole("button", { name: "Edit" }).click();
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await dialog.getByLabel("Name").fill(saved);

      await page.route("**/*", async (route) => {
        const request = route.request();
        if (isActionPost(request)) actionPosts += 1;
        await route.continue();
      });
      await dialog.getByRole("button", { name: "Save" }).evaluate((button) => {
        if (button instanceof HTMLElement) {
          button.click();
          button.click();
        }
      });
      await expect(dialog).toBeHidden({ timeout: 10000 });
      const audits = await withPlatformCatalog((tx) =>
        tx.auditLog.count({ where: { entityId: idA, action: "catalog.edit" } }),
      );
      expect(actionPosts).toBe(1);
      expect(audits).toBe(1);

      await reloadReview(page);
      await expect(reviewRow(page, saved)).toBeVisible({ timeout: 10000 });
    } finally {
      await page.unroute("**/*").catch(() => {});
      await deleteReviewProduct(idA);
    }
  });
});

test.describe("2FA enrollment (unenrolled admin)", () => {
  const UNENROLLED_EMAIL = "unenrolled-admin@platform.test";

  test("unenrolled admin is redirected to enroll-2fa, completes enrollment, reaches stores", async ({
    page,
  }) => {
    await page.goto("/admin/sign-in");
    await page.getByLabel("Email").fill(UNENROLLED_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.click("button[type='submit']");

    await page.waitForURL("**/admin/enroll-2fa", { timeout: 10000 });
    await expect(page.locator("h1")).toContainText("two-factor");

    await page.fill("input[type='password']", ADMIN_PASSWORD);
    await page.click("button:has-text('Begin setup')");

    const totpUriEl = page.locator("code").first();
    await expect(totpUriEl).toBeVisible({ timeout: 15000 });
    const totpUri = await totpUriEl.textContent();
    expect(totpUri).toBeTruthy();

    const secretMatch = totpUri!.match(/secret=([A-Z2-7]+)/i);
    expect(secretMatch).toBeTruthy();
    const enrolledSecret = secretMatch![1];

    const code = generateTOTP(enrolledSecret);
    await page.fill("input[inputmode='numeric']", code);
    await page.click("button:has-text('Verify and continue')");

    await page.waitForURL("**/admin/stores", { timeout: 15000 });
    await expect(page.locator("h1")).toHaveText("Stores");
  });
});
