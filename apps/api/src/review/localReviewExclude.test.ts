import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalReviewExcludeFilter,
  filterLocalReviewPaths,
  isLocalReviewPathExcluded,
  matchesExcludePattern,
  parseExcludePatterns,
  readConsistencyIgnoreFile
} from "./localReviewExclude";

describe("parseExcludePatterns", () => {
  it("skips blanks and full-line comments", () => {
    expect(parseExcludePatterns(`
# Noise
artifacts/
apps/web/src/shell/dogfood*.ts

*.png
`)).toEqual(["artifacts/", "apps/web/src/shell/dogfood*.ts", "*.png"]);
  });

  it("accepts comma-separated env-style lists", () => {
    expect(parseExcludePatterns("artifacts/, tmp/**, # ignored")).toEqual(["artifacts/", "tmp/**"]);
  });
});

describe("matchesExcludePattern", () => {
  it("matches directory prefixes and globs", () => {
    expect(matchesExcludePattern("artifacts/shot.png", "artifacts/")).toBe(true);
    expect(matchesExcludePattern("artifacts", "artifacts/")).toBe(true);
    expect(matchesExcludePattern("src/keep.ts", "artifacts/")).toBe(false);
    expect(matchesExcludePattern("apps/web/src/shell/dogfoodBait.ts", "apps/web/src/shell/dogfood*.ts")).toBe(true);
    expect(matchesExcludePattern("apps/web/src/shell/AppShell.tsx", "apps/web/src/shell/dogfood*.ts")).toBe(false);
    expect(matchesExcludePattern("nested/foo.png", "*.png")).toBe(true);
  });
});

describe("createLocalReviewExcludeFilter", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("loads .consistencyignore and env extras for a temp repo", () => {
    root = mkdtempSync(join(tmpdir(), "consistency-ignore-"));
    writeFileSync(join(root, ".consistencyignore"), "# sample\nartifacts/\napps/web/src/shell/dogfood*.ts\n");
    mkdirSync(join(root, "artifacts"), { recursive: true });

    const filter = createLocalReviewExcludeFilter(root, {
      CONSISTENCY_LOCAL_REVIEW_EXCLUDE: "scratch.tmp,\n**/dogfoodTrackedBait.ts"
    });

    expect(readConsistencyIgnoreFile(root)).toEqual(["artifacts/", "apps/web/src/shell/dogfood*.ts"]);
    expect(filter.excludes("artifacts/report.png")).toBe(true);
    expect(filter.excludes("apps/web/src/shell/dogfoodBait.ts")).toBe(true);
    expect(filter.excludes("apps/web/src/shell/dogfoodTrackedBait.ts")).toBe(true);
    expect(filter.excludes("scratch.tmp")).toBe(true);
    expect(filter.excludes("apps/web/src/shell/AppShell.tsx")).toBe(false);

    expect(filterLocalReviewPaths(
      ["keep.ts", "artifacts/a.png", "apps/web/src/shell/dogfoodBait.ts"],
      filter.patterns
    )).toEqual(["keep.ts"]);
    expect(isLocalReviewPathExcluded("keep.ts", filter.patterns)).toBe(false);
  });
});
