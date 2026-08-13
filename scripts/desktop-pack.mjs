// Stages the monorepo pieces the desktop app needs and runs electron-builder.
// The API runtime is installed into staged/ via a generated manifest (npm
// install --prefix) instead of copying the repo node_modules: copying follows
// workspace junctions and recurses through apps/desktop/staged itself.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const staged = join(root, "apps", "desktop", "staged");

console.log("Building web UI with the desktop API base URL ...");
// base=./ keeps asset URLs relative so the shell can load index.html via file://.
execSync("npm run build -w @consistency/web -- --base=./", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_API_BASE_URL: "http://127.0.0.1:3001" }
});

console.log("Staging app pieces into apps/desktop/staged ...");
rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
cpSync(join(root, "apps", "web", "dist"), join(staged, "apps", "web", "dist"), { recursive: true });
cpSync(join(root, "apps", "api", "src"), join(staged, "apps", "api", "src"), { recursive: true });
cpSync(join(root, "engine"), join(staged, "engine"), {
  recursive: true,
  filter: source => !source.includes("__pycache__") && !source.includes("node_modules")
});

// The runtime install lives in staged/runtime instead of staged/node_modules:
// electron-builder's file matcher silently drops any directory literally named
// node_modules, which would leave the packaged app without its runtime.
const runtime = join(staged, "runtime");
mkdirSync(runtime, { recursive: true });
console.log("Generating runtime manifest and installing production dependencies ...");
const apiManifest = JSON.parse(readFileSync(join(root, "apps", "api", "package.json"), "utf8"));
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runtimeManifest = {
  name: "consistency-desktop-runtime",
  version: "0.1.0",
  private: true,
  dependencies: {
    ...apiManifest.dependencies,
    // Direct file: entries replace the registry version ranges: the packages
    // are private and unpublished. vcs-core's own schema@0.1.0 requirement is
    // satisfied by schema's package.json version.
    "@consistency/schema": "file:../../packages/schema",
    "@consistency/vcs-core": "file:../../packages/vcs-core",
    tsx: rootManifest.devDependencies.tsx
  }
};
writeFileSync(join(runtime, "package.json"), JSON.stringify(runtimeManifest, null, 2));
execSync("npm install --omit=dev --no-audit --no-fund", {
  cwd: runtime,
  stdio: "inherit",
  env: { ...process.env, npm_config_engine_strict: "false" }
});

// npm installs file: workspace deps as junctions pointing back into the
// repository; electron-builder cannot recreate them inside the package.
// Replace each link with a real directory copy (rename the link away first
// so nothing deletes through it).
for (const name of ["schema", "vcs-core"]) {
  const linkPath = join(runtime, "node_modules", "@consistency", name);
  const stash = linkPath + ".linktmp";
  renameSync(linkPath, stash);
  cpSync(join(root, "packages", name), linkPath, {
    recursive: true,
    filter: source => !source.includes("node_modules") && !source.endsWith(".test.ts")
  });
  rmdirSync(stash);
}

console.log("Rebuilding better-sqlite3 for the Electron ABI ...");
execSync("npx electron-rebuild -f -w better-sqlite3 --module-dir " + runtime, {
  cwd: join(root, "apps", "desktop"),
  stdio: "inherit"
});

// electron-builder's file matcher drops ANY directory named node_modules, so
// the installed tree is renamed to modules/ for packaging.
renameSync(join(runtime, "node_modules"), join(runtime, "modules"));

console.log("Running electron-builder (Windows targets) ...");
// Default target: win-unpacked (dir). NSIS/portable installers need the
// winCodeSign cache whose extraction creates symlinks - requires Windows
// Developer Mode or an admin shell. Set DESKTOP_TARGETS to opt in:
//   DESKTOP_TARGETS="--win nsis portable" npm run desktop:pack
execSync("npx electron-builder --win " + (process.env.DESKTOP_TARGETS ?? "dir"), {
  cwd: join(root, "apps", "desktop"),
  stdio: "inherit"
});
console.log("Desktop build finished. Output: apps/desktop/release");
