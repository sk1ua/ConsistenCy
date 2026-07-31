import { execFileSync } from "node:child_process";

export function queryPythonVersion(python = "python", execute = execFileSync) {
  return execute(
    python,
    ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"],
    { encoding: "utf8" }
  ).trim();
}

export function assertNodeBaseline(version) {
  const clean = version.replace(/^v/, "");
  const major = Number(clean.split(".")[0]);
  if (major !== 22) {
    throw new Error(`Node 22.x required, got ${version}`);
  }
}

export function assertPythonBaseline(version) {
  if (!version.startsWith("3.12.")) {
    throw new Error(`Python 3.12.x required, got ${version}`);
  }
}
