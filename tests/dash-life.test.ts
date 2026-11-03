import { describe, expect, test } from "bun:test";
import { activityOf, estimateToolCalls, laneLife, publicLogText, runtimesOf, sanitizeLogs, skillsFromFiles, workingOf } from "../src/dash/life.ts";
import type { DashLane } from "../src/dash/types.ts";

const lane = (over: Partial<DashLane> = {}): DashLane => ({
  id: "lane-1",
  project: "front",
  status: "running",
  harness: "codex",
  model: "gpt-5.1",
  effort: "medium",
  costUsd: 0.2,
  started: "2026-11-01T09:00:00.000Z",
  ended: null,
  life: "running",
  blocked: false,
  verifyOk: null,
  worktree: "/tmp/wt",
  durationSec: 120,
  tokens: { input: 8000, output: 400, cacheRead: 0, cacheWrite: 0 },
  pid: 9,
  progress: null,
  ...over,
});

describe("lane lifecycle", () => {
  test("maps orch statuses onto the issue board lives", () => {
    expect(laneLife({ status: "running" })).toBe("running");
    expect(laneLife({ status: "running", verifyOk: true })).toBe("verify");
    expect(laneLife({ status: "running", verifyOk: false })).toBe("failed");
    expect(laneLife({ status: "blocked" })).toBe("blocked");
    expect(laneLife({ status: "complete" })).toBe("done");
    expect(laneLife({ status: "failed" })).toBe("failed");
    expect(laneLife({ status: "timeout" })).toBe("failed");
    expect(laneLife({ status: "pending" })).toBe("queued");
    expect(laneLife({ status: "pending", pid: 12 })).toBe("claimed");
  });
});

describe("log sanitizer", () => {
  test("keeps NEXT/RESUME notes and drops secrets", () => {
    const kept = sanitizeLogs([
      { at: "2026-11-01T09:00:00Z", kind: "next", project: "lab", text: "RESUME: relancer VERIFY" },
      { at: "2026-11-01T09:01:00Z", kind: "state", project: "lab", text: "branch main @ abc" },
      { at: "2026-11-01T09:02:00Z", kind: "path", project: "lab", text: "/secret/path" },
      { at: "2026-11-01T09:03:00Z", kind: "next", project: "lab", text: "ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx" },
    ]);
    expect(kept.map((row) => row.kind)).toEqual(["next", "state"]);
    expect(kept[0].text).toContain("RESUME");
    expect(JSON.stringify(kept)).not.toContain("sk-ant-");
    expect(publicLogText("ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx")).toBeNull();
  });
});

  test("keeps a long Kiba note whole, short public text stays short", () => {
    const note = `Décision : ${"x".repeat(400)}`;
    const [kept] = sanitizeLogs([{ at: "2026-11-01T09:00:00Z", kind: "decision", project: "lab", text: note }]);
    expect(kept.text).toBe(note);
    expect(publicLogText(note)?.length).toBe(160);
  });

describe("activity, working, runtimes, skills", () => {
  test("interleaves leads, lanes and log notes", () => {
    const events = activityOf({
      leads: [{
        id: "kiba:front", project: "front", pid: 1, harness: "codex", model: "gpt-5.1",
        effort: "medium", permissionMode: null, started: "2026-11-01T09:00:00.000Z",
        uptimeSec: 60, remoteControl: false, supervised: false, cwd: "/tmp/front", activity: "working",
      }],
      lanes: [lane()],
      ledger: [{ id: "lane-1", at: "2026-11-01T09:10:00.000Z", kind: "run", project: "front", status: "running" }],
      logs: [{ at: "2026-11-01T09:05:00.000Z", kind: "next", project: "front", text: "RESUME: suivre la lane" }],
    });
    expect(events.some((e) => e.actor.kind === "lead")).toBe(true);
    expect(events.some((e) => e.actor.kind === "lane")).toBe(true);
    expect(events.some((e) => e.verb === "note NEXT")).toBe(true);
    expect(events[0].at >= events[events.length - 1].at).toBe(true);
  });

  test("working panel uses last known state when no live stream exists", () => {
    const now = new Date("2026-11-01T09:02:00.000Z");
    const panel = workingOf([lane({ tokens: { input: 8000, output: 4000, cacheRead: 0, cacheWrite: 0 } })], now);
    expect(panel).toHaveLength(1);
    expect(panel[0].toolCalls).toBe(estimateToolCalls({ input: 8000, output: 4000 }));
    expect(panel[0].stream[0]).toContain("dernier état");
    expect(panel[0].steps.length).toBeGreaterThan(0);
  });

  test("runtimes mark installed harnesses and build a daily heat series", () => {
    const { runtimes, heat } = runtimesOf({
      hostName: "kev",
      cores: 16,
      ramGib: 32,
      installed: ["claude", "codex"],
      leads: [],
      lanes: [lane(), lane({ id: "l2", harness: "claude", started: "2026-11-01T08:00:00.000Z", costUsd: 0.1 })],
      ledger: [{ at: "2026-10-31T12:00:00.000Z", kind: "run", costUsd: 0.5 }],
    });
    expect(runtimes[0]).toMatchObject({ id: "host", name: "kev", online: true, live: true });
    expect(runtimes.find((r) => r.id === "codex")?.online).toBe(true);
    expect(runtimes.find((r) => r.id === "codex")?.live).toBe(true);
    expect(runtimes.find((r) => r.id === "grok")?.online).toBe(false);
    expect(runtimes.find((r) => r.id === "grok")?.live).toBe(false);
    expect(heat.some((c) => c.day === "2026-11-01" && c.runs >= 1)).toBe(true);
    expect(heat.some((c) => c.day === "2026-10-31")).toBe(true);
  });

  test("skills come from SKILL.md front matter only", () => {
    const skills = skillsFromFiles([
      { id: "model-refresh", text: "---\nname: model-refresh\ndescription: Recaler les modèles du profil.\n---\n# body secret\nANTHROPIC_API_KEY=nope\n" },
      { id: "broken", text: "no front matter" },
    ]);
    expect(skills).toEqual([{ id: "model-refresh", name: "model-refresh", description: "Recaler les modèles du profil." }]);
    expect(JSON.stringify(skills)).not.toContain("ANTHROPIC");
  });
});
