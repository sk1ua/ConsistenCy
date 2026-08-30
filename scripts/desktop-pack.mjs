// Build and stage the desktop application around explicit, pinned runtimes.
// The Electron renderer is an untrusted client; the Node and Python helpers
// live outside the renderer sandbox and communicate through the local API.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
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

if (Number(process.versions.node.split(".")[0]) < 22) {
  throw new Error(`Desktop packaging requires Node >= 22.x; received ${process.version}`);
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

const statusOutput = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
const isDirty = statusOutput.status === 0 && Boolean(statusOutput.stdout.trim());
if (isDirty && process.env.CONSISTENCY_ALLOW_DIRTY_PACK !== "true") {
  throw new Error("Desktop package provenance requires a clean Git working tree. Commit changes before packaging.");
}

const revParseOutput = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
if (revParseOutput.status !== 0 || !revParseOutput.stdout.trim()) {
  throw new Error("Desktop packaging requires an accessible Git repository to resolve HEAD commit SHA");
}
const gitCommitSha = revParseOutput.stdout.trim();

console.log(`Building same-origin renderer and bundled API (version=${desktopManifest.version}, sha=${gitCommitSha}) ...`);
runNpm(["run", "build", "-w", "@consistency/web", "--", "--base=/"], root, {
  VITE_API_BASE_URL: "/api",
  VITE_APP_VERSION: desktopManifest.version,
  VITE_GIT_COMMIT: gitCommitSha
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
writeFileSync(join(staged, "build-info.json"), JSON.stringify({
  version: desktopManifest.version,
  commitSha: gitCommitSha,
  buildMode: releaseMode ? "release" : "manual"
}, null, 2));
cpSync(join(root, "apps", "web", "dist"), join(staged, "apps", "web", "dist"), { recursive: true });
cpSync(join(root, "apps", "api", "dist"), join(staged, "apps", "api", "dist"), { recursive: true });
cpSync(join(root, "engine"), join(staged, "engine"), {
  recursive: true,
  filter: source => !source.includes("__pycache__") && !source.includes("node_modules")
});

const runtime = join(staged, "runtime");
mkdirSync(runtime, { recursive: true });

// The API is bundled except for the native SQLite module and the tree-sitter
// assets. They are installed under Node 22, not rebuilt for Electron's
// embedded Node ABI.
const apiManifest = JSON.parse(readFileSync(join(root, "apps", "api", "package.json"), "utf8"));
const pluginsManifest = JSON.parse(readFileSync(join(root, "packages", "plugins-builtin", "package.json"), "utf8"));
writeFileSync(join(runtime, "package.json"), JSON.stringify({
  name: "consistency-desktop-runtime",
  version: "0.1.0",
  private: true,
  dependencies: {
    "better-sqlite3": apiManifest.dependencies["better-sqlite3"],
    // TreeSitterService resolves these two at runtime: the wasm runtime and
    // the grammar files are data assets that esbuild cannot inline, so the
    // bundled server.cjs still require.resolve()es them from node_modules.
    // Pin the exact versions locked in @consistency/plugins-builtin.
    "web-tree-sitter": pluginsManifest.dependencies["web-tree-sitter"],
    "tree-sitter-wasms": pluginsManifest.dependencies["tree-sitter-wasms"]
  }
}, null, 2));
runNpm(["install", "--omit=dev", "--no-audit", "--no-fund"], runtime, {
  npm_config_engine_strict: "true"
});
renameSync(join(runtime, "node_modules"), join(runtime, "modules"));

const apiDistModules = join(staged, "apps", "api", "dist", "node_modules");
mkdirSync(apiDistModules, { recursive: true });
cpSync(join(runtime, "modules"), apiDistModules, { recursive: true });

const stagedRootModules = join(staged, "node_modules");
mkdirSync(stagedRootModules, { recursive: true });
cpSync(join(runtime, "modules"), stagedRootModules, { recursive: true });

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

// The bundled interpreter is an embeddable distribution: its *._pth file
// enables isolated mode, so PYTHONPATH (set by the deterministic analyzer)
// is ignored and `python -m engine` cannot locate staged/engine. Put the
// staged root — the parent of the engine package, two levels above the
// interpreter — on the interpreter's default sys.path so `import engine`
// works without relying on environment variables.
const stagedPython = join(runtime, "python");
const pthFiles = readdirSync(stagedPython).filter(name => name.toLowerCase().endsWith("._pth"));
if (pthFiles.length !== 1) {
  throw new Error(`Bundled Python must ship exactly one *._pth file: ${stagedPython}`);
}
const pthPath = join(stagedPython, pthFiles[0]);
writeFileSync(pthPath, `${readFileSync(pthPath, "utf8").trimEnd()}\n# ConsistenCy staged root (parent of the engine package)\n..\\..\n`);

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
