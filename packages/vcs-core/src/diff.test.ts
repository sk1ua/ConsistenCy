import { describe, expect, it } from "vitest";
import { vcsChangedFileSchema } from "@consistency/schema";
import { parseUnifiedDiff, splitNulRecords } from "./diff";

describe("parseUnifiedDiff", () => {
  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("\n  \n")).toEqual([]);
  });

  it("parses a modified file with accurate add/delete counts", () => {
    const [file] = parseUnifiedDiff([
      "diff --git a/apps/api/src/http.ts b/apps/api/src/http.ts",
      "index 1a2b3c4..5d6e7f8 100644",
      "--- a/apps/api/src/http.ts",
      "+++ b/apps/api/src/http.ts",
      "@@ -10,5 +10,6 @@ export function createHttpServer() {",
      "   const app = express();",
      "   app.use(json());",
      "-  app.post(\"/admin\", handler);",
      "+  app.post(\"/admin\", requireAuth, handler);",
      "+  app.get(\"/health\", healthHandler);",
      "   return app;",
      " }"
    ].join("\n"));

    expect(file?.path).toBe("apps/api/src/http.ts");
    expect(file?.status).toBe("modified");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0]?.oldStart).toBe(10);
    expect(file?.hunks[0]?.oldLines).toBe(5);
    expect(file?.hunks[0]?.newLines).toBe(6);
  });

  it("does not mistake a deleted line for a file header", () => {
    // Deleting the literal text "-- a/evil/path" renders as "--- a/evil/path",
    // which is byte-identical to a diff file header.
    const files = parseUnifiedDiff([
      "diff --git a/notes.txt b/notes.txt",
      "index aaa1111..bbb2222 100644",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "--- a/evil/path",
      "+++ b/good/path"
    ].join("\n"));

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("notes.txt");
    expect(files[0]?.additions).toBe(1);
    expect(files[0]?.deletions).toBe(1);
    expect(files[0]?.hunks[0]?.content).toContain("--- a/evil/path");
  });

  it("parses an added file with a zero-based old side", () => {
    const [file] = parseUnifiedDiff([
      "diff --git a/packages/vcs-core/src/index.ts b/packages/vcs-core/src/index.ts",
      "new file mode 100644",
      "index 0000000..1234567",
      "--- /dev/null",
      "+++ b/packages/vcs-core/src/index.ts",
      "@@ -0,0 +1,2 @@",
      "+export * from \"./git\";",
      "+export * from \"./diff\";"
    ].join("\n"));

    expect(file?.status).toBe("added");
    expect(file?.path).toBe("packages/vcs-core/src/index.ts");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
    expect(file?.hunks[0]?.oldStart).toBe(0);
    expect(file?.hunks[0]?.oldLines).toBe(0);
    expect(file?.previousPath).toBeUndefined();
  });

  it("keeps the original path for a deleted file", () => {
    const [file] = parseUnifiedDiff([
      "diff --git a/apps/web/src/pages/RealDataPage.tsx b/apps/web/src/pages/RealDataPage.tsx",
      "deleted file mode 100644",
      "index 1234567..0000000",
      "--- a/apps/web/src/pages/RealDataPage.tsx",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export function RealDataPage() {",
      "-}"
    ].join("\n"));

    expect(file?.status).toBe("deleted");
    expect(file?.path).toBe("apps/web/src/pages/RealDataPage.tsx");
    expect(file?.deletions).toBe(2);
  });

  it("records previousPath for a rename and handles omitted line counts", () => {
    const [file] = parseUnifiedDiff([
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 92%",
      "rename from old/name.ts",
      "rename to new/name.ts",
      "index aaa1111..bbb2222 100644",
      "--- a/old/name.ts",
      "+++ b/new/name.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;"
    ].join("\n"));

    expect(file?.status).toBe("renamed");
    expect(file?.path).toBe("new/name.ts");
    expect(file?.previousPath).toBe("old/name.ts");
    expect(file?.hunks[0]?.oldLines).toBe(1);
    expect(file?.hunks[0]?.newLines).toBe(1);
  });

  it("flags binary files, which carry no ---/+++ lines", () => {
    const [file] = parseUnifiedDiff([
      "diff --git a/docs/screenshots/dashboard.png b/docs/screenshots/dashboard.png",
      "index aaa1111..bbb2222 100644",
      "Binary files a/docs/screenshots/dashboard.png and b/docs/screenshots/dashboard.png differ"
    ].join("\n"));

    expect(file?.path).toBe("docs/screenshots/dashboard.png");
    expect(file?.binary).toBe(true);
    expect(file?.hunks).toEqual([]);
    expect(file?.additions).toBe(0);
  });

  it("treats a permission change as modified but a symlink swap as type_changed", () => {
    const [permission] = parseUnifiedDiff([
      "diff --git a/scripts/dev.sh b/scripts/dev.sh",
      "old mode 100644",
      "new mode 100755"
    ].join("\n"));
    expect(permission?.path).toBe("scripts/dev.sh");
    expect(permission?.status).toBe("modified");

    const [retyped] = parseUnifiedDiff([
      "diff --git a/link b/link",
      "old mode 120000",
      "new mode 100644",
      "index aaa1111..bbb2222",
      "--- a/link",
      "+++ b/link",
      "@@ -1 +1 @@",
      "-target/path",
      "\\ No newline at end of file",
      "+real content"
    ].join("\n"));
    expect(retyped?.status).toBe("type_changed");
    expect(retyped?.additions).toBe(1);
    expect(retyped?.deletions).toBe(1);
  });

  it("parses several files from one patch", () => {
    const files = parseUnifiedDiff([
      "diff --git a/one.ts b/one.ts",
      "index aaa1111..bbb2222 100644",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/two.ts b/two.ts",
      "new file mode 100644",
      "index 0000000..ccc3333",
      "--- /dev/null",
      "+++ b/two.ts",
      "@@ -0,0 +1 @@",
      "+c",
      "diff --git a/three.png b/three.png",
      "index ddd4444..eee5555 100644",
      "Binary files a/three.png and b/three.png differ"
    ].join("\n"));

    expect(files.map((file) => file.path)).toEqual(["one.ts", "two.ts", "three.png"]);
    expect(files.map((file) => file.status)).toEqual(["modified", "added", "modified"]);
    expect(files[2]?.binary).toBe(true);
  });

  it("emits files that satisfy the Module 0 contract", () => {
    const files = parseUnifiedDiff([
      "diff --git a/old.ts b/new.ts",
      "similarity index 80%",
      "rename from old.ts",
      "rename to new.ts",
      "index aaa1111..bbb2222 100644",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-drop",
      "+add"
    ].join("\n"));

    for (const file of files) {
      expect(() => vcsChangedFileSchema.parse(file)).not.toThrow();
    }
  });
});

describe("splitNulRecords", () => {
  it("drops the trailing empty field git leaves behind", () => {
    expect(splitNulRecords("a.txt\0b.txt\0")).toEqual(["a.txt", "b.txt"]);
    expect(splitNulRecords("")).toEqual([]);
  });
});
