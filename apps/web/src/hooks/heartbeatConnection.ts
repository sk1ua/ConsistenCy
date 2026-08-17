import type { HeartbeatPulse, HeartbeatStreamEvent } from "@consistency/schema";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type HeartbeatClient = {
  heartbeat: () => Promise<HeartbeatPulse | null>;
  heartbeatStream: (signal?: AbortSignal) => AsyncIterable<HeartbeatStreamEvent>;
};

export type HeartbeatConnectionEnvironment = {
  isOnline: () => boolean;
  isVisible: () => boolean;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
  onOnline: (callback: () => void) => () => void;
  onOffline: (callback: () => void) => () => void;
  onVisibilityChange: (callback: () => void) => () => void;
};

type HeartbeatConnectionCallbacks = {
  onPulse: (pulse: HeartbeatPulse) => void;
  onUnavailable: (unavailable: boolean) => void;
  onReconnecting: (reconnecting: boolean) => void;
};

export function heartbeatReconnectDelay(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(30, Math.floor(attempt)));
  return Math.min(INITIAL_RECONNECT_DELAY_MS * (2 ** safeAttempt), MAX_RECONNECT_DELAY_MS);
}

export function appendHeartbeatHistory(
  history: readonly HeartbeatPulse[],
  pulse: HeartbeatPulse,
  limit = 40
): HeartbeatPulse[] {
  if (limit <= 0) return [];
  const previous = history.at(-1);
  if (previous?.pulseId === pulse.pulseId) return [...history.slice(-limit, -1), pulse];
  return [...history.slice(-(limit - 1)), pulse];
}

export function browserHeartbeatEnvironment(): HeartbeatConnectionEnvironment {
  return {
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: timer => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
    onOnline: callback => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener("online", callback);
      return () => window.removeEventListener("online", callback);
    },
    onOffline: callback => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener("offline", callback);
      return () => window.removeEventListener("offline", callback);
    },
    onVisibilityChange: callback => {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    }
  };
}

/**
 * Maintains one current SSE cycle. Failed streams reconnect with capped
 * exponential backoff; hidden and offline windows pause work, then wake
 * immediately when they become useful again.
 */
export function startHeartbeatConnection(
  client: HeartbeatClient,
  callbacks: HeartbeatConnectionCallbacks,
  environment: HeartbeatConnectionEnvironment = browserHeartbeatEnvironment()
): { stop: () => void } {
  let stopped = false;
  let retryAttempt = 0;
  let retryTimer: unknown;
  let cycleSequence = 0;
  let activeCycle: number | undefined;
  let activeController: AbortController | undefined;

  const ready = () => environment.isOnline() && environment.isVisible();

  function clearRetry(): void {
    if (retryTimer === undefined) return;
    environment.clearTimer(retryTimer);
    retryTimer = undefined;
  }

  function suspendActiveCycle(): void {
    activeCycle = undefined;
    activeController?.abort();
    activeController = undefined;
    clearRetry();
  }

  function scheduleRetry(delayMs: number): void {
    clearRetry();
    if (stopped || !ready()) return;
    retryTimer = environment.setTimer(() => {
      retryTimer = undefined;
      void connect();
    }, delayMs);
  }

  async function connect(): Promise<void> {
    if (stopped || activeCycle !== undefined || !ready()) return;

    const cycle = ++cycleSequence;
    const controller = new AbortController();
    activeCycle = cycle;
    activeController = controller;

    const isCurrent = () => !stopped && activeCycle === cycle && !controller.signal.aborted;
    try {
      const current = await client.heartbeat();
      if (!isCurrent()) return;
      if (current) callbacks.onPulse(current);
      callbacks.onUnavailable(false);
      callbacks.onReconnecting(false);

      for await (const event of client.heartbeatStream(controller.signal)) {
        if (!isCurrent()) return;
        if (event.event === "error") throw new Error(event.message);
        retryAttempt = 0;
        if (event.event === "pulse") callbacks.onPulse(event.pulse);
      }

      if (isCurrent()) throw new Error("Heartbeat stream ended unexpectedly.");
    } catch {
      if (!isCurrent()) return;
      callbacks.onUnavailable(true);
      callbacks.onReconnecting(true);
      const delayMs = heartbeatReconnectDelay(retryAttempt);
      retryAttempt = Math.min(retryAttempt + 1, 30);
      scheduleRetry(delayMs);
    } finally {
      if (activeCycle === cycle) {
        activeCycle = undefined;
        activeController = undefined;
      }
    }
  }

  const removeOnlineListener = environment.onOnline(() => {
    if (stopped || !environment.isVisible()) return;
    retryAttempt = 0;
    suspendActiveCycle();
    callbacks.onReconnecting(true);
    void connect();
  });
  const removeOfflineListener = environment.onOffline(() => {
    if (stopped) return;
    suspendActiveCycle();
    callbacks.onUnavailable(true);
    callbacks.onReconnecting(true);
  });
  const removeVisibilityListener = environment.onVisibilityChange(() => {
    if (stopped) return;
    if (!environment.isVisible()) {
      suspendActiveCycle();
      return;
    }
    if (!environment.isOnline()) return;
    retryAttempt = 0;
    suspendActiveCycle();
    callbacks.onReconnecting(true);
    void connect();
  });

  if (!environment.isOnline()) {
    callbacks.onUnavailable(true);
    callbacks.onReconnecting(true);
  } else if (environment.isVisible()) {
    void connect();
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      suspendActiveCycle();
      removeOnlineListener();
      removeOfflineListener();
      removeVisibilityListener();
    }
  };
}
