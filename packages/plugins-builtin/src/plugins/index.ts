/**
 * H22 plugin manifest / lifecycle surface.
 *
 * Exposed as a subpath (`@consistency/plugins-builtin/plugins`) so the existing
 * root barrel — consumed by the review workload — keeps its exact shape.
 */

export {
  PLUGIN_PROTOCOL_VERSION,
  PluginManifestError,
  entryIntegrity,
  loadPluginManifest,
  resolvePluginEntry
} from "./manifest.js";
export type {
  InstalledPlugin,
  LoadPluginManifestOptions,
  PluginCompatibility,
  PluginManifest,
  PluginManifestErrorCode,
  PluginTrustTier
} from "./manifest.js";

export { PluginLifecycleError, PluginLifecycleManager } from "./lifecycle.js";
export type {
  ActivatePluginInput,
  PluginActivation,
  PluginCapabilityBinding,
  PluginHealth,
  PluginLifecycleErrorCode,
  PluginLifecycleManagerOptions,
  PluginRuntimeState
} from "./lifecycle.js";

export { isUsableRange, parseSemver, satisfiesRange } from "./version.js";
export type { Semver } from "./version.js";

export {
  PLUGIN_CONTAINMENT_MODEL,
  describePluginContainment,
  isOsContained
} from "./containment.js";
export type { ContainmentLevel, PluginContainmentModel } from "./containment.js";
