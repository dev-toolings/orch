import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLanes, reapDeadLanes } from "../src/lane.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function lane(root: string, id: string, pid: number, extra: Record<string, unknown> = {}) {
  const dir = join(root, "lanes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ id, to: "claude", repo: "/x", base: "b", branch: `lane/${id}`, worktree: join(dir, "wt"), status: "running", changed: true, usage: {}, started: "t", ended: "", pid, ...extra }));
}
const mk = () => { const r = mkdtempSync(join(tmpdir(), "reap-")); roots.push(r); return r; };
const DEAD = 2 ** 22 + 12345;

test("dead pid is reaped", async () => {
  const root = mk();
  lane(root, "a", DEAD);
  expect(reapDeadLanes(root).map((x) => x.id)).toEqual(["a"]);
  const [s] = listLanes(root);
  expect(s.status).toBe("failed");
  expect(s.reason).toBe("lane process died");
  expect(s.ended).not.toBe("");
  expect(s.branch).toBe("lane/a");
  lane(root, "b", DEAD);
  expect(reapDeadLanes(root).map((x) => x.id)).toEqual(["b"]);
  expect(reapDeadLanes(root)).toEqual([]);
});

test("live pid is untouched", async () => {
  const root = mk();
  lane(root, "a", process.pid);
  expect(reapDeadLanes(root)).toEqual([]);
  expect(listLanes(root)[0].status).toBe("running");
});

test("the watchdog sends SIGKILL to a group that outlived its SIGTERM, once, and reaps every pass", async () => {
  const { Watchdog } = await import("../src/kiba/watchdog.ts");
  let now = 0;
  const sent: string[] = [];
  let reaps = 0;
  const w = { id: "L", phase: "worker", progressKey: "k", turns: 0, lastTool: null, declared: ["a.ts"], touched: ["b.ts"], pgid: 4242 };
  const dog = new Watchdog({ stall_seconds: 600, max_turns_without_test: 99 } as never, {
    observe: () => [w], now: () => now, alive: () => true, reap: () => { reaps++; },
    kill: (_x, sig) => { sent.push(sig ?? "SIGTERM"); return true; }, signal: () => {},
  });
  await dog.tick();
  now = 1000;
  await dog.tick();
  now = 20_000;
  await dog.tick();
  await dog.tick();
  expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
  expect(reaps).toBe(4);
});
