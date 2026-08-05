import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "./store";
import { workflowSpecSchema, type WorkflowSpec } from "@consistency/schema";

const SAMPLE_SPEC: WorkflowSpec = workflowSpecSchema.parse({
  version: 2,
  name: "sample",
  description: "Sample workflow",
  nodes: [{ id: "security", uses: "engine.security", timeoutMs: 120000 }],
  verifiers: [],
  synthesizer: { id: "synthesizer", needs: ["security"], uses: "synthesize.review_report" }
});

describe("WorkflowStore", () => {
  let root: string;
  let builtinDirectory: string;
  let draftDirectory: string;
  let store: WorkflowStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "workflow-store-"));
    builtinDirectory = join(root, "builtins");
    draftDirectory = join(root, "drafts");
    store = new WorkflowStore({ builtinDirectory, draftDirectory });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists builtin workflows parsed from YAML", () => {
    mkdirSync(builtinDirectory, { recursive: true });
    writeFileSync(join(builtinDirectory, "sample.yml"), `
version: 2
name: sample
description: Sample workflow
nodes:
  - id: security
    uses: engine.security
    timeoutMs: 120000
synthesizer:
  needs: [security]
`, "utf8");
    const list = store.list();
    expect(list).toEqual([{
      name: "sample",
      description: "Sample workflow",
      source: "builtin",
      nodeCount: 1,
      verifierCount: 0
    }]);
  });

  it("prefers a draft over a builtin with the same name", () => {
    mkdirSync(builtinDirectory, { recursive: true });
    writeFileSync(join(builtinDirectory, "sample.yml"), `
version: 2
name: sample
nodes:
  - id: security
    uses: engine.security
synthesizer:
  needs: [security]
`, "utf8");
    store.saveDraft({ ...SAMPLE_SPEC, description: "Draft override" });
    expect(store.get("sample")?.source).toBe("draft");
    expect(store.get("sample")?.spec.description).toBe("Draft override");
  });

  it("saves and deletes JSON drafts under the draft directory", () => {
    store.saveDraft(SAMPLE_SPEC);
    const draftPath = join(draftDirectory, "sample.json");
    expect(existsSync(draftPath)).toBe(true);
    expect(JSON.parse(readFileSync(draftPath, "utf8")).name).toBe("sample");
    expect(store.list().some(item => item.source === "draft" && item.name === "sample")).toBe(true);
    expect(store.deleteDraft("sample")).toBe(true);
    expect(store.deleteDraft("sample")).toBe(false);
    expect(store.get("sample")).toBeUndefined();
  });

  it("rejects drafts with unsafe names and returns undefined for unknown workflows", () => {
    expect(() => store.saveDraft({ ...SAMPLE_SPEC, name: "Bad Name" })).toThrow(/must match/);
    expect(store.get("missing")).toBeUndefined();
    expect(store.deleteDraft("Bad Name")).toBe(false);
  });
});
