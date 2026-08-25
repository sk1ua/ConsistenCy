import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { join } from "node:path";

async function waitUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      await new Promise(r => setTimeout(r, 400));
    }
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is already in use; stop the existing service before capturing.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForWorkspace(page, selector) {
  await page.locator('nav[aria-label="Application Navigation"]').waitFor();
  await page.locator("main").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".loading-state").length === 0, undefined, { timeout: 30000 });
  if (selector) await page.locator(selector).waitFor({ state: "visible", timeout: 30000 });
  await page.evaluate(() => document.fonts?.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
}

async function waitForHeartbeat(page) {
  await page.waitForFunction(async () => {
    try {
      const response = await fetch("/api/heartbeat");
      const payload = await response.json();
      return Boolean(payload?.pulse?.repository?.root || payload?.pulse?.repository?.branch);
    } catch {
      return false;
    }
  }, undefined, { timeout: 30000 });
}

async function openRepositoryOverview(page) {
  const repositoryLink = page.locator('a[href^="#/repositories/"]').last();
  let routeIds = [];
  if (await repositoryLink.count() > 0) {
    const href = await repositoryLink.getAttribute("href");
    if (href) routeIds.push(decodeURIComponent(href.split("/")[2] ?? ""));
  }
  if (routeIds.length === 0) {
    const heartbeat = await page.evaluate(async () => (await fetch("/api/heartbeat")).json());
    const root = heartbeat?.pulse?.repository?.root;
    const name = typeof root === "string" ? root.split(/[\\/]/).filter(Boolean).at(-1) : undefined;
    if (name) routeIds.push(`local:${name}`, name);
    const workspaceName = process.cwd().split(/[\\/]/).filter(Boolean).at(-1);
    if (workspaceName) routeIds.push(`local:${workspaceName}`, workspaceName);
  }

  for (const routeId of routeIds) {
    await page.goto(`http://127.0.0.1:5173/#/repositories/${encodeURIComponent(routeId)}/overview`);
    await waitForWorkspace(page, 'nav[aria-label="Navigation tabs"]');
    await page.getByRole("tab", { name: "概览" }).waitFor({ state: "visible", timeout: 30000 });
     await page.getByText("最近提交").waitFor({ state: "visible", timeout: 30000 });
    const heading = await page.getByRole("heading", { level: 1 }).textContent();
    if (heading && !/unavailable|不可用/i.test(heading)) return;
  }
  throw new Error(`No authoritative repository overview route resolved from ${routeIds.join(", ")}.`);
}

async function openRoute(page, theme, hash) {
  await page.goto(`http://127.0.0.1:5173/${hash}`);
  await page.evaluate(value => window.localStorage.setItem("consistency.theme.v1", value), theme);
  await page.reload();
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
  await waitForWorkspace(page, ".repository-hub-page");
  await waitForHeartbeat(page);
  await page.waitForTimeout(300);
  await page.locator('a[href^="#/repositories/"]').waitFor({ state: "visible", timeout: 30000 });
}

async function main() {
  console.log("Starting API and Web servers for prototype visual capture...");
  await assertPortAvailable(8787);
  await assertPortAvailable(5173);

  const apiProcess = spawn("node", ["apps/api/dist/server.cjs"], {
    env: {
      ...process.env,
      PORT: "8787",
      NODE_ENV: "development",
      CONSISTENCY_ALLOW_DIRTY_PACK: "true"
    },
    stdio: "inherit"
  });

  const webProcess = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
    cwd: join(process.cwd(), "apps", "web"),
    env: { ...process.env },
    stdio: "inherit",
    shell: true
  });

  let childError;
  apiProcess.once("error", error => { childError = error; });
  webProcess.once("error", error => { childError = error; });

  try {
    await waitUrl("http://127.0.0.1:8787/health");
    await waitUrl("http://127.0.0.1:5173");
    if (childError) throw childError;
    console.log("Servers are ready. Launching browser...");

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      window.localStorage.setItem("consistency.locale.v1", "zh-CN");
    });

    // 1. Shell Dark
    await openRoute(page, "dark", "#/repositories");
    await page.screenshot({ path: "01-shell-dark.png" });
    console.log("Captured 01-shell-dark.png");

    // 2. Repository Overview Dark
    await openRepositoryOverview(page);
    await page.screenshot({ path: "02-repository-overview-dark.png" });
    console.log("Captured 02-repository-overview-dark.png");

    // 3. Shell Light
    await openRoute(page, "light", "#/repositories");
    await page.screenshot({ path: "03-shell-light.png" });
    console.log("Captured 03-shell-light.png");

    // 4. Repository Overview Light
    await openRepositoryOverview(page);
    await page.screenshot({ path: "04-repository-overview-light.png" });
    console.log("Captured 04-repository-overview-light.png");

    await browser.close();
    console.log("All 4 prototype screenshots captured successfully!");
  } finally {
    stopProcessTree(apiProcess);
    stopProcessTree(webProcess);
  }
}

main().catch(err => {
  console.error("Failed capturing screenshots:", err);
  process.exit(1);
});
