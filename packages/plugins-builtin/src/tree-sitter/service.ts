/**
 * TreeSitterService — parsing INFRASTRUCTURE (Ring 1 protected service),
 * NOT an analyzer.
 *
 * It initializes the pinned web-tree-sitter runtime, loads pinned grammar
 * WASM from `tree-sitter-wasms`, and hands analyzers provider-agnostic
 * {@link ParsedDocument}s. It never emits findings.
 *
 * Runtime + grammar versions are pinned exactly in package.json and are
 * queryable via {@link versions()} for Evidence provenance.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import Parser from "web-tree-sitter";
import type { LanguageId } from "./languages.js";
import { detectLanguage, languageEntry, UnsupportedLanguageError } from "./languages.js";
import { ParsedDocument } from "./document.js";

const require = createRequire(import.meta.url);

export class TreeSitterInitError extends Error {
  constructor(message: string) {
    super(`TreeSitterService initialization failed: ${message}`);
    this.name = "TreeSitterInitError";
  }
}

export interface GrammarVersions {
  readonly runtimePackage: "web-tree-sitter";
  readonly runtimeVersion: string;
  readonly grammarsPackage: "tree-sitter-wasms";
  readonly grammarsPackageVersion: string;
  readonly languages: readonly { readonly language: LanguageId; readonly grammarFile: string }[];
}

export interface ParseOptions {
  /** Parse as this language (explicit). */
  readonly language?: LanguageId;
  /** …or detect the language from this file path. */
  readonly filePath?: string;
}

export class TreeSitterService {
  #initPromise: Promise<void> | null = null;
  readonly #languages = new Map<LanguageId, Parser.Language>();

  /** Idempotent runtime initialization (no internet access at runtime). */
  init(): Promise<void> {
    if (!this.#initPromise) {
      this.#initPromise = (async () => {
        try {
          const wasmPath = require.resolve("web-tree-sitter/tree-sitter.wasm");
          await Parser.init({ locateFile: () => wasmPath });
        } catch (err) {
          throw new TreeSitterInitError((err as Error).message);
        }
      })();
    }
    return this.#initPromise;
  }

  supportedLanguages(): readonly LanguageId[] {
    return ["typescript", "javascript"];
  }

  detectLanguage(filePath: string): LanguageId | undefined {
    return detectLanguage(filePath);
  }

  /**
   * Parse source text into a protected ParsedDocument. Unsupported languages
   * fail EXPLICITLY — never parsed with the wrong grammar.
   */
  async parse(source: string, options: ParseOptions): Promise<ParsedDocument> {
    await this.init();
    const language: LanguageId | undefined =
      options.language ?? (options.filePath ? detectLanguage(options.filePath) : undefined);
    if (!language) {
      throw new UnsupportedLanguageError(options.filePath ?? "(no language)");
    }
    const treeSitterLanguage = await this.#loadLanguage(language);

    const parser = new Parser();
    parser.setLanguage(treeSitterLanguage);
    const tree = parser.parse(source);
    try {
      return ParsedDocument.fromRawNode(language, source, tree.rootNode as unknown as Parameters<typeof ParsedDocument.fromRawNode>[2]);
    } finally {
      tree.delete();
    }
  }

  /** Pinned runtime/grammar versions — feed these into Evidence provenance. */
  versions(): GrammarVersions {
    const runtimePkg = require("web-tree-sitter/package.json") as { version: string };
    const grammarsPkg = require("tree-sitter-wasms/package.json") as { version: string };
    return {
      runtimePackage: "web-tree-sitter",
      runtimeVersion: runtimePkg.version,
      grammarsPackage: "tree-sitter-wasms",
      grammarsPackageVersion: grammarsPkg.version,
      languages: ["typescript", "javascript"].map((id) => {
        const entry = languageEntry(id as LanguageId);
        return { language: id as LanguageId, grammarFile: entry.grammarFile };
      }),
    };
  }

  async #loadLanguage(id: LanguageId): Promise<Parser.Language> {
    const cached = this.#languages.get(id);
    if (cached) return cached;
    const entry = languageEntry(id);
    const grammarPath = require.resolve(`tree-sitter-wasms/out/${entry.grammarFile}`);
    const language = await Parser.Language.load(fs.readFileSync(grammarPath));
    this.#languages.set(id, language);
    return language;
  }
}
