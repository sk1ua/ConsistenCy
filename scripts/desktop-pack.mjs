// Build and stage the desktop application around explicit, pinned runtimes.
// The Electron renderer is an untrusted client; the Node and Python helpers
// live outside the renderer sandbox and communicate through the local API.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";

const root = process.cwd();
const staged = join(root, "apps", "desktop", "staged");
const npmCli = process.env.npm_execpath;
const require = createRequire(import.meta.url);
const { resolveDesktopReleasePolicy } = require("../apps/desktop/scripts/release-policy.cjs");
const desktopManifest = JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8"));
const {
  requestedTargets,
  releaseMode,
  releaseChannel,
  publishMode,
  builderChannel,
  githubReleaseType,
  updateEligibleArtifact
} = resolveDesktopReleasePolicy(process.env, desktopManifest.version);

if (Number(process.versions.node.split(".")[0]) !== 22) {
  throw new Error(`Desktop packaging requires Node 22.x; received ${process.version}`);
}
if (!npmCli || !existsSync(npmCli)) {
  throw new Error("Desktop packaging must be started through npm so the pinned npm CLI is known");
}

function runNpm(args, cwd = root, extraEnv = {}) {
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv }
  });
}

function verifyPython312(executable) {
  const result = spawnSync(executable, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0 || !String(result.stdout).trim().startsWith("3.12.")) {
    throw new Error(`Bundled Python must be 3.12.x: ${executable}`);
  }
}

console.log("Building same-origin renderer and bundled API ...");
runNpm(["run", "build", "-w", "@consistency/web", "--", "--base=/"], root, {
  VITE_API_BASE_URL: "/api"
});
runNpm(["run", "build", "-w", "@consistency/api"]);

console.log("Staging immutable application assets ...");
rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
writeFileSync(join(staged, "package.json"), JSON.stringify({
  name: "consistency-workspace",
  private: true,
  type: "commonjs"
}, null, 2));
cpSync(join(root, "apps", "web", "dist"), join(staged, "apps", "web", "dist"), { recursive: true });
cpSync(join(root, "apps", "api", "dist"), join(staged, "apps", "api", "dist"), { recursive: true });
cpSync(
  join(root, "apps", "api", "src", "notebook", "demo-snapshot"),
  join(staged, "apps", "api", "dist", "notebook", "demo-snapshot"),
  { recursive: true }
);
cpSync(join(root, "engine"), join(staged, "engine"), {
  recursive: true,
  filter: source => !source.includes("__pycache__") && !source.includes("node_modules")
});

const runtime = join(staged, "runtime");
mkdirSync(runtime, { recursive: true });

// The API is bundled except for the native SQLite module. It is installed
// under Node 22, not rebuilt for Electron's embedded Node ABI.
const apiManifest = JSON.parse(readFileSync(join(root, "apps", "api", "package.json"), "utf8"));
writeFileSync(join(runtime, "package.json"), JSON.stringify({
  name: "consistency-desktop-runtime",
  version: "0.1.0",
  private: true,
  dependencies: { "better-sqlite3": apiManifest.dependencies["better-sqlite3"] }
}, null, 2));
runNpm(["install", "--omit=dev", "--no-audit", "--no-fund"], runtime, {
  npm_config_engine_strict: "true"
});
renameSync(join(runtime, "node_modules"), join(runtime, "modules"));

const nodeDirectory = join(runtime, "node");
mkdirSync(nodeDirectory, { recursive: true });
cpSync(process.execPath, join(nodeDirectory, basename(process.execPath)));

const pythonBundleRoot = process.env.CONSISTENCY_PYTHON_BUNDLE_ROOT;
if (!pythonBundleRoot) {
  throw new Error(
    "CONSISTENCY_PYTHON_BUNDLE_ROOT must point to a redistributable Python 3.12 runtime for desktop packaging"
  );
}
const pythonRoot = resolve(pythonBundleRoot);
const pythonExecutable = join(pythonRoot, "python.exe");
if (!existsSync(pythonExecutable)) {
  throw new Error(`Python bundle does not contain python.exe: ${pythonRoot}`);
}
verifyPython312(pythonExecutable);
cpSync(pythonRoot, join(runtime, "python"), {
  recursive: true,
  filter: source => !source.includes("__pycache__")
});

console.log("Running electron-builder (Windows targets) ...");
console.log(releaseMode
  ? "Release signing is mandatory; electron-builder will fail unless the artifact is signed."
  : "Local/manual package: signing is not asserted and automatic updates remain disabled.");
const builderArguments = [
  "exec",
  "electron-builder",
  "--",
  "--win",
  ...requestedTargets,
  `-c.forceCodeSigning=${releaseMode ? "true" : "false"}`,
  `-c.extraMetadata.consistencyDesktopSignedRelease=${releaseMode ? "true" : "false"}`,
  `-c.extraMetadata.consistencyDesktopUpdateChannel=${releaseChannel}`,
  `-c.extraMetadata.consistencyDesktopDistribution=${updateEligibleArtifact ? "nsis" : "manual"}`,
  `-c.publish.channel=${builderChannel}`,
  `-c.publish.releaseType=${githubReleaseType}`,
  "--publish",
  publishMode
];
runNpm(
  builderArguments,
  join(root, "apps", "desktop")
);
console.log("Desktop build finished. Output: apps/desktop/release");
