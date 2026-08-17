import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const outputDir = resolve(process.env.CONSISTENCY_SCREENSHOT_DIR ?? join(process.cwd(), "docs", "screenshots"));
const captureOnlyCss = `
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .page-stack { opacity: 1 !important; transform: none !important; }
`;

type Theme = "dark" | "light";
type Locale = "en-US" | "zh-CN";
type Presentation = { width: 1440 | 1280 | 1100; theme: Theme; locale: Locale };

const presentations: Presentation[] = ([1440, 1280, 1100] as const).flatMap(width =>
  (["dark", "light"] as const).flatMap(theme =>
    (["en-US", "zh-CN"] as const).map(locale => ({ width, theme, locale }))
  )
);

async function stabilize(page: Page, rootSelector: string, dataSelectors: string[] = []): Promise<void> {
  const root = page.locator(rootSelector).first();
  await expect(root).toBeVisible();
  for (const selector of dataSelectors) await expect(page.locator(selector).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(root).toHaveCSS("opacity", "1");
  await page.evaluate(() => {
    for (const animation of document.getAnimations({ subtree: true })) animation.cancel();
  });
  await expect.poll(() => page.evaluate(() => document.getAnimations({ subtree: true }).filter(animation =>
    animation.playState === "running" || animation.playState === "pending"
  ).length)).toBe(0);
}

async function applyPresentation(page: Page, presentation: Presentation): Promise<void> {
  await page.setViewportSize({ width: presentation.width, height: 900 });
  await page.evaluate(({ width, theme, locale }) => {
    window.localStorage.setItem("consistency.theme.v1", theme);
    window.localStorage.setItem("consistency.locale.v1", locale);
    window.localStorage.setItem("consistency.workbench-layout.v1", JSON.stringify({
      version: 1,
      explorerCollapsed: false,
      explorerWidth: 258,
      inspectorOpen: width >= 1440,
      inspectorWidth: 360,
      ledgerOpen: false
    }));
  }, presentation);
  await page.reload();
  await page.addStyleTag({ content: captureOnlyCss });
  await expect(page.locator("html")).toHaveAttribute("lang", presentation.locale);
  await expect(page.locator("html")).toHaveAttribute("data-theme", presentation.theme);
}

async function expectWorkbenchIntegrity(page: Page): Promise<void> {
  const workbench = page.locator(".audit-workbench");
  await expect(workbench).toBeVisible();
  const box = await workbench.boundingBox();
  expect(box, "audit-workbench must have a rendered box").not.toBeNull();
  expect(box!.width, "audit-workbench must retain a usable center column").toBeGreaterThanOrEqual(640);

  const offenders = await workbench.evaluate(root => {
    const results: Array<{ text: string; lines: number; charactersPerLine: number }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const parent = node.parentElement;
      if (parent && text.length >= 6 && !parent.closest("[aria-hidden='true']")) {
        const style = window.getComputedStyle(parent);
        const parentBox = parent.getBoundingClientRect();
        if (style.display !== "none" && style.visibility !== "hidden" && parentBox.width > 0 && parentBox.height > 0) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const lineTops = [...range.getClientRects()]
            .filter(rect => rect.width > 0 && rect.height > 0)
            .map(rect => Math.round(rect.top));
          const lines = [...new Set(lineTops)].length;
          const characters = [...text.replace(/\s/g, "")].length;
          const charactersPerLine = lines > 0 ? characters / lines : characters;
          if (lines >= 3 && charactersPerLine < 3) {
            results.push({ text: text.slice(0, 80), lines, charactersPerLine });
          }
        }
      }
      node = walker.nextNode();
    }
    return results;
  });
  expect(offenders, `text wrapped one word/character per line: ${JSON.stringify(offenders)}`).toEqual([]);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outputDir, name), fullPage: true });
}

test.describe("audit workbench screenshot capture", () => {
  test.beforeAll(() => mkdirSync(outputDir, { recursive: true }));
  test.setTimeout(180_000);

  test("captures the responsive theme and locale matrix plus primary review surfaces", async ({ page, request }) => {
    const seedResponse = await request.post("http://127.0.0.1:3001/demo/seed", { data: {} });
    expect(seedResponse.ok()).toBe(true);

    await page.goto("/#/inbox");
    for (const presentation of presentations) {
      await applyPresentation(page, presentation);
      await stabilize(page, ".audit-shell", [".audit-workbench", ".dashboard-page"]);
      await expectWorkbenchIntegrity(page);
      const localeLabel = presentation.locale === "en-US" ? "en" : "zh";
      await capture(page, `audit-inbox-${presentation.width}-${presentation.theme}-${localeLabel}.png`);
    }

    await applyPresentation(page, { width: 1440, theme: "dark", locale: "en-US" });
    await page.locator(".activity-rail").getByRole("link", { name: "Runs", exact: true }).click();
    await stabilize(page, ".audit-shell", [".jobs-table tbody tr"]);
    await expectWorkbenchIntegrity(page);
    await capture(page, "audit-runs-1440-dark-en.png");

    const succeededRow = page.getByRole("table", { name: "Review queue" }).getByRole("row").filter({ hasText: /Succeeded/i }).first();
    await succeededRow.getByRole("button").click();
    await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
    await stabilize(page, ".report-workspace", [".report-header", ".report-ide .finding-item", ".report-ide .evidence-panel"]);
    await expectWorkbenchIntegrity(page);
    await capture(page, "audit-run-overview-1440-dark-en.png");

    await page.getByRole("tab", { name: "Notebook", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Notebook", exact: true })).toHaveAttribute("aria-selected", "true");
    await stabilize(page, ".notebook-panel", [".notebook-source-bar", ".notebook-conversation"]);
    await expectWorkbenchIntegrity(page);
    await capture(page, "audit-run-notebook-1440-dark-en.png");

    await page.locator(".activity-rail").getByRole("link", { name: "Workflows", exact: true }).click();
    await stabilize(page, ".workflows-page", [".workflow-list", ".react-flow"]);
    await expectWorkbenchIntegrity(page);
    await capture(page, "audit-workflows-1440-dark-en.png");

    await page.locator(".activity-rail").getByRole("link", { name: "Settings", exact: true }).click();
    await stabilize(page, ".settings-editor", [".settings-group"]);
    await expectWorkbenchIntegrity(page);
    await capture(page, "audit-settings-1440-dark-en.png");
  });
});
