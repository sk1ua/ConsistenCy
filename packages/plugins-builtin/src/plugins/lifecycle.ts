/**
 * H22 — plugin lifecycle ownership.
 *
 * One place owns the three things a plugin must never outlive:
 *   1. its granted capabilities (Kernel CapabilityBroker handles),
 *   2. its child process (Kernel SandboxManager session),
 *   3. its admitted version (pinned for the whole run).
 *
 * The manager adapts the EXISTING Kernel mechanisms — it does not add a second
 * execution or authorization path:
 *   - grants go through `CapabilityBroker.issue` and are released with
 *     `CapabilityBroker.revoke`;
 *   - execution goes through `SandboxManager.launch/cancel` (child-process RPC),
 *     whose per-call authorization is `CapabilityBroker.authorise` via
 *     `SyscallGateway`.
 *
 * Every terminal path (deactivate, uninstall, refused admission, crash,
 * timeout, cancellation, protocol violation) releases the grants and makes sure
 * a process cannot be left behind. Revoked handles are retained (never reused)
 * so a host-side check can prove the Kernel itself now denies them. Failures
 * are coded and explainable — never a silent downgrade.
 */

import type {
  Action,
  AgentId,
  BoundOperation,
  CapabilityBroker,
  CapabilityHandle,
  PluginDescriptor,
  Principal,
  PrincipalId,
  Resource,
  RunId,
  SandboxLaunch,
  SandboxManager,
  SandboxRunResult,
  SandboxSessionId,
  SyscallGateway,
  TrustedOperationHandler
} from "@consistency/kernel";
import type { InstalledPlugin } from "./manifest.js";

export type PluginLifecycleErrorCode =
  | "PLUGIN_NOT_INSTALLED"
  | "PLUGIN_ALREADY_ACTIVE"
  | "PLUGIN_NOT_ACTIVE"
  | "PLUGIN_CAPABILITY_NOT_DECLARED"
  | "PLUGIN_ACTIVATION_FAILED";

/** Coded, explainable lifecycle failure — no silent degradation. */
export class PluginLifecycleError extends Error {
  constructor(
    readonly code: PluginLifecycleErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "PluginLifecycleError";
  }

  get reason(): string {
    return `${this.code}: ${this.message}`;
  }
}

export type PluginRuntimeState = "inactive" | "active" | "failed" | "disabled";

export interface PluginCapabilityBinding {
  readonly action: Action;
  readonly resource: Resource;
}

export interface ActivatePluginInput {
  readonly plugin: InstalledPlugin;
  readonly principal: Principal;
  readonly runId?: RunId;
  readonly agentId?: AgentId;
  /** RPC method → capability the TRUSTED PARENT will hold for this plugin. */
  readonly capabilities: ReadonlyMap<string, PluginCapabilityBinding>;
  /** RPC method → trusted handler (must cover every bound method). */
  readonly operations: ReadonlyMap<string, TrustedOperationHandler>;
  readonly timeoutMs?: number;
  readonly workerArgs?: readonly string[];
}

export interface PluginActivation {
  readonly pluginId: string;
  /** Version this run is pinned to; an upgrade cannot change it. */
  readonly pinnedVersion: string;
  readonly sessionId: SandboxSessionId;
  readonly grantedActions: readonly string[];
}

export interface PluginHealth {
  readonly pluginId: string;
  readonly state: PluginRuntimeState;
  /** Version currently installed on disk (may be newer than pinnedVersion). */
  readonly installedVersion: string;
  /** Version the live/run access was admitted with. */
  readonly pinnedVersion?: string;
  readonly grantedActions: readonly string[];
  readonly sessionId?: SandboxSessionId;
  readonly lastError?: { readonly code: string; readonly message: string };
}

type GrantEntry = { action: Action; resource: Resource; handle: CapabilityHandle };

type ActivationRecord = {
  state: PluginRuntimeState;
  /** Principal the grants were issued to — authorisation must match it. */
  principal: Principal;
  pinnedVersion: string;
  pinnedDescriptor: PluginDescriptor;
  sessionId?: SandboxSessionId;
  /** Live grants. Emptied the moment they are revoked. */
  handleByMethod: Map<string, GrantEntry>;
  /** Revoked grants, retained for host-side post-mortem checks only. */
  revokedHandles: Map<string, GrantEntry>;
  lastError?: { code: string; message: string };
};

export interface PluginLifecycleManagerOptions {
  readonly broker: CapabilityBroker;
  readonly gateway: SyscallGateway;
  readonly sandbox: SandboxManager;
  /** Kernel identity that issues and revokes plugin capabilities. */
  readonly kernelPrincipalId: PrincipalId;
}

export class PluginLifecycleManager {
  readonly #options: PluginLifecycleManagerOptions;
  readonly #records = new Map<string, ActivationRecord>();

  constructor(options: PluginLifecycleManagerOptions) {
    this.#options = options;
  }

  /**
   * Admit one plugin for a run: grant exactly the declared capabilities, then
   * launch the child process through the existing sandbox path.
   */
  activate(input: ActivatePluginInput): PluginActivation {
    const plugin = input.plugin;
    const existing = this.#records.get(plugin.id);
    if (existing?.state === "active") {
      throw new PluginLifecycleError(
        "PLUGIN_ALREADY_ACTIVE",
        `plugin '${plugin.id}' is already active in session ${existing.sessionId ?? "unknown"}`,
        { pluginId: plugin.id }
      );
    }

    // Declaration gate: a plugin only ever receives what its manifest declared.
    for (const [method, binding] of input.capabilities) {
      if (!plugin.capabilities.includes(binding.action)) {
        throw new PluginLifecycleError(
          "PLUGIN_CAPABILITY_NOT_DECLARED",
          `plugin '${plugin.id}' requested '${binding.action}' via '${method}' but did not declare it in its manifest`,
          { pluginId: plugin.id, method, action: binding.action, declared: plugin.capabilities }
        );
      }
    }

    const record: ActivationRecord = {
      state: "active",
      principal: input.principal,
      pinnedVersion: plugin.version,
      pinnedDescriptor: plugin.descriptor,
      handleByMethod: new Map(),
      revokedHandles: new Map()
    };

    const failAdmission = (message: string): never => {
      this.#revokeRecord(record);
      record.state = "failed";
      record.lastError = { code: "PLUGIN_ACTIVATION_FAILED", message };
      this.#records.set(plugin.id, record);
      throw new PluginLifecycleError("PLUGIN_ACTIVATION_FAILED", message, { pluginId: plugin.id });
    };

    try {
      for (const [method, binding] of input.capabilities) {
        record.handleByMethod.set(method, {
          action: binding.action,
          resource: binding.resource,
          handle: this.#options.broker.issue({
            subject: input.principal,
            action: binding.action,
            resource: binding.resource
          })
        });
      }
    } catch (error) {
      // A partial grant must never survive a failed admission.
      return failAdmission(
        `capability grant failed for '${plugin.id}': ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const bound: Map<string, BoundOperation> = new Map();
    for (const [method, entry] of record.handleByMethod) {
      bound.set(method, { action: entry.action, resource: entry.resource, handle: entry.handle });
    }

    let launched: SandboxLaunch;
    try {
      launched = this.#options.sandbox.launch(plugin.descriptor, {
        gateway: this.#options.gateway,
        principal: input.principal,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        capabilities: bound,
        operations: input.operations,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.workerArgs === undefined ? {} : { workerArgs: input.workerArgs })
      });
    } catch (error) {
      return failAdmission(
        `sandbox launch refused for '${plugin.id}': ${error instanceof Error ? error.message : String(error)}`
      );
    }

    record.sessionId = launched.sessionId;
    this.#records.set(plugin.id, record);

    // Terminal sessions hand their capabilities back automatically: a crashed
    // or finished run must not keep a live grant, and a process must never be
    // left behind.
    void launched.result.then(
      result => this.#onTerminal(plugin.id, launched.sessionId, result),
      error => this.#onTerminal(plugin.id, launched.sessionId, {
        sessionId: launched.sessionId,
        state: "failed",
        error: { code: "session_rejected", message: error instanceof Error ? error.message : String(error) }
      })
    );

    return {
      pluginId: plugin.id,
      pinnedVersion: plugin.version,
      sessionId: launched.sessionId,
      grantedActions: [...record.handleByMethod.values()].map(entry => entry.action)
    };
  }

  /** Disable a plugin: release every grant and stop its process (if any). */
  deactivate(pluginId: string, reason = "disabled by host"): PluginHealth {
    const record = this.#records.get(pluginId);
    if (!record) {
      throw new PluginLifecycleError("PLUGIN_NOT_INSTALLED", `plugin '${pluginId}' is not installed`, { pluginId });
    }
    this.#revokeRecord(record);
    if (record.sessionId !== undefined) this.#options.sandbox.cancel(record.sessionId);
    record.sessionId = undefined;
    record.state = "disabled";
    record.lastError = { code: "disabled", message: reason };
    return this.health(pluginId);
  }

  /** Uninstall: release everything, then forget the plugin entirely. */
  uninstall(pluginId: string): void {
    const record = this.#records.get(pluginId);
    if (!record) {
      throw new PluginLifecycleError("PLUGIN_NOT_INSTALLED", `plugin '${pluginId}' is not installed`, { pluginId });
    }
    this.#revokeRecord(record);
    if (record.sessionId !== undefined) this.#options.sandbox.cancel(record.sessionId);
    this.#records.delete(pluginId);
  }

  /**
   * Host-side self-check: does this plugin still hold a usable grant for the
   * given RPC method? Live grants are authorised by the Kernel; revoked ones are
   * still probed so the Kernel's own denial reason is observable.
   */
  authorise(pluginId: string, method: string): { readonly allowed: boolean; readonly reason?: string } {
    const record = this.#records.get(pluginId);
    if (!record) return { allowed: false, reason: "no_grant" };
    const entry = record.handleByMethod.get(method) ?? record.revokedHandles.get(method);
    if (!entry) return { allowed: false, reason: "no_grant" };
    try {
      this.#options.broker.authorise({
        principal: record.principal,
        handle: entry.handle,
        action: entry.action,
        resource: entry.resource
      });
      return { allowed: true };
    } catch (error) {
      const reason = (error as { reason?: string }).reason;
      return { allowed: false, reason: reason ?? "denied" };
    }
  }

  /** Version-pinned health: the installed version may drift; the run may not. */
  health(pluginId: string, installedVersion?: string): PluginHealth {
    const record = this.#records.get(pluginId);
    if (!record) {
      throw new PluginLifecycleError("PLUGIN_NOT_INSTALLED", `plugin '${pluginId}' is not installed`, { pluginId });
    }
    return {
      pluginId,
      state: record.state,
      installedVersion: installedVersion ?? record.pinnedVersion,
      pinnedVersion: record.pinnedVersion,
      grantedActions: [...record.handleByMethod.values()].map(entry => entry.action),
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.lastError === undefined ? {} : { lastError: record.lastError })
    };
  }

  /** Descriptor the live run was admitted with (upgrades do not touch it). */
  pinnedDescriptor(pluginId: string): PluginDescriptor {
    const record = this.#records.get(pluginId);
    if (!record) {
      throw new PluginLifecycleError("PLUGIN_NOT_INSTALLED", `plugin '${pluginId}' is not installed`, { pluginId });
    }
    return record.pinnedDescriptor;
  }

  /** Sessions this manager still owns (should be empty after every teardown). */
  ownedSessions(): readonly SandboxSessionId[] {
    return [...this.#records.values()]
      .map(record => record.sessionId)
      .filter((sessionId): sessionId is SandboxSessionId => sessionId !== undefined);
  }

  #onTerminal(pluginId: string, sessionId: SandboxSessionId, result: SandboxRunResult): void {
    const record = this.#records.get(pluginId);
    if (!record || record.sessionId !== sessionId) return;
    this.#revokeRecord(record);
    record.sessionId = undefined;
    if (result.state === "succeeded") {
      record.state = "inactive";
      record.lastError = undefined;
      return;
    }
    // Defensive: a non-succeeded session must not leave a process behind.
    this.#options.sandbox.cancel(sessionId);
    record.state = "failed";
    record.lastError = result.error ?? {
      code: result.state,
      message: `plugin '${pluginId}' run ended with state '${result.state}'`
    };
  }

  /** Revoke every live grant and keep it for post-mortem authorisation probes. */
  #revokeRecord(record: ActivationRecord): void {
    for (const [method, entry] of record.handleByMethod) {
      this.#options.broker.revoke(entry.handle, this.#options.kernelPrincipalId);
      record.revokedHandles.set(method, entry);
    }
    record.handleByMethod.clear();
  }
}
