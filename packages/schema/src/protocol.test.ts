import { describe, expect, it } from "vitest";
import {
  parseWireAnalyzeResponse,
  parseWireComposeReviewResponse,
  wireAnalyzeRequestSchema,
  wireComposeReviewRequestSchema,
  wireProtocolRequestSchema
} from "./protocol";

describe("Protocol Wire Schemas and Transforms", () => {
  it("validates wire analyze request schema", () => {
    const validReq = {
      id: "req_123",
      action: "analyze" as const,
      files: [
        {
          path: "src/main.ts",
          content: "console.log('hello');",
          baseline: "console.log('base');",
          language: "typescript"
        }
      ]
    };

    const parsed = wireAnalyzeRequestSchema.parse(validReq);
    expect(parsed.id).toBe("req_123");
    expect(parsed.action).toBe("analyze");
    expect(parsed.files).toHaveLength(1);
  });

  it("discriminates protocol requests via union", () => {
    const composeReq = {
      id: "req_456",
      action: "compose_review" as const,
      files: [
        { path: "src/a.ts", risk_score: 0.8, findings: ["high risk"] }
      ]
    };

    const parsed = wireProtocolRequestSchema.parse(composeReq);
    expect(parsed.action).toBe("compose_review");
    expect(parsed.id).toBe("req_456");
  });

  it("rejects compose_review with invalid file format or unexpected properties", () => {
    const invalidComposeReq = {
      id: "req_bad",
      action: "compose_review",
      files: [{ anything: true }]
    };

    expect(() => wireComposeReviewRequestSchema.parse(invalidComposeReq)).toThrow();
  });

  it("parses and transforms wire analyze response into camelCase domain object", () => {
    const wireResponse = {
      id: "req_789",
      ok: true as const,
      files: [
        {
          path: "src/utils.ts",
          risk_score: 0.45,
          risk_label: "medium",
          risk_color: "YELLOW",
          signals: { style: 0.1 },
          findings: ["Style deviation detected"],
          confidence: 0.9,
          breakdown: { style: 0.1 },
          agent_collaboration: { decision: "approve" }
        }
      ],
      consensus: { agreement: 0.95 },
      evidence_pack: {
        strategy: "default",
        context_budget_tokens: 1000,
        packs: [],
        summary: {
          files_with_evidence: 0,
          total_selected_evidence: 0,
          average_selected_evidence_count: 0,
          average_compression_ratio: 0
        }
      }
    };

    const domain = parseWireAnalyzeResponse(wireResponse);
    expect(domain.id).toBe("req_789");
    expect(domain.ok).toBe(true);
    if (domain.ok) {
      expect(domain.files[0]).toEqual({
        path: "src/utils.ts",
        riskScore: 0.45,
        riskLabel: "medium",
        riskColor: "YELLOW",
        signals: { style: 0.1 },
        findings: ["Style deviation detected"],
        confidence: 0.9,
        breakdown: { style: 0.1 },
        agentCollaboration: { decision: "approve" }
      });
      expect(domain.evidencePack?.strategy).toBe("default");
    }
  });

  it("parses and transforms wire compose_review response into camelCase domain object", () => {
    const wireComposeResponse = {
      id: "req_compose_1",
      ok: true as const,
      overall_score: 20,
      risk_level: "critical" as const,
      summary: "2 files reviewed.",
      recommendations: ["Fix security finding."]
    };

    const domain = parseWireComposeReviewResponse(wireComposeResponse);
    expect(domain.id).toBe("req_compose_1");
    expect(domain.ok).toBe(true);
    if (domain.ok) {
      expect(domain.overallScore).toBe(20);
      expect(domain.riskLevel).toBe("critical");
      expect(domain.summary).toBe("2 files reviewed.");
      expect(domain.recommendations).toEqual(["Fix security finding."]);
    }
  });

  it("parses strict error response and rejects extra keys in ok:false payload", () => {
    const validErrorResponse = {
      id: "req-comp-err",
      ok: false as const,
      error: "Protocol validation error: ComposeReviewFile requires a numeric 'risk_score' between 0.0 and 1.0"
    };

    const domain = parseWireComposeReviewResponse(validErrorResponse);
    expect(domain.id).toBe("req-comp-err");
    expect(domain.ok).toBe(false);
    if (!domain.ok) {
      expect(domain.error).toContain("Protocol validation error");
    }

    // Extra keys in error response must be strictly rejected
    const invalidErrorResponse = {
      ...validErrorResponse,
      overall_score: 100
    };
    expect(() => parseWireComposeReviewResponse(invalidErrorResponse)).toThrow();
  });

  it("rejects analyze success response missing files array", () => {
    expect(() => parseWireAnalyzeResponse({ id: "req_nofiles", ok: true })).toThrow();
  });

  it("rejects analyze request missing correlation id or containing blank strings", () => {
    expect(() => wireAnalyzeRequestSchema.parse({ action: "analyze", files: [] })).toThrow();
    expect(() => wireAnalyzeRequestSchema.parse({ id: "   ", action: "analyze", files: [] })).toThrow();
    expect(() => wireAnalyzeRequestSchema.parse({
      id: "req_1",
      action: "analyze",
      files: [{ path: "  ", content: "x=1" }]
    })).toThrow();
  });

  it("rejects options: null in request schema", () => {
    expect(() => wireAnalyzeRequestSchema.parse({
      id: "req_1",
      action: "analyze",
      files: [],
      options: null
    })).toThrow();
  });
});
