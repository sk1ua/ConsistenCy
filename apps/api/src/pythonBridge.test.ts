import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeFileWithPython,
  buildPRReportWithPython,
  buildAnalyzeFileArgs,
  buildPRReportArgs,
  parseAnalyzeFileRequest,
  resolveAnalyzeFileRequest,
  PythonBridgeError,
  type RunProcess
} from "./pythonBridge";
import prReportFixture from "../../../tests/fixtures/pr_report_minimal.json";

const validAnalysisResult = {
  risk_score: 0.1,
  raw_score: 0.1,
  risk_level: "Minor Drift",
  risk_colour: "YELLOW",
  breakdown: { semantic: 0.1 },
  signal_results: {
    semantic: {
      signal_name: "semantic",
      score: 0.1,
      evidence: [],
      confidence: 1,
      metadata: {}
    }
  },
  signal_composition: { semantic: 1 },
  dominant_signals: ["semantic"],
  confidence: 0.8,
  explainability: {
    dominant_signals: ["semantic"],
    contributions: { semantic: 1 },
    evidence_chain: [{ signal_name: "semantic", text: "changed" }],
    confidence: 0.8
  },
  agent_collaboration: {
    scope: "file.py",
    decision: "monitor",
    consensus_score: 0.1,
    confidence: 0.8,
    quorum: "5/5",
    participants: ["SemanticAgent"],
    protocol: "parallel_agents -> evidence_normalization -> weighted_consensus -> reviewer_handoff"
  },
  evidence: [],
  agent_details: {
    SemanticAgent: {
      score: 0.1,
      evidence: [],
      elapsed_ms: 1
    }
  }
};

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pythonBridge", () => {
  it("builds analyze-file CLI args without a shell string", () => {
    expect(buildAnalyzeFileArgs({ currentFile: "new.py", baselineFile: "old.py" })).toEqual(
      expect.arrayContaining(["analyze-file", "new.py", "old.py", "--json-output"])
    );
  });

  it("builds pr-report CLI args without a shell string", () => {
    expect(buildPRReportArgs({ repoPath: ".", baseSha: "base123", headSha: "head456" })).toEqual(
      expect.arrayContaining([
        "pr-report",
        "--repo",
        ".",
        "--base",
        "base123",
        "--head",
        "head456",
        "--json-output"
      ])
    );
  });

  it("validates analyze-file request bodies", () => {
    expect(parseAnalyzeFileRequest({ currentFile: "new.py", baselineFile: "old.py" })).toEqual({
      currentFile: "new.py",
      baselineFile: "old.py"
    });
    expect(() => parseAnalyzeFileRequest({ currentFile: "new.py" })).toThrow(PythonBridgeError);
  });

  it("only resolves analyze-file inputs inside the configured workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "consistency-analyze-"));
    tempDirectories.push(workspace);
    mkdirSync(join(workspace, "job-1"));
    writeFileSync(join(workspace, "job-1", "new.py"), "print('new')");
    writeFileSync(join(workspace, "job-1", "old.py"), "print('old')");
    writeFileSync(join(workspace, ".env"), "TOKEN=secret");

    expect(resolveAnalyzeFileRequest(workspace, {
      currentFile: "job-1/new.py",
      baselineFile: "job-1/old.py"
    })).toEqual({
      currentFile: join(workspace, "job-1", "new.py"),
      baselineFile: join(workspace, "job-1", "old.py")
    });
    expect(() => resolveAnalyzeFileRequest(workspace, {
      currentFile: "../outside.py",
      baselineFile: "job-1/old.py"
    })).toThrow(/configured workspace/);
    expect(() => resolveAnalyzeFileRequest(workspace, {
      currentFile: ".env",
      baselineFile: "job-1/old.py"
    })).toThrow(/Secret files/);
  });

  it("returns schema-validated Python JSON", async () => {
    const runProcess: RunProcess = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(validAnalysisResult),
      stderr: ""
    });

    await expect(
      analyzeFileWithPython({ currentFile: "new.py", baselineFile: "old.py" }, { runProcess })
    ).resolves.toMatchObject({ risk_score: 0.1 });
  });

  it("maps non-zero Python exits to bridge errors", async () => {
    const runProcess: RunProcess = async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "boom"
    });

    await expect(
      analyzeFileWithPython({ currentFile: "new.py", baselineFile: "old.py" }, { runProcess })
    ).rejects.toMatchObject({ code: "PYTHON_EXIT_NONZERO" });
  });

  it("rejects non-JSON Python stdout", async () => {
    const runProcess: RunProcess = async () => ({
      exitCode: 0,
      stdout: "not json",
      stderr: ""
    });

    await expect(
      analyzeFileWithPython({ currentFile: "new.py", baselineFile: "old.py" }, { runProcess })
    ).rejects.toMatchObject({ code: "PYTHON_INVALID_JSON" });
  });

  it("returns schema-validated legacy PR report JSON", async () => {
    const runProcess: RunProcess = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(prReportFixture),
      stderr: ""
    });

    await expect(
      buildPRReportWithPython({ repoPath: ".", baseSha: "base123", headSha: "head456" }, { runProcess })
    ).resolves.toMatchObject({ base_ref: "base123", head_ref: "head456" });
  });
});
