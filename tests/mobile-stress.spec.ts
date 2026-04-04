import { test, expect, type Page } from "@playwright/test";

// Mobile viewport (iPhone 14 Pro size)
const MOBILE = { width: 390, height: 844 };

async function setMobile(page: Page) {
  await page.setViewportSize(MOBILE);
}

// Mobile menu items are inside div[data-mobile-menu] (the overlay container)
// The desktop nav items are hidden via CSS on mobile — do not use those selectors
const mobileMenuItem = (page: Page, label: string) =>
  page.locator(`div[data-mobile-menu] a:has-text('${label}')`);

async function gotoAndWait(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

// ── Burger Menu ─────────────────────────────────────────────
test.describe("Burger menu", () => {
  test("opens and closes on mobile", async ({ page }) => {
    await setMobile(page);
    await gotoAndWait(page, "/");

    const burger = page.locator('[data-mobile-menu]').first();
    await expect(burger).toBeVisible();

    // Open
    await burger.click();
    await expect(mobileMenuItem(page, "Projects")).toBeVisible();

    // Close via X button (header is z-[100], above backdrop z-[90])
    await page.locator('[data-mobile-menu]').first().click({ force: true });
    await expect(mobileMenuItem(page, "Projects")).not.toBeVisible();
  });

  test("menu stays working after navigating Home → Projects → Home", async ({ page }) => {
    await setMobile(page);
    await gotoAndWait(page, "/");
    await gotoAndWait(page, "/projects");
    await gotoAndWait(page, "/");

    const burger = page.locator('[data-mobile-menu]').first();
    await burger.click();
    await expect(mobileMenuItem(page, "Projects")).toBeVisible();
  });

  test("menu closes when nav link is clicked", async ({ page }) => {
    await setMobile(page);
    await gotoAndWait(page, "/");

    await page.locator('[data-mobile-menu]').first().click();
    await mobileMenuItem(page, "Projects").click();
    await expect(page).toHaveURL("/projects");
  });
});

// ── Experience Accordion ────────────────────────────────────
test.describe("Experience accordion", () => {
  test("expands on first load", async ({ page }) => {
    await setMobile(page);
    await page.goto("/");

    const firstTrigger = page.locator(".exp-trigger").first();
    await expect(firstTrigger).toBeVisible();

    await firstTrigger.click();
    await expect(firstTrigger).toHaveAttribute("aria-expanded", "true");

    // Body should have non-zero height
    const body = page.locator(".exp-body").first();
    const maxHeight = await body.evaluate((el: HTMLElement) => el.style.maxHeight);
    expect(maxHeight).not.toBe("0px");
    expect(maxHeight).not.toBe("0");
  });

  test("collapses when clicked again", async ({ page }) => {
    await setMobile(page);
    await page.goto("/");

    const firstTrigger = page.locator(".exp-trigger").first();
    await firstTrigger.click();
    await expect(firstTrigger).toHaveAttribute("aria-expanded", "true");

    await firstTrigger.click();
    await expect(firstTrigger).toHaveAttribute("aria-expanded", "false");
  });

  test("still works after navigating Projects → Home", async ({ page }) => {
    await setMobile(page);
    await page.goto("/projects");
    await page.goto("/");

    const firstTrigger = page.locator(".exp-trigger").first();
    await firstTrigger.click();
    await expect(firstTrigger).toHaveAttribute("aria-expanded", "true");
  });

  test("still works after navigating Blog → Home", async ({ page }) => {
    await setMobile(page);
    await page.goto("/blog");
    await page.goto("/");

    const firstTrigger = page.locator(".exp-trigger").first();
    await firstTrigger.click();
    await expect(firstTrigger).toHaveAttribute("aria-expanded", "true");
  });

  test("all past jobs expand/collapse independently", async ({ page }) => {
    await setMobile(page);
    await page.goto("/");

    const triggers = page.locator(".exp-trigger");
    const count = await triggers.count();

    for (let i = 0; i < count; i++) {
      const t = triggers.nth(i);
      await t.click();
      await expect(t).toHaveAttribute("aria-expanded", "true");
      await t.click();
      await expect(t).toHaveAttribute("aria-expanded", "false");
    }
  });
});

// ── Projects Slider ─────────────────────────────────────────
test.describe("Projects slider", () => {
  test("renders on first load", async ({ page }) => {
    await setMobile(page);
    await page.goto("/projects");

    await expect(page.locator("#slider-track")).toBeVisible();
    const firstSlide = page.locator(".slider-slide").first();
    await expect(firstSlide).toBeVisible();
  });

  test("dot navigation works", async ({ page }) => {
    await setMobile(page);
    await page.goto("/projects");

    const dots = page.locator(".slider-dot");
    const count = await dots.count();
    if (count < 2) return; // skip if only 1 slide

    // Click second dot
    await dots.nth(1).click();
    await page.waitForTimeout(500); // allow opacity transition

    const secondSlide = page.locator(".slider-slide").nth(1);
    const opacity = await secondSlide.evaluate((el: HTMLElement) => el.style.opacity);
    expect(opacity).toBe("1");
  });

  test("slider still works after Home → Projects navigation", async ({ page }) => {
    await setMobile(page);
    await page.goto("/");
    await page.goto("/projects");

    const dots = page.locator(".slider-dot");
    const count = await dots.count();
    if (count < 2) return;

    await dots.nth(1).click();
    await page.waitForTimeout(500);

    const secondSlide = page.locator(".slider-slide").nth(1);
    const opacity = await secondSlide.evaluate((el: HTMLElement) => el.style.opacity);
    expect(opacity).toBe("1");
  });

  test("slider still works after Projects → Home → Projects navigation", async ({ page }) => {
    await setMobile(page);
    await page.goto("/projects");
    await page.goto("/");
    await page.goto("/projects");

    await expect(page.locator("#slider-track")).toBeVisible();

    const dots = page.locator(".slider-dot");
    const count = await dots.count();
    if (count < 2) return;

    await dots.nth(1).click();
    await page.waitForTimeout(500);

    const secondSlide = page.locator(".slider-slide").nth(1);
    const opacity = await secondSlide.evaluate((el: HTMLElement) => el.style.opacity);
    expect(opacity).toBe("1");
  });

  test("track height is set (not 0)", async ({ page }) => {
    await setMobile(page);
    await page.goto("/projects");

    const track = page.locator("#slider-track");
    const height = await track.evaluate((el: HTMLElement) => parseInt(el.style.height));
    expect(height).toBeGreaterThan(0);
  });
});

// ── View Transitions (real link clicks, Astro ClientRouter) ─
test.describe("Astro view transitions (real link clicks)", () => {
  test("accordion works after clicking nav link Home → Projects → Home", async ({ page }) => {
    await setMobile(page);
    await gotoAndWait(page, "/");

    // On mobile, navigate via burger menu (desktop nav links are hidden)
    await page.locator('[data-mobile-menu]').first().click();
    await mobileMenuItem(page, "Projects").click();
    await page.waitForURL("/projects");
    await page.waitForLoadState("networkidle");

    // Navigate home via logo
    await page.locator('a[href="/"]').first().click();
    await page.waitForURL("/");
    await page.waitForLoadState("networkidle");

    const trigger = page.locator(".exp-trigger").first();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  test("slider works after clicking nav link Home → Projects", async ({ page }) => {
    await setMobile(page);
    await gotoAndWait(page, "/");

    // Open burger and click Projects
    await page.locator('[data-mobile-menu]').first().click();
    await mobileMenuItem(page, "Projects").click();
    await page.waitForURL("/projects");
    await page.waitForLoadState("networkidle");

    const dots = page.locator(".slider-dot");
    if (await dots.count() < 2) return;

    await dots.nth(1).click();
    await page.waitForTimeout(500);
    const opacity = await page.locator(".slider-slide").nth(1).evaluate((el: HTMLElement) => el.style.opacity);
    expect(opacity).toBe("1");
  });

  test("burger menu works after clicking nav link Projects → Home", async ({ page }) => {
    await setMobile(page);
    await gotoAndWait(page, "/projects");

    // Navigate back home via logo click
    await page.locator('a[href="/"]').first().click();
    await page.waitForURL("/");
    await page.waitForLoadState("networkidle");

    const burger = page.locator('[data-mobile-menu]').first();
    await burger.click();
    await expect(mobileMenuItem(page, "Projects")).toBeVisible();
  });

  test("3-hop navigation: Home → Blog → Projects → Home, all features work", async ({ page }) => {
    await setMobile(page);
    await gotoAndWait(page, "/");

    // Hop 1: to Blog
    await page.locator('[data-mobile-menu]').first().click();
    await mobileMenuItem(page, "Blog").click();
    await page.waitForURL("/blog");
    await page.waitForLoadState("networkidle");

    // Hop 2: to Projects (desktop nav link visible in blog since it's wider? no — use logo + goto)
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#slider-track")).toBeVisible();

    // Hop 3: back Home via link click
    await page.locator('a[href="/"]').first().click();
    await page.waitForURL("/");
    await page.waitForLoadState("networkidle");

    // Accordion should work
    const trigger = page.locator(".exp-trigger").first();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Burger menu should work
    const burger = page.locator('[data-mobile-menu]').first();
    await burger.click();
    await expect(mobileMenuItem(page, "Projects")).toBeVisible();
  });
});

// ── Multi-page navigation stress (simulate real user flow) ──
test.describe("Multi-page navigation stress", () => {
  test("full cycle: Home → Projects → Blog → Home, check all features", async ({ page }) => {
    await setMobile(page);

    // Home
    await gotoAndWait(page, "/");
    let trigger = page.locator(".exp-trigger").first();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Projects
    await gotoAndWait(page, "/projects");
    await expect(page.locator("#slider-track")).toBeVisible();

    // Blog
    await gotoAndWait(page, "/blog");
    await expect(page).toHaveURL("/blog");

    // Back to Home
    await gotoAndWait(page, "/");
    trigger = page.locator(".exp-trigger").first();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Burger menu should still work
    const burger = page.locator('[data-mobile-menu]').first();
    await burger.click();
    await expect(mobileMenuItem(page, "Projects")).toBeVisible();
  });

  test("rapid back-and-forth between pages (5 times)", async ({ page }) => {
    await setMobile(page);

    const pages = ["/", "/projects", "/", "/projects", "/"];
    for (const url of pages) {
      await gotoAndWait(page, url);
    }

    // After 5 navigations, everything should still work
    const trigger = page.locator(".exp-trigger").first();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
