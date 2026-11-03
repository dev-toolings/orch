// ops: controls of the host Kiba lives on, in the spirit of Emilien's
// 50/50 checks: key-only SSH, root refused, firewall on, nothing private
// exposed, brain on localhost, fresh backups that restore, routines green,
// secrets file private. Pure checks over collected text, so tests run on
// fixtures; `collect` only reads (no root needed, hence config files rather
// than `sshd -T` and `ufw status`).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { paint, status } from "../core/color.ts";
import { envPath } from "../core/env.ts";
import { ROOT } from "../core/profile.ts";
import { everyMs, type History, nextRun, type Routine } from "../routines/routines.ts";

export interface OpsConfig { public_ports: number[]; backup_max_age_hours: number }
export interface Control { id: string; ok: boolean | null; detail: string }

export function loadOpsConfig(path = process.env.ORCH_OPS_CONFIG ?? join(ROOT, "catalog", "ops.yaml")): OpsConfig {
  const c = parse(readFileSync(path, "utf8")) as OpsConfig;
  if (!Array.isArray(c?.public_ports) || !c.public_ports.every(Number.isInteger)) throw new Error(`ops: ${path}: public_ports must list port numbers`);
  c.backup_max_age_hours ??= 26;
  return c;
}

// sshd keeps the first value it reads for a keyword; a Match block only
// applies to some connections, so reading stops there.
export function sshSettings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);
    const k = key.toLowerCase();
    if (k === "match") break;
    if (!out.has(k)) out.set(k, rest.join(" ").toLowerCase());
  }
  return out;
}

// Defaults of OpenSSH when a keyword is absent.
export function sshControls(text: string): Control[] {
  const s = sshSettings(text);
  const pw = s.get("passwordauthentication") ?? "yes";
  const kbd = s.get("kbdinteractiveauthentication") ?? s.get("challengeresponseauthentication") ?? "yes";
  const root = s.get("permitrootlogin") ?? "prohibit-password";
  return [
    { id: "ssh-key-only", ok: pw === "no" && kbd === "no", detail: `PasswordAuthentication ${pw}, KbdInteractiveAuthentication ${kbd}` },
    { id: "ssh-root-refused", ok: root === "no", detail: `PermitRootLogin ${root}` },
  ];
}

export function firewallControl(ufwConf: string | null): Control {
  if (ufwConf === null) return { id: "firewall", ok: null, detail: "no /etc/ufw/ufw.conf: firewall not checked" };
  const on = /^\s*ENABLED\s*=\s*yes\s*$/m.test(ufwConf);
  return { id: "firewall", ok: on, detail: on ? "ufw enabled" : "ufw disabled (ENABLED=no)" };
}

// Whether ufw drops what it does not allow on the host: enabled, and its
// input policy (world-readable /etc/default/ufw) is DROP or REJECT.
export function hostFiltered(ufwConf: string | null, ufwDefaults: string | null): boolean {
  return !!ufwConf && /^\s*ENABLED\s*=\s*yes\s*$/m.test(ufwConf) && /^\s*DEFAULT_INPUT_POLICY\s*=\s*"?(DROP|REJECT)"?\s*$/m.test(ufwDefaults ?? "");
}

// Host ports Docker publishes (`docker ps --format '{{.Ports}}'`): reached
// through Docker's own NAT rules, which ufw does not filter.
export function dockerPublished(ports: string): Listener[] {
  const out: Listener[] = [];
  for (const m of ports.matchAll(/(\[[^\]]+\]|[\d.]+):(\d+)(?:-\d+)?->/g)) out.push({ address: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) });
  return out;
}

export interface Listener { address: string; port: number }

// `ss -tlnH` lines: State Recv-Q Send-Q Local:Port Peer:Port
export function listeners(ss: string): Listener[] {
  return ss.split("\n").flatMap((line) => {
    const local = line.trim().split(/\s+/)[3];
    const m = local?.match(/^(.*):(\d+)$/);
    return m ? [{ address: m[1].replace(/^\[|\]$/g, "").replace(/%.*$/, ""), port: Number(m[2]) }] : [];
  });
}

const isLoopback = (a: string) => a.startsWith("127.") || a === "::1";

// What the network can reach. With ufw dropping by default, host listeners
// are filtered and only Docker-published ports count; without it, every
// listener beyond localhost does. public_ports are open on purpose.
export function exposureControl(ls: Listener[], publicPorts: number[], ctx: { filtered?: boolean; docker?: Listener[] } = {}): Control {
  const pool = ctx.filtered ? (ctx.docker ?? []) : [...ls, ...(ctx.docker ?? [])];
  const open = [...new Set(pool.filter((l) => !isLoopback(l.address) && !publicPorts.includes(l.port)).map((l) => `${l.address}:${l.port}`))];
  const where = ctx.filtered ? "published by Docker, which ufw does not filter" : "listening beyond localhost";
  return { id: "exposure", ok: open.length === 0, detail: open.length ? `${where}: ${open.join(", ")}` : `only ${publicPorts.join(", ")} reachable beyond localhost` };
}

export function brainBoundControl(ls: Listener[], port: number): Control {
  const on = ls.filter((l) => l.port === port);
  if (!on.length) return { id: "brain-localhost", ok: null, detail: `nothing listens on ${port}: brain not running` };
  const wide = on.filter((l) => !isLoopback(l.address));
  return { id: "brain-localhost", ok: wide.length === 0, detail: wide.length ? `port ${port} open on ${wide.map((l) => l.address).join(", ")}` : `port ${port} on localhost only` };
}

// A routine on a host that is not always on: due work runs at the first
// tick after start-up, so only work due for a while on a running host is a
// failure. `running` is the routine this check runs inside, if any.
export type RoutineState = "ok" | "failed" | "pending" | "overdue";
const GRACE_MS = 30 * 60_000;

export function routineState(r: Routine, h: History | undefined, now: Date, bootAt: Date | null): RoutineState {
  if (h?.last?.deferred) return "pending";
  if (h?.last && !h.last.ok) return "failed";
  const due = nextRun(r, h, now);
  if (due > now || (!!h?.lastOk && now.getTime() - Date.parse(h.lastOk.end) < everyMs(r))) return "ok";
  // due now: since when, counting only time the host was up
  const dueAt = h?.lastOk ? Date.parse(h.lastOk.end) + everyMs(r) : (bootAt?.getTime() ?? now.getTime());
  const since = Math.max(dueAt, bootAt?.getTime() ?? dueAt);
  return now.getTime() - since > GRACE_MS ? "overdue" : "pending";
}

export function backupControl(latest: { path: string; mtime: Date } | null, maxAgeHours: number, now: Date, backup: RoutineState = "overdue"): Control {
  const pending = backup === "pending";
  if (!latest) return { id: "backup-fresh", ok: pending ? null : false, detail: pending ? "no brain backup yet: brain-backup is due and runs at the next tick" : "no brain backup yet" };
  const hours = (now.getTime() - latest.mtime.getTime()) / 3_600_000;
  if (hours <= maxAgeHours) return { id: "backup-fresh", ok: true, detail: `newest backup ${hours.toFixed(1)} h old (max ${maxAgeHours} h)` };
  return { id: "backup-fresh", ok: pending ? null : false, detail: `newest backup ${hours.toFixed(1)} h old (max ${maxAgeHours} h)${pending ? ": host was off, brain-backup runs at the next tick" : ""}` };
}

export function restoreControl(h: History | undefined, backup: RoutineState = "overdue"): Control {
  const last = h?.last;
  if (!last) return { id: "backup-restores", ok: backup === "pending" ? null : false, detail: "brain-backup never ran" };
  if (last.deferred) return { id: "backup-restores", ok: null, detail: `brain-backup deferred: ${last.deferred} (${last.end.slice(0, 16)})` };
  const check = last.steps.find((s) => s.command.endsWith("restore-check"));
  return { id: "backup-restores", ok: !!check && check.exit === 0, detail: check ? `restore-check ${check.exit === 0 ? "passed" : "failed"} on ${last.end.slice(0, 16)}` : `last brain-backup stopped before its restore check (${last.end.slice(0, 16)})` };
}

export function routinesControl(routines: Routine[], hist: Map<string, History>, now: Date, bootAt: Date | null, running?: string): Control {
  const states = routines.filter((r) => r.enabled && r.id !== running).map((r) => ({ r, s: routineState(r, hist.get(r.id), now, bootAt) }));
  const bad = states.filter((x) => x.s === "failed" || x.s === "overdue").map((x) => `${x.r.id} ${x.s === "failed" ? "failed" : "overdue (is orch-routines.timer active?)"}`);
  const pending = states.filter((x) => x.s === "pending").map((x) => x.r.id);
  if (bad.length) return { id: "routines", ok: false, detail: [...bad, ...(pending.length ? [`pending: ${pending.join(", ")}`] : [])].join(", ") };
  if (pending.length) return { id: "routines", ok: null, detail: `due, run at the next tick: ${pending.join(", ")}` };
  return { id: "routines", ok: true, detail: `${states.length} enabled routines green` };
}

export function envFileControl(mode: number | null): Control {
  if (mode === null) return { id: "env-private", ok: false, detail: "no .env" };
  return { id: "env-private", ok: (mode & 0o077) === 0, detail: `.env mode ${(mode & 0o777).toString(8)}` };
}

// Reads the host. Missing sources come back as null, never as a pass.
export function collect(): { ssh: string; ufw: string | null; ufwDefaults: string | null; ss: string; docker: string; envMode: number | null; bootAt: Date | null } {
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const main = read("/etc/ssh/sshd_config") ?? "";
  // Include lines are expanded where they stand, as sshd does.
  const ssh = main.split("\n").map((line) => {
    const m = line.match(/^\s*Include\s+(\S+)/i);
    if (!m) return line;
    const dir = dirname(m[1]);
    const re = new RegExp(`^${m[1].slice(dir.length + 1).replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
    return existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => read(join(dir, f)) ?? "").join("\n") : "";
  }).join("\n");
  const ss = spawnSync("ss", ["-tlnH"], { encoding: "utf8" }).stdout ?? "";
  const docker = spawnSync("docker", ["ps", "--format", "{{.Ports}}"], { encoding: "utf8" }).stdout ?? "";
  const uptime = Number((read("/proc/uptime") ?? "").split(" ")[0]);
  const env = envPath();
  return {
    ssh, ufw: read("/etc/ufw/ufw.conf"), ufwDefaults: read("/etc/default/ufw"), ss, docker,
    envMode: existsSync(env) ? statSync(env).mode : null,
    bootAt: uptime > 0 ? new Date(Date.now() - uptime * 1000) : null,
  };
}

// A failed control in the operator's words, with the fix: what a routine
// alert shows instead of the raw line.
export function explain(c: Control): string {
  const d = c.detail;
  switch (c.id) {
    case "ssh-key-only": return "SSH accepte encore les mots de passe. À faire : `PasswordAuthentication no` et `KbdInteractiveAuthentication no` dans sshd_config.";
    case "ssh-root-refused": return "SSH accepte les connexions root. À faire : `PermitRootLogin no` dans sshd_config.";
    case "firewall": return "Le pare-feu est désactivé. À faire : `sudo ufw enable`.";
    case "exposure": return `Des ports sont ouverts sur le réseau : ${d.split(": ").at(-1)}${d.includes("Docker") ? " (publiés par Docker, que ufw ne filtre pas)" : ""}. À faire : les lier à 127.0.0.1 ou les fermer.`;
    case "brain-localhost": {
      const m = /^port (\d+) open on (.+)$/.exec(d);
      return `La base mémoire${m ? ` (port ${m[1]})` : ""} est joignable hors de la machine${m ? ` sur ${m[2]}` : ""}. À faire : la lier à 127.0.0.1 dans infra/compose.yml.`;
    }
    case "backup-fresh": {
      const m = /newest backup ([\d.]+) h old \(max (\d+) h\)/.exec(d);
      return `${m ? `La dernière sauvegarde de la mémoire date de ${Math.round(Number(m[1]))} h (maximum ${m[2]} h)` : "Aucune sauvegarde de la mémoire"}. À faire : \`orch routine run brain-backup\`.`;
    }
    case "backup-restores": return "La dernière sauvegarde de la mémoire n'a pas été vérifiée par une restauration. À faire : `orch routine run brain-backup`, puis `orch routine journal`.";
    case "routines": return `Routines en échec ou en retard : ${d.split(", ").filter((x) => /failed|overdue/.test(x)).map((x) => x.split(" ")[0]).join(", ")}. À faire : \`orch routine status\`.`;
    case "env-private": return d === "no .env" ? "Le fichier .env est introuvable." : `Le fichier .env est lisible par d'autres comptes (${d.replace(".env ", "")}). À faire : \`chmod 600 .env\`.`;
    default: return `${c.id} : ${d}`;
  }
}

export function formatControls(cs: Control[], color = false): string[] {
  return cs.map((c) => `${status(c.ok, color)} ${paint(c.id.padEnd(16), "bold", color)} ${c.detail}`);
}
