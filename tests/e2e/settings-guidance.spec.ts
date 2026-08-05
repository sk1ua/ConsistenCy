import { expect, test } from "@playwright/test";

test.describe("beginner settings guidance", () => {
  test("explains credential modes and never returns a saved public-read token", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Settings|设置/ }).click();
    await expect(page.locator(".settings-editor")).toBeVisible();

    await expect(page.locator(".source-mode-guide > span")).toHaveCount(3);
    await expect(page.locator(".source-mode-guide")).toContainText("Anonymous public PR");

    const tokenInput = page.locator("#setting-publicReadToken");
    const tokenHelp = page.locator("#setting-publicReadToken-help");
    await expect(tokenInput).toHaveAttribute("aria-describedby", "setting-publicReadToken-help");
    await expect(tokenHelp.getByRole("link", { name: /Open official guide/ })).toHaveAttribute(
      "href",
      "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
    );

    const testOnlyToken = "e2e-public-read-token";
    await tokenInput.fill(testOnlyToken);
    const saveResponse = page.waitForResponse(response => response.url().endsWith("/settings") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    const response = await saveResponse;
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toContain(testOnlyToken);
    await expect(page.locator("label[for='setting-publicReadToken'] .configured")).toHaveText("Configured");
    await expect(tokenInput).toHaveValue("");

    await page.locator("#setting-provider").selectOption("openai");
    const openAiInput = page.locator("#setting-openaiApiKey");
    await expect(openAiInput).toHaveAttribute("aria-describedby", "setting-openaiApiKey-help");
    await expect(page.locator("#setting-openaiApiKey-help a")).toHaveAttribute("href", "https://platform.openai.com/api-keys");
  });
});
