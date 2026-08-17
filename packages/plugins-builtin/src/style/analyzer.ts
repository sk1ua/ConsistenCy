/**
 * StyleAnalyzer — a small DETERMINISTIC style analyzer (NOT an LLM StyleAgent).
 *
 * Rules (all objectively detectable, no subjective complaints):
 *   - style.trailing-whitespace   text rule, confidence 0.95
 *   - style.line-too-long         text rule (configurable threshold), 0.90
 *   - style.forbidden-todo        text rule: TODO without a ticket
 *                                 reference TODO(PROJ-123), 0.90
 *   - style.too-many-parameters   AST rule via TreeSitterService
 *                                 (configurable threshold), 0.85
 *
 * Every result becomes Kernel Evidence with provenance
 * { repository, sha, analyzer: "style", analyzerVersion }. Output is
 * deterministically ordered by (path, startLine, endLine, ruleId).
 */

import type { EvidenceInput } from "@consistency/kernel";
import type { Analyzer, AnalyzerDeps, AnalyzerInput } from "../analyzer/types.js";
import { orderEvidence } from "../analyzer/types.js";
import { redactSensitiveText } from "../analyzer/redact.js";
import { detectLanguage } from "../tree-sitter/languages.js";

export const STYLE_ANALYZER_VERSION = "1.0.0";

export interface StyleAnalyzerConfig {
  readonly maxLineLength: number;
  readonly maxFunctionParams: number;
  readonly requireTodoTicket: boolean;
}

export const DEFAULT_STYLE_CONFIG: StyleAnalyzerConfig = {
  maxLineLength: 100,
  maxFunctionParams: 5,
  requireTodoTicket: true,
};

const TRAILING_WHITESPACE = /[ \t]+$/;
const TODO_WITHOUT_TICKET = /\/\/.*TODO(?!\s*\([A-Z][A-Z0-9]*-[0-9]+\))/i;
const MAX_EXCERPT_LENGTH = 160;

export class StyleAnalyzer implements Analyzer<StyleAnalyzerConfig> {
  readonly id = "style";
  readonly version = STYLE_ANALYZER_VERSION;

  async analyze(
    input: AnalyzerInput,
    deps: AnalyzerDeps,
    config: Partial<StyleAnalyzerConfig> = {},
  ): Promise<EvidenceInput[]> {
    const cfg: StyleAnalyzerConfig = { ...DEFAULT_STYLE_CONFIG, ...config };
    const evidence: EvidenceInput[] = [];

    for (const file of [...input.files].sort()) {
      const { path, content } = await deps.readFile(file);
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        const lineNumber = index + 1; // 1-based user-facing
        if (TRAILING_WHITESPACE.test(line)) {
          evidence.push(this.#rule(input, path, lineNumber, lineNumber, "style.trailing-whitespace", 0.95, `trailing whitespace`, line));
        }
        if (line.length > cfg.maxLineLength) {
          evidence.push(this.#rule(input, path, lineNumber, lineNumber, "style.line-too-long", 0.9, `line length ${line.length} exceeds ${cfg.maxLineLength}`, line));
        }
        if (cfg.requireTodoTicket && TODO_WITHOUT_TICKET.test(line)) {
          evidence.push(this.#rule(input, path, lineNumber, lineNumber, "style.forbidden-todo", 0.9, `TODO without ticket reference TODO(PROJ-123)`, line));
        }
      });

      // AST rule — only for supported languages (skipped deterministically otherwise).
      if (detectLanguage(file) !== undefined) {
        const document = await deps.treeSitter.parse(content, { filePath: file });
        for (const params of document.nodesOfType("formal_parameters")) {
          const parameterNodes = params.children.filter((child) => child.type.endsWith("parameter"));
          if (parameterNodes.length > cfg.maxFunctionParams) {
            evidence.push(
              this.#rule(
                input,
                path,
                params.startLine,
                params.endLine,
                "style.too-many-parameters",
                0.85,
                `${parameterNodes.length} parameters exceeds ${cfg.maxFunctionParams}`,
                document.lineText(params.startLine) ?? "",
              ),
            );
          }
        }
      }
    }

    return orderEvidence(evidence);
  }

  #rule(
    input: AnalyzerInput,
    path: string,
    startLine: number,
    endLine: number,
    ruleId: string,
    confidence: number,
    message: string,
    excerptLine: string,
  ): EvidenceInput {
    const excerpt = redactSensitiveText(excerptLine).trim().slice(0, MAX_EXCERPT_LENGTH);
    return {
      source: ruleId === "style.too-many-parameters" ? "ast" : "lint",
      ruleId,
      location: { path, startLine, endLine },
      confidence,
      payload: { kind: "style", ruleId, message, excerpt },
      provenance: {
        repository: input.repository,
        sha: input.headSha,
        analyzer: this.id,
        analyzerVersion: this.version,
      },
    };
  }
}
