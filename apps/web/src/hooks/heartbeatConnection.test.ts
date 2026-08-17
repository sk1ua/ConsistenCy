import type { HeartbeatPulse, HeartbeatStreamEvent } from "@consistency/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendHeartbeatHistory,
  heartbeatReconnectDelay,
  startHeartbeatConnection,
  type HeartbeatConnectionEnvironment
} from "./heartbeatConnection";

const pulse = (pulseId: string): HeartbeatPulse => ({
  pulseId,
  state: "idle",
  repository: { root: "D:/repo", provider: "local_git" },
  observedAt: "2026-08-14T00:00:00.000Z",
  dirtyFileCount: 0,
  pendingEvents: 0
});

function controlledEnvironment(initial: { online?: boolean; visible?: boolean } = {}) {
  let online = initial.online ?? true;
  let visible = initial.visible ?? true;
  const onlineListeners = new Set<() => void>();
  const offlineListeners = new Set<() => void>();
  const visibilityListeners = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>, callback: () => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  const environment: HeartbeatConnectionEnvironment = {
    isOnline: () => online,
    isVisible: () => visible,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onOnline: callback => subscribe(onlineListeners, callback),
    onOffline: callback => subscribe(offlineListeners, callback),
    onVisibilityChange: callback => subscribe(visibilityListeners, callback)
  };
  return {
    environment,
    setOnline(next: boolean) {
      online = next;
      for (const listener of next ? onlineListeners : offlineListeners) listener();
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of visibilityListeners) listener();
    }
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("heartbeat connection", () => {
  it("caps exponential reconnect delays", () => {
    expect(heartbeatReconnectDelay(0)).toBe(1_000);
    expect(heartbeatReconnectDelay(1)).toBe(2_000);
    expect(heartbeatReconnectDelay(20)).toBe(30_000);
  });

  it("deduplicates snapshots and bounds history", () => {
    const first = pulse("pulse-1");
    const replacement = { ...first, dirtyFileCount: 2 };
    const second = pulse("pulse-2");

    expect(appendHeartbeatHistory([first], replacement, 2)).toEqual([replacement]);
    expect(appendHeartbeatHistory([first, replacement], second, 2)).toEqual([replacement, second]);
  });

  it("reconnects failed streams with exponential backoff", async () => {
    vi.useFakeTimers();
    const controlled = controlledEnvironment();
    let streamAttempts = 0;
    async function* failedStream(): AsyncGenerator<HeartbeatStreamEvent> {
      streamAttempts += 1;
      throw new Error("stream failed");
    }
    const client = {
      heartbeat: vi.fn(async () => pulse("snapshot")),
      heartbeatStream: vi.fn(() => failedStream())
    };
    const unavailable: boolean[] = [];
    const reconnecting: boolean[] = [];
    const connection = startHeartbeatConnection(client, {
      onPulse: () => undefined,
      onUnavailable: value => unavailable.push(value),
      onReconnecting: value => reconnecting.push(value)
    }, controlled.environment);

    await flushPromises();
    expect(streamAttempts).toBe(1);
    expect(unavailable.at(-1)).toBe(true);
    expect(reconnecting.at(-1)).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(streamAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(streamAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(streamAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(streamAttempts).toBe(3);
    connection.stop();
  });

  it("pauses while hidden or offline and reconnects immediately on recovery", async () => {
    const controlled = controlledEnvironment({ visible: false });
    async function* waitForAbort(signal?: AbortSignal): AsyncGenerator<HeartbeatStreamEvent> {
      if (signal?.aborted) return;
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    }
    const client = {
      heartbeat: vi.fn(async () => pulse("snapshot")),
      heartbeatStream: vi.fn((signal?: AbortSignal) => waitForAbort(signal))
    };
    const unavailable: boolean[] = [];
    const connection = startHeartbeatConnection(client, {
      onPulse: () => undefined,
      onUnavailable: value => unavailable.push(value),
      onReconnecting: () => undefined
    }, controlled.environment);

    await flushPromises();
    expect(client.heartbeat).not.toHaveBeenCalled();

    controlled.setVisible(true);
    await flushPromises();
    expect(client.heartbeat).toHaveBeenCalledTimes(1);

    controlled.setOnline(false);
    await flushPromises();
    expect(unavailable.at(-1)).toBe(true);
    controlled.setOnline(true);
    await flushPromises();
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    expect(unavailable.at(-1)).toBe(false);
    connection.stop();
  });
});
