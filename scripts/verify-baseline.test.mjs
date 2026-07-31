import { describe, expect, it } from "vitest";
import { assertNodeBaseline, assertPythonBaseline, queryPythonVersion } from "./baseline-runtime.mjs";

describe("Baseline Runtime Verification Pure Functions & Executable Injections", () => {
  it("passes Node 22.x and throws on non-22 Node versions", () => {
    expect(() => assertNodeBaseline("v22.23.2")).not.toThrow();
    expect(() => assertNodeBaseline("22.0.0")).not.toThrow();
    expect(() => assertNodeBaseline("v25.8.1")).toThrow("Node 22.x required, got v25.8.1");
    expect(() => assertNodeBaseline("v20.10.0")).toThrow("Node 22.x required, got v20.10.0");
  });

  it("passes Python 3.12.x and throws on non-3.12 Python versions", () => {
    expect(() => assertPythonBaseline("3.12.12")).not.toThrow();
    expect(() => assertPythonBaseline("3.12.0")).not.toThrow();
    expect(() => assertPythonBaseline("3.11.9")).toThrow("Python 3.12.x required, got 3.11.9");
    expect(() => assertPythonBaseline("3.13.1")).toThrow("Python 3.12.x required, got 3.13.1");
  });

  it("propagates a missing Python executable error", () => {
    const missingExec = () => {
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      throw error;
    };
    expect(() => queryPythonVersion("missing-python", missingExec)).toThrow("spawn ENOENT");
  });

  it("rejects malformed Python version output", () => {
    const execute = () => "not-a-valid-version";
    expect(() => assertPythonBaseline(queryPythonVersion("python", execute))).toThrow("Python 3.12.x required, got not-a-valid-version");
  });
});
