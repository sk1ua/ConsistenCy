import { describe, expect, it } from "vitest";
import {
  heartbeatConfigSchema,
  heartbeatPulseSchema,
  heartbeatStreamEventSchema,
  relevantContextSchema
} from "./heartbeat";

const observedAt = "2026-08-05T12:00:00.000Z";
const pulse = {
  pulseId: "pulse-1",
  state: "idle",
  repository: { root: "D:/sk1ua/python/ConsistenCy" },
  observedAt,
  dirtyFileCount: 3,
  pendingEvents: 0
} as const;

describe("heartbeat daemon config", () => {
  it("stays opt-in with a 30s pulse by default", () => {
    const config = heartbeatConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.pulseIntervalMs).toBe(30_000);
    expect(config.indexPath).toBe(".consistency/knowledge_graph.sqlite");
  });

  it("bounds the pulse interval", () => {
    expect(() => heartbeatConfigSchema.parse({ pulseIntervalMs: 100 })).toThrow();
    expect(() => heartbeatConfigSchema.parse({ pulseIntervalMs: 7_200_000 })).toThrow();
  });
});

describe("heartbeat pulses", () => {
  it("parses a healthy pulse without metrics", () => {
    const parsed = heartbeatPulseSchema.parse(pulse);
    expect(parsed.metrics).toBeUndefined();
    expect(parsed.state).toBe("idle");
  });

  it("carries health and velocity metrics when computed", () => {
    const parsed = heartbeatPulseSchema.parse({
      ...pulse,
      state: "scanning",
      metrics: {
        windowDays: 14,
        churnRate: 182.5,
        riskIndex: 0.42,
        riskIndexTrend: -0.08,
        unsettledSecurityDebt: 2,
        filesTracked: 311,
        computedAt: observedAt
      }
    });
    expect(parsed.metrics?.riskIndexTrend).toBeLessThan(0);
  });

  it("forces a degraded pulse to explain itself", () => {
    expect(() => heartbeatPulseSchema.parse({ ...pulse, state: "degraded" })).toThrow();
    expect(heartbeatPulseSchema.parse({
      ...pulse,
      state: "degraded",
      lastError: "git index.lock is held"
    }).lastError).toBeTruthy();
  });
});

describe("heartbeat stream events", () => {
  it("discriminates pulse, change, progress, and error frames", () => {
    expect(heartbeatStreamEventSchema.parse({ event: "pulse", pulse }).event).toBe("pulse");

    expect(heartbeatStreamEventSchema.parse({
      event: "change",
      change: {
        type: "WORKING_DIR_DIRTY",
        eventId: "evt-1",
        repository: { root: "D:/sk1ua/python/ConsistenCy" },
        detectedAt: observedAt
      }
    }).event).toBe("change");

    expect(heartbeatStreamEventSchema.parse({
      event: "index_progress",
      processed: 40,
      total: 311
    }).event).toBe("index_progress");

    expect(heartbeatStreamEventSchema.parse({
      event: "error",
      message: "Indexer stalled",
      recoverable: true
    }).event).toBe("error");
  });

  it("rejects progress beyond the total", () => {
    expect(() => heartbeatStreamEventSchema.parse({
      event: "index_progress",
      processed: 400,
      total: 311
    })).toThrow();
  });
});

describe("context augmentation", () => {
  it("defaults every bucket so callers never branch on undefined", () => {
    expect(relevantContextSchema.parse({})).toEqual({
      historicalFixes: [],
      relatedModules: [],
      pastSecurityReports: [],
      callerGraph: []
    });
  });

  it("parses a populated context", () => {
    const context = relevantContextSchema.parse({
      historicalFixes: [{
        reference: "1a30c2b",
        file: "apps/api/src/http.ts",
        summary: "Added auth guard to management routes",
        fixedAt: observedAt,
        severity: "high"
      }],
      relatedModules: [{ path: "apps/api/src/server.ts", relation: "imported_by", weight: 0.8 }],
      callerGraph: [{
        callerFile: "apps/api/src/server.ts",
        callerSymbol: "start",
        calleeFile: "apps/api/src/http.ts",
        calleeSymbol: "createHttpServer",
        depth: 1
      }]
    });
    expect(context.historicalFixes).toHaveLength(1);
    expect(context.pastSecurityReports).toEqual([]);
  });
});
