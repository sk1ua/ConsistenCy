/**
 * Wave 3 / R3 残留（task-10）— 诊断 traceView 必须优先读权威终态原因。
 *
 * 缺陷：`buildRunTraceView` 只从 `run_failed` 的 error 文本（`run-cancelled (…)`）
 * 或 payload.cancelId 推断"取消"，完全忽略已经权威化的 `terminal_reason`。
 * 两个方向都会失真：
 *   - 一个真正被取消的运行（权威 `user_cancelled`）若 error 文本被清洗/改写，
 *     诊断会报 `detected: false` —— 已知的取消事实被丢掉；
 *   - 一个降级运行（权威 `degraded_coverage`）只要 provider 错误文本里恰好出现
 *     `run-cancelled (…)`，诊断就会凭空报出一次取消 —— 重解释。
 *
 * 契约：权威值优先；历史行（没有权威列值）保留 error 文本 / payload.cancelId
 * 的兼容回退，并且回退路径要在 `unknowns` 里说明来源。
 */

import { describe, expect, it } from "vitest";
import { buildRunTraceView, type DiagnosticsEventLike } from "./traceView";

const T0 = "2026-01-01T00:00:00.000Z";
function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function event(overrides: Partial<DiagnosticsEventLike> & { seq: number; eventType: string }): DiagnosticsEventLike {
  return {
    eventId: `wfevt_${overrides.seq}`,
    runId: "wfrun_terminal_faces",
    correlationId: "wfrun_terminal_faces",
    timestamp: at(overrides.seq * 100),
    payload: {},
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: "wfrun_terminal_faces",
    status: "failed",
    createdAt: T0,
    finishedAt: at(1_000),
    ...overrides,
  };
}

describe("Wave3 R3 残留（task-10）— traceView 的终态原因只有一个权威来源", () => {
  it("W10-b1: an authoritative user_cancelled run is detected even with NO cancel-id text", () => {
    const view = buildRunTraceView({
      run: run({ terminalReason: "user_cancelled", lifecycleState: "cancelled" }),
      events: [
        event({ seq: 1, eventType: "run_started" }),
        event({ seq: 2, eventType: "step_started", stepId: "model-verify", attemptNumber: 1, timestamp: at(400) }),
        event({
          seq: 3,
          eventType: "run_failed",
          timestamp: at(900),
          terminalReason: "user_cancelled",
          toState: "cancelled",
          error: "run was cancelled by the operator",
        }),
      ],
    });

    expect(view.terminal.terminalReason).toBe("user_cancelled");
    expect(view.terminal.lifecycleState).toBe("cancelled");
    expect(view.terminal.source).toBe("ledger_event");
    expect(view.cancellation.detected).toBe(true);
    expect(view.cancellation.reasonSource).toBe("authoritative");
    // Observed wait is still derived from the ledger: 400ms → 900ms.
    expect(view.cancellation.observedWaitMs).toBe(500);
    expect(view.cancellation.waitKnown).toBe(true);
    // The causal cancel id is genuinely unknown here — reported, not invented.
    expect(view.cancellation.cancelId).toBeNull();
    expect(view.unknowns.some((entry) => entry.includes("cancel id"))).toBe(true);
  });

  it("W10-b2: a degraded run whose error text mentions a cancel is NOT reported as cancelled", () => {
    const view = buildRunTraceView({
      run: run({ terminalReason: "degraded_coverage", lifecycleState: "degraded" }),
      events: [
        event({ seq: 1, eventType: "run_started" }),
        event({ seq: 2, eventType: "step_started", stepId: "model-verify", attemptNumber: 1, timestamp: at(400) }),
        event({
          seq: 3,
          eventType: "run_failed",
          timestamp: at(900),
          terminalReason: "degraded_coverage",
          toState: "degraded",
          // Provider text that merely LOOKS like a cancel must not win over the
          // authoritative reason (the legacy pattern would match it).
          error: "upstream: run-cancelled (cancel_injected)",
        }),
      ],
    });

    expect(view.terminal.terminalReason).toBe("degraded_coverage");
    expect(view.cancellation.detected).toBe(false);
    expect(view.cancellation.cancelId).toBeNull();
    expect(view.cancellation.reasonSource).toBeNull();
    expect(view.unknowns.some((entry) => entry.includes("authoritative"))).toBe(true);
  });

  it("W10-b3: an interrupted run is authoritative too (reason surfaced, not inferred)", () => {
    const view = buildRunTraceView({
      run: run({ terminalReason: "interrupted", lifecycleState: "failed" }),
      events: [
        event({ seq: 1, eventType: "run_started" }),
        event({ seq: 2, eventType: "step_started", stepId: "analyze", attemptNumber: 1 }),
        event({
          seq: 3,
          eventType: "run_failed",
          timestamp: at(900),
          terminalReason: "interrupted",
          toState: "failed",
          error: "run interrupted by API restart",
        }),
      ],
    });

    expect(view.terminal.terminalReason).toBe("interrupted");
    expect(view.terminal.source).toBe("ledger_event");
    expect(view.cancellation.detected).toBe(false);
    // Interrupted is NOT a cancellation and must never be reported as one.
    expect(view.unknowns.some((entry) => entry.includes("interrupted"))).toBe(false);
  });

  it("W10-b4: the run row alone can carry the authority (ledger event without the refined triple)", () => {
    const view = buildRunTraceView({
      run: run({ terminalReason: "result_unavailable", lifecycleState: "degraded" }),
      events: [
        event({ seq: 1, eventType: "run_started" }),
        event({ seq: 2, eventType: "run_failed", timestamp: at(900), error: "checkpoint write failed" }),
      ],
    });

    expect(view.terminal.terminalReason).toBe("result_unavailable");
    expect(view.terminal.source).toBe("run_row");
    expect(view.cancellation.detected).toBe(false);
  });

  it("W10-b5: legacy rows keep the documented error-text fallback (and say so)", () => {
    const view = buildRunTraceView({
      // Pre-R3 row: no refined facts anywhere.
      run: run(),
      events: [
        event({ seq: 1, eventType: "run_started" }),
        event({ seq: 2, eventType: "step_started", stepId: "model-verify", attemptNumber: 1, timestamp: at(400) }),
        event({ seq: 3, eventType: "run_failed", timestamp: at(900), error: "model-verify: run-cancelled (cancel_legacy)" }),
      ],
    });

    expect(view.terminal.terminalReason).toBeNull();
    expect(view.terminal.source).toBe("none");
    expect(view.cancellation.detected).toBe(true);
    expect(view.cancellation.cancelId).toBe("cancel_legacy");
    expect(view.cancellation.reasonSource).toBe("legacy_error_text");
    expect(view.unknowns.some((entry) => entry.includes("legacy"))).toBe(true);
  });

  it("W10-b6: the legacy payload cancelId path still works when no refined fact exists", () => {
    const view = buildRunTraceView({
      run: run(),
      events: [
        event({ seq: 1, eventType: "run_started" }),
        event({ seq: 2, eventType: "run_failed", timestamp: at(900), payload: { cancelId: "cancel_payload" } }),
      ],
    });

    expect(view.terminal.terminalReason).toBeNull();
    expect(view.cancellation.detected).toBe(true);
    expect(view.cancellation.cancelId).toBe("cancel_payload");
    expect(view.cancellation.reasonSource).toBe("legacy_cancel_payload");
  });
});
