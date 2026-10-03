import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PATCHED_BRACE_EXPANSION = "5.0.12";
export const PATCHED_BRACE_EXPANSION_INTEGRITY = "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==";

const PATCHES = [
  {
    parent: "@earendil-works/pi-coding-agent",
    dependency: "brace-expansion",
    version: PATCHED_BRACE_EXPANSION,
    integrity: PATCHED_BRACE_EXPANSION_INTEGRITY
  }
];

function workspaceRoot() {
  return resolve(import.meta.dirname, "..");
}

function assertInside(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  if (relativePath.startsWith("..") || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    throw new Error(`Refusing to patch a path outside the workspace: ${candidate}`);
  }
}

function packageManifest(packageJsonPath) {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function recordIntegrity(packageJsonPath, integrity) {
  const manifest = packageManifest(packageJsonPath);
  manifest._integrity = integrity;
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function npmCliPath() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error("npm CLI was not found beside the current Node.js executable.");
  return found;
}

function packageDirectories(root, packageName) {
  const output = execFileSync(
    process.execPath,
    [npmCliPath(), "ls", packageName, "--all", "--parseable", "--depth=Infinity"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function copyPackageContents(source, destination) {
  for (const entry of readdirSync(destination)) {
    rmSync(join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(destination, entry), { recursive: true });
  }
}

export function patchShrinkwrapDependencies({
  root = workspaceRoot(),
  patches = PATCHES,
  listPackages = packageDirectories,
  readManifest = packageManifest,
  replaceContents = copyPackageContents,
  stampIntegrity = recordIntegrity
} = {}) {
  const resolvedRoot = resolve(root);
  const actions = [];

  for (const patch of patches) {
    const source = resolve(resolvedRoot, "node_modules", patch.dependency);
    const sourceManifest = join(source, "package.json");
    assertInside(resolvedRoot, sourceManifest);
    if (!existsSync(sourceManifest)) {
      throw new Error(`Missing patched ${patch.dependency}@${patch.version} at ${relative(resolvedRoot, sourceManifest)}`);
    }
    const sourceManifestData = readManifest(sourceManifest);
    if (sourceManifestData.version !== patch.version) {
      throw new Error(`Expected ${patch.dependency}@${patch.version}, found ${sourceManifestData.version}`);
    }
    if (patch.integrity && sourceManifestData._integrity !== patch.integrity) {
      stampIntegrity(sourceManifest, patch.integrity);
    }

    const parents = listPackages(resolvedRoot, patch.parent);
    if (parents.length === 0) {
      throw new Error(`Installed package not found: ${patch.parent}`);
    }

    for (const parent of parents) {
      const destination = resolve(parent, "node_modules", patch.dependency);
      const destinationManifest = join(destination, "package.json");
      assertInside(resolvedRoot, destination);
      if (!existsSync(destinationManifest)) continue;
      const before = readManifest(destinationManifest);
      if (before.version !== patch.version || before._integrity !== patch.integrity) {
        replaceContents(source, destination);
        if (patch.integrity) stampIntegrity(destinationManifest, patch.integrity);
      }
      const after = readManifest(destinationManifest);
      if (after.version !== patch.version || (patch.integrity && after._integrity !== patch.integrity)) {
        throw new Error(`${relative(resolvedRoot, destination)} is ${after.version}, expected ${patch.version}`);
      }
      actions.push({
        parent: relative(resolvedRoot, parent),
        dependency: patch.dependency,
        before: before.version,
        after: after.version
      });
    }
  }

  return actions;
}

function isDirectExecution() {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false;
}

if (isDirectExecution()) {
  const actions = patchShrinkwrapDependencies();
  if (actions.length === 0) {
    console.log("Shrinkwrap dependency patch: no nested copies required replacement.");
  } else {
    for (const action of actions) {
      console.log(`Shrinkwrap dependency patch: ${action.parent} ${action.dependency} ${action.before} -> ${action.after}`);
    }
  }
}
