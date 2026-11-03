import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupControl, brainBoundControl, dockerPublished, envFileControl, explain, exposureControl, firewallControl, hostFiltered, listeners, restoreControl, routinesControl, routineState, sshControls } from "../src/ops/ops.ts";
import { tokenUsage, tokensOnDay, usageLines, usageTokens } from "../src/ops/usage.ts";
import type { Entry, Routine } from "../src/routines/routines.ts";

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-ops-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SS = `LISTEN 0      4096       127.0.0.1:5433  0.0.0.0:*
LISTEN 0      4096      127.0.0.53%lo:53    0.0.0.0:*
LISTEN 0      4096         0.0.0.0:22    0.0.0.0:*
LISTEN 0      4096            [::]:22       [::]:*
LISTEN 0      4096         0.0.0.0:8100  0.0.0.0:*
LISTEN 0      4096               *:2377        *:*
LISTEN 0      4096           [::1]:9000     [::]:*`;

describe("ops controls", () => {
  test("ssh: the first value wins, Match blocks are ignored, absent keywords take OpenSSH defaults", () => {
    expect(sshControls("").map((c) => c.ok)).toEqual([false, false]);
    const hardened = "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nPasswordAuthentication yes\nMatch User x\n  PermitRootLogin yes\n";
    expect(sshControls(hardened).map((c) => c.ok)).toEqual([true, true]);
    expect(sshControls("# PasswordAuthentication no\nPermitRootLogin prohibit-password\n").map((c) => c.detail)).toEqual([
      "PasswordAuthentication yes, KbdInteractiveAuthentication yes", "PermitRootLogin prohibit-password"]);
  });

  test("firewall from ufw.conf; unknown when it is missing, never a pass", () => {
    expect(firewallControl("ENABLED=yes\n").ok).toBe(true);
    expect(firewallControl("ENABLED=no\n").ok).toBe(false);
    expect(firewallControl(null).ok).toBeNull();
  });

  test("listeners parse IPv4, IPv6 and zone suffixes; exposure lists what is open beyond localhost", () => {
    const ls = listeners(SS);
    expect(ls).toContainEqual({ address: "127.0.0.53", port: 53 });
    expect(ls).toContainEqual({ address: "::1", port: 9000 });
    expect(exposureControl(ls, [22]).detail).toBe("listening beyond localhost: 0.0.0.0:8100, *:2377");
    expect(exposureControl(ls.filter((l) => l.port !== 8100 && l.port !== 2377), [22]).ok).toBe(true);
  });

  test("brain must listen on localhost only; down is unknown", () => {
    expect(brainBoundControl(listeners(SS), 5433).ok).toBe(true);
    expect(brainBoundControl(listeners("LISTEN 0 1 0.0.0.0:5433 0.0.0.0:*"), 5433).ok).toBe(false);
    expect(brainBoundControl([], 5433).ok).toBeNull();
  });

  const R = (id: string, every = "1d", enabled = true): Routine => ({ id, description: "", every, commands: [["x"]], timeout_minutes: 1, enabled });
  const at = (iso: string, ok = true, steps: Entry["steps"] = []): Entry => ({ id: "x", start: iso, end: iso, ok, steps });
  const now = new Date("2026-10-24T12:00:00Z");

  test("a routine state counts only the time the host was up", () => {
    const boot = (iso: string) => new Date(iso);
    // ran 2 h ago, every 1d: ok
    expect(routineState(R("a"), { last: at("2026-10-24T10:00:00Z"), lastOk: at("2026-10-24T10:00:00Z") }, now, boot("2026-10-24T08:00:00Z"))).toBe("ok");
    // due since yesterday, but the host started 10 min ago: pending, the next tick runs it
    expect(routineState(R("a"), { last: at("2026-10-22T10:00:00Z"), lastOk: at("2026-10-22T10:00:00Z") }, now, boot("2026-10-24T11:50:00Z"))).toBe("pending");
    // due and the host has been up for 2 h: overdue, the timer is not running
    expect(routineState(R("a"), { last: at("2026-10-22T10:00:00Z"), lastOk: at("2026-10-22T10:00:00Z") }, now, boot("2026-10-24T10:00:00Z"))).toBe("overdue");
    // never ran: pending right after start-up, overdue later
    expect(routineState(R("a"), undefined, now, boot("2026-10-24T11:55:00Z"))).toBe("pending");
    expect(routineState(R("a"), undefined, now, boot("2026-10-24T09:00:00Z"))).toBe("overdue");
    // a failed last run is a failure whatever the timing
    expect(routineState(R("a"), { last: at("2026-10-24T11:59:00Z", false), lastOk: at("2026-10-24T01:00:00Z") }, now, boot("2026-10-24T08:00:00Z"))).toBe("failed");
  });

  test("a deferred last run is pending", () => {
    const last = { ...at("2026-10-24T11:59:00Z", false), deferred: "brain unreachable" };
    expect(routineState(R("a"), { last }, now, new Date("2026-10-24T08:00:00Z"))).toBe("pending");
  });

  test("backups must be fresh and restore; right after start-up a stale backup is pending, not failed", () => {
    expect(backupControl(null, 26, now).ok).toBe(false);
    expect(backupControl(null, 26, now, "pending").ok).toBeNull();
    expect(backupControl({ path: "b", mtime: new Date("2026-10-24T03:30:00Z") }, 26, now).ok).toBe(true);
    expect(backupControl({ path: "b", mtime: new Date("2026-10-22T03:30:00Z") }, 26, now).ok).toBe(false);
    expect(backupControl({ path: "b", mtime: new Date("2026-10-22T03:30:00Z") }, 26, now, "pending").detail).toMatch(/host was off/);
    const steps = (exits: number[]) => exits.map((exit, i) => ({ command: i ? "orch brain restore-check" : "orch brain backup", exit, timed_out: false, ms: 1, tail: "" }));
    expect(restoreControl({ last: at("2026-10-24T03:40:00Z", true, steps([0, 0])) }).ok).toBe(true);
    expect(restoreControl({ last: at("2026-10-24T03:40:00Z", false, steps([0, 1])) }).ok).toBe(false);
    expect(restoreControl({ last: at("2026-10-24T03:40:00Z", false, steps([1])) }).detail).toMatch(/stopped before its restore check/);
    expect(restoreControl(undefined).ok).toBe(false);
    expect(restoreControl(undefined, "pending").ok).toBeNull();
  });

  test("a deferred brain backup leaves restore status unknown with its reason and end time", () => {
    const last = { ...at("2026-10-24T03:40:00Z", false), deferred: "brain unreachable" };
    expect(restoreControl({ last })).toEqual({
      id: "backup-restores",
      ok: null,
      detail: "brain-backup deferred: brain unreachable (2026-10-24T03:40)",
    });
  });

  test("routines: failures and overdue work fail, pending work is unknown, disabled and running ones are skipped", () => {
    const boot = new Date("2026-10-24T08:00:00Z");
    const hist = new Map([
      ["a", { last: at("2026-10-24T11:00:00Z"), lastOk: at("2026-10-24T11:00:00Z") }],
      ["b", { last: at("2026-10-24T11:00:00Z", false) }],
    ]);
    expect(routinesControl([R("a"), R("b"), R("c"), R("d", "1d", false)], hist, now, boot).detail).toBe("b failed, c overdue (is orch-routines.timer active?)");
    expect(routinesControl([R("a"), R("c")], hist, now, new Date("2026-10-24T11:55:00Z"))).toEqual({ id: "routines", ok: null, detail: "due, run at the next tick: c" });
    expect(routinesControl([R("a"), R("c")], hist, now, boot, "c").ok).toBe(true);
  });

  test("exposure: with ufw dropping, only Docker-published ports count", () => {
    const ls = listeners("LISTEN 0 1 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 1 *:2377 *:*\nLISTEN 0 1 0.0.0.0:8100 0.0.0.0:*\nLISTEN 0 1 127.0.0.1:5433 0.0.0.0:*");
    const docker = dockerPublished("443/tcp, 0.0.0.0:8100->8000/tcp, [::]:8100->8000/tcp\n127.0.0.1:5433->5432/tcp\n0.0.0.0:7000-7001->7000-7001/tcp");
    expect(docker).toEqual([{ address: "0.0.0.0", port: 8100 }, { address: "::", port: 8100 }, { address: "127.0.0.1", port: 5433 }, { address: "0.0.0.0", port: 7000 }]);
    expect(exposureControl(ls, [22], { filtered: true, docker }).detail).toBe("published by Docker, which ufw does not filter: 0.0.0.0:8100, :::8100, 0.0.0.0:7000");
    expect(exposureControl(ls, [22], { filtered: false, docker }).detail).toContain("*:2377");
    expect(exposureControl(ls, [22, 8100, 7000], { filtered: true, docker }).ok).toBe(true);
    expect(hostFiltered("ENABLED=yes\n", 'DEFAULT_INPUT_POLICY="DROP"\n')).toBe(true);
    expect(hostFiltered("ENABLED=yes\n", 'DEFAULT_INPUT_POLICY="ACCEPT"\n')).toBe(false);
    expect(hostFiltered("ENABLED=no\n", 'DEFAULT_INPUT_POLICY="DROP"\n')).toBe(false);
  });

  test(".env must be private", () => {
    expect(envFileControl(0o100600).ok).toBe(true);
    expect(envFileControl(0o100644).ok).toBe(false);
    expect(envFileControl(null).ok).toBe(false);
  });
});

describe("token usage", () => {
  test("each message counts once, per day and model, within the period", () => {
    const dir = join(root, "projects", "-home-kev");
    mkdirSync(join(dir, "sub"), { recursive: true });
    const line = (id: string, ts: string, model: string, out: number) =>
      JSON.stringify({ timestamp: ts, message: { id, model, usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 } } });
    writeFileSync(join(dir, "a.jsonl"), [line("m1", "2026-10-24T08:00:00Z", "claude-opus-5-5", 100), line("m1", "2026-10-24T08:00:00Z", "claude-opus-5-5", 100), "not json", '{"type":"user"}'].join("\n"));
    writeFileSync(join(dir, "sub", "b.jsonl"), [line("m2", "2026-10-24T09:00:00Z", "claude-opus-5-5", 50), line("m3", "2026-10-20T09:00:00Z", "claude-opus-5-5", 999), line("m4", "2026-10-24T09:00:00Z", "<synthetic>", 0)].join("\n"));
    const old = join(dir, "old.jsonl");
    writeFileSync(old, line("m5", "2026-10-24T09:00:00Z", "claude-sonnet-5-5", 7));
    utimesSync(old, new Date("2026-10-01"), new Date("2026-10-01"));
    const u = tokenUsage(join(root, "projects"), new Date("2026-10-23T00:00:00Z"));
    expect([...u.keys()]).toEqual(["2026-10-24"]);
    expect(u.get("2026-10-24")?.get("claude-opus-5-5")).toEqual({ input: 20, output: 150, cache_read: 2000, cache_write: 10, messages: 2 });
    expect(u.get("2026-10-24")?.has("<synthetic>")).toBe(false);
    expect(usageLines(u)[0]).toContain("cache read      2k");
    expect(usageLines(new Map())).toEqual(["no usage in the period"]);
    expect(tokensOnDay(u, "2026-10-24")).toBe(20 + 150 + 2000 + 10);
    expect(tokensOnDay(u, "2026-10-23")).toBe(0);
    expect(usageTokens({ input: 1, output: 2, cache_read: 3, cache_write: 4, messages: 1 })).toBe(10);
  });

  test("a failed control reads as a problem and its fix, in the operator's words", () => {
    expect(explain(exposureControl([{ address: "0.0.0.0", port: 5432 }], [22]))).toBe("Des ports sont ouverts sur le réseau : 0.0.0.0:5432. À faire : les lier à 127.0.0.1 ou les fermer.");
    expect(explain(backupControl({ path: "x", mtime: new Date("2026-10-24T00:00:00Z") }, 26, new Date("2026-10-25T07:00:00Z")))).toBe("La dernière sauvegarde de la mémoire date de 31 h (maximum 26 h). À faire : `orch routine run brain-backup`.");
    expect(explain(envFileControl(0o100644))).toBe("Le fichier .env est lisible par d'autres comptes (mode 644). À faire : `chmod 600 .env`.");
  });
});
