import { useEffect, useState } from "react";
import type { DashSnapshot } from "./types";

export type ApiState =
  | { status: "loading"; stream: StreamState }
  | { status: "ok"; snap: DashSnapshot; stream: StreamState }
  | { status: "error"; message: string; stream: StreamState };

export type StreamStatus = "live" | "reconnecting" | "offline";

export interface StreamState {
  status: StreamStatus;
  lastEventAt: string | null;
}

const DEFAULT_STREAM: StreamState = { status: "offline", lastEventAt: null };

function readSnapshot(data: unknown): DashSnapshot {
  if (!data || typeof data !== "object") throw new Error("Réponse inattendue");
  return data as DashSnapshot;
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<DashSnapshot> {
  const res = await fetch("/api/snapshot", { signal });
  if (!res.ok) throw new Error(`Le tableau n'est pas joignable (${res.status}).`);
  return readSnapshot(await res.json());
}

export function useSnapshot(pollMs = 2000): ApiState {
  const [state, setState] = useState<ApiState>({ status: "loading", stream: DEFAULT_STREAM });

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;

    const setStream = (next: Partial<StreamState>) => {
      setState((prev) => ({ ...prev, stream: { ...prev.stream, ...next } }));
    };

    const apply = (snap: DashSnapshot) => {
      if (cancelled) return;
      setState((prev) => ({ status: "ok", snap, stream: { ...prev.stream, lastEventAt: snap.at } }));
    };
    const fail = (err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : "Le tableau n'est pas joignable.";
      setState((prev) => (prev.status === "ok" ? prev : { status: "error", message, stream: prev.stream }));
    };

    const ac = new AbortController();
    fetchSnapshot(ac.signal).then(apply).catch(fail);

    try {
      setStream({ status: "reconnecting" });
      source = new EventSource("/api/stream");
      source.onopen = () => setStream({ status: "live" });
      source.onmessage = (ev) => {
        try {
          apply(JSON.parse(ev.data) as DashSnapshot);
          setStream({ status: "live" });
        } catch { /* keep last */ }
      };
      source.onerror = () => {
        if (!source) return;
        setStream({ status: source.readyState === EventSource.CLOSED ? "offline" : "reconnecting" });
      };
    } catch {
      setStream({ status: "offline" });
    }

    const timer = window.setInterval(() => {
      if (source && source.readyState === EventSource.OPEN) return;
      if (source && source.readyState === EventSource.CONNECTING) setStream({ status: "reconnecting" });
      fetchSnapshot().then(apply).catch(fail);
    }, pollMs);

    return () => {
      cancelled = true;
      ac.abort();
      source?.close();
      window.clearInterval(timer);
    };
  }, [pollMs]);

  return state;
}
