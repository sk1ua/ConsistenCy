/**
 * @consistency/plugins-builtin — deterministic repository intelligence
 * infrastructure (PR-4, clean build).
 *
 * Contains ONLY: TreeSitterService infrastructure, the deterministic
 * analyzer contract, and the Style + Secret analyzers. No Cordis, no agent
 * orchestration, no LLM drivers, no review workflow.
 */

export { TreeSitterService, TreeSitterInitError } from "./tree-sitter/service.js";
export type { GrammarVersions, ParseOptions } from "./tree-sitter/service.js";
export { ParsedDocument } from "./tree-sitter/document.js";
export type { NodeRef } from "./tree-sitter/document.js";
export {
  LANGUAGE_REGISTRY,
  detectLanguage,
  languageEntry,
  UnsupportedLanguageError,
} from "./tree-sitter/languages.js";
export type { LanguageId, LanguageEntry } from "./tree-sitter/languages.js";

export type {
  Analyzer,
  AnalyzerDeps,
  AnalyzerInput,
  SnapshotFileContent,
} from "./analyzer/types.js";
export { orderEvidence } from "./analyzer/types.js";
// Canonical armored-key redaction shared by every redaction gate in the
// repository (workload-review model-visible policy, apps/api error/log
// redaction). `redactSensitiveText` keeps its historical name and semantics.
export {
  redactSensitiveText,
  redactPrivateKeyBlocks,
  privateKeyHeaderMatcher,
  privateKeyBlockPattern,
  PRIVATE_KEY_HEADER_SOURCE,
  REDACTED_PRIVATE_KEY,
} from "./analyzer/redact.js";

export { StyleAnalyzer, STYLE_ANALYZER_VERSION, DEFAULT_STYLE_CONFIG } from "./style/analyzer.js";
export type { StyleAnalyzerConfig } from "./style/analyzer.js";

export { SecretAnalyzer, SECRET_ANALYZER_VERSION } from "./secret/analyzer.js";

export { BUILTIN_ANALYZER_REGISTRY } from "./registry.js";
export type { BuiltinAnalyzerMeta, BuiltinAnalyzerKind } from "./registry.js";

// H22 plugin manifest / lifecycle / containment surface. The manifest layer is
// metadata + policy only: it validates untrusted manifests, pins versions, and
// adapts the Kernel CapabilityBroker/SandboxManager (no second execution or
// authorization path, no package installer).
export {
  PLUGIN_PROTOCOL_VERSION,
  PluginManifestError,
  entryIntegrity,
  loadPluginManifest,
  resolvePluginEntry,
} from "./plugins/manifest.js";
export type {
  InstalledPlugin,
  LoadPluginManifestOptions,
  PluginCompatibility,
  PluginManifest,
  PluginManifestErrorCode,
  PluginTrustTier,
} from "./plugins/manifest.js";
export { PluginLifecycleError, PluginLifecycleManager } from "./plugins/lifecycle.js";
export type {
  ActivatePluginInput,
  PluginActivation,
  PluginCapabilityBinding,
  PluginHealth,
  PluginLifecycleErrorCode,
  PluginLifecycleManagerOptions,
  PluginRuntimeState,
} from "./plugins/lifecycle.js";
export { isUsableRange, parseSemver, satisfiesRange } from "./plugins/version.js";
export type { Semver } from "./plugins/version.js";
export {
  PLUGIN_CONTAINMENT_MODEL,
  describePluginContainment,
  isOsContained,
} from "./plugins/containment.js";
export type { ContainmentLevel, PluginContainmentModel } from "./plugins/containment.js";
