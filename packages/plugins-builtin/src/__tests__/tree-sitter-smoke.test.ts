/**
 * Tree-sitter runtime smoke test — must pass BEFORE any analyzer work.
 *
 * Proves the correct WASM initialization path under the current Node
 * environment: `Parser.init({ locateFile })` resolving the runtime's own
 * bundled tree-sitter.wasm (NOT the broken `wasmBinary` path that caused the
 * archival "env.abort" instantiation failure).
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

describe("web-tree-sitter runtime smoke", () => {
  it("initializes the runtime without env.abort instantiation failures", async () => {
    const wasmPath = require.resolve("web-tree-sitter/tree-sitter.wasm");
    expect(fs.existsSync(wasmPath)).toBe(true);
    await expect(Parser.init({ locateFile: () => wasmPath })).resolves.toBeUndefined();
  });

  it("parses a TypeScript fixture and exposes a stable syntax tree shape", async () => {
    const wasmPath = require.resolve("web-tree-sitter/tree-sitter.wasm");
    await Parser.init({ locateFile: () => wasmPath });

    const grammarPath = require.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm");
    const language = await Parser.Language.load(fs.readFileSync(grammarPath));

    const parser = new Parser();
    parser.setLanguage(language);

    const source = "const x = 1\nfunction add(a: number, b: number): number {\n  return a + b\n}\n";
    const tree = parser.parse(source);
    expect(tree.rootNode.type).toBe("program");
    expect(tree.rootNode.hasError).toBe(false);

    // The function declaration node exists and carries zero-based positions.
    let found = false;
    function walk(node: Parser.SyntaxNode) {
      if (node.type === "function_declaration") {
        found = true;
        expect(node.startPosition.row).toBe(1); // second line, zero-based
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walk(child);
      }
    }
    walk(tree.rootNode);
    expect(found).toBe(true);
    tree.delete();
  });
});
