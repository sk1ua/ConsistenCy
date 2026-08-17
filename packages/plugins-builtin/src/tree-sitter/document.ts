/**
 * ParsedDocument — the protected, tree-sitter-agnostic parse result.
 *
 * Analyzers receive NodeRef structures (positions converted to USER-FACING
 * 1-BASED lines), never raw tree-sitter Parser/Tree/SyntaxNode objects. This
 * keeps TreeSitterService replaceable infrastructure (§22).
 */

import type { LanguageId } from "./languages.js";

export interface NodeRef {
  readonly type: string;
  readonly text: string;
  /** 1-based inclusive line (user-facing). */
  readonly startLine: number;
  readonly endLine: number;
  /** 1-based inclusive column. */
  readonly startColumn: number;
  readonly isNamed: boolean;
  readonly isError: boolean;
  /** True when this subtree contains an ERROR/MISSING node. */
  readonly hasError: boolean;
  readonly children: readonly NodeRef[];
}

interface RawNode {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly isError: boolean;
  readonly hasError: boolean;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  /** web-tree-sitter 0.22 exposes namedChildren as a property getter. */
  readonly namedChildren: readonly RawNode[];
}

export class ParsedDocument {
  readonly language: LanguageId;
  readonly source: string;
  readonly root: NodeRef;
  readonly #nodes: readonly NodeRef[];

  private constructor(language: LanguageId, source: string, root: NodeRef, nodes: readonly NodeRef[]) {
    this.language = language;
    this.source = source;
    this.root = root;
    this.#nodes = nodes;
  }

  /** Convert a raw parse root into a ParsedDocument (1-based positions). */
  static fromRawNode(language: LanguageId, source: string, rawRoot: RawNode): ParsedDocument {
    const nodes: NodeRef[] = [];
    const convert = (raw: RawNode): NodeRef => {
      const node: NodeRef = {
        type: raw.type,
        text: raw.text,
        startLine: raw.startPosition.row + 1,
        endLine: raw.endPosition.row + 1,
        startColumn: raw.startPosition.column + 1,
        isNamed: raw.isNamed,
        isError: raw.isError,
        hasError: raw.hasError,
        children: Object.freeze(raw.namedChildren.map(convert)),
      };
      nodes.push(Object.freeze(node));
      return node;
    };
    const root = Object.freeze(convert(rawRoot));
    return new ParsedDocument(language, source, root, Object.freeze(nodes));
  }

  /** All nodes in pre-order (deterministic). */
  nodes(): readonly NodeRef[] {
    return this.#nodes;
  }

  nodesOfType(type: string): readonly NodeRef[] {
    return this.#nodes.filter((node) => node.type === type);
  }

  hasErrors(): boolean {
    return this.root.hasError;
  }

  /** 1-based line text, or undefined when out of range. */
  lineText(line: number): string | undefined {
    return this.source.split("\n")[line - 1];
  }
}
