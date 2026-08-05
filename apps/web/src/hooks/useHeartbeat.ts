import { useEffect, useState } from "react";
import type { HeartbeatPulse } from "@consistency/schema";
import { api } from "../api/client";

const HISTORY_LIMIT = 40;

export function useHeartbeat() {
  const [pulse, setPulse] = useState<HeartbeatPulse | null>(null);
  const [history, setHistory] = useState<HeartbeatPulse[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function run() {
      try {
        const current = await api.heartbeat();
        if (cancelled) return;
        if (current) {
          setPulse(current);
          setHistory([current]);
        }
        for await (const event of api.heartbeatStream(controller.signal)) {
          if (cancelled) return;
          if (event.event === "pulse") {
            setPulse(event.pulse);
            setHistory(previous => [...previous.slice(-(HISTORY_LIMIT - 1)), event.pulse]);
          }
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setUnavailable(true);
      }
    }

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return { pulse, history, unavailable };
}
