import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Stability budget for vitest invocations whose project root is the repository
// root (e.g. `vitest run apps/api ...` with path filters). Without a root
// config those runs use vitest's defaults — a 5s per-test timeout and
// cores−1 workers — which do NOT match the budgets each workspace configures
// in its own vitest.config.ts, so the same tests that pass inside a workspace
// fail here purely on wall-clock.
//
// Evidence status (2026-09-27 audit, docs/upstream-reuse-ledger.md §9):
//   - the "commitPath AC-PUB-2/3/5 and host.test.ts failing at 5.5–8.8s under
//     root-config defaults" observation is HISTORICAL (2026-09-21 round 2) and
//     was NOT re-reproduced by the 2026-09-27 audit — treat it as a prior
//     observation, not a standing measurement;
//   - what the 2026-09-27 audit did measure: the slowest single API test is now
//     5416ms (> the 5s default), and one full run breached 30s purely because
//     the host had exhausted its loopback ephemeral ports (12,579 TIME_WAIT of
//     13,977 → listen/connect ENOBUFS), which no per-test budget can absorb.
// The settings below are therefore a deliberate margin, not a pass/fail switch:
// measured 2026-09-27 on Node v25.8.1 (the repo declares Node 22.x — recorded
// because it is a known environment drift), 4/8/23 workers all pass.
//
// These settings mirror apps/api/vitest.config.ts; see that file and
// apps/api/vitest.setup.ts for the full rationale. Per-workspace runs are
// unaffected: vitest resolves the config from the invocation's project root,
// so `vitest run` inside apps/api or a package still uses that
// workspace's own config.
export default defineConfig({
  test: {
    // Analysis jobs clone the repositories they inspect into
    // .consistency/workspaces/job_*/. Those checkouts carry their own test
    // suites, which a root-level run would otherwise collect and execute as
    // if they were ours.
    exclude: [...configDefaults.exclude, "**/dist/**", "**/.consistency/**"],
    // Resolved against THIS file, not against the invocation's working
    // directory: workspace runs that have no vitest.config.ts of their own
    // (e.g. `npm run test -w @consistency/schema`, whose cwd is the package
    // directory) inherit this root config, and a bare "./vitest.setup.ts"
    // then resolved to <workspace>/vitest.setup.ts and failed the whole run
    // with "Cannot find module …/packages/schema/vitest.setup.ts".
    setupFiles: [fileURLToPath(new URL("./vitest.setup.ts", import.meta.url))],
    // See apps/api/vitest.config.ts: the suites spawn real git processes,
    // Python engine subprocesses, and in-process HTTP servers; the default 5s
    // timeout fails them under load while every assertion passes, and the
    // default worker count starves process creation on Windows. Assertions
    // are unchanged — this only widens the wall-clock budget.
    testTimeout: 30_000,
    maxWorkers: 8
  }
});
