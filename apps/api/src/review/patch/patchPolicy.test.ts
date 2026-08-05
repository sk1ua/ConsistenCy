import { describe, expect, it } from "vitest";
import { inspectPatch } from "./patchPolicy";

const REVIEWED = ["apps/api/src/http.ts", "apps/api/src/server.ts"];

function patchFor(path: string, otherPath = path): string {
  return [
    `diff --git a/${path} b/${otherPath}`,
    `--- a/${path}`,
    `+++ b/${otherPath}`,
    "@@ -1,2 +1,3 @@",
    " const app = express();",
    "+app.use(requireAuth);",
    " export default app;"
  ].join("\n");
}

describe("inspectPatch", () => {
  it("accepts a patch confined to reviewed files", () => {
    const result = inspectPatch(patchFor("apps/api/src/http.ts"), { reviewedPaths: REVIEWED });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.touchedPaths).toEqual(["apps/api/src/http.ts"]);
  });

  it("rejects an empty patch", () => {
    expect(inspectPatch("   ", { reviewedPaths: REVIEWED }).violations[0]?.code).toBe("EMPTY_PATCH");
  });

  it("rejects a patch with no hunks", () => {
    const result = inspectPatch(
      "diff --git a/apps/api/src/http.ts b/apps/api/src/http.ts\n",
      { reviewedPaths: REVIEWED }
    );
    expect(result.violations.map(violation => violation.code)).toContain("MALFORMED");
  });

  it("rejects a file that was never reviewed", () => {
    // A fix for code nobody looked at has no evidence behind it.
    const result = inspectPatch(patchFor("apps/api/src/unreviewed.ts"), { reviewedPaths: REVIEWED });

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("PATH_OUTSIDE_REVIEW");
  });

  it("rejects CI configuration even when it was reviewed", () => {
    const result = inspectPatch(patchFor(".github/workflows/ci.yml"), {
      reviewedPaths: [".github/workflows/ci.yml"]
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("FORBIDDEN_PATH");
  });

  it("rejects git internals, lockfiles, and credential-bearing dotfiles", () => {
    // `.npmrc` classifies as a secret path rather than merely protected, since
    // it can carry registry auth tokens. Either way the patch is refused.
    for (const path of [".git/config", "package-lock.json", ".npmrc", ".consistency/config.json"]) {
      const result = inspectPatch(patchFor(path), { reviewedPaths: [path] });
      expect(result.ok, path).toBe(false);
      expect(["FORBIDDEN_PATH", "SECRET_PATH"], path).toContain(result.violations[0]?.code);
    }
  });

  it("rejects secret paths", () => {
    const result = inspectPatch(patchFor("apps/api/secrets/app.private-key.pem"), {
      reviewedPaths: ["apps/api/secrets/app.private-key.pem"]
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("SECRET_PATH");
  });

  it("rejects path traversal and absolute paths", () => {
    for (const path of ["../../etc/passwd", "/etc/passwd", "C:/Windows/System32/drivers/etc/hosts"]) {
      const result = inspectPatch(patchFor(path), { reviewedPaths: [path] });
      expect(result.ok, path).toBe(false);
      expect(result.violations[0]?.code, path).toBe("PATH_TRAVERSAL");
    }
  });

  it("catches a rename that smuggles in a second, unreviewed path", () => {
    const result = inspectPatch(
      patchFor("apps/api/src/http.ts", ".github/workflows/release.yml"),
      { reviewedPaths: REVIEWED }
    );

    expect(result.ok).toBe(false);
    expect(result.violations.some(violation => violation.code === "FORBIDDEN_PATH")).toBe(true);
  });

  it("enforces a size cap", () => {
    const huge = `${patchFor("apps/api/src/http.ts")}\n${"+padding\n".repeat(5_000)}`;
    const result = inspectPatch(huge, { reviewedPaths: REVIEWED, maxPatchBytes: 512 });

    expect(result.violations.some(violation => violation.code === "TOO_LARGE")).toBe(true);
  });

  it("enforces a file-count cap", () => {
    const combined = REVIEWED.map(path => patchFor(path)).join("\n");
    const result = inspectPatch(combined, { reviewedPaths: REVIEWED, maxFiles: 1 });

    expect(result.violations.some(violation => violation.code === "TOO_MANY_FILES")).toBe(true);
  });

  it("normalises backslash paths so Windows-style output cannot bypass checks", () => {
    const result = inspectPatch(patchFor(".github\\workflows\\ci.yml"), {
      reviewedPaths: [".github/workflows/ci.yml"]
    });

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("FORBIDDEN_PATH");
  });

  it("ignores /dev/null on additions and deletions", () => {
    const addition = [
      "diff --git a/apps/api/src/http.ts b/apps/api/src/http.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/apps/api/src/http.ts",
      "@@ -0,0 +1 @@",
      "+export {};"
    ].join("\n");

    const result = inspectPatch(addition, { reviewedPaths: REVIEWED });
    expect(result.touchedPaths).toEqual(["apps/api/src/http.ts"]);
    expect(result.ok).toBe(true);
  });
});
