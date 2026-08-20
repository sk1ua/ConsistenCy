import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createE2eGitFixture(name = "e2e-fixture"): string {
  const root = process.env.CONSISTENCY_E2E_ROOT ?? join(tmpdir(), "consistency-e2e");
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "e2e@consistency.local"]);
  git(["config", "user.name", "ConsistenCy E2E"]);
  writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
  git(["add", "src.ts"]);
  git(["commit", "-q", "-m", "initial commit"]);
  writeFileSync(join(repo, "src.ts"), "export const a = 2;\nexport const b = 3;\n");
  return repo;
}
