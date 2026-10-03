import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { PATCHED_BRACE_EXPANSION, PATCHED_BRACE_EXPANSION_INTEGRITY } from "./patch-shrinkwrap-deps.mjs";

const PATCHED_PACKAGES = new Map([
  ["brace-expansion", {
    version: PATCHED_BRACE_EXPANSION,
    integrity: PATCHED_BRACE_EXPANSION_INTEGRITY
  }]
]);

function workspaceRoot() {
  return resolve(import.meta.dirname, "..");
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

function auditReportFromNpm(root) {
  try {
    return JSON.parse(execFileSync(process.execPath, [npmCliPath(), "audit", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }));
  } catch (error) {
    if (!error.stdout) throw error;
    return JSON.parse(error.stdout);
  }
}

function isPackageRoot(directory) {
  const parent = dirname(directory);
  return existsSync(join(directory, "package.json"))
    && (dirname(parent).endsWith(`${sep}node_modules`) || parent.endsWith(`${sep}node_modules`));
}

function patchedPackageRequirement(manifest, patchedPackages) {
  const requirement = patchedPackages.get(manifest.name);
  if (!requirement) return undefined;
  return typeof requirement === "string" ? { version: requirement } : requirement;
}

function walkPackageRoots(directory, root, found = []) {
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return found;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name === "node_modules") {
      const modules = join(directory, entry.name);
      for (const child of readdirSync(modules, { withFileTypes: true })) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        if (child.name.startsWith("@")) {
          const scope = join(modules, child.name);
          for (const scoped of readdirSync(scope, { withFileTypes: true })) {
            if (!scoped.isDirectory() || scoped.isSymbolicLink()) continue;
            const candidate = join(scope, scoped.name);
            if (isPackageRoot(candidate)) found.push(candidate);
            walkPackageRoots(candidate, root, found);
          }
          continue;
        }
        const candidate = join(modules, child.name);
        if (isPackageRoot(candidate)) found.push(candidate);
        walkPackageRoots(candidate, root, found);
      }
      continue;
    }
    if (entry.name === ".bin") continue;
    walkPackageRoots(join(directory, entry.name), root, found);
  }
  return found;
}

export function vulnerableInstalledPackages({
  root = workspaceRoot(),
  patchedPackages = PATCHED_PACKAGES,
  auditReport,
  packageRoots
} = {}) {
  const resolvedRoot = resolve(root);
  const report = auditReport ?? auditReportFromNpm(resolvedRoot);
  const findings = [];

  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    if (!["high", "critical"].includes(vulnerability.severity)) continue;
    const required = patchedPackageRequirement({ name: vulnerability.name }, patchedPackages);
    if (!required) {
      findings.push(`${vulnerability.severity} advisory remains: ${vulnerability.name}`);
      continue;
    }
    for (const node of vulnerability.nodes ?? []) {
      const installed = join(resolvedRoot, node, "package.json");
      if (!existsSync(installed)) {
        findings.push(`${vulnerability.name} advisory node is not installed: ${node}`);
        continue;
      }
      const manifest = JSON.parse(readFileSync(installed, "utf8"));
      if (manifest.version !== required.version) {
        findings.push(`${node} is ${vulnerability.name}@${manifest.version}; required ${required.version}`);
      }
      if (required.integrity && manifest._integrity !== required.integrity) {
        findings.push(`${node} integrity does not match ${vulnerability.name}@${required.version}`);
      }
    }
  }

  const roots = packageRoots ?? walkPackageRoots(join(resolvedRoot, "node_modules"), resolvedRoot);
  for (const packageRoot of roots) {
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const required = patchedPackageRequirement(manifest, patchedPackages);
    if (!required) continue;
    if (manifest.version !== required.version) {
      findings.push(`${relative(resolvedRoot, packageRoot)} is ${manifest.name}@${manifest.version}; required ${required.version}`);
    }
    if (required.integrity && manifest._integrity !== required.integrity) {
      findings.push(`${relative(resolvedRoot, packageRoot)} integrity does not match ${manifest.name}@${required.version}`);
    }
  }

  return findings;
}

function isDirectExecution() {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(resolve(entry)).href : false;
}

if (isDirectExecution()) {
  const report = auditReportFromNpm(workspaceRoot());
  const findings = vulnerableInstalledPackages({ auditReport: report });
  if (findings.length > 0) {
    console.error("Installed dependency audit failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  console.log("Installed dependency audit passed.");
}
