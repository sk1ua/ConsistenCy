/**
 * H22 — plugin manifest negatives.
 *
 * Every case here is a way an untrusted manifest could widen its own reach:
 * escaping the plugin root, swapping the entry after review, smuggling host
 * environment variables, claiming an unmediated/intent action, shadowing a
 * builtin id, or arriving without a dependency the host can resolve. Each MUST
 * fail with a code plus a human-readable reason — never silently.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_CONTAINMENT_MODEL,
  PluginManifestError,
  describePluginContainment,
  entryIntegrity,
  isOsContained,
  loadPluginManifest,
  satisfiesRange,
  type InstalledPlugin,
  type PluginManifestErrorCode
} from "../plugins/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ENTRY_SOURCE = "export default { run: async () => ({ ok: true }) };\n";

function pluginRoot(): { root: string; entry: string; integrity: string } {
  const root = mkdtempSync(join(tmpdir(), "h22-plugin-"));
  roots.push(root);
  const entry = join(root, "plugin.mjs");
  writeFileSync(entry, ENTRY_SOURCE, "utf8");
  return { root, entry, integrity: entryIntegrity(readFileSync(entry)) };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { integrity } = pluginRoot();
  return {
    id: "third-party-style",
    version: "1.2.3",
    entry: "plugin.mjs",
    integrity,
    executionDomain: "child-process",
    compatibility: { host: ">=0.1.0 <1.0.0", protocol: "^1.0.0" },
    capabilities: ["repo.read"],
    dependencies: {},
    logicalRing: 3,
    title: "Third-party style plugin",
    ...overrides
  };
}

function load(raw: Record<string, unknown>, root: string, overrides: Record<string, unknown> = {}): InstalledPlugin {
  return loadPluginManifest(raw, {
    root,
    hostVersion: "0.1.0",
    trust: "third-party",
    builtinIds: ["style", "secret"],
    ...overrides
  });
}

function failureOf(run: () => unknown): PluginManifestError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestError);
    return error as PluginManifestError;
  }
  throw new Error("expected the manifest to be rejected");
}

function expectCode(error: PluginManifestError, code: PluginManifestErrorCode): void {
  expect(error.code).toBe(code);
  // The operator-facing reason must be explainable, not just a code.
  expect(error.reason).toContain(code);
  expect(error.message.trim().length).toBeGreaterThan(0);
}

describe("H22 plugin manifest", () => {
  it("accepts a well-formed third-party manifest and yields a Kernel descriptor", () => {
    const { root } = pluginRoot();
    const installed = load(manifest(), root);
    expect(installed).toMatchObject({
      id: "third-party-style",
      version: "1.2.3",
      trust: "third-party",
      executionDomain: "child-process",
      capabilities: ["repo.read"]
    });
    expect(installed.entrypoint.startsWith(root)).toBe(true);
    expect(installed.descriptor).toEqual({
      id: "third-party-style",
      version: "1.2.3",
      trust: "untrusted",
      logicalRing: 3,
      executionDomain: "child-process",
      entrypoint: installed.entrypoint,
      requestedOperations: ["repo.read"]
    });
  });

  it("rejects an entry that escapes the plugin root (traversal, absolute, symlink)", () => {
    const { root, integrity } = pluginRoot();
    const outside = mkdtempSync(join(tmpdir(), "h22-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "outside.mjs"), ENTRY_SOURCE, "utf8");

    expectCode(failureOf(() => load(manifest({ entry: "../outside.mjs", integrity }), root)), "PLUGIN_ENTRY_ESCAPES_ROOT");
    expectCode(
      failureOf(() => load(manifest({ entry: join(outside, "outside.mjs"), integrity }), root)),
      "PLUGIN_ENTRY_ESCAPES_ROOT"
    );
    // Creating a symlink needs privileges on Windows; assert the escape only
    // when the link actually exists (the lexical cases above always run).
    try {
      symlinkSync(join(outside, "outside.mjs"), join(root, "linked.mjs"));
    } catch {
      // EPERM on unprivileged Windows: the containment rule is still covered.
    }
    if (existsSync(join(root, "linked.mjs"))) {
      expectCode(failureOf(() => load(manifest({ entry: "linked.mjs", integrity }), root)), "PLUGIN_ENTRY_ESCAPES_ROOT");
    }
  });

  it("rejects a tampered entry: the integrity hash must match the bytes on disk", () => {
    const { root, entry } = pluginRoot();
    const raw = manifest();
    writeFileSync(entry, `${ENTRY_SOURCE}// swapped after review\n`, "utf8");
    const error = failureOf(() => load(raw, root));
    expectCode(error, "PLUGIN_INTEGRITY_MISMATCH");
    expect(error.message).toContain("integrity mismatch");
    expect(error.details["expected"]).not.toBe(error.details["actual"]);
  });

  it("refuses host-owned fields — a plugin cannot smuggle environment or trust", () => {
    const { root } = pluginRoot();
    expectCode(failureOf(() => load(manifest({ env: { NODE_OPTIONS: "--require ./evil.cjs" } }), root)), "PLUGIN_MANIFEST_INVALID");
    expectCode(failureOf(() => load(manifest({ envVars: { HOST_SECRET: "x" } }), root)), "PLUGIN_MANIFEST_INVALID");
    expectCode(failureOf(() => load(manifest({ trust: "builtin" }), root)), "PLUGIN_MANIFEST_INVALID");
    const error = failureOf(() => load(manifest({ env: { NODE_OPTIONS: "x" } }), root));
    expect(error.message).toContain("host-owned");
  });

  it("rejects incompatibility with an explainable host/protocol reason (no silent skip)", () => {
    const { root } = pluginRoot();
    const hostError = failureOf(() => load(manifest({ compatibility: { host: ">=2.0.0", protocol: "^1.0.0" } }), root));
    expectCode(hostError, "PLUGIN_INCOMPATIBLE_HOST");
    expect(hostError.message).toContain("requires host >=2.0.0");
    expect(hostError.message).toContain("this host is 0.1.0");

    const protocolError = failureOf(() => load(manifest({ compatibility: { host: ">=0.1.0", protocol: "^2.0.0" } }), root));
    expectCode(protocolError, "PLUGIN_INCOMPATIBLE_PROTOCOL");
    expect(protocolError.message).toContain("sandbox protocol ^2.0.0");

    const badRange = failureOf(() => load(manifest({ compatibility: { host: "not-a-range", protocol: "^1.0.0" } }), root));
    expectCode(badRange, "PLUGIN_MANIFEST_INVALID");
  });

  it("rejects a missing or incompatible dependency with the resolved reason", () => {
    const { root } = pluginRoot();
    expectCode(failureOf(() => load(manifest({ dependencies: { "core-rules": "^1.0.0" } }), root)), "PLUGIN_DEPENDENCY_MISSING");

    const dependency = load(manifest({ id: "core-rules", version: "0.5.0" }), root);
    const error = failureOf(() => load(manifest({ dependencies: { "core-rules": "^1.0.0" } }), root, { installed: [dependency] }));
    expectCode(error, "PLUGIN_DEPENDENCY_INCOMPATIBLE");
    expect(error.message).toContain("installed version is 0.5.0");

    const satisfied = load(manifest({ dependencies: { "core-rules": "^0.5.0" } }), root, { installed: [dependency] });
    expect(satisfied.dependencies).toEqual({ "core-rules": "^0.5.0" });
  });

  it("refuses to let a third party shadow a builtin id", () => {
    const { root } = pluginRoot();
    const error = failureOf(() => load(manifest({ id: "style" }), root, { trust: "third-party" }));
    expectCode(error, "PLUGIN_ID_SHADOWED");
    expect(error.message).toContain("trusted builtin");

    // The same id is legitimate when the HOST declares the manifest builtin.
    const builtin = load(manifest({ id: "style" }), root, { trust: "builtin" });
    expect(builtin.trust).toBe("builtin");
    expect(builtin.descriptor.trust).toBe("trusted");
  });

  it("rejects capabilities outside the Kernel-mediated allowlist, including commit intents", () => {
    const { root } = pluginRoot();
    expectCode(failureOf(() => load(manifest({ capabilities: ["github.publish"] }), root)), "PLUGIN_MANIFEST_INVALID");
    expectCode(failureOf(() => load(manifest({ capabilities: ["repo.destroy"] }), root)), "PLUGIN_MANIFEST_INVALID");
    expectCode(failureOf(() => load(manifest({ capabilities: ["not an action"] }), root)), "PLUGIN_MANIFEST_INVALID");
    // Declared capabilities are deduplicated, never silently widened.
    const installed = load(manifest({ capabilities: ["repo.read", "repo.read", "ast.query"] }), root);
    expect(installed.capabilities).toEqual(["repo.read", "ast.query"]);
  });

  it("fails closed on a malformed manifest instead of guessing defaults", () => {
    const { root } = pluginRoot();
    expectCode(failureOf(() => load(manifest({ id: "Bad Id" }), root)), "PLUGIN_MANIFEST_INVALID");
    expectCode(failureOf(() => load(manifest({ version: "1.2" }), root)), "PLUGIN_MANIFEST_INVALID");
    expectCode(failureOf(() => load(manifest({ executionDomain: "in-process" }), root)), "PLUGIN_MANIFEST_INVALID");
    expectCode(failureOf(() => load(manifest({ entry: "missing.mjs" }), root)), "PLUGIN_ENTRY_MISSING");
    expectCode(failureOf(() => load(manifest({ integrity: "sha256-nope" }), root)), "PLUGIN_MANIFEST_INVALID");
    expectCode(failureOf(() => load(manifest({ unexpected: true }), root)), "PLUGIN_MANIFEST_INVALID");
  });

  it("pins the semver contract used by compatibility and dependency gates", () => {    expect(satisfiesRange("0.1.0", ">=0.1.0 <1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", ">=0.1.0 <1.0.0")).toBe(false);
    expect(satisfiesRange("1.2.9", "^1.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesRange("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesRange("1.0.0", "*")).toBe(true);
    expect(satisfiesRange("garbage", "*")).toBe(false);
  });

  it("keeps the entry readable only through the contained real path", () => {
    const { root, entry } = pluginRoot();
    mkdirSync(join(root, "nested"), { recursive: true });
    copyFileSync(entry, join(root, "nested", "inner.mjs"));
    const installed = load(manifest({ entry: "nested/inner.mjs", integrity: entryIntegrity(readFileSync(join(root, "nested", "inner.mjs"))) }), root);
    expect(installed.entry).toBe("nested/inner.mjs");
    expect(installed.entrypoint).toBe(join(root, "nested", "inner.mjs"));
  });

  it("describes plugin containment honestly: no OS containment is claimed", () => {
    expect(PLUGIN_CONTAINMENT_MODEL).toEqual({
      processIsolation: "enforced",
      capabilityAuthorization: "enforced",
      parentEnvironmentIsolation: "enforced",
      osFilesystemContainment: "not-provided",
      osNetworkContainment: "not-provided",
      osSubprocessContainment: "not-provided"
    });
    expect(isOsContained()).toBe(false);
    const description = describePluginContainment();
    expect(description).toContain("process isolation enforced");
    expect(description).toContain("does NOT provide OS-level containment");
    // A surface that reads this projection cannot claim sandbox safety.
    expect(description).not.toMatch(/sandbox(ed)? (is )?safe/i);
  });
});
