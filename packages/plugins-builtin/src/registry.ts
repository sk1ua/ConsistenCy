/**
 * Lightweight builtin analyzer registry for product surfaces (Plugins page).
 * Deliberately metadata-only — no TreeSitter / Cordis / LLM imports.
 */

export type BuiltinAnalyzerKind = "deterministic";

export interface BuiltinAnalyzerMeta {
  readonly id: string;
  readonly version: string;
  readonly kind: BuiltinAnalyzerKind;
  readonly title: string;
  readonly titleZh: string;
  readonly summary: string;
  readonly summaryZh: string;
  readonly packageName: "@consistency/plugins-builtin";
}

/**
 * Analyzers actually shipped in this package today.
 * Keep in sync with StyleAnalyzer / SecretAnalyzer versions.
 */
export const BUILTIN_ANALYZER_REGISTRY: readonly BuiltinAnalyzerMeta[] = [
  {
    id: "style",
    version: "1.0.0",
    kind: "deterministic",
    title: "Style analyzer",
    titleZh: "风格分析器",
    summary:
      "Deterministic style rules: trailing whitespace, line length, TODO tickets, and parameter-count AST checks.",
    summaryZh: "确定性风格规则：行尾空白、行长、TODO 工单引用、以及参数个数 AST 检查。",
    packageName: "@consistency/plugins-builtin"
  },
  {
    id: "secret",
    version: "1.0.0",
    kind: "deterministic",
    title: "Secret analyzer",
    titleZh: "密钥扫描分析器",
    summary:
      "High-signal secret scanner (private keys, GitHub tokens, AWS keys, hardcoded credentials) with redacted evidence only.",
    summaryZh: "高信号密钥扫描（私钥头、GitHub token、AWS key、硬编码凭据）；证据仅含脱敏摘要。",
    packageName: "@consistency/plugins-builtin"
  }
] as const;
