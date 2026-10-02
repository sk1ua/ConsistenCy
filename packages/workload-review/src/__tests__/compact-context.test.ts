import { describe, expect, it } from "vitest";
import type { PRReviewContext } from "@consistency/schema";
import { buildAgentPrompt } from "../agents/prompts.js";

function context(): PRReviewContext {
  return {
    jobId: "compact", source: "local_git", repositoryFullName: "test/example",
    baseSha: "base", headSha: "head", projectMetadata: {}, workspacePath: "unused",
    changedFiles: [{
      path: "src/app.py", status: "modified", additions: 1, deletions: 1, changes: 2,
      patch: "@@ -2,1 +2,1 @@\n-    return 0\n+    return 1\n",
    }],
    diff: "",
    fileContents: {
      "src/app.py": "def changed():\n    return 1\n\ndef untouched():\n    return 0\n",
      "src/other.py": "def elsewhere():\n    return 2\n",
    },
    baseFileContents: {},
  };
}

describe("compact file context", () => {
  it("keeps the default full file prompt byte-identical", () => {
    const first = buildAgentPrompt("Correctness", context(), undefined, [], "en-US");
    const second = buildAgentPrompt("Correctness", context(), undefined, [], "en-US", undefined, undefined, 3, false);
    expect(second.userPrompt).toBe(first.userPrompt);
    expect(first.userPrompt).toContain("def untouched");
    expect(first.userPrompt).toContain("FILE src/other.py");
    expect(first.userPrompt).not.toContain("\nHUNK\n");
  });

  it("sends numbered hunks and the enclosing unit, not untouched files", () => {
    const prompt = buildAgentPrompt("Correctness", context(), undefined, [], "en-US", undefined, undefined, 3, true).userPrompt;
    expect(prompt).toContain("HUNK\n2:     return 1");
    expect(prompt).toContain("UNIT\n1: def changed():\n2:     return 1");
    expect(prompt).not.toContain("def untouched");
    expect(prompt).not.toContain("FILE src/other.py");
  });
});
