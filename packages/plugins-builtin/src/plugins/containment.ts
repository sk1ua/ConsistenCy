/**
 * H22 — the containment model a plugin may be described with.
 *
 * Projected from the Kernel sandbox contract (packages/kernel/src/sandbox/
 * types.ts, "SECURITY MODEL — three distinct guarantees"), which is the single
 * source of truth. Any UI, catalog, or document describing plugin execution
 * MUST read this projection instead of inventing stronger wording: a plain
 * child process retains the OS permissions of the account it runs under, so OS
 * containment is NOT provided today.
 */

export type ContainmentLevel = "enforced" | "not-provided";

export interface PluginContainmentModel {
  /** Separate PID + JS heap; no parent globals. */
  readonly processIsolation: ContainmentLevel;
  /** Every RPC operation is authorised per-call by the Kernel. */
  readonly capabilityAuthorization: ContainmentLevel;
  /** The child is never launched with the parent's environment. */
  readonly parentEnvironmentIsolation: ContainmentLevel;
  /** Filesystem confinement (chroot/AppContainer/seatbelt): not implemented. */
  readonly osFilesystemContainment: ContainmentLevel;
  /** Network confinement: not implemented. */
  readonly osNetworkContainment: ContainmentLevel;
  /** Subprocess confinement: not implemented. */
  readonly osSubprocessContainment: ContainmentLevel;
}

export const PLUGIN_CONTAINMENT_MODEL: PluginContainmentModel = Object.freeze({
  processIsolation: "enforced",
  capabilityAuthorization: "enforced",
  parentEnvironmentIsolation: "enforced",
  osFilesystemContainment: "not-provided",
  osNetworkContainment: "not-provided",
  osSubprocessContainment: "not-provided"
});

/**
 * Honest one-line description for surfaces that must not over-claim: it names
 * what IS enforced and states plainly that OS containment is absent.
 */
export function describePluginContainment(): string {
  const model = PLUGIN_CONTAINMENT_MODEL;
  return [
    `Plugin isolation: process isolation ${model.processIsolation}, capability authorization ${model.capabilityAuthorization}, parent environment isolation ${model.parentEnvironmentIsolation}.`,
    `This runtime does NOT provide OS-level containment: filesystem ${model.osFilesystemContainment}, network ${model.osNetworkContainment}, subprocess ${model.osSubprocessContainment}.`
  ].join(" ");
}

/** True when the model still describes a sandbox that is NOT OS-contained. */
export function isOsContained(): boolean {
  const model = PLUGIN_CONTAINMENT_MODEL;
  return model.osFilesystemContainment === "enforced"
    && model.osNetworkContainment === "enforced"
    && model.osSubprocessContainment === "enforced";
}
