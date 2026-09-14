import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`shared shell, navigation and filters at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto("./");
    const header = await page.locator("body > div header.navigation").innerHTML();
    await page.locator("a[href*=\"sdk-import-time\"]").click();
    expect(await page.locator("header.navigation").innerHTML()).toEqual(header);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("#detail-run-count")).toHaveText("3");
    await expect(page.locator("#detail-charts svg")).toHaveCount(1);
    await expect(page.locator("#detail-charts article")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText("Fixture import change")).toBeVisible();
    const start = page.getByRole("slider", { name: /First LiteLLM version/ });
    await start.focus();
    await start.press("ArrowRight");
    await expect(page.locator("#detail-version-count")).toHaveText("2");
    await expect(page.locator("#detail-charts article")).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "Remove all", exact: true }).click();
    await expect(page.locator("#detail-empty")).toContainText("Select at least one metric");
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "Select all metrics", exact: true }).click();
    await page.getByRole("combobox").press("Escape");
    await expect(page.locator("#detail-charts svg")).toHaveCount(1);
    await page.getByRole("link", { name: "All benchmarks", exact: true }).click();
    await page.locator("a[href*=\"sdk-import-footprint\"]").click();
    await expect(page.locator("#detail-run-count")).toHaveText("1");
    await expect(page.locator("#detail-version-count")).toHaveText("1");
    await expect(page.locator("#detail-charts svg")).toHaveCount(2);
    // Exercise parameter-only navigation without unmounting the route via the directory.
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = new URL("../sdk-import-time/", location.href).href;
      link.textContent = "Switch benchmark";
      document.querySelector("main")!.append(link);
    });
    await page.getByRole("link", { name: "Switch benchmark" }).click();
    await expect(page.locator("#detail-version-count")).toHaveText("3");
    expect(requests.some((url) => /\/data\/(index|annotations)\.json/.test(url))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    expect(errors).toEqual([]);
  });
}

test("static HTML includes scoped data and empty benchmarks finish loading", async ({ request, page }) => {
  const response = await request.get("sdk-import-time/");
  const html = await response.text();
  expect(html).toMatch(/id="detail-run-count"[^>]*>\s*3\s*</);
  expect(html).toContain("Fixture import change");
  expect(html).not.toContain("\"benchmark_id\":\"sdk-import-footprint\"");
  await page.goto("proxy-ocr/");
  await expect(page.locator("#detail-run-count")).toHaveText("0");
  await expect(page.getByText("No versions available.")).toBeVisible();
  await expect(page.locator("#detail-empty")).toContainText(
    "No successful canonical Linux measurements",
  );
  expect((await request.get("data/index.json")).ok()).toBe(true);
  expect((await request.get("favicon.svg")).ok()).toBe(true);
  expect((await request.get("unknown-benchmark/")).status()).toBe(404);
});

test("chart setup failures are visible and do not stay busy", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.getComputedStyle;
    window.getComputedStyle = function(element, pseudo) {
      if (element === document.documentElement) throw new Error("Simulated chart theme failure");
      return original.call(window, element, pseudo);
    };
  });
  await page.goto("sdk-import-time/");
  await expect(page.getByText("Unable to render measurements.", { exact: false })).toBeVisible();
  await expect(page.locator("#detail-charts article")).toHaveAttribute("aria-busy", "false");
});

test("failed route data uses the shared error shell", async ({ page }) => {
  await page.goto("./");
  await page.route("**/sdk-import-time/__data.json*", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Test failure" }),
    }));
  await page.locator("a[href*=\"sdk-import-time\"]").click();
  await expect(page.getByRole("heading", { name: "Unable to load benchmark data" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
});
