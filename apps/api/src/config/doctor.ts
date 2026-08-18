import { accessSync, constants, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./env";
import { normalizeGitHubPrivateKey } from "../github/auth";

export type DoctorCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

export type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
};

function nearestExistingDirectory(path: string): string {
  let directory = resolve(path);
  while (!existsSync(directory)) {
    const parent = dirname(directory);
    if (parent === directory) return process.cwd();
    directory = parent;
  }
  return directory;
}

export function diagnoseConfiguration(environment: NodeJS.ProcessEnv): DoctorResult {
  const checks: DoctorCheck[] = [];
  let config;
  try {
    config = loadEnv(environment);
    checks.push({ id: "schema", status: "pass", message: "Configuration values are valid" });
  } catch (error) {
    checks.push({
      id: "schema",
      status: "fail",
      message: error instanceof Error ? error.message : "Configuration validation failed"
    });
    return { ok: false, checks };
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(nodeMajor === 22
    ? { id: "node", status: "pass", message: `Node.js ${process.versions.node} matches the 22.x baseline` }
    : { id: "node", status: "warn", message: `Node.js ${process.versions.node} differs from the 22.x baseline` });

  try {
    const directory = nearestExistingDirectory(dirname(config.databasePath));
    accessSync(directory, constants.R_OK | constants.W_OK);
    checks.push({ id: "database", status: "pass", message: `Database directory is accessible: ${directory}` });
  } catch {
    checks.push({ id: "database", status: "fail", message: `Database directory is not writable: ${dirname(config.databasePath)}` });
  }

  if (!config.LLM_PROVIDER) {
    checks.push({ id: "llm", status: "warn", message: "LLM provider is not configured; review executions will be blocked until configured" });
  } else {
    const configured = config.LLM_PROVIDER === "deepseek" ? Boolean(config.DEEPSEEK_API_KEY) : Boolean(config.OPENAI_API_KEY);
    checks.push(configured
      ? { id: "llm", status: "pass", message: `${config.LLM_PROVIDER} credentials are configured` }
      : { id: "llm", status: "fail", message: `${config.LLM_PROVIDER} credentials are missing` });
  }

  const githubValues = [config.GITHUB_APP_ID, config.GITHUB_PRIVATE_KEY, config.GITHUB_WEBHOOK_SECRET];
  if (githubValues.every(Boolean)) {
    try {
      const privateKey = normalizeGitHubPrivateKey(config.GITHUB_PRIVATE_KEY!);
      const valid = privateKey.includes("-----BEGIN") && privateKey.includes("PRIVATE KEY-----");
      checks.push(valid
        ? { id: "github", status: "pass", message: "GitHub App ID, private key and webhook secret are configured" }
        : { id: "github", status: "fail", message: "GitHub private key is not a valid PEM key or readable key file" });
    } catch (error) {
      checks.push({ id: "github", status: "fail", message: error instanceof Error ? error.message : "GitHub private key is invalid" });
    }
  } else if (githubValues.some(Boolean)) {
    checks.push({ id: "github", status: "fail", message: "GitHub App configuration is incomplete" });
  } else {
    checks.push({ id: "github", status: "warn", message: "GitHub App is not configured; real PR webhooks cannot run" });
  }

  checks.push(config.allowedOrigins.includes(config.CONSISTENCY_WEB_URL)
    ? { id: "cors", status: "pass", message: "Web URL is included in allowed origins" }
    : { id: "cors", status: "warn", message: "Web URL is not listed in allowed origins; browser requests may be blocked" });

  return { ok: checks.every(check => check.status !== "fail"), checks };
}
