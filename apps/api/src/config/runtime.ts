import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { loadEnv, type AppConfig } from "./env";
import { SettingsStore } from "./settings";

export function loadNearestEnvFile(startDirectory = process.cwd()): string | undefined {
  let directory = startDirectory;
  while (true) {
    const envPath = join(directory, ".env");
    if (existsSync(envPath)) {
      loadEnvFile(envPath);
      return envPath;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function loadRuntimeConfig(
  store: SettingsStore | undefined = undefined,
  environment: NodeJS.ProcessEnv = process.env
): { config: AppConfig; store: SettingsStore } {
  const resolvedStore = store ?? new SettingsStore(environment.CONSISTENCY_SETTINGS_ROOT);

  if (environment.CONSISTENCY_LOAD_ENV_FILE !== "false") {
    if (environment !== process.env) {
      throw new Error("Custom environment requires CONSISTENCY_LOAD_ENV_FILE=false");
    }
    loadNearestEnvFile();
  }

  return {
    config: loadEnv(resolvedStore.effectiveEnvironment(environment)),
    store: resolvedStore
  };
}
