import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { diagnoseConfiguration } from "./doctor";
import { loadNearestEnvFile } from "./runtime";
import { SettingsStore, type SettingsPatch } from "./settings";

type ConfigAlias = {
  secret: boolean;
  patch: (value: string | null) => SettingsPatch;
};

const aliases: Record<string, ConfigAlias> = {
  "llm.provider": { secret: false, patch: value => ({ llm: { provider: value as "mock" | "deepseek" | "openai" } }) },
  "llm.deepseek-base-url": { secret: false, patch: value => ({ llm: { deepseekBaseUrl: value ?? undefined } }) },
  "llm.deepseek-model": { secret: false, patch: value => ({ llm: { deepseekModel: value ?? undefined } }) },
  "llm.openai-model": { secret: false, patch: value => ({ llm: { openaiModel: value ?? undefined } }) },
  "llm.deepseek-api-key": { secret: true, patch: value => ({ llm: { deepseekApiKey: value } }) },
  "llm.openai-api-key": { secret: true, patch: value => ({ llm: { openaiApiKey: value } }) },
  "github.app-id": { secret: false, patch: value => ({ github: { appId: value } }) },
  "github.private-key": { secret: true, patch: value => ({ github: { privateKey: value } }) },
  "github.webhook-secret": { secret: true, patch: value => ({ github: { webhookSecret: value } }) },
  "runtime.database-path": { secret: false, patch: value => ({ runtime: { databasePath: value ?? undefined } }) },
  "runtime.workspace-root": { secret: false, patch: value => ({ runtime: { workspaceRoot: value ?? undefined } }) },
  "runtime.worker-concurrency": { secret: false, patch: value => ({ runtime: { workerConcurrency: Number(value) } }) },
  "runtime.worker-poll-ms": { secret: false, patch: value => ({ runtime: { workerPollIntervalMs: Number(value) } }) },
  "runtime.web-url": { secret: false, patch: value => ({ runtime: { webUrl: value ?? undefined } }) },
  "runtime.api-token": { secret: true, patch: value => ({ runtime: { apiToken: value } }) }
};

async function hiddenQuestion(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const fallback = createInterface({ input: stdin, output: stdout });
    try { return await fallback.question(label); } finally { fallback.close(); }
  }
  stdout.write(label);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(value);
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        stdin.off("keypress", onKeypress);
        stdin.setRawMode(false);
        reject(new Error("Setup cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") { finish(); return; }
      if (key.name === "backspace") {
        if (value.length > 0) { value = value.slice(0, -1); stdout.write("\b \b"); }
        return;
      }
      if (text && !key.ctrl) { value += text; stdout.write("*"); }
    };
    stdin.on("keypress", onKeypress);
  });
}

function printSnapshot(store: SettingsStore, json = false): void {
  const snapshot = store.snapshot(process.env);
  if (json) { stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`); return; }
  stdout.write([
    `LLM provider       ${snapshot.llm.provider}`,
    `DeepSeek key       ${snapshot.llm.deepseekApiKeyConfigured ? "configured" : "missing"}`,
    `OpenAI key         ${snapshot.llm.openaiApiKeyConfigured ? "configured" : "missing"}`,
    `GitHub App ID      ${snapshot.github.appId || "missing"}`,
    `GitHub private key ${snapshot.github.privateKeyConfigured ? "configured" : "missing"}`,
    `Webhook secret     ${snapshot.github.webhookSecretConfigured ? "configured" : "missing"}`,
    `Database           ${snapshot.runtime.databasePath}`,
    `Workspace          ${snapshot.runtime.workspaceRoot}`,
    `Worker concurrency ${snapshot.runtime.workerConcurrency}`,
    ...(snapshot.overriddenByEnvironment.length ? [`Environment overrides: ${snapshot.overriddenByEnvironment.join(", ")}`] : [])
  ].join("\n") + "\n");
}

async function setup(store: SettingsStore): Promise<void> {
  const current = store.snapshot(process.env);
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write("\nConsistenCy setup\nPress Enter to keep the value shown in brackets.\n\n");
  const providerInput = await rl.question(`LLM provider mock/deepseek/openai [${current.llm.provider}]: `);
  const provider = (providerInput.trim() || current.llm.provider) as "mock" | "deepseek" | "openai";
  const patch: SettingsPatch = { llm: { provider }, github: {}, runtime: {} };
  if (provider === "deepseek") {
    patch.llm!.deepseekBaseUrl = (await rl.question(`DeepSeek base URL [${current.llm.deepseekBaseUrl}]: `)).trim() || current.llm.deepseekBaseUrl;
    patch.llm!.deepseekModel = (await rl.question(`DeepSeek model [${current.llm.deepseekModel}]: `)).trim() || current.llm.deepseekModel;
  } else if (provider === "openai") {
    patch.llm!.openaiModel = (await rl.question(`OpenAI model [${current.llm.openaiModel}]: `)).trim() || current.llm.openaiModel;
  }
  patch.github!.appId = (await rl.question(`GitHub App ID [${current.github.appId || "not configured"}]: `)).trim() || undefined;
  patch.runtime!.databasePath = (await rl.question(`Database path [${current.runtime.databasePath}]: `)).trim() || current.runtime.databasePath;
  patch.runtime!.workspaceRoot = (await rl.question(`Workspace root [${current.runtime.workspaceRoot}]: `)).trim() || current.runtime.workspaceRoot;
  const concurrency = (await rl.question(`Worker concurrency [${current.runtime.workerConcurrency}]: `)).trim();
  if (concurrency) patch.runtime!.workerConcurrency = Number(concurrency);
  patch.runtime!.webUrl = (await rl.question(`Web URL [${current.runtime.webUrl}]: `)).trim() || current.runtime.webUrl;
  rl.close();

  if (provider === "deepseek" && !current.llm.deepseekApiKeyConfigured) patch.llm!.deepseekApiKey = await hiddenQuestion("DeepSeek API key: ");
  if (provider === "openai" && !current.llm.openaiApiKeyConfigured) patch.llm!.openaiApiKey = await hiddenQuestion("OpenAI API key: ");
  if (!current.github.privateKeyConfigured) patch.github!.privateKey = await hiddenQuestion("GitHub private key path or PEM (optional): ") || undefined;
  if (!current.github.webhookSecretConfigured) patch.github!.webhookSecret = await hiddenQuestion("GitHub webhook secret (optional): ") || undefined;

  store.update(patch);
  stdout.write(`\nSaved configuration under ${store.directory}. Secrets are encrypted.\nRun 'npm run config -- doctor' before starting the API.\n`);
}

async function main(): Promise<void> {
  loadNearestEnvFile();
  const store = new SettingsStore();
  const [command = "help", action, ...rest] = process.argv.slice(2);
  if (command === "setup") { await setup(store); return; }
  if (command === "config" && action === "show") { printSnapshot(store, rest.includes("--json")); return; }
  if (command === "config" && action === "doctor") {
    const result = diagnoseConfiguration(store.effectiveEnvironment(process.env));
    if (rest.includes("--json")) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else for (const check of result.checks) stdout.write(`${check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗"} ${check.message}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "config" && action === "set") {
    const [key, suppliedValue] = rest;
    const alias = key ? aliases[key] : undefined;
    if (!alias) throw new Error(`Unknown config key. Available keys:\n${Object.keys(aliases).join("\n")}`);
    const clear = suppliedValue === "--clear";
    const value = clear ? null : suppliedValue ?? (alias.secret ? await hiddenQuestion(`${key}: `) : undefined);
    if (value === undefined) throw new Error("A value is required");
    store.update(alias.patch(value));
    stdout.write(`Updated ${key}. Restart the API to apply the change.\n`);
    return;
  }
  stdout.write("Commands:\n  npm run setup\n  npm run config -- show [--json]\n  npm run config -- doctor [--json]\n  npm run config -- set <key> <value|--clear>\n");
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
