import { expect, test } from "bun:test";
import type { Logger } from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/core/profile.ts";
import { flowState } from "../src/dash/flow.ts";
import { createHub } from "../src/dash/serve.ts";
import type { DashSnapshot } from "../src/dash/types.ts";
import { tasksDir, TaskStore } from "../src/core/tasks.ts";

test("flux: the task journal and the outbox counts come from the orch serve state", async () => {
  const state = mkdtempSync(join(tmpdir(), "flux-tasks-"));
  const snap = { at: "now", leads: [], lanes: [], budget: { budget: 4 } } as unknown as DashSnapshot;
  const block = (id: string) => flowState(snap, state, loadProfile("kiba"), Date.now(), () => false).blocks.find((b) => b.id === id)!;
  expect(block("inbox").live).toContain("0 événement à traiter");
  const store = new TaskStore(tasksDir(state));
  await store.receive({ key: "gh-run-x-1", source: "github", sender: "github", kind: "ci_fail", thread: "branch:/r:main", text: "CI failed" });
  expect(block("inbox").live).toContain("1 événement à traiter");
  await store.enqueue({ key: "t1:notice", kind: "notify", task: "t1", payload: { title: "x", text: "y" } });
  expect(block("wake").live).toBe("1 effet en attente");
});

test("flux: the architecture shows the kiba profile's real settings and the machine budget", () => {
  const state = mkdtempSync(join(tmpdir(), "flux-"));
  const profile = loadProfile("kiba");
  const snap = {
    at: "now", leads: [], lanes: [],
    budget: { budget: 4, cpu: 8, ram: 88, ceiling: 4, quota: null, limitedBy: "ceiling" },
  } as unknown as DashSnapshot;
  const view = flowState(snap, state, profile, Date.now(), () => true);
  const block = (id: string) => view.blocks.find((b) => b.id === id)!;
  expect(block("budget").config[0]).toBe("4 places, toute la machine (limite : ceiling)");
  expect(block("budget").live).toBe("0/4 places prises");
  expect(block("dispatch").config[0]).toBe("mechanical haiku low, normal sonnet medium, risky opus high");
  expect(block("route").live).toBe("claude prêt, codex prêt, grok prêt");
  expect(block("wake").config[1]).toBe("livraison, commentaire de PR, notification");
});

test("dash hub: one snapshot build per change serves every open page", async () => {
  let builds = 0;
  let fire: (() => void) | undefined;
  const log = { debug() {} } as unknown as Logger;
  const hub = createHub({
    collect: () => ({ at: String(++builds) }) as unknown as DashSnapshot,
    intervalMs: 60_000, log, subscribe: (fn) => { fire = fn; return () => { fire = undefined; }; },
  });
  const readers = [hub.response("snapshot", "/a"), hub.response("snapshot", "/b")].map((r) => r.body!.getReader());
  const dec = new TextDecoder();
  const next = async (r: ReadableStreamDefaultReader<Uint8Array>) => dec.decode((await r.read()).value);
  for (const r of readers) await next(r);
  await Bun.sleep(20);
  const before = builds;
  fire!();
  const got = await Promise.all(readers.map(async (r) => {
    let text = "";
    while (!text.includes(`"at":"${before + 1}"`)) text += await next(r);
    return text;
  }));
  expect(builds).toBe(before + 1);
  expect(got.every((t) => t.includes(`"at":"${before + 1}"`))).toBe(true);
  for (const r of readers) await r.cancel();
  expect(hub.clients()).toBe(0);
  expect(fire).toBeUndefined();
});

test("dash hub: a quiet stream still gets a heartbeat, so no idle timeout cuts it", async () => {
  const log = { debug() {} } as unknown as Logger;
  const hub = createHub({ collect: () => ({ at: "x" }) as unknown as DashSnapshot, intervalMs: 60_000, log, heartbeatMs: 30 });
  const reader = hub.response("flow", "/f").body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes(": ping")) text += dec.decode((await reader.read()).value);
  await reader.cancel();
  expect(hub.clients()).toBe(0);
});
