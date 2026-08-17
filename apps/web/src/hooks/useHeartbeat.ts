import { useEffect, useState } from "react";
import type { HeartbeatPulse } from "@consistency/schema";
import { api } from "../api/client";
import { appendHeartbeatHistory, startHeartbeatConnection } from "./heartbeatConnection";

export function useHeartbeat() {
  const [pulse, setPulse] = useState<HeartbeatPulse | null>(null);
  const [history, setHistory] = useState<HeartbeatPulse[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    const connection = startHeartbeatConnection(api, {
      onPulse: nextPulse => {
        setPulse(nextPulse);
        setHistory(previous => appendHeartbeatHistory(previous, nextPulse));
      },
      onUnavailable: setUnavailable,
      onReconnecting: setReconnecting
    });
    return () => {
      connection.stop();
    };
  }, []);

  return { pulse, history, unavailable, reconnecting };
}
