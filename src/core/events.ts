// Control-plane events (spend alerts, kill). Global, under the state dir.
// Shown by `orch log` and `orch top`. Fail-open: a bad write never throws.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.ts";

export type EventKind = "warn" | "info";

export interface ControlEvent {
  at: string;
  kind: EventKind;
  text: string;
  source: string;
}

export const eventsPath = (state = stateDir()) => join(state, "events.jsonl");

export function readEvents(state = stateDir()): ControlEvent[] {
  const path = eventsPath(state);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line) as Partial<ControlEvent>;
      if (!row || typeof row.text !== "string" || (row.kind !== "warn" && row.kind !== "info")) return [];
      return [{
        at: typeof row.at === "string" ? row.at : "",
        kind: row.kind,
        text: row.text,
        source: typeof row.source === "string" ? row.source : "",
      }];
    } catch {
      return [];
    }
  });
}

export function appendEvent(event: Omit<ControlEvent, "at"> & { at?: string }, state = stateDir()): ControlEvent | null {
  const row: ControlEvent = {
    at: event.at ?? new Date().toISOString(),
    kind: event.kind,
    text: event.text.replace(/[\r\n\t]+/g, " ").trim().slice(0, 400),
    source: event.source,
  };
  if (!row.text) return null;
  try {
    mkdirSync(state, { recursive: true });
    appendFileSync(eventsPath(state), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return row;
  } catch {
    return null;
  }
}

export function formatEvents(events: ControlEvent[], cap = 12): string {
  const kept = events.slice(-cap);
  if (!kept.length) return "";
  return `ALERTS:\n${kept.map((e) => {
    const stamp = e.at.length >= 16 ? e.at.slice(11, 16) : e.at;
    return `- ${stamp} ${e.text}`;
  }).join("\n")}`;
}
