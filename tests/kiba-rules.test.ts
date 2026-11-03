import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadProfile, validateProfile } from "../src/core/profile.ts";
import { releaseThreadAt, subscribeThreadAt, threadHolderAt } from "../src/core/threads.ts";
import { tasksDir, TaskStore } from "../src/core/tasks.ts";
import { type Route, specFeatures } from "../src/lanes/route.ts";
import {
  codeKind, DEFAULT_KIBA, filterEvent, type InboundEvent, isNudge, bump, provenance, kibaRoute, rungFor, validateKibaConfig,
} from "../src/kiba/rules.ts";
import { parseSpec } from "../src/lanes/spec.ts";

const feat = (files: string[], mechanical = false) =>
  specFeatures(parseSpec(`OBJECTIVE: x\nFILES: ${files.join(", ")}\nMECHANICAL: ${mechanical ? "yes" : "no"}\n`));
const tmp = (p: string) => mkdtempSync(join("/tmp", p));
const ev = (o: Partial<InboundEvent>): InboundEvent => ({ id: "E1", source: "operator", kind: "comment", text: "x", ...o });

describe("kiba: code-first filter and provenance", () => {
  const ctx = { holder: (t: string) => (t === "T3" ? "lane-T3" : undefined), fastPath: true, trivial: (t: string) => t === "T1" };

  test("chatter, green CI and status pings never wake the lead", () => {
    expect(filterEvent(ev({ kind: "chatter", text: "salut" }), ctx).to).toBe("drop");
    expect(filterEvent(ev({ kind: "ci_pass", source: "ci", task: "T9" }), ctx).to).toBe("drop");
    for (const t of ["tu en es où ?", "+1", "ça avance ?", "pas pressé", "merci pour celle-là"]) {
      expect(isNudge(t)).toBe(true);
      expect(filterEvent(ev({ task: "T9", text: t }), ctx).to).toBe("drop");
    }
    expect(isNudge("Pense à garder cartTotal compatible sans code.")).toBe(false);
  });

  test("a follow-up of a held task goes to its lane; others reach the lead", () => {
    expect(filterEvent(ev({ task: "T3", text: "Pense à garder cartTotal compatible." }), ctx)).toEqual({ to: "lane", task: "T3", owner: "lane-T3" });
    expect(filterEvent(ev({ kind: "ci_fail", source: "ci", task: "T3", text: "CI rouge" }), ctx).to).toBe("lane");
    expect(filterEvent(ev({ kind: "ci_fail", source: "ci", task: "T9", text: "CI rouge" }), ctx).to).toBe("lead");
  });

  test("fast path for a trivial task, switchable off (orch serve runs with it off)", () => {
    expect(filterEvent(ev({ kind: "task", task: "T1" }), ctx)).toEqual({ to: "fast-path", task: "T1" });
    expect(filterEvent(ev({ kind: "task", task: "T1" }), { ...ctx, fastPath: false }).to).toBe("lead");
    expect(filterEvent(ev({ kind: "task", task: "T4" }), ctx).to).toBe("lead");
  });

  test("every event carries its provenance; outside text is untrusted", () => {
    expect(provenance(ev({ source: "ci" }))).toBe("src=ci untrusted");
    expect(provenance(ev({ source: "orch" }))).toBe("src=orch");
  });
});

describe("kiba: direct routing lock", () => {
  test("one subscriber per thread; only the owner releases it (src/core/threads.ts)", async () => {
    const dir = tmp("orch-threads-");
    try {
      const file = join(dir, "threads.json");
      expect(await subscribeThreadAt(file, "T3", "task-a")).toBe(true);
      expect(await subscribeThreadAt(file, "T3", "task-b")).toBe(false);
      expect(threadHolderAt(file, "T3")).toBe("task-a");
      expect(await releaseThreadAt(file, "T3", "task-b")).toBe(false);
      expect(await releaseThreadAt(file, "T3", "task-a")).toBe(true);
      expect(await subscribeThreadAt(file, "T3", "task-b")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("kiba: ladder and escalation", () => {
  const cfg = DEFAULT_KIBA;
  test("kind to rung: mechanical haiku/low, normal sonnet/medium, risky opus/high", () => {
    expect(rungFor("mechanical", 0, cfg)).toEqual({ to: "lane", rung: { model: "haiku", effort: "low" }, steps: 0 });
    expect(rungFor("normal", 0, cfg)).toMatchObject({ rung: { model: "sonnet", effort: "medium" } });
    expect(rungFor("risky", 0, cfg)).toMatchObject({ rung: { model: "opus", effort: "high" } });
    expect(codeKind(feat(["migrations/002.sql"]))).toBe("risky");
    expect(codeKind(feat(["src/auth/x.ts"], true))).toBe("risky");
  });

  test("one rung up after two failures (model, then effort), operator at max_attempts", () => {
    expect(rungFor("mechanical", 1, cfg)).toMatchObject({ rung: { model: "haiku", effort: "low" }, steps: 0 });
    expect(rungFor("mechanical", 2, cfg)).toMatchObject({ rung: { model: "sonnet", effort: "low" }, steps: 1 });
    expect(rungFor("normal", 2, cfg)).toMatchObject({ rung: { model: "opus", effort: "medium" }, steps: 1 });
    expect(rungFor("normal", 3, cfg).to).toBe("operator");
  });

  test("automatic bump never exceeds high: opus/high after two failures goes back to the lead", () => {
    expect(bump({ model: "opus", effort: "medium" })).toEqual({ model: "opus", effort: "high" });
    expect(bump({ model: "opus", effort: "high" })).toBeNull();
    expect(bump({ model: "opus", effort: "xhigh" })).toBeNull();
    const top = rungFor("risky", 2, cfg);
    expect(top.to).toBe("operator");
    expect(top.to === "operator" && top.why).toContain("top of the ladder");
    expect(rungFor("risky", 1, cfg)).toMatchObject({ rung: { model: "opus", effort: "high" } });
    expect(() => validateKibaConfig({ escalate_after: 2, max_attempts: 4 })).toThrow(/escalate_after \+ 1/);
    const r: Route = { action: "lane", to: "claude", effort: "high", review: "none", reasons: [] };
    expect(kibaRoute(r, feat(["migrations/002.sql"]), 2, cfg).action).toBe("escalate");
    expect(kibaRoute(r, { ...feat(["migrations/002.sql"]), reasoning: "xhigh" }, 2, cfg)).toBe(r);
  });

  test("lane route under the router profile: ladder model for a Claude lane, escalation instead of hand-back", () => {
    const base: Route = { action: "lane", to: "claude", effort: "low", review: "none", reasons: [] };
    const f = feat(["src/a.ts", "src/b.ts", "src/c.ts"], true);
    expect(kibaRoute(base, f, 0, cfg)).toMatchObject({ action: "lane", model: "haiku", effort: "low" });
    expect(kibaRoute({ ...base, action: "escalate" }, f, 2, cfg)).toMatchObject({ action: "lane", model: "sonnet", effort: "low" });
    expect(kibaRoute(base, f, 3, cfg).action).toBe("escalate");
    expect(kibaRoute({ ...base, to: "codex" }, f, 0, cfg).model).toBeUndefined();
  });
});

describe("kiba: single writer", () => {
  test("only the orchestrator writes the task journal: a worker is refused", async () => {
    const dir = tmp("orch-tasks-writer-");
    const saved = process.env.ORCH_LANE;
    try {
      const store = new TaskStore(tasksDir(dir));
      process.env.ORCH_LANE = "1";
      await expect(store.change(() => {})).rejects.toThrow(/never writes/);
      expect(existsSync(join(tasksDir(dir), "state.json"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ORCH_LANE; else process.env.ORCH_LANE = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kiba: profile", () => {
  test("kiba profile loads with its ladder and watchdog, no conductor key; max20 and lean carry no kiba section", () => {
    const p = loadProfile("kiba");
    expect(p.kiba?.ladder).toEqual(DEFAULT_KIBA.ladder);
    expect(p.kiba).toMatchObject({ escalate_after: 2, max_attempts: 3, lane_timeout_seconds: 900, watchdog: DEFAULT_KIBA.watchdog });
    for (const k of ["lead_disallowed_tools", "research", "fast_path"]) expect(p.kiba).not.toHaveProperty(k);
    expect(Object.keys(p.lead)).toEqual(["claude"]);
    expect(p.route?.self_max_files).toBe(0);
    expect(p.lead.claude).toMatchObject({ model: "opus", effort: "medium", permission_mode: "bypassPermissions" });
    expect((p.kiba as { pool?: unknown }).pool).toBeUndefined();
    for (const name of ["max20", "lean"]) expect(loadProfile(name).kiba).toBeUndefined();
  });

  test("an invalid kiba section is refused; keys of the retired conductor are accepted and dropped", () => {
    const p = loadProfile("kiba");
    expect(() => validateProfile({ ...p, kiba: { ...p.kiba, ladder: { ...p.kiba!.ladder, trivial: { model: "haiku", effort: "low" } } as never } })).toThrow(/unknown kind trivial/);
    expect(() => validateProfile({ ...p, kiba: { ...p.kiba, escalate_after: 0 } })).toThrow(/escalate_after/);
    const old = validateKibaConfig({ lead_disallowed_tools: ["Bash"], research: [], fast_path: true } as never);
    for (const k of ["lead_disallowed_tools", "research", "fast_path"]) expect(old).not.toHaveProperty(k);
    expect(() => validateKibaConfig({ ladder: { ...DEFAULT_KIBA.ladder, risky: { model: "opus", effort: "max" } } })).toThrow(/effort/);
  });

  test("a spec KIND raises the code kind, never lowers it", () => {
    const base: Route = { action: "lane", to: "claude", effort: "low", review: "none", reasons: [] };
    const f = feat(["src/a.ts", "src/b.ts", "src/c.ts"], true);
    expect(kibaRoute(base, f, 0, DEFAULT_KIBA, "risky")).toMatchObject({ model: "opus", effort: "high" });
    expect(kibaRoute(base, feat(["src/auth/x.ts", "a.ts", "b.ts"]), 0, DEFAULT_KIBA, "mechanical")).toMatchObject({ model: "opus" });
  });
});
