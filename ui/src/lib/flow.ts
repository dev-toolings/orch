import { useEffect, useState } from "react";
import type { FlowState } from "../types";
import type { StreamStatus } from "../api";

/** /api/flow: the architecture view, re-sent only when a setting or a counter changed. */
export function useFlow(): { state: FlowState | null; status: StreamStatus } {
  const [state, setState] = useState<FlowState | null>(null);
  const [status, setStatus] = useState<StreamStatus>("reconnecting");
  useEffect(() => {
    const source = new EventSource("/api/flow");
    source.onopen = () => setStatus("live");
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
    source.addEventListener("state", (ev) => {
      try { setState(JSON.parse((ev as MessageEvent).data) as FlowState); setStatus("live"); } catch { /* keep last */ }
    });
    return () => source.close();
  }, []);
  return { state, status };
}
