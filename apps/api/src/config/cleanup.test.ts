import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");

const REMOVED_PATHS = [
  "backend/cli.py",
  "backend/config.py",
  "backend/requirements.txt",
  "backend/src",
  "apps/api/src/publish/publisher.ts",
  "apps/api/src/publish/dbPublisher.ts",
  "apps/api/src/github/comment.ts",
  "apps/api/src/review/legacyReportAdapter.ts",
  "packages/schema/src/legacy.ts",
  "evaluation/scripts/generate_pr_report.py",
  "evaluation/scripts/run_public_pr_reports.py",
  "evaluation/smoke_manifest.json"
];

const LEGACY_PATTERNS = [
  "from src.",
  "backend/cli.py",
  "backend/src",
  "publishPullRequestComment",
  "dbPublisher"
];

const GENERATED_CONTENT_DIRS = [
  resolve(ROOT, "evaluation/repos"),
  resolve(ROOT, "evaluation/results"),
  resolve(ROOT, "evaluation/data")
];

function isInsideGeneratedContent(path: string): boolean {
  const absolute = resolve(path);
  return GENERATED_CONTENT_DIRS.some(
    (root) => absolute === root || absolute.startsWith(`${root}${sep}`)
  );
}

function getAllSourceFiles(dir: string): string[] {
  let results: string[] = [];
  if (!existsSync(dir) || isInsideGeneratedContent(dir)) return results;
  const list = readdirSync(dir);
  for (const file of list) {
    if (file === "node_modules" || file === ".git" || file === "dist" || file === "__pycache__") continue;
    const filePath = join(dir, file);
    if (isInsideGeneratedContent(filePath)) continue;
    const stat = statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllSourceFiles(filePath));
    } else if (/\.(ts|tsx|py|yml|yaml|md|json|toml|txt)$/.test(file)) {
      // Exclude historical audit reports and static test assertion files
      if (!file.endsWith("Audit_Report.md") && !file.endsWith("cleanup.test.ts") && !file.endsWith("ciWorkflow.test.ts")) {
        results.push(filePath);
      }
    }
  }
  return results;
}

describe("Phase 6 Cleanup Static Audit Gate", () => {
  it("verifies all V1 legacy files and directories are physically deleted", () => {
    for (const relPath of REMOVED_PATHS) {
      const fullPath = resolve(ROOT, relPath);
      expect(existsSync(fullPath), `Expected ${relPath} to be deleted`).toBe(false);
    }
  });

  it("verifies zero non-historical references to legacy V1 patterns remain", () => {
    const targetDirs = [
      resolve(ROOT, "apps"),
      resolve(ROOT, "packages"),
      resolve(ROOT, "engine"),
      resolve(ROOT, "tests"),
      resolve(ROOT, "examples"),
      resolve(ROOT, "evaluation"),
      resolve(ROOT, ".github"),
      resolve(ROOT, "docs")
    ];

    const allFiles: string[] = [];
    for (const d of targetDirs) {
      allFiles.push(...getAllSourceFiles(d));
    }
    allFiles.push(resolve(ROOT, "README.md"));
    allFiles.push(resolve(ROOT, "CONTRIBUTING.md"));

    expect(allFiles.some((path) => isInsideGeneratedContent(path))).toBe(false);

    const violations: string[] = [];

    for (const filePath of allFiles) {
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, "utf-8");
      for (const pattern of LEGACY_PATTERNS) {
        if (content.includes(pattern)) {
          violations.push(`${filePath}: contains pattern "${pattern}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
