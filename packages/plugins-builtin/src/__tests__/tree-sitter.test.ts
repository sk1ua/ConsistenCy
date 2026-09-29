/**
 * TreeSitterService tests — AC-TS-1 … AC-TS-5.
 */

import { describe, it, expect } from "vitest";
import {
  TreeSitterService,
  UnsupportedLanguageError,
  detectLanguage,
} from "../index.js";

const TS_SOURCE = [
  "const x = 1",
  "function add(a: number, b: number): number {",
  "  return a + b",
  "}",
].join("\n");

describe("TreeSitterService — infrastructure", () => {
  it("AC-TS-1: runtime initializes successfully under the current test environment", async () => {
    const service = new TreeSitterService();
    await expect(service.init()).resolves.toBeUndefined();
    // Idempotent.
    await expect(service.init()).resolves.toBeUndefined();
  });

  it("AC-TS-2: TypeScript and JavaScript fixtures parse with a stable tree shape", async () => {
    const service = new TreeSitterService();
    const ts = await service.parse(TS_SOURCE, { language: "typescript" });
    expect(ts.root.type).toBe("program");
    expect(ts.hasErrors()).toBe(false);
    expect(ts.nodesOfType("function_declaration")).toHaveLength(1);

    const js = await service.parse("const y = 2\n", { language: "javascript" });
    expect(js.root.type).toBe("program");
    expect(js.hasErrors()).toBe(false);
  });

  it("AC-TS-3: syntax node positions map deterministically to 1-based source lines", async () => {
    const service = new TreeSitterService();
    const doc = await service.parse(TS_SOURCE, { language: "typescript" });

    const fn = doc.nodesOfType("function_declaration")[0]!;
    // Function declaration spans source lines 2..4 (1-based, user-facing).
    expect(fn.startLine).toBe(2);
    expect(fn.endLine).toBe(4);

    // The return statement is on line 3.
    const ret = doc.nodesOfType("return_statement")[0]!;
    expect(ret.startLine).toBe(3);
    expect(ret.endLine).toBe(3);

    // Positions are consistent with the 1-based line-text helper.
    expect(doc.lineText(ret.startLine)).toBe("  return a + b");
  });

  it("AC-TS-4: unsupported languages are rejected explicitly", async () => {
    const service = new TreeSitterService();
    await expect(service.parse("fn main() {}", { filePath: "main.rs" })).rejects.toThrow(
      UnsupportedLanguageError,
    );
    await expect(service.parse("print(1)", { filePath: "script.py" })).rejects.toThrow(
      UnsupportedLanguageError,
    );
    expect(detectLanguage("main.rs")).toBeUndefined();
    expect(detectLanguage("component.tsx")).toBeUndefined(); // JSX slice deferred
  });

  it("AC-TS-5: runtime and grammar versions are pinned and queryable for provenance", async () => {
    const service = new TreeSitterService();
    const versions = service.versions();

    expect(versions.runtimePackage).toBe("web-tree-sitter");
    expect(versions.runtimeVersion).toBe("0.22.6"); // exact pin — no floating range
    expect(versions.grammarsPackage).toBe("tree-sitter-wasms");
    expect(versions.grammarsPackageVersion).toBe("0.1.13");
    expect(versions.languages).toEqual([
      { language: "typescript", grammarFile: "tree-sitter-typescript.wasm" },
      { language: "javascript", grammarFile: "tree-sitter-javascript.wasm" },
    ]);

    // No internet access at runtime: parse completes offline after init.
    const doc = await service.parse("const z = 1", { language: "typescript" });
    expect(doc.hasErrors()).toBe(false);
  });
});
