/**
 * Language registry — the explicit, extensible extension → grammar mapping.
 *
 * Unknown/unsupported languages fail EXPLICITLY (UnsupportedLanguageError);
 * they are never accidentally parsed with the wrong grammar. Grammar files
 * come from the pinned `tree-sitter-wasms` package (exact version — no
 * floating `latest`).
 */

export type LanguageId = "typescript" | "javascript";

export interface LanguageEntry {
  readonly id: LanguageId;
  readonly extensions: readonly string[];
  /** Grammar wasm file inside `tree-sitter-wasms/out`. */
  readonly grammarFile: string;
}

export const LANGUAGE_REGISTRY: readonly LanguageEntry[] = [
  {
    id: "typescript",
    extensions: [".ts", ".mts", ".cts"],
    grammarFile: "tree-sitter-typescript.wasm",
  },
  {
    id: "javascript",
    extensions: [".js", ".mjs", ".cjs"],
    grammarFile: "tree-sitter-javascript.wasm",
  },
];

export class UnsupportedLanguageError extends Error {
  constructor(filePathOrLanguage: string) {
    super(`Unsupported language for: ${filePathOrLanguage}`);
    this.name = "UnsupportedLanguageError";
  }
}

/** Map a file path to a language id by lowercase extension; undefined when unsupported. */
export function detectLanguage(filePath: string): LanguageId | undefined {
  const lower = filePath.toLowerCase();
  for (const entry of LANGUAGE_REGISTRY) {
    if (entry.extensions.some((ext) => lower.endsWith(ext))) {
      return entry.id;
    }
  }
  return undefined;
}

export function languageEntry(id: LanguageId): LanguageEntry {
  const entry = LANGUAGE_REGISTRY.find((e) => e.id === id);
  if (!entry) {
    throw new UnsupportedLanguageError(id);
  }
  return entry;
}
