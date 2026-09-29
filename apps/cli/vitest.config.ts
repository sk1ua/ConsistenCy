import { defineConfig } from "vitest/config";

/**
 * `root` is pinned to this package rather than left to the caller's CWD: the
 * repo has no root vitest config, so `vitest run --config apps/cli/...` from the
 * workspace root would otherwise resolve `include` against the root and find no
 * test files.
 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
});
