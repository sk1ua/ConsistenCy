import { describe, expect, it } from "vitest";
import { LocalGitAdapter } from "./local-git-adapter";

describe("LocalGitAdapter diff safety", () => {
  it("disables external diff and text conversion for working diffs", async () => {
    // Given
    const calls: string[][] = [];
    const adapter = new LocalGitAdapter({
      root: "D:/repository",
      exec: async (args) => {
        calls.push(args);
        return {
          stdout: args[0] === "rev-parse" ? "a".repeat(40) : "",
          stderr: "",
          exitCode: 0
        };
      }
    });

    // When
    await adapter.getWorkingDiff();

    // Then
    expect(calls).toContainEqual([
      "diff",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "HEAD"
    ]);
  });

  it("disables external diff and text conversion for branch diffs", async () => {
    // Given
    const calls: string[][] = [];
    const adapter = new LocalGitAdapter({
      root: "D:/repository",
      exec: async (args) => {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    // When
    await adapter.getBranchDiff("base", "head");

    // Then
    expect(calls).toEqual([[
      "diff",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "base...head"
    ]]);
  });
});
