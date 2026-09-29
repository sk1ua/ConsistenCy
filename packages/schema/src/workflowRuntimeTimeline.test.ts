/**
 * H12 event-projection tests — the pure shared projection the API snapshot
 * endpoint AND the web client rebuild both run through.
 *
 *   T1  happy path: step events fold into rows with status/duration/model/
 *       evidence; run terminal detection.
 *   T2  dedupe: repeated eventIds count once (first seq wins) and are
 *       reported; out-of-order input is ordered by seq.
 *   T3  seq gaps are marked explicitly (every missing seq), not hidden.
 *   T4  awaiting_input (H10): an open step under an awaiting_input run shows
 *       awaiting_input — waiting-for-human is distinct from executing.
 *   T5  mergeWorkflowRunEvents cursor semantics: replayed frames are dropped
 *       (counted), gaps beyond the cursor are flagged, rebuild from a full
 *       refetch is idempotent.
 *   T6  unknown event types stay seq-continuous and are surfaced.
 */

import { describe, expect, it } from "vitest";
import {
  mergeWorkflowRunEvents,
  projectWorkflowRunTimeline,
  workflowRuntimeRunTimelineSchema,
  type WorkflowRuntimeRunEvent,
} from "./workflow-runtime";

const RUN_STATE = {
  runId: "wfrun_t1",
  status: "running" as const,
  lifecycleState: "running" as const,
};

function event(overrides: Partial<WorkflowRuntimeRunEvent> & { seq: number; eventId: string }): WorkflowRuntimeRunEvent {
  return {
    eventType: "step_started",
    correlationId: "wfrun_t1",
    runId: "wfrun_t1",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, overrides.seq)).toISOString(),
    payload: {},
    ...overrides,
  } as WorkflowRuntimeRunEvent;
}

describe("projectWorkflowRunTimeline (H12)", () => {
  it("T1: folds step events into rows with status, duration, model, and evidence ids", () => {
    const timeline = projectWorkflowRunTimeline(RUN_STATE, [
      event({ seq: 1, eventId: "e1", eventType: "run_started" }),
      event({
        seq: 2, eventId: "e2", stepId: "analyze", attemptNumber: 1,
        payload: { serviceRef: "deterministic-evidence.analyzer", agentId: "analyze:wfrun_t1", model: "deepseek-chat" },
      }),
      event({
        seq: 3, eventId: "e3", stepId: "analyze", eventType: "step_succeeded",
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 4)).toISOString(),
        payload: { evidenceIds: ["ev_1", "ev_2"] },
      }),
    ]);

    expect(timeline.steps).toHaveLength(1);
    const step = timeline.steps[0]!;
    expect(step.stepId).toBe("analyze");
    expect(step.state).toBe("succeeded");
    expect(step.serviceRef).toBe("deterministic-evidence.analyzer");
    expect(step.agentId).toBe("analyze:wfrun_t1");
    expect(step.model).toBe("deepseek-chat");
    expect(step.startedAt).toBeDefined();
    expect(step.finishedAt).toBeDefined();
    expect(step.durationMs).toBe(2000);
    expect(step.evidenceIds).toEqual(["ev_1", "ev_2"]);
    expect(timeline.terminal).toBe(false);
    expect(timeline.awaitingInput).toBe(false);
    // The projection validates against its own published schema.
    expect(() => workflowRuntimeRunTimelineSchema.parse(timeline)).not.toThrow();
  });

  it("T2: dedupes repeated eventIds (first seq wins, replays reported) and orders out-of-order frames", () => {
    const first = event({ seq: 2, eventId: "e2", stepId: "analyze", payload: { serviceRef: "svc" } });
    const replay = event({ seq: 9, eventId: "e2", stepId: "analyze", payload: { serviceRef: "svc" } });
    const timeline = projectWorkflowRunTimeline(RUN_STATE, [
      replay,
      event({ seq: 1, eventId: "e1" }),
      first,
    ]);

    expect(timeline.duplicateEventIds).toEqual(["e2"]);
    // Exactly one step row; the replayed (higher-seq) frame did not double it.
    expect(timeline.steps).toHaveLength(1);
    expect(timeline.steps[0]!.stepId).toBe("analyze");
    expect(timeline.seqGaps).toEqual([]);
  });

  it("T3: marks every missing seq inside a gap explicitly", () => {
    const timeline = projectWorkflowRunTimeline(RUN_STATE, [
      event({ seq: 1, eventId: "e1" }),
      event({ seq: 4, eventId: "e4", stepId: "verify", eventType: "step_succeeded" }),
    ]);
    expect(timeline.seqGaps).toEqual([2, 3]);
  });

  it("T4: an open step under an awaiting_input run reads awaiting_input, not executing", () => {
    const timeline = projectWorkflowRunTimeline(
      { ...RUN_STATE, lifecycleState: "awaiting_input" as const },
      [
        event({ seq: 1, eventId: "e1", eventType: "run_started" }),
        event({ seq: 2, eventId: "e2", stepId: "analyze" }),
      ]
    );
    expect(timeline.awaitingInput).toBe(true);
    expect(timeline.steps[0]!.state).toBe("awaiting_input");
    // A terminal run never shows awaiting_input, whatever the flag says.
    const done = projectWorkflowRunTimeline(
      { ...RUN_STATE, status: "succeeded" as const, lifecycleState: "awaiting_input" as const },
      [event({ seq: 1, eventId: "e1", eventType: "run_started" })]
    );
    expect(done.awaitingInput).toBe(true);
    expect(done.terminal).toBe(true);
  });

  it("T6: unknown event types stay seq-continuous and are surfaced, never hidden", () => {
    const timeline = projectWorkflowRunTimeline(RUN_STATE, [
      event({ seq: 1, eventId: "e1" }),
      event({ seq: 2, eventId: "e2", eventType: "custom_future_event" }),
      event({ seq: 3, eventId: "e3", stepId: "analyze" }),
    ]);
    expect(timeline.unknownEventTypes).toEqual(["custom_future_event"]);
    expect(timeline.seqGaps).toEqual([]);
    expect(timeline.steps[0]!.state).toBe("running");
  });

  it("T7: empty history projects an explicit empty timeline (not an error)", () => {
    const timeline = projectWorkflowRunTimeline(RUN_STATE, []);
    expect(timeline.steps).toEqual([]);
    expect(timeline.terminal).toBe(false);
    expect(timeline.seqGaps).toEqual([]);
    expect(() => workflowRuntimeRunTimelineSchema.parse(timeline)).not.toThrow();
  });
});

describe("mergeWorkflowRunEvents (H12 client merge)", () => {
  const base = [event({ seq: 1, eventId: "e1" }), event({ seq: 2, eventId: "e2" })];

  it("T5a: replayed frames at/below the cursor are dropped and counted", () => {
    const merged = mergeWorkflowRunEvents(base, 2, [event({ seq: 1, eventId: "e1" }), event({ seq: 2, eventId: "e2" })]);
    expect(merged.events).toHaveLength(2);
    expect(merged.duplicates).toBe(2);
    expect(merged.nextCursor).toBe(2);
    expect(merged.gapAfter).toBeUndefined();
  });

  it("T5b: a frame beyond cursor+1 is accepted AND flagged as a gap", () => {
    const merged = mergeWorkflowRunEvents(base, 2, [event({ seq: 5, eventId: "e5" })]);
    expect(merged.events).toHaveLength(3);
    expect(merged.nextCursor).toBe(5);
    expect(merged.gapAfter).toBe(2);
  });

  it("T5c: a full refetch (from 0) rebuilds the identical event set — idempotent refresh", () => {
    const withMore = [...base, event({ seq: 3, eventId: "e3" })];
    const rebuilt = mergeWorkflowRunEvents([], 0, withMore);
    expect(rebuilt.events.map((item) => item.eventId)).toEqual(["e1", "e2", "e3"]);
    expect(rebuilt.duplicates).toBe(0);
    // Refetching everything again against the rebuilt set changes nothing.
    const again = mergeWorkflowRunEvents(rebuilt.events, rebuilt.nextCursor, withMore);
    expect(again.events).toHaveLength(3);
    expect(again.duplicates).toBe(3);
    expect(again.gapAfter).toBeUndefined();
  });
});
