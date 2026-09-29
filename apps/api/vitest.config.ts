import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Analysis jobs clone the repositories they inspect into
    // .consistency/workspaces/job_*/. Those checkouts carry their own test
    // suites, which vitest's default include glob would otherwise collect and
    // execute as if they were ours.
    exclude: [...configDefaults.exclude, "**/dist/**", "**/.consistency/**"],
    // Replaces http/https.globalAgent with non-keep-alive agents for every
    // test file; see vitest.setup.ts for the loopback-socket rationale and its
    // reproduction status.
    setupFiles: ["./vitest.setup.ts"],
    // Wall-clock budget only — assertions are unchanged.
    //
    // Documented failure this budget answers (2026-09-21, recorded in the file
    // comment of src/audit/localRegistration.http.test.ts and in
    // docs/delivery-readiness.md:183): two full-suite runs hit the 5s default
    // with "Test timed out in 5000ms" and NO assertion failure, while that test
    // takes ~1.1-1.3s isolated; raising its per-test budget to 20s produced
    // 794/794. The suite has since grown to 96 files / 946 tests.
    //
    // Measured on 2026-09-27 (this checkout, HEAD 0b20fa2, Windows, 24 logical
    // cores, Node v25.8.1 — note .node-version/.nvmrc declare Node 22, so this
    // is NOT the declared baseline):
    //   4 workers  -> 96 files / 946 tests passed, 26.13s, exit 0
    //   8 workers  -> 96 files / 946 tests passed, 16.75s, exit 0
    //   23 workers -> 96 files / 946 tests passed, 17.65s, exit 0
    // Slowest single test at 23 workers: 7865ms (the localRegistration case,
    // ~1.28s isolated); slowest test file 15.3s. High file-level parallelism
    // clearly inflates per-test wall-clock, but nothing approached this budget
    // at that suite size (96 files).
    //
    // Re-measured 2026-09-27 14:45 at 4 workers once the team's in-flight work
    // settled, with the grown suite: 100 files / 994 tests ALL passed, 68.74s,
    // exit 0. Slowest single test in that run: 5416ms — i.e. at the current
    // suite size a real test already exceeds vitest's 5s default, which is the
    // concrete reason this budget cannot go back to the default. It is still
    // only ~18% of 30s.
    //
    // Separate failure mode, same day 14:35, with the grown suite (100 files /
    // 983 tests) at only 4 workers: the run failed because the HOST ran out of
    // loopback sockets — 12.5k TIME_WAIT entries against a 13,977-port dynamic
    // range — surfacing as `listen/connect ENOBUFS: no buffer space available
    // 127.0.0.1`, two unhandled ENOBUFS errors, and three 30s timeouts in files
    // that normally finish in ~1s (localRegistration, reviews, triggers). Every
    // failure was transport-level; no assertion failed. No timeout budget can
    // fix ENOBUFS, and lowering workers does not prevent it either: treat a run
    // failing this way as a saturated machine (usually several full-suite runs
    // in the same few minutes, including this team's parallel verification),
    // not as a slow or hanging product.
    //
    // An earlier note here claimed the 30s budget "was still exceeded (3/3
    // full runs, localRegistration >30s)" and that loopback requests
    // intermittently failed with ECONNRESET at 23 workers. Neither was
    // reproduced on 2026-09-27 (three full runs above: zero ECONNRESET, no test
    // above 7.9s), so both are historical observations, not current evidence.
    // The ENOBUFS run above shows such a wall-clock breach is possible, but its
    // cause is host socket exhaustion rather than the worker count.
    // 30s is therefore margin against the documented 5s starvation failure and
    // against genuine product hangs; it is not a measured requirement of any
    // currently known slow test. Full evidence: docs/upstream-reuse-ledger.md §9.
    testTimeout: 30_000,
    // File-level parallelism cap. Vitest's default here is cores − 1 = 23 (24
    // logical cores), which starves the git/Python spawns and loopback HTTP
    // these files rely on. All three concurrency levels measured above pass, so
    // this cap is a robustness/wall-clock margin rather than a pass/fail
    // switch: it keeps the per-test inflation measured above (~1.3s → ~7.9s for
    // the slowest case) well inside the budget. Assertions and the fail-closed
    // timeout budget are unchanged.
    maxWorkers: 8
  }
});
