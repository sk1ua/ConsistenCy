// Stages the monorepo pieces the desktop app needs and runs electron-builder.
// v1 note: copies the whole node_modules (dereferenced) - size optimization is
// a follow-up. asar is disabled so the Python engine can read its sources.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const staged = join(root, "apps", "desktop", "staged");
const electronDir = join("node_modules", "electron");

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
cpSync(join(root, "packages"), join(staged, "packages"), { recursive: true });
cpSync(join(root, "engine"), join(staged, "engine"), {
  recursive: true,
  filter: source => !source.includes("__pycache__") && !source.includes("node_modules")
});
cpSync(join(root, "node_modules"), join(staged, "node_modules"), {
  recursive: true,
  dereference: true,
  filter: source =>
    !source.includes(electronDir) &&
    !source.includes(".cache") &&
    !source.includes(join("node_modules", ".vite")) &&
    !source.includes(join("node_modules", ".playwright"))
});

console.log("Running electron-builder (Windows targets) ...");
execSync("npx electron-builder --win", { cwd: join(root, "apps", "desktop"), stdio: "inherit" });
console.log("Desktop build finished. Output: apps/desktop/release");
