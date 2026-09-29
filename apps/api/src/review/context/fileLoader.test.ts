import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSecretPath, loadWorkspaceFiles, resolveWorkspaceFile } from "./fileLoader";

const directories: string[] = [];

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("secure workspace file loading", () => {
  it("rejects traversal, absolute paths, and symlink escapes", () => {
    const workspace = tempDirectory("consistency-workspace-");
    const outside = tempDirectory("consistency-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(workspace, "link"), "junction");

    expect(() => resolveWorkspaceFile(workspace, "../secret.txt")).toThrow(/escapes/);
    expect(() => resolveWorkspaceFile(workspace, join(outside, "secret.txt"))).toThrow(/relative/);
    expect(() => resolveWorkspaceFile(workspace, "link/secret.txt")).toThrow(/outside/);
  });

  it("skips secret, binary, and oversized files", () => {
    const workspace = tempDirectory("consistency-files-");
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "small.ts"), "export const ok = true;");
    writeFileSync(join(workspace, "src", "token.ts"), "const token = 'github_pat_abcdefghijklmnopqrstuvwxyz123456';");
    writeFileSync(join(workspace, "src", "large.ts"), "x".repeat(100));
    writeFileSync(join(workspace, ".env"), "TOKEN=secret");
    writeFileSync(join(workspace, "src", "binary.dat"), Buffer.from([0, 1, 2]));

    expect(loadWorkspaceFiles({
      workspacePath: workspace,
      paths: ["src/small.ts", "src/token.ts", "src/large.ts", ".env", "src/binary.dat"],
      maxFileBytes: 100,
      maxTotalBytes: 140
    })).toEqual({
      "src/small.ts": "export const ok = true;",
      "src/token.ts": "const token=[REDACTED];"
    });
    expect(isSecretPath("config/.env.production")).toBe(true);
    expect(isSecretPath("keys/app.pem")).toBe(true);
    expect(isSecretPath(".npmrc")).toBe(true);
  });
});
