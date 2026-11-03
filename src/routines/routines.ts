// routines: work that runs whenever the host is up, not at fixed hours (the
// host is not always on). A tick (orch-routines.timer: after start-up, then
// every 15 minutes) runs each enabled routine that is due, in catalog order:
// last success started `every` ago, last failure ended `retry` ago. One
// routine at a time under a kernel flock, each command under a timeout,
// the first failing command stopping the routine. Every run is one line of
// the journal; alerts are sent on the first failure, at most daily while it
// lasts, and on recovery.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { tail } from "../core/output.ts";
import { stateDir } from "../core/paths.ts";
import { assertSpendAllowed, isPaidRoutine, loadPolicy, pauseReason, type ControlPolicy } from "../core/policy.ts";
import { ROOT } from "../core/profile.ts";
import { tryLock } from "../lanes/lock.ts";
import { type Notice, when } from "../presence/notify.ts";

export interface Routine {
  id: string;
  description: string;
  every: string;
  retry?: string;
  commands: string[][];
  timeout_minutes: number;
  enabled: boolean;
}

export interface Step { command: string; exit: number | null; timed_out: boolean; ms: number; tail: string }
// waited_ms: time spent waiting for another routine to release the lock.
export interface Entry { id: string; start: string; end: string; ok: boolean; waited_ms?: number; skipped?: string; deferred?: string; steps: Step[] }

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
export const DEFER_LIMIT_MS = 2 * UNITS.h;

export function parseDuration(s: string): number {
  const m = /^(\d+)\s*(m|h|d)$/.exec(String(s ?? "").trim());
  if (!m || Number(m[1]) <= 0) throw new Error(`duration "${s}": a positive number then m, h or d (15m, 2h, 1d)`);
  return Number(m[1]) * UNITS[m[2]];
}

export const everyMs = (r: Routine) => parseDuration(r.every);
export const retryMs = (r: Routine) => (r.retry ? parseDuration(r.retry) : Math.min(everyMs(r), UNITS.h));

export function loadRoutines(path = process.env.ORCH_ROUTINES_CONFIG ?? join(ROOT, "catalog", "routines.yaml")): Routine[] {
  const doc = parse(readFileSync(path, "utf8")) as { routines?: Routine[] };
  const fail = (msg: string): never => { throw new Error(`routines: ${path}: ${msg}`); };
  const list = doc?.routines ?? fail("routines: list required");
  const seen = new Set<string>();
  for (const r of list) {
    if (!/^[a-z][a-z0-9-]*$/.test(r.id ?? "")) fail(`id ${r.id}: lowercase letters, digits and - only`);
    if (seen.has(r.id)) fail(`id ${r.id} declared twice`);
    seen.add(r.id);
    if ("schedule" in r) fail(`${r.id}: schedule is gone, routines run when due: use every (15m, 1d...)`);
    try { everyMs(r); if (r.retry) parseDuration(r.retry); } catch (e) { fail(`${r.id}: ${(e as Error).message}`); }
    if (!Array.isArray(r.commands) || !r.commands.length || !r.commands.every((c) => Array.isArray(c) && c.length && c.every((a) => typeof a === "string"))) {
      fail(`${r.id}: commands must be a list of argv lists`);
    }
    if (!(r.timeout_minutes > 0)) fail(`${r.id}: timeout_minutes must be positive`);
    // YAML reads `yes` as a string: anything but true or false is refused, not taken as off.
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") fail(`${r.id}: enabled must be true or false`);
    r.enabled ??= false;
    r.description ??= "";
  }
  return list;
}

export const routinesDir = (state = stateDir()) => join(state, "routines");
export const journalPath = (state = stateDir()) => join(routinesDir(state), "journal.jsonl");
const alertsPath = (state: string) => join(routinesDir(state), "alerts.json");
const lockPath = (state: string) => join(routinesDir(state), "lock");

// The returned release closes only our descriptor; the inode is never removed.
export async function acquire(lock: string, waitMs: number, sleep = (ms: number) => Bun.sleep(ms)): Promise<(() => void) | null> {
  mkdirSync(join(lock, ".."), { recursive: true });
  const fd = openSync(lock, "a", 0o600);
  const deadline = Date.now() + waitMs;
  let held = false;
  try {
    while (!tryLock(fd)) {
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(1000, deadline - Date.now()));
    }
    held = true;
    return () => { if (held) { held = false; closeSync(fd); } };
  } finally {
    if (!held) closeSync(fd);
  }
}

// `orch` and `lane` mean this checkout, so a routine never depends on what PATH finds.
export const resolveArgv = (argv: string[]) => (argv[0] === "orch" || argv[0] === "lane"
  ? [process.execPath, "--no-env-file", join(ROOT, "src", `${argv[0]}.ts`), ...argv.slice(1)]
  : argv);

interface ExecResult { exit: number | null; timedOut: boolean; output: string }
export type Exec = (argv: string[], timeoutMs: number, env: NodeJS.ProcessEnv) => ExecResult | Promise<ExecResult>;

const TERM_GRACE_MS = 500;
const execDefault: Exec = (argv, timeoutMs, env) => new Promise((resolve) => {
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  let timedOut = false;
  let closed = false;
  let killed = false;
  let exit: number | null = null;
  const collect = (chunk: string) => { output = (output + chunk).slice(-(16 << 20)); };
  child.stdout.setEncoding("utf8").on("data", collect);
  child.stderr.setEncoding("utf8").on("data", collect);
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    }
  };
  const finish = () => {
    if (!closed || (timedOut && !killed)) return;
    clearTimeout(timer);
    resolve({ exit, timedOut, output });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    // Keep this timer even if the leader exits or closes its output first.
    setTimeout(() => {
      kill("SIGKILL");
      killed = true;
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    }, TERM_GRACE_MS);
  }, timeoutMs);
  child.on("error", (e) => { collect(e.message); });
  child.on("close", (code) => { exit = code; closed = true; finish(); });
});

export interface RunOpts {
  state?: string;
  exec?: Exec;
  waitMs?: number;
  now?: () => Date;
  notify?: (notice: Notice) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  locked?: boolean; // the caller (a tick) already holds the lock
  policy?: ControlPolicy;
}

// Journal past this size keeps its newest lines only.
const JOURNAL_MAX_BYTES = 2 << 20;
const JOURNAL_KEEP_LINES = 5000;

function append(state: string, entry: Entry) {
  mkdirSync(routinesDir(state), { recursive: true });
  const path = journalPath(state);
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  if (statSync(path).size > JOURNAL_MAX_BYTES) {
    const kept = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-JOURNAL_KEEP_LINES);
    writeFileSync(`${path}.tmp`, `${kept.join("\n")}\n`);
    renameSync(`${path}.tmp`, path);
  }
}

interface Alert { failing_since: string; notified_at: string }
const DAY = UNITS.d;

// The lines that say what broke: FAIL and error lines, then the closing
// summary line; the plain tail when none stands out. A bare tail hid the one
// FAIL of `orch ops check` behind its `ok` lines.
export function failingLines(output: string, max = 10): string {
  const lines = output.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const bad = lines.filter((l) => /^\s*(FAIL|ERROR|FATAL)\b|\berror:/i.test(l));
  if (!bad.length) return tail(output, 8);
  const last = lines.at(-1)!;
  return [...bad.slice(0, max), ...(bad.includes(last) ? [] : [last])].join("\n");
}

// How long, in words the operator reads: 40 min, 7 h, 3 jours.
const lasted = (ms: number) => {
  const h = Math.round(ms / UNITS.h);
  return h < 1 ? `${Math.max(1, Math.round(ms / UNITS.m))} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} jours`;
};

// A command may explain its own result to the operator, in their words:
// `ALERT-TITLE: <outcome>` and one `ALERT: <problem and fix>` per problem on
// failure, `ALERT-OK: <outcome>` on success (`orch ops check` does, when
// ORCH_ROUTINE is set). Without them the alert falls back to the command,
// its exit and its failing lines.
export function explained(output: string): { title?: string; items: string[]; ok?: string } {
  const pick = (tag: string) => output.split("\n").filter((l) => l.startsWith(`${tag}: `)).map((l) => l.slice(tag.length + 2).trim());
  return { title: pick("ALERT-TITLE")[0], items: pick("ALERT"), ok: pick("ALERT-OK")[0] };
}

// What to tell the operator after a run, given the routine's alert record:
// first failure, daily reminder, or recovery; nothing otherwise.
export function alertFor(r: Routine, e: Entry, prev: Alert | undefined, now: Date): { notice?: Notice; next?: Alert } {
  if (e.deferred) return prev ? { next: prev } : {};
  if (e.ok) {
    if (!prev) return {};
    const down = Date.parse(e.end) - Date.parse(prev.failing_since);
    const ok = explained(e.steps.at(-1)?.tail ?? "").ok;
    return { notice: { title: ok ?? `${r.id} fonctionne de nouveau`, level: "ok", text: `Réglé après ${lasted(down)} de problème, depuis le ${when(Date.parse(prev.failing_since))}.` } };
  }
  const bad = e.steps.at(-1);
  const own = explained(bad?.tail ?? "");
  const what = e.skipped ? "La routine n'a pas tourné : une autre tenait encore le verrou."
    : own.items.length ? own.items.map((i) => `- ${i}`).join("\n")
    : bad?.timed_out ? `La commande \`${bad.command}\` a dépassé son délai de ${r.timeout_minutes} min.`
    : `La commande \`${bad?.command}\` a échoué (code ${bad?.exit}).`;
  const subject = own.title ?? `${r.id} a échoué`;
  const notice = (title: string): Notice => ({
    title, level: "fail", text: what,
    log: e.skipped || own.items.length ? undefined : failingLines(bad?.tail ?? "") || undefined,
    note: `Nouvel essai ${when(Date.parse(e.end) + retryMs(r), "R")}.${bad && own.items.length ? ` Détail : \`${bad.command}\`` : ""}`,
  });
  if (!prev) return { notice: notice(subject), next: { failing_since: e.end, notified_at: now.toISOString() } };
  if (now.getTime() - Date.parse(prev.notified_at) >= DAY) {
    return { notice: notice(`${subject}, depuis ${lasted(now.getTime() - Date.parse(prev.failing_since))}`), next: { ...prev, notified_at: now.toISOString() } };
  }
  return { next: prev };
}

async function report(r: Routine, e: Entry, state: string, now: Date, notify?: (notice: Notice) => Promise<unknown>) {
  const path = alertsPath(state);
  const alerts = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, Alert>) : {};
  const { notice, next } = alertFor(r, e, alerts[r.id], now);
  if (next) alerts[r.id] = next;
  else delete alerts[r.id];
  writeFileSync(`${path}.tmp`, `${JSON.stringify(alerts, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  if (notice && notify) await notify(notice).catch((err) => console.error((err as Error).message));
}

export async function runRoutine(r: Routine, o: RunOpts = {}): Promise<Entry> {
  const state = o.state ?? stateDir();
  const now = o.now ?? (() => new Date());
  const lock = lockPath(state);
  const start = now().toISOString();
  const entry: Entry = { id: r.id, start, end: start, ok: true, steps: [] };
  const t0 = Date.now();
  const release = o.locked ? () => {} : await acquire(lock, o.waitMs ?? 30 * 60_000, o.sleep);
  entry.waited_ms = Date.now() - t0;
  if (!release) {
    entry.ok = false;
    entry.skipped = "another routine kept the lock";
    entry.end = now().toISOString();
    // Still one journal line and an alert: a lock held for too long is news.
    append(state, entry);
    await report(r, entry, state, now(), o.notify);
    return entry;
  }
  try {
    const paused = pauseReason(process.env, state);
    if (paused) {
      entry.ok = true;
      entry.skipped = `paused: ${paused}`;
      entry.end = now().toISOString();
      append(state, entry);
      return entry;
    }
    if (isPaidRoutine(r.id, o.policy ?? loadPolicy())) {
      try { assertSpendAllowed({ state, label: `routine ${r.id}`, watched: true, policy: o.policy }); }
      catch (error) {
        entry.ok = true;
        entry.skipped = (error as Error).message;
        entry.end = now().toISOString();
        append(state, entry);
        return entry;
      }
    }
    for (const argv of r.commands) {
      const t1 = Date.now();
      // ORCH_ROUTINE tells a command which routine runs it (ops check skips its own).
      const res = await (o.exec ?? execDefault)(resolveArgv(argv), r.timeout_minutes * 60_000, { ...process.env, ORCH_ROUTINE: r.id });
      const step: Step = { command: argv.join(" "), exit: res.exit, timed_out: res.timedOut, ms: Date.now() - t1, tail: tail(res.output, 12).slice(-1500) };
      entry.steps.push(step);
      if (res.timedOut || res.exit !== 0) {
        entry.ok = false;
        if (!res.timedOut && res.exit === 75) entry.deferred = "brain unreachable";
        break;
      }
    }
    entry.end = now().toISOString();
    if (entry.deferred && deferredTooLong(r.id, entry.end, state)) delete entry.deferred;
    append(state, entry);
    await report(r, entry, state, now(), o.notify);
    return entry;
  } finally {
    release();
  }
}

function deferredTooLong(id: string, end: string, state: string): boolean {
  const previous = readJournal(state).filter((entry) => entry.id === id);
  let first: Entry | undefined;
  // Count the whole outage: entries already turned into failures by this
  // limit (last step exit 75) keep the streak, so it does not restart.
  const unreachable = (e: Entry) => !!e.deferred || e.steps.at(-1)?.exit === 75;
  for (let i = previous.length - 1; i >= 0 && unreachable(previous[i]); i--) first = previous[i];
  return !!first && Date.parse(end) - Date.parse(first.start) >= DEFER_LIMIT_MS;
}

export function readJournal(state = stateDir()): Entry[] {
  const path = journalPath(state);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Entry]; } catch { return []; }
  });
}

export interface History { last?: Entry; lastOk?: Entry }

export function histories(state = stateDir()): Map<string, History> {
  const out = new Map<string, History>();
  for (const e of readJournal(state)) {
    const h = out.get(e.id) ?? {};
    h.last = e;
    if (e.ok) h.lastOk = e;
    out.set(e.id, h);
  }
  return out;
}

// Ticks are 15 minutes apart, not to the millisecond: a run ending at
// 21:45:03.217 and the next tick at 22:00:03.204 left a 15m routine 13 ms
// short of due, so it ran every other tick. SLACK_MS early is due. `every`
// counts from when a success really started, after any wait for the lock (a
// long run does not push the next one back); `retry` from when a failure
// ended, so a run that timed out after an hour is not retried at once.
export const SLACK_MS = 2 * UNITS.m;

const began = (e: Entry) => Date.parse(e.start) + (e.waited_ms ?? 0);
const okAt = (r: Routine, h?: History) => (h?.lastOk ? began(h.lastOk) + everyMs(r) - SLACK_MS : -Infinity);
const retryAt = (r: Routine, h?: History) => (h?.last && !h.last.ok
  ? Date.parse(h.last.end) + (h.last.deferred ? 15 * UNITS.m : retryMs(r)) - SLACK_MS
  : -Infinity);

export function isDue(r: Routine, h: History | undefined, now: Date): boolean {
  if (h?.last?.deferred) return now.getTime() >= retryAt(r, h);
  return now.getTime() >= okAt(r, h) && now.getTime() >= retryAt(r, h);
}

// When the next run may happen: now when due, else once both delays pass.
export function nextRun(r: Routine, h: History | undefined, now: Date): Date {
  if (h?.last?.deferred) return new Date(Math.max(retryAt(r, h), now.getTime()));
  if (isDue(r, h, now)) return now;
  return new Date(Math.max(okAt(r, h), retryAt(r, h), now.getTime()));
}

// One tick: every due routine, in order, under one hold of the lock. A tick
// that finds the lock taken (another tick, a manual run) leaves it be: the
// next tick catches up.
export async function tick(routines: Routine[], o: RunOpts = {}): Promise<{ ran: Entry[]; busy: boolean }> {
  const state = o.state ?? stateDir();
  const now = o.now ?? (() => new Date());
  const lock = lockPath(state);
  const release = await acquire(lock, 0, o.sleep);
  if (!release) return { ran: [], busy: true };
  const ran: Entry[] = [];
  try {
    for (const r of routines.filter((x) => x.enabled)) {
      if (isDue(r, histories(state).get(r.id), now())) ran.push(await runRoutine(r, { ...o, state, locked: true }));
    }
  } finally {
    release();
  }
  return { ran, busy: false };
}

// User units: one tick service, one timer (after start-up, then every 15
// minutes; Persistent catches a tick missed while asleep).
export function routineUnits(): { name: string; content: string }[] {
  return [
    {
      name: "orch-routines.service",
      content: `[Unit]
Description=orch routines: run the routines that are due

[Service]
Type=oneshot
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/orch routine tick
`,
    },
    {
      name: "orch-routines.timer",
      content: `[Unit]
Description=orch routines tick: after start-up, then every 15 minutes

[Timer]
OnStartupSec=2min
OnCalendar=*:0/15
Persistent=true
Unit=orch-routines.service

[Install]
WantedBy=timers.target
`,
    },
  ];
}
