import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Analysis jobs clone the repositories they inspect into
    // .consistency/workspaces/job_*/. Those checkouts carry their own test
    // suites, which vitest's default include glob would otherwise collect and
    // execute as if they were ours.
    exclude: [...configDefaults.exclude, "**/dist/**", "**/.consistency/**"]
  }
});
