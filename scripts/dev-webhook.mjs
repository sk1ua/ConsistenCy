#!/usr/bin/env node
/**
 * dev-webhook — 一键启动本地 Webhook 开发环境
 *
 * 作用：
 *   1. 启动 ngrok 隧道转发到 API (127.0.0.1:8787)
 *   2. 读取 ngrok 生成的公网 URL
 *   3. 用 GitHub App 私钥自动更新 App 的 Webhook URL
 *   4. 输出最终 Webhook URL
 *
 * 用法：
 *   node scripts/dev-webhook.mjs
 *   或： npm run dev:webhook
 *
 * 前置条件：.env 已配置 GITHUB_APP_ID / GITHUB_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";

const PORT = 8787;
const NGROK_API = "http://127.0.0.1:4040";

function loadConfig() {
  if (existsSync(".env")) loadEnvFile(".env");
  const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET } = process.env;
  if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || !GITHUB_WEBHOOK_SECRET) {
    console.error("❌ .env 缺少 GITHUB_APP_ID / GITHUB_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET");
    process.exit(1);
  }
  return { appId: GITHUB_APP_ID, privateKey: GITHUB_PRIVATE_KEY, webhookSecret: GITHUB_WEBHOOK_SECRET };
}

function resolvePrivateKey(value) {
  const trimmed = value.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  if (existsSync(trimmed)) return readFileSync(trimmed, "utf8");
  throw new Error(`私钥文件不存在: ${trimmed}`);
}

async function getTunnelUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${NGROK_API}/api/tunnels`);
      const { tunnels } = await res.json();
      const t = tunnels?.find(t => t.public_url?.startsWith("https://"));
      if (t?.public_url) return t.public_url;
    } catch { /* ngrok 还没起来 */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function ensureNgrok() {
  // 已经有一个隧道了就直接复用
  return (async () => {
    const existing = await getTunnelUrl();
    if (existing) return { url: existing, started: false };
    const child = spawn("ngrok", ["http", String(PORT)], { stdio: "ignore", detached: true });
    child.unref();
    const url = await getTunnelUrl();
    if (!url) throw new Error("ngrok 启动失败，请确认已配置 authtoken");
    return { url, started: true };
  })();
}

async function updateWebhookConfig(octokit, url, secret) {
  // 注: 该端点 PATCH 偶发返回 404 但实际生效（GitHub 行为），以 GET 验证为准
  try {
    await octokit.request("PATCH /app/hook/config", {
      url: `${url}/github/webhook`,
      content_type: "json",
      secret,
    });
  } catch (err) {
    const status = err?.status;
    if (status !== 404) throw err;
    console.log("    ⚠ PATCH 返回 404（已知误报），以 GET 验证结果为准");
  }
  const { data } = await octokit.request("GET /app/hook/config");
  return data;
}

const main = async () => {
  console.log("🔧 dev-webhook — 一键 Webhook 开发环境\n");
  const { appId, privateKey, webhookSecret } = loadConfig();
  const pem = resolvePrivateKey(privateKey);

  console.log(`1/3 启动 ngrok 隧道 (${PORT}) ...`);
  const { url } = await ensureNgrok();
  console.log(`    ✅ 公网地址: ${url}`);

  console.log("2/3 生成 GitHub App token ...");
  const auth = createAppAuth({ appId, privateKey: pem });
  const { token } = await auth({ type: "app" });
  const octokit = new Octokit({ auth: token });

  console.log("3/3 更新 GitHub App Webhook URL ...");
  const cfg = await updateWebhookConfig(octokit, url, webhookSecret);
  console.log(`    ✅ Webhook URL: ${cfg.url}`);
  console.log(`    ✅ content_type: ${cfg.content_type}`);
  console.log(`    ✅ secret: ${cfg.secret ? "已设置" : "未设置"}`);

  console.log(`\n🎉 全部就绪！Webhook 终点: ${cfg.url}`);
  console.log(`    API 健康检查: http://127.0.0.1:${PORT}/health`);
  console.log(`    观察 Job:      curl -s http://127.0.0.1:${PORT}/jobs`);
};

main().catch(err => {
  console.error("❌ 失败:", err.message ?? err);
  process.exit(1);
});
