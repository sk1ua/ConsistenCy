import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vulnerableInstalledPackages } from "./audit-installed-deps.mjs";
import { patchShrinkwrapDependencies } from "./patch-shrinkwrap-deps.mjs";

const temporaryRoots = [];

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "consistency-shrinkwrap-"));
  temporaryRoots.push(root);
  const source = join(root, "node_modules", "brace-expansion");
  const nested = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "brace-expansion");
  mkdirSync(join(source, "dist"), { recursive: true });
  mkdirSync(join(nested, "old"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "brace-expansion",
    version: "5.0.12",
    _integrity: "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ=="
  }));
  writeFileSync(join(source, "dist", "index.js"), "patched");
  writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "brace-expansion", version: "5.0.9" }));
  writeFileSync(join(nested, "old", "vulnerable.js"), "vulnerable");
  return { root, source, nested };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shrinkwrap dependency patch", () => {
  it("replaces only the nested vulnerable copy with the verified patched package", () => {
    const { root, nested } = createWorkspace();
    const parent = join(root, "node_modules", "@earendil-works", "pi-coding-agent");

    const actions = patchShrinkwrapDependencies({
      root,
      listPackages: () => [parent]
    });

    expect(actions).toEqual([
      expect.objectContaining({ dependency: "brace-expansion", before: "5.0.9", after: "5.0.12" })
    ]);
    expect(JSON.parse(readFileSync(join(nested, "package.json"), "utf8"))._integrity).toContain("sha512-");
    expect(readFileSync(join(nested, "dist", "index.js"), "utf8")).toBe("patched");
    expect(() => readFileSync(join(nested, "old", "vulnerable.js"), "utf8")).toThrow();
  });

  it("fails closed when the patched source package is missing or has another version", () => {
    const { root } = createWorkspace();
    rmSync(join(root, "node_modules", "brace-expansion"), { recursive: true, force: true });

    expect(() => patchShrinkwrapDependencies({
      root,
      listPackages: () => []
    })).toThrow("Missing patched brace-expansion@5.0.12");
  });
});

describe("installed dependency audit", () => {
  it("accepts a high advisory only when every installed copy has the patched version", () => {
    const { root, nested } = createWorkspace();
    const report = {
      vulnerabilities: {
        "brace-expansion": {
          name: "brace-expansion",
          severity: "high",
          nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"]
        }
      }
    };

    expect(vulnerableInstalledPackages({
      root,
      auditReport: report,
      packageRoots: [nested]
    })).toEqual([
      "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion is brace-expansion@5.0.9; required 5.0.12",
      "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion integrity does not match brace-expansion@5.0.12",
      expect.stringContaining("brace-expansion@5.0.9; required 5.0.12"),
      expect.stringContaining("integrity does not match brace-expansion@5.0.12")
    ]);

    writeFileSync(join(nested, "package.json"), JSON.stringify({
      name: "brace-expansion",
      version: "5.0.12",
      _integrity: "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ=="
    }));
    expect(vulnerableInstalledPackages({
      root,
      auditReport: report,
      packageRoots: [nested, join(root, "node_modules", "brace-expansion")]
    })).toEqual([]);
  });

  it("still fails for an unpatched high advisory", () => {
    expect(vulnerableInstalledPackages({
      root: process.cwd(),
      auditReport: { vulnerabilities: { example: { name: "example", severity: "high", nodes: [] } } },
      packageRoots: []
    })).toEqual(["high advisory remains: example"]);
  });
});
