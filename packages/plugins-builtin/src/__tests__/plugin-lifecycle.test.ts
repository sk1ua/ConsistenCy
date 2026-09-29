/**
 * H22 — plugin lifecycle ownership against the REAL Kernel mechanisms.
 *
 * No mocks of the boundaries under test: capabilities are issued/revoked by the
 * real `CapabilityBroker`, authorization runs through the real `SyscallGateway`,
 * and sessions are real child processes owned by the real `SandboxManager`
 * (the same worker bootstrap the Kernel sandbox suite uses).
 *
 * Pinned behaviours:
 *   - activate grants ONLY declared capabilities, and pins the manifest version;
 *   - deactivate/uninstall revoke every grant and stop the process;
 *   - an abnormally exiting plugin is reaped, its grants revoked, no zombie;
 *   - an undeclared capability is refused before anything is granted;
 *   - upgrades never change the version a running plugin was admitted with.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityBroker,
  MemoryJournal,
  SandboxManager,
  SyscallGateway,
  asRunId,
  makePrincipalId,
  type Principal,
  type Resource,
  type TrustedOperationHandler
} from "@consistency/kernel";
import {
  PluginLifecycleError,
  PluginLifecycleManager,
  entryIntegrity,
  loadPluginManifest,
  type InstalledPlugin
} from "../plugins/index.js";

const FIXTURE_PLUGIN = fileURLToPath(
  new URL("../../../kernel/src/__tests__/sandbox-fixtures/fixture-plugin.mjs", import.meta.url)
);

const RUN_ID = "run_h22_plugin";
const REPOSITORY: Resource = { kind: "repository", id: "example/plugin-repo" };

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Rig = {
  broker: CapabilityBroker;
  gateway: SyscallGateway;
  sandbox: SandboxManager;
  journal: MemoryJournal;
  lifecycle: PluginLifecycleManager;
  plugin: InstalledPlugin;
  upgraded: InstalledPlugin;
  principal: Principal;
};

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "h22-lifecycle-"));
  const entry = join(root, "plugin.mjs");
  copyFileSync(FIXTURE_PLUGIN, entry);
  const integrity = entryIntegrity(readFileSync(entry));

  const journal = new MemoryJournal();
  const broker = new CapabilityBroker(journal);
  const gateway = new SyscallGateway(broker);
  const sandbox = new SandboxManager();
  const lifecycle = new PluginLifecycleManager({
    broker,
    gateway,
    sandbox,
    kernelPrincipalId: makePrincipalId("kernel", "plugin-host")
  });
  cleanups.push(() => {
    sandbox.terminateAll();
    rmSync(root, { recursive: true, force: true });
  });

  const principal: Principal = {
    id: makePrincipalId("plugin", "third-party-style", RUN_ID),
    kind: "plugin",
    runId: RUN_ID
  };

  const base = {
    id: "third-party-style",
    entry: "plugin.mjs",
    integrity,
    executionDomain: "child-process",
    compatibility: { host: ">=0.1.0 <1.0.0", protocol: "^1.0.0" },
    capabilities: ["repo.read"],
    dependencies: {},
    logicalRing: 3,
    title: "Third-party style plugin"
  };

  const load = (version: string) =>
    loadPluginManifest(
      { ...base, version },
      { root, hostVersion: "0.1.0", trust: "third-party", builtinIds: ["style", "secret"] }
    );

  return { broker, gateway, sandbox, journal, lifecycle, plugin: load("1.0.0"), upgraded: load("1.1.0"), principal };
}

function bindings(): Map<string, { action: "repo.read"; resource: Resource }> {
  return new Map([["repo.read", { action: "repo.read" as const, resource: REPOSITORY }]]);
}

function operations(): Map<string, TrustedOperationHandler> {
  return new Map([["repo.read", () => ({ value: { path: "README.md", content: "ok" } }) as never]]);
}

function activate(harness: Rig, workerArgs: string[], plugin: InstalledPlugin = harness.plugin) {
  return harness.lifecycle.activate({
    plugin,
    principal: harness.principal,
    runId: asRunId(RUN_ID),
    capabilities: bindings(),
    operations: operations(),
    workerArgs
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached before timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("H22 plugin lifecycle", () => {
  it("grants only declared capabilities, and deactivate revokes them and stops the process", async () => {
    const harness = rig();
    const activation = activate(harness, ["hang"]);

    expect(activation.grantedActions).toEqual(["repo.read"]);
    expect(harness.lifecycle.authorise(harness.plugin.id, "repo.read")).toEqual({ allowed: true });
    expect(harness.sandbox.get(activation.sessionId)?.state).toBe("running");

    const health = harness.lifecycle.deactivate(harness.plugin.id, "operator disabled the plugin");
    expect(health.state).toBe("disabled");
    expect(health.grantedActions).toEqual([]);
    // The very next authorization attempt is denied, with the Kernel's reason.
    expect(harness.lifecycle.authorise(harness.plugin.id, "repo.read")).toEqual({ allowed: false, reason: "revoked" });
    expect(harness.sandbox.get(activation.sessionId)?.state).toBe("cancelled");
    await waitFor(() => harness.sandbox.get(activation.sessionId)?.processExited === true);
    expect(harness.sandbox.activeSessions()).toEqual([]);

    // Uninstall forgets the plugin entirely (and stays a no-op for its grants).
    harness.lifecycle.uninstall(harness.plugin.id);
    expect(() => harness.lifecycle.health(harness.plugin.id)).toThrow(PluginLifecycleError);
  });

  it("refuses an undeclared capability before granting or launching anything", () => {
    const harness = rig();
    let failure: unknown;
    try {
      harness.lifecycle.activate({
        plugin: harness.plugin,
        principal: harness.principal,
        runId: asRunId(RUN_ID),
        capabilities: new Map([
          ["repo.read", { action: "repo.read" as const, resource: REPOSITORY }],
          ["ast.query", { action: "ast.query" as const, resource: { kind: "ast", snapshotId: "snap_h22" } }]
        ]),
        operations: operations()
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PluginLifecycleError);
    expect((failure as PluginLifecycleError).code).toBe("PLUGIN_CAPABILITY_NOT_DECLARED");
    expect((failure as PluginLifecycleError).reason).toContain("ast.query");
    // Nothing was granted and no session exists.
    expect(harness.journal.entries().filter(entry => entry.type.startsWith("capability."))).toEqual([]);
    expect(harness.sandbox.activeSessions()).toEqual([]);
    expect(() => harness.lifecycle.health(harness.plugin.id)).toThrow(PluginLifecycleError);
  });

  it("pins the admitted version for the run; an upgrade cannot change it", async () => {
    const harness = rig();
    activate(harness, ["hang"]);

    expect(harness.lifecycle.pinnedDescriptor(harness.plugin.id).version).toBe("1.0.0");
    // The registry may now hold 1.1.0, but the live run stays on 1.0.0.
    const health = harness.lifecycle.health(harness.plugin.id, harness.upgraded.version);
    expect(health.installedVersion).toBe("1.1.0");
    expect(health.pinnedVersion).toBe("1.0.0");

    harness.lifecycle.deactivate(harness.plugin.id);
    const reactivated = activate(harness, ["hang"], harness.upgraded);
    expect(reactivated.pinnedVersion).toBe("1.1.0");
    expect(harness.lifecycle.pinnedDescriptor(harness.plugin.id).version).toBe("1.1.0");
  });

  it("reaps an abnormally exiting plugin: process closed, grants revoked, no zombie session", async () => {
    const harness = rig();
    const activation = activate(harness, ["crash-exit"]);
    expect(harness.lifecycle.authorise(harness.plugin.id, "repo.read")).toEqual({ allowed: true });

    await waitFor(() => harness.lifecycle.health(harness.plugin.id).state === "failed");
    const health = harness.lifecycle.health(harness.plugin.id);
    expect(health.pinnedVersion).toBe("1.0.0");
    expect(health.grantedActions).toEqual([]);
    expect(health.lastError?.code).toBeTruthy();
    expect(health.lastError?.message.length).toBeGreaterThan(0);

    expect(harness.lifecycle.authorise(harness.plugin.id, "repo.read")).toEqual({ allowed: false, reason: "revoked" });
    expect(harness.sandbox.activeSessions()).toEqual([]);
    expect(harness.sandbox.get(activation.sessionId)?.processExited).toBe(true);
    expect(harness.lifecycle.ownedSessions()).toEqual([]);
  });

  it("releases grants when a run finishes on its own, and reports the outcome", async () => {
    const harness = rig();
    activate(harness, ["pid"]);
    await waitFor(() => harness.lifecycle.health(harness.plugin.id).state !== "active");
    const health = harness.lifecycle.health(harness.plugin.id);
    expect(health.state).toBe("inactive");
    expect(health.grantedActions).toEqual([]);
    // The grant is gone AND the Kernel itself now denies the retained handle.
    expect(harness.lifecycle.authorise(harness.plugin.id, "repo.read")).toEqual({ allowed: false, reason: "revoked" });
    expect(harness.sandbox.activeSessions()).toEqual([]);
  });

  it("refuses an unusable binding configuration with a coded reason and releases the grant it issued", () => {
    const harness = rig();
    let failure: unknown;
    try {
      harness.lifecycle.activate({
        plugin: harness.plugin,
        principal: harness.principal,
        runId: asRunId(RUN_ID),
        capabilities: bindings(),
        // No trusted handler for the bound method: the Kernel refuses the
        // configuration synchronously, so nothing may stay granted.
        operations: new Map()
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PluginLifecycleError);
    expect((failure as PluginLifecycleError).code).toBe("PLUGIN_ACTIVATION_FAILED");
    expect((failure as PluginLifecycleError).reason).toContain("sandbox launch refused");
    // The grant was issued during admission, so its revocation is observable.
    expect(harness.lifecycle.authorise(harness.plugin.id, "repo.read")).toEqual({ allowed: false, reason: "revoked" });
    expect(harness.lifecycle.health(harness.plugin.id)).toMatchObject({ state: "failed", grantedActions: [] });
    expect(harness.sandbox.activeSessions()).toEqual([]);
  });
});
