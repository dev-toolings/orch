// Notification channels (catalog/presence.yaml `notify:`), read by orch serve,
// the routines, improve and reflect. The persistent presence lead (a tmux
// session running `kiba --conductor`) is retired: the always-on conductor is
// `orch serve`, under its own opt-in unit orch-serve.service.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "../core/profile.ts";
import { secretEnv } from "../core/env.ts";
import { type Channel, CHANNELS, missingKeys } from "./notify.ts";

export interface PresenceConfig { notify: Channel[] }

// Older files also carry session, workdir, remote_control, crash_loop and
// restart_delay_seconds: accepted and ignored.
export function loadPresenceConfig(path = process.env.ORCH_PRESENCE_CONFIG ?? join(ROOT, "catalog", "presence.yaml")): PresenceConfig {
  const c = (parse(readFileSync(path, "utf8")) ?? {}) as { notify?: unknown };
  // none, one channel or a list of them
  const raw = c.notify ?? "none";
  const list = raw === "none" ? [] : Array.isArray(raw) ? raw : [raw];
  for (const ch of list) if (!CHANNELS.includes(ch)) throw new Error(`presence: ${path}: notify: none, or any of ${CHANNELS.join(", ")} (not ${String(ch)})`);
  return { notify: [...new Set(list as Channel[])] };
}

// The retired presence unit: `orch doctor` reports a leftover install.
export const PRESENCE_UNIT = "orch-kiba.service";

export const PRESENCE_REPLACED = "presence: the persistent Kiba lead is retired; orch serve replaced it (opt-in unit orch-serve.service: systemctl --user enable --now orch-serve.service, or orch serve in a terminal)";

export function notifyLine(channels: Channel[], env: Record<string, string | undefined> = secretEnv()): string {
  if (!channels.length) return "none";
  return channels.map((ch) => {
    const missing = missingKeys(ch, env);
    return missing.length ? `${ch} (missing ${missing.join(", ")})` : ch;
  }).join(", ");
}
