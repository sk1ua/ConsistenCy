import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createGitExec, execGit, type GitSpawnOptions } from "./git";
import { LocalGitAdapter } from "./local-git-adapter";

class CapturedGitProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

type GitInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: GitSpawnOptions;
};

describe("createGitExec", () => {
  it("uses only runtime variables and disables Git configuration and helpers", async () => {
    // Given
    const invocations: GitInvocation[] = [];
    const ambientEnv: NodeJS.ProcessEnv = {
      PATH: "D:/tools",
      PATHEXT: ".EXE;.CMD",
      SystemRoot: "C:/Windows",
      TEMP: "D:/temp",
      TMP: "D:/tmp",
      CUSTOM_VALUE: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
      HTTP_PROXY: "must-not-leak",
      HOME: "D:/home",
      USERPROFILE: "D:/profile",
      SSH_AUTH_SOCK: "D:/agent.sock",
      Git_Dir: "D:/redirected/.git",
      gIt_WoRk_TrEe: "D:/redirected",
      GIT_CONFIG_COUNT: "1",
      git_config_key_0: "diff.external",
      GIT_CONFIG_VALUE_0: "D:/helper.exe",
      GIT_EXTERNAL_DIFF: "D:/external-diff.exe",
      GiT_DiFf_OpTs: "--output=D:/outside.patch"
    };
    const gitExec = createGitExec((command, args, options) => {
      invocations.push({ command, args, options });
      const child = new CapturedGitProcess();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }, ambientEnv);

    // When
    await gitExec(["status"], { cwd: "D:/repository" });

    // Then
    expect(invocations.map(({ command, args }) => ({ command, args }))).toEqual([{
      command: "git",
      args: [
        "--no-pager",
        "-c",
        "core.quotePath=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
        "-c",
        "core.askPass=",
        "-c",
        "core.editor=",
        "-c",
        "core.sshCommand=",
        "-c",
        "credential.helper=",
        "-c",
        "credential.interactive=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.git.allow=never",
        "-c",
        "protocol.http.allow=never",
        "-c",
        "protocol.https.allow=never",
        "-c",
        "protocol.ssh.allow=never",
        "-c",
        "protocol.ext.allow=never",
        "status"
      ]
    }]);
    expect(invocations.map(({ options }) => options.env)).toEqual([{
      PATH: "D:/tools",
      PATHEXT: ".EXE;.CMD",
      SystemRoot: "C:/Windows",
      TEMP: "D:/temp",
      TMP: "D:/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0"
    }]);
    expect(invocations.map(({ options }) => options)).toMatchObject([{
      cwd: "D:/repository",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }]);
  });

  it("permits only local file transport when explicitly requested", async () => {
    // Given
    const invocations: GitInvocation[] = [];
    const gitExec = createGitExec((command, args, options) => {
      invocations.push({ command, args, options });
      const child = new CapturedGitProcess();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }, { PATH: "D:/tools" });

    // When
    await gitExec(["clone", "source", "target"], {
      cwd: "D:/scratch",
      allowLocalFileTransport: true
    });

    // Then
    expect(invocations[0]?.args).toContain("protocol.file.allow=always");
    expect(invocations[0]?.args).not.toContain("protocol.file.allow=never");
    expect(invocations[0]?.args).toEqual(expect.arrayContaining([
      "protocol.allow=never",
      "protocol.git.allow=never",
      "protocol.http.allow=never",
      "protocol.https.allow=never",
      "protocol.ssh.allow=never",
      "protocol.ext.allow=never"
    ]));
  });

  it("rejects local file transport by default", async () => {
    // Given
    const source = mkdtempSync(join(tmpdir(), "consistency-git-source-"));
    const target = join(tmpdir(), `consistency-git-target-${randomUUID()}`);
    try {
      execFileSync("git", ["init", "--bare", "--quiet", source], { stdio: "ignore" });

      await expect(execGit(["clone", "--quiet", source, target], { cwd: tmpdir() }))
        .rejects.toThrow("transport 'file' not allowed");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("does not execute repository-configured read helpers", async () => {
    // Given
    const repository = mkdtempSync(join(tmpdir(), "consistency-git-readonly-"));
    const helperDirectory = mkdtempSync(join(tmpdir(), "consistency-git-helper-"));
    const marker = join(helperDirectory, "invoked.txt");
    const helper = join(helperDirectory, "helper.cjs");
    const helperCommand = `"${process.execPath}" "${helper}" "${marker}"`;
    try {
      writeFileSync(helper, "require('node:fs').writeFileSync(process.argv[2], 'invoked');\n");
      execFileSync("git", ["init", "--quiet"], { cwd: repository, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repository, stdio: "ignore" });
      writeFileSync(join(repository, "tracked.txt"), "before\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: repository, stdio: "ignore" });
      execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repository, stdio: "ignore" });
      writeFileSync(join(repository, ".gitattributes"), "tracked.txt diff=marker\n");
      writeFileSync(join(repository, "tracked.txt"), "after\n");
      const helperConfigs = [
        ["core.fsmonitor", helperCommand],
        ["diff.external", helperCommand],
        ["diff.marker.textconv", helperCommand]
      ] as const;
      for (const [key, value] of helperConfigs) {
        execFileSync("git", ["config", key, value], { cwd: repository, stdio: "ignore" });
      }
      const adapter = new LocalGitAdapter({ root: repository });

      // When
      await execGit(["status", "--porcelain=v1"], { cwd: repository });
      await adapter.getWorkingDiff();

      // Then
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(helperDirectory, { recursive: true, force: true });
    }
  });
});
