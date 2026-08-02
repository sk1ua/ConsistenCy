import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";
import { loadRuntimeConfig } from "./runtime";

describe("Runtime Config & Environment Isolation Unit Tests", () => {
  it("defaults CONSISTENCY_WORKERS_ENABLED to true and parses string 'false' as boolean false", () => {
    const defaultEnv = loadEnv({});
    expect(defaultEnv.CONSISTENCY_WORKERS_ENABLED).toBe(true);

    const disabledEnv = loadEnv({ CONSISTENCY_WORKERS_ENABLED: "false" });
    expect(disabledEnv.CONSISTENCY_WORKERS_ENABLED).toBe(false);

    const enabledEnv = loadEnv({ CONSISTENCY_WORKERS_ENABLED: "true" });
    expect(enabledEnv.CONSISTENCY_WORKERS_ENABLED).toBe(true);

    expect(() => loadEnv({ CONSISTENCY_WORKERS_ENABLED: "0" as any })).toThrow();
    expect(() => loadEnv({ CONSISTENCY_WORKERS_ENABLED: "yes" as any })).toThrow();
  });

  it("constructs SettingsStore from CONSISTENCY_SETTINGS_ROOT in environment parameter without reading real .consistency", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "runtime-test-"));
    try {
      const { config, store } = loadRuntimeConfig(undefined, {
        CONSISTENCY_SETTINGS_ROOT: tempRoot,
        CONSISTENCY_LOAD_ENV_FILE: "false"
      });

      expect(store.rootDirectory).toBe(resolve(tempRoot));
      expect(config.CONSISTENCY_WORKERS_ENABLED).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("prevents reading project .env file when CONSISTENCY_LOAD_ENV_FILE=false", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "runtime-test-env-"));
    try {
      const { config } = loadRuntimeConfig(undefined, {
        CONSISTENCY_SETTINGS_ROOT: tempRoot,
        CONSISTENCY_LOAD_ENV_FILE: "false",
        CONSISTENCY_WORKERS_ENABLED: "false"
      });

      expect(config.CONSISTENCY_WORKERS_ENABLED).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
