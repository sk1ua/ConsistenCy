import { describe, expect, it } from "vitest";
import relevantContext from "../../../tests/fixtures/relevant_context.json";
import {
  callerGraphEdgeSchema,
  historicalFixSchema,
  relatedModuleSchema,
  relevantContextSchema
} from "./heartbeat";

describe("context augmentation contract", () => {
  it("parses a payload captured from the real Python indexer", () => {
    // Regenerate by running engine.knowledge.get_relevant_context and dumping
    // the result to tests/fixtures/relevant_context.json. A failure here means
    // the Python query and this schema have diverged.
    const parsed = relevantContextSchema.parse(relevantContext);

    expect(parsed.historicalFixes).toHaveLength(1);
    expect(parsed.relatedModules.length).toBeGreaterThan(0);
    expect(parsed.pastSecurityReports).toHaveLength(1);
    expect(parsed.callerGraph.length).toBeGreaterThan(0);
  });

  it("accepts every row the indexer produced", () => {
    const parsed = relevantContextSchema.parse(relevantContext);

    for (const fix of parsed.historicalFixes) {
      expect(() => historicalFixSchema.parse(fix)).not.toThrow();
    }
    for (const related of parsed.relatedModules) {
      expect(() => relatedModuleSchema.parse(related)).not.toThrow();
    }
    for (const edge of parsed.callerGraph) {
      expect(() => callerGraphEdgeSchema.parse(edge)).not.toThrow();
    }
  });

  it("uses the relation vocabulary the schema declares", () => {
    const parsed = relevantContextSchema.parse(relevantContext);
    const relations = new Set(parsed.relatedModules.map(module => module.relation));
    for (const relation of relations) {
      expect(["imports", "imported_by", "sibling", "test"]).toContain(relation);
    }
    expect(relations.has("imported_by")).toBe(true);
    expect(relations.has("test")).toBe(true);
  });

  it("anchors every caller edge to both endpoints", () => {
    const parsed = relevantContextSchema.parse(relevantContext);
    for (const edge of parsed.callerGraph) {
      expect(edge.callerFile.length).toBeGreaterThan(0);
      expect(edge.calleeFile).toBe("pkg/beta.py");
      expect(edge.depth).toBeGreaterThan(0);
    }
  });

  it("rejects a caller edge missing an endpoint", () => {
    expect(() => callerGraphEdgeSchema.parse({
      callerFile: "a.py",
      callerSymbol: "go",
      calleeFile: "",
      calleeSymbol: "helper",
      depth: 1
    })).toThrow();
  });
});
