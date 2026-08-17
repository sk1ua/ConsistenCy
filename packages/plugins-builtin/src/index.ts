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
export { redactSensitiveText } from "./analyzer/redact.js";

export { StyleAnalyzer, STYLE_ANALYZER_VERSION, DEFAULT_STYLE_CONFIG } from "./style/analyzer.js";
export type { StyleAnalyzerConfig } from "./style/analyzer.js";

export { SecretAnalyzer, SECRET_ANALYZER_VERSION } from "./secret/analyzer.js";
