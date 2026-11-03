import type { Notice } from "../src/presence/notify.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, alertFor, retryMs, type Entry, type Exec, histories, isDue, journalPath, loadRoutines, nextRun, parseDuration, readJournal, resolveArgv, type Routine, routinesDir, routineUnits, runRoutine, tick } from "../src/routines/routines.ts";
import { contender } from "./exclusion.ts";

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-routines-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const routine = (over: Partial<Routine> = {}): Routine => ({ id: "r", description: "", every: "1d", commands: [["true"]], timeout_minutes: 1, enabled: true, ...over });
const fresh = () => mkdtempSync(join(root, "s-"));

describe("routines", () => {
  test("the shipped catalog keeps paid consolidation and D ingestion opt-in, ops-check last", () => {
    const rs = loadRoutines();
    expect(rs.find((r) => r.id === "hindsight-consolidate")).toBeUndefined();
    expect(rs.find((r) => r.id === "transcript-ingest")?.enabled).toBe(false);
    // living memory (2026-10-28): the banks follow orch mem and the exhaust, the night reflects on the day
    expect(rs.find((r) => r.id === "hindsight-seed")?.commands).toEqual([["orch", "brain", "hindsight-seed"]]);
    expect(rs.find((r) => r.id === "reflect")?.commands).toEqual([["orch", "reflect", "run"]]);
    // the update dialog blocked unattended Codex launches (2026-10-28)
    expect(rs.find((r) => r.id === "codex-update")?.commands).toEqual([["bun", "install", "-g", "@openai/codex@latest"]]);
    // daily proposals, validated by the operator (2026-10-25)
    expect(rs.find((r) => r.id === "improve")?.commands).toEqual([["orch", "improve", "run"]]);
    expect(rs.find((r) => r.id === "rules-bench")?.commands).toEqual([["orch", "rule", "bench"]]);
    // paid; on since the operator moved orch mem to the brain (2026-10-24)
    expect(rs.find((r) => r.id === "brain-embed")?.enabled).toBe(true);
    expect(rs.at(-1)?.id).toBe("ops-check");
  });

  test("the catalog is validated", () => {
    const file = join(root, "routines.yaml");
    const bad = (yaml: string, re: RegExp) => { writeFileSync(file, yaml); expect(() => loadRoutines(file)).toThrow(re); };
    bad("routines:\n  - { id: Bad, every: 1d, commands: [[x]], timeout_minutes: 1 }\n", /id Bad/);
    bad("routines:\n  - { id: a, every: 1d, commands: [[x]], timeout_minutes: 1 }\n  - { id: a, every: 1d, commands: [[x]], timeout_minutes: 1 }\n", /twice/);
    bad("routines:\n  - { id: a, every: 1d, commands: [], timeout_minutes: 1 }\n", /argv lists/);
    bad("routines:\n  - { id: a, every: daily, commands: [[x]], timeout_minutes: 1 }\n", /a positive number then m, h or d/);
    bad("routines:\n  - { id: a, every: 1d, retry: 0h, commands: [[x]], timeout_minutes: 1 }\n", /a positive number/);
    bad("routines:\n  - { id: a, schedule: daily, every: 1d, commands: [[x]], timeout_minutes: 1 }\n", /schedule is gone/);
    bad("routines:\n  - { id: a, every: 1d, commands: [[x]], timeout_minutes: 1, enabled: yes }\n", /enabled must be true or false/);
    writeFileSync(file, "routines:\n  - { id: a, every: 1d, commands: [[x]], timeout_minutes: 1 }\n");
    expect(loadRoutines(file)[0].enabled).toBe(false);
  });

  test("steps run in order, the first failure stops the routine, the run is journaled and notified", async () => {
    const state = fresh();
    const ran: string[] = [];
    const exec: Exec = (argv) => { ran.push(argv.join(" ")); return argv[0] === "bad" ? { exit: 3, timedOut: false, output: "line1\nboom\n" } : { exit: 0, timedOut: false, output: "fine" }; };
    const notes: Notice[] = [];
    const e = await runRoutine(routine({ id: "backup", commands: [["good"], ["bad"], ["never"]] }), { state, exec, notify: async (t) => {
      expect(await acquire(join(routinesDir(state), "lock"), 0)).toBeNull();
      expect(readJournal(state).map((x) => x.id)).toEqual(["backup"]);
      expect(JSON.parse(readFileSync(join(routinesDir(state), "alerts.json"), "utf8")).backup).toBeDefined();
      notes.push(t);
    } });
    expect(ran).toEqual(["good", "bad"]);
    expect([e.ok, e.steps.map((s) => s.exit)]).toEqual([false, [0, 3]]);
    expect([notes[0].title, notes[0].text, notes[0].log]).toEqual(["backup a échoué", "La commande `bad` a échoué (code 3).", "line1\nboom"]);
    expect(readJournal(state).map((x) => x.id)).toEqual(["backup"]);
    expect(existsSync(join(routinesDir(state), "lock"))).toBe(true);
  });

  test("exit 75 is deferred, journaled without an alert record or notification", async () => {
    const state = fresh();
    const notes: Notice[] = [];
    const e = await runRoutine(routine(), {
      state,
      exec: () => ({ exit: 75, timedOut: false, output: "orch: brain unreachable: Failed to connect" }),
      notify: async (text) => { notes.push(text); },
      now: () => new Date("2026-10-24T12:00:00Z"),
    });
    expect([e.ok, e.deferred, readJournal(state)[0].deferred]).toEqual([false, "brain unreachable", "brain unreachable"]);
    expect(notes).toEqual([]);
    expect(JSON.parse(readFileSync(join(routinesDir(state), "alerts.json"), "utf8"))).toEqual({});
  });

  test("orch routine run: a deferred run exits 75, a failed one 1", () => {
    const dir = fresh();
    const routines = join(dir, "routines.yaml");
    writeFileSync(routines, `routines:
  - { id: down, every: 1d, commands: [[sh, -c, "exit 75"]], timeout_minutes: 1, enabled: true }
  - { id: bad, every: 1d, commands: [[sh, -c, "exit 3"]], timeout_minutes: 1, enabled: true }
`);
    const presence = join(dir, "presence.yaml");
    writeFileSync(presence, "session: t\nworkdir: /tmp\nnotify: none\n");
    const run = (id: string) => spawnSync(process.execPath, [join(import.meta.dir, "../src/orch.ts"), "routine", "run", id], {
      encoding: "utf8",
      env: { ...process.env, ORCH_STATE: join(dir, "state"), ORCH_ROUTINES_CONFIG: routines, ORCH_PRESENCE_CONFIG: presence },
    });
    const down = run("down");
    expect([down.status, down.stdout.trim()]).toEqual([75, "DEFER down  brain unreachable"]);
    expect(run("bad").status).toBe(1);
  });

  test("a timeout kills a TERM-trapping command and its grandchild and remains a journaled failure", async () => {
    for (const onTerm of [":", "exit 0", "exit 75"]) {
      const state = fresh();
      const pids = join(state, "pids");
      const leader = join(state, "leader");
      const script = `
        trap '${onTerm}' TERM
        echo $$ > "$1"
        sh -c 'trap "" TERM; sleep 30 & echo "$$ $!" > "$1"; wait' child "$2" &
        while :; do wait; done
      `;
      try {
        const e = await runRoutine(routine({ commands: [["sh", "-c", script, "routine", leader, pids], ["true"]], timeout_minutes: 0.005 }), { state });
        expect(e.steps).toHaveLength(1);
        expect(e.steps[0].timed_out).toBe(true);
        expect(e.steps[0].ms).toBeLessThan(2000);
        expect(e.ok).toBe(false);
        expect(e.deferred).toBeUndefined();
        if (onTerm !== ":") expect(e.steps[0].exit).toBe(Number(onTerm.split(" ")[1]));
        expect(readJournal(state)).toEqual([e]);
        const tree = `${readFileSync(leader, "utf8")} ${readFileSync(pids, "utf8")}`.trim().split(/\s+/).join(",");
        const running = () => spawnSync("ps", ["-o", "stat=", "-p", tree], { encoding: "utf8", env: { ...process.env, HOME: state } }).stdout.trim().split("\n").filter((s) => s && !s.trim().startsWith("Z"));
        const deadline = Date.now() + 1000;
        while (running().length && Date.now() < deadline) await Bun.sleep(10);
        expect(running()).toEqual([]);
        const release = await acquire(join(routinesDir(state), "lock"), 0);
        expect(release).not.toBeNull();
        release?.();
      } finally {
        if (existsSync(leader)) {
          try { process.kill(-Number(readFileSync(leader, "utf8")), "SIGKILL"); } catch {}
        }
      }
    }
  });

  test("one routine at a time: a live holder makes the next one wait, then skip, journaled", async () => {
    const state = fresh();
    const lock = join(routinesDir(state), "lock");
    const release = await acquire(lock, 0);
    try {
      let ran = false;
      const e = await runRoutine(routine(), { state, waitMs: 0, exec: () => { ran = true; return { exit: 0, timedOut: false, output: "" }; } });
      expect([ran, e.ok, e.skipped]).toEqual([false, false, "another routine kept the lock"]);
      expect(e.waited_ms).toBeGreaterThanOrEqual(0);
      expect(readJournal(state).map((x) => x.skipped)).toEqual(["another routine kept the lock"]);
      expect(await acquire(lock, 0)).toBeNull();
    } finally {
      release?.();
    }
  });

  test("two processes recovering a dead routine owner admit only one and preserve its inode", async () => {
    const state = fresh();
    const lock = join(state, "lock");
    writeFileSync(lock, "999999999\n"); // a leftover PID file is harmless
    const inode = statSync(lock).ino;
    const holder = contender(state, "routine");
    const contenders: ReturnType<typeof contender>[] = [];
    try {
      await holder.ready;
      expect(await holder.start()).toBe("held");
      expect(await acquire(lock, 0)).toBeNull();
      await holder.stop();
      contenders.push(contender(state, "routine"), contender(state, "routine"));
      await Promise.all(contenders.map((c) => c.ready));
      expect((await Promise.all(contenders.map((c) => c.start()))).sort()).toEqual(["busy", "held"]);
      expect(await acquire(lock, 0)).toBeNull();
      expect(statSync(lock).ino).toBe(inode);
    } finally {
      await holder.stop();
      await Promise.all(contenders.map((c) => c.stop()));
    }
  });

  test("a corrupt journal line is skipped, not fatal", async () => {
    const state = fresh();
    await runRoutine(routine({ id: "a" }), { state, exec: () => ({ exit: 0, timedOut: false, output: "" }) });
    writeFileSync(journalPath(state), `${readFileSync(journalPath(state), "utf8")}{not json\n`);
    expect(readJournal(state).length).toBe(1);
  });

  test("installed entry points and routine launches disable Bun env autoload", () => {
    for (const name of ["orch", "lane", "lead"]) {
      const source = readFileSync(join(import.meta.dir, "../src", `${name}.ts`), "utf8");
      expect(source.split("\n")[0]).toBe("#!/usr/bin/env -S bun --no-env-file");
    }
    for (const name of ["orch", "lane"]) {
      expect(resolveArgv([name, "status"])).toEqual([
        process.execPath, "--no-env-file", join(import.meta.dir, "../src", `${name}.ts`), "status",
      ]);
    }
  });

  test("orch means this checkout; units: one template, a timer per enabled routine", () => {
    expect(resolveArgv(["orch", "ops", "check"]).slice(1)).toEqual(["--no-env-file", expect.stringMatching(/src\/orch\.ts$/), "ops", "check"]);
    expect(resolveArgv(["systemctl", "--user"])).toEqual(["systemctl", "--user"]);
    const units = routineUnits();
    expect(units.map((u) => u.name)).toEqual(["orch-routines.service", "orch-routines.timer"]);
    expect(units[1].content).toContain("OnStartupSec=2min\nOnCalendar=*:0/15\nPersistent=true");
    expect(units[0].content).toContain("ExecStart=%h/.local/bin/orch routine tick");
  });

  test("durations; due means last success older than every and last failure older than retry", () => {
    expect([parseDuration("15m"), parseDuration("2h"), parseDuration("7d")]).toEqual([900_000, 7_200_000, 604_800_000]);
    expect(() => parseDuration("0m")).toThrow();
    const r = routine({ every: "1d" });
    const at = (iso: string, ok = true): Entry => ({ id: "r", start: iso, end: iso, ok, steps: [] });
    const now = new Date("2026-10-24T12:00:00Z");
    expect(isDue(r, undefined, now)).toBe(true);
    expect(isDue(r, { last: at("2026-10-24T01:00:00Z"), lastOk: at("2026-10-24T01:00:00Z") }, now)).toBe(false);
    expect(isDue(r, { last: at("2026-10-23T11:00:00Z"), lastOk: at("2026-10-23T11:00:00Z") }, now)).toBe(true);
    // failed 30 min ago: retry waits the shorter of every and 1h
    const failed = { last: at("2026-10-24T11:30:00Z", false), lastOk: at("2026-10-22T00:00:00Z") };
    expect(isDue(r, failed, now)).toBe(false);
    expect(nextRun(r, failed, now).toISOString()).toBe("2026-10-24T12:28:00.000Z");
    expect(isDue(routine({ every: "1d", retry: "10m" }), failed, now)).toBe(true);
    expect(nextRun(r, { last: at("2026-10-24T01:00:00Z"), lastOk: at("2026-10-24T01:00:00Z") }, now).toISOString()).toBe("2026-10-25T00:58:00.000Z");
  });

  test("a 15m routine is due at every tick, even one landing a few ms early, and counts from its start", () => {
    const r = routine({ every: "15m" });
    // the journal of 2026-10-24: ended 21:45:03.217, next tick 22:00:03.204
    const ran: Entry = { id: "r", start: "2026-10-24T21:45:03.209Z", end: "2026-10-24T21:45:03.217Z", ok: true, steps: [] };
    expect(isDue(r, { last: ran, lastOk: ran }, new Date("2026-10-24T22:00:03.204Z"))).toBe(true);
    // a manual run between two ticks still waits for the next interval
    expect(isDue(r, { last: ran, lastOk: ran }, new Date("2026-10-24T21:55:00Z"))).toBe(false);
    // a daily routine that ran 3 minutes is due again at the same tick the next day
    const long: Entry = { id: "r", start: "2026-10-24T16:15:03Z", end: "2026-10-24T16:18:03Z", ok: true, steps: [] };
    expect(isDue(routine({ every: "1d" }), { last: long, lastOk: long }, new Date("2026-10-25T16:15:02Z"))).toBe(true);
  });

  // both found by a lane contest judge on 2026-10-25
  test("a failure's retry counts from its end; a success counts from after its wait for the lock", () => {
    // brain-backup timed out after its 60 minutes: not retried at the next tick
    const timedOut: Entry = { id: "r", start: "2026-10-24T16:15:00Z", end: "2026-10-24T17:15:00Z", ok: false, steps: [] };
    const daily = routine({ every: "1d" });
    expect(isDue(daily, { last: timedOut }, new Date("2026-10-24T17:30:00Z"))).toBe(false);
    expect(nextRun(daily, { last: timedOut }, new Date("2026-10-24T17:30:00Z")).toISOString()).toBe("2026-10-24T18:13:00.000Z");
    // a manual run that waited 10 minutes for the lock started at 22:00
    const waited: Entry = { id: "r", start: "2026-10-24T21:50:00Z", end: "2026-10-24T22:00:05Z", ok: true, waited_ms: 600_000, steps: [] };
    const quarter = routine({ every: "15m" });
    expect(isDue(quarter, { last: waited, lastOk: waited }, new Date("2026-10-24T22:05:00Z"))).toBe(false);
    expect(isDue(quarter, { last: waited, lastOk: waited }, new Date("2026-10-24T22:13:00Z"))).toBe(true);
  });

  test("a deferred run is due after the adjusted 15 minutes while a plain failure keeps retry", () => {
    const r = routine({ every: "1d", retry: "4h" });
    const lastOk: Entry = { id: "r", start: "2026-10-23T00:00:00Z", end: "2026-10-23T00:00:00Z", ok: true, steps: [] };
    const deferred: Entry = { id: "r", start: "2026-10-24T12:00:00Z", end: "2026-10-24T12:00:00Z", ok: false, deferred: "brain unreachable", steps: [] };
    const failed: Entry = { ...deferred, deferred: undefined };
    const deferredHistory = { last: deferred, lastOk };
    const failedHistory = { last: failed, lastOk };
    expect(isDue(r, deferredHistory, new Date("2026-10-24T12:12:59Z"))).toBe(false);
    expect(isDue(r, deferredHistory, new Date("2026-10-24T12:13:00Z"))).toBe(true);
    expect(nextRun(r, deferredHistory, new Date("2026-10-24T12:01:00Z")).toISOString()).toBe("2026-10-24T12:13:00.000Z");
    expect(isDue(r, failedHistory, new Date("2026-10-24T12:13:00Z"))).toBe(false);
    expect(nextRun(r, failedHistory, new Date("2026-10-24T12:13:00Z")).toISOString()).toBe("2026-10-24T15:58:00.000Z");
  });

  test("a deferral lasting two hours becomes a notifying failure", async () => {
    const state = fresh();
    const notes: Notice[] = [];
    let at = Date.parse("2026-10-24T12:00:00Z");
    const r = routine({ id: "brain-embed" });
    let last: Entry | undefined;
    // i = 9: the outage goes on after the limit and stays a failure, it does
    // not start a new silent deferral.
    for (let i = 0; i <= 9; i++) {
      at = Date.parse("2026-10-24T12:00:00Z") + i * 15 * 60_000;
      last = await runRoutine(r, {
        state,
        exec: () => ({ exit: 75, timedOut: false, output: "brain unreachable" }),
        notify: async (text) => { notes.push(text); },
        now: () => new Date(at),
        policy: { spend: { daily_usd: 10, embed_usd_per_million: 0.02 }, paid_routines: ["brain-embed"] },
      });
      expect(last.deferred).toBe(i < 8 ? "brain unreachable" : undefined);
    }
    expect([last?.ok, last?.deferred, notes.length]).toEqual([false, undefined, 1]);
    expect(notes[0].title).toBe("brain-embed a échoué");
  });

  test("a paid routine without a daily cap still runs", async () => {
    const state = fresh();
    const ran: string[] = [];
    const e = await runRoutine(routine({ id: "brain-embed" }), {
      state,
      exec: async (argv) => { ran.push(argv.join(" ")); return { exit: 0, timedOut: false, output: "" }; },
      policy: { spend: { daily_usd: null, embed_usd_per_million: 0.02 }, paid_routines: ["brain-embed"] },
    });
    expect(e.ok).toBe(true);
    expect(e.skipped).toBeUndefined();
    expect(ran).toEqual(["true"]);
  });

  test("a tick runs the due routines in catalog order, skips the rest, and passes ORCH_ROUTINE", async () => {
    const state = fresh();
    const seen: string[] = [];
    const exec: Exec = (argv, _t, env) => { seen.push(`${env.ORCH_ROUTINE}:${argv[0]}`); return { exit: 0, timedOut: false, output: "" }; };
    const rs = [routine({ id: "a", commands: [["one"]] }), routine({ id: "off", enabled: false }), routine({ id: "b", commands: [["two"]] })];
    const t1 = await tick(rs, { state, exec, now: () => new Date("2026-10-24T12:00:00Z") });
    expect([t1.busy, seen]).toEqual([false, ["a:one", "b:two"]]);
    const t2 = await tick(rs, { state, exec, now: () => new Date("2026-10-24T13:00:00Z") });
    expect(t2.ran).toEqual([]);
    const t3 = await tick(rs, { state, exec, now: () => new Date("2026-10-25T12:30:00Z") });
    expect(t3.ran.map((e) => e.id)).toEqual(["a", "b"]);
    expect(histories(state).get("a")?.lastOk?.end).toBe("2026-10-25T12:30:00.000Z");
    expect(existsSync(join(routinesDir(state), "lock"))).toBe(true);
  });

  test("a tick that finds the lock taken runs nothing and journals nothing", async () => {
    const state = fresh();
    const release = await acquire(join(routinesDir(state), "lock"), 0);
    try {
      const t = await tick([routine()], { state, exec: () => { throw new Error("must not run"); } });
      expect([t.busy, t.ran, readJournal(state)]).toEqual([true, [], []]);
    } finally {
      release?.();
    }
  });

  test("alerts: first failure, then at most one reminder a day, then recovery", async () => {
    const r = routine({ id: "ops" });
    // the FAIL line leads, even when ok lines come after it
    const out = "ok   ssh-key-only  no password\nFAIL exposure  5432 reachable\nok   routines  green\nok   env-private  600\n8/9 green";
    const fail = (end: string): Entry => ({ id: "ops", start: end, end, ok: false, steps: [{ command: "orch ops check", exit: 1, timed_out: false, ms: 1, tail: out }] });
    const first = alertFor(r, fail("2026-10-24T07:00:00Z"), undefined, new Date("2026-10-24T07:00:00Z"));
    expect(first.notice).toEqual({
      title: "ops a échoué", level: "fail", text: "La commande `orch ops check` a échoué (code 1).", log: "FAIL exposure  5432 reachable\n8/9 green",
      note: `Nouvel essai <t:${Date.parse("2026-10-24T07:00:00Z") / 1000 + retryMs(r) / 1000}:R>.`,
    });
    const hourLater = alertFor(r, fail("2026-10-24T08:00:00Z"), first.next, new Date("2026-10-24T08:00:00Z"));
    expect([hourLater.notice, hourLater.next]).toEqual([undefined, first.next]);
    const deferred = { ...fail("2026-10-24T08:30:00Z"), deferred: "brain unreachable" };
    expect(alertFor(r, deferred, first.next, new Date("2026-10-24T08:30:00Z"))).toEqual({ next: first.next });
    const dayLater = alertFor(r, fail("2026-10-25T07:30:00Z"), first.next, new Date("2026-10-25T07:30:00Z"));
    expect(dayLater.notice?.title).toBe("ops a échoué, depuis 25 h");
    const ok: Entry = { id: "ops", start: "x", end: "2026-10-25T09:00:00Z", ok: true, steps: [] };
    expect(alertFor(r, ok, dayLater.next, new Date("2026-10-25T09:00:00Z")).notice).toMatchObject({ title: "ops fonctionne de nouveau", level: "ok", text: expect.stringMatching(/^Réglé après 26 h de problème/) });
    expect(alertFor(r, ok, undefined, new Date())).toEqual({});
    // a command that explains itself: its words replace the raw output
    const own = "FAIL exposure\nALERT-TITLE: Un point à corriger sur l'hôte\nALERT: Des ports sont ouverts sur le réseau : 0.0.0.0:5432. À faire : les fermer.";
    const told = alertFor(r, { ...fail("2026-10-26T07:00:00Z"), steps: [{ command: "orch ops check", exit: 1, timed_out: false, ms: 1, tail: own }] }, undefined, new Date("2026-10-26T07:00:00Z")).notice;
    expect([told?.title, told?.text, told?.log]).toEqual(["Un point à corriger sur l'hôte", "- Des ports sont ouverts sur le réseau : 0.0.0.0:5432. À faire : les fermer.", undefined]);
    const healed: Entry = { ...ok, steps: [{ command: "orch ops check", exit: 0, timed_out: false, ms: 1, tail: "9/9 green\nALERT-OK: Les contrôles de l'hôte sont de nouveau tous bons" }] };
    expect(alertFor(r, healed, dayLater.next, new Date("2026-10-25T09:00:00Z")).notice?.title).toBe("Les contrôles de l'hôte sont de nouveau tous bons");
    // end to end: a failing routine run twice in an hour notifies once
    const state = fresh();
    const notes: Notice[] = [];
    const bad: Exec = () => ({ exit: 1, timedOut: false, output: "boom" });
    await runRoutine(r, { state, exec: bad, notify: async (t) => { notes.push(t); }, now: () => new Date("2026-10-24T07:00:00Z") });
    await runRoutine(r, { state, exec: bad, notify: async (t) => { notes.push(t); }, now: () => new Date("2026-10-24T08:00:00Z") });
    expect(notes.length).toBe(1);
  });
});
