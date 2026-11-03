import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectBus, collectDash, emptyBus } from "../src/dash/collect.ts";
import { loadProfile } from "../src/core/profile.ts";

let root: string;
let busRoot: string;
let labRoot: string;

function writeMsg(dir: string, file: string, over: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `${JSON.stringify({
    id: "id1",
    thread: "th1",
    hop: 1,
    at: "2026-11-01T10:00:00.000Z",
    from: "front",
    to: "lab",
    type: "request",
    body: { text: "aligner le contrat" },
    mac: "aa".repeat(32),
    ...over,
  }, null, 2)}\n`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-dash-bus-"));
  busRoot = join(root, "bus");
  labRoot = join(root, "lab");
  mkdirSync(join(labRoot, "lab"), { recursive: true });
  writeFileSync(join(labRoot, "lab", "orch.yaml"), `name: lab
bus:
  root: ${busRoot}
  neighbors:
    - name: front
      path: ../front
      contract: openapi.yaml
      role: consumer
`);
  writeMsg(join(busRoot, "lab", "inbox"), "a.json", {
    id: "aabbccdd",
    thread: "th-live",
    hop: 2,
    at: "2026-11-01T10:05:00.000Z",
    body: { text: "aligner le contrat pour la release" },
  });
  writeMsg(join(busRoot, "lab", "inbox"), "bad.json", { id: 1, type: "nope" });
  writeMsg(join(busRoot, "lab", "ack"), "b.json", {
    id: "ack1",
    thread: "th-live",
    hop: 1,
    at: "2026-11-01T09:50:00.000Z",
    from: "lab",
    to: "front",
    type: "reply",
    body: { text: "ok" },
  });
  writeMsg(join(busRoot, "lab", "escalate"), "c.json", {
    id: "esc1",
    thread: "th-hot",
    hop: 5,
    at: "2026-11-01T09:40:00.000Z",
    from: "lab",
    to: "front",
    body: { text: "plus de 2 allers-retours", escalate: "more than 2 round-trips" },
  });
  writeMsg(join(busRoot, "front", "inbox"), "secret.json", {
    id: "secret1",
    thread: "th-secret",
    hop: 1,
    at: "2026-11-01T09:00:00.000Z",
    from: "lab",
    to: "front",
    body: { text: "use ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx please", hmac: "should-not-leak" },
  });
  mkdirSync(join(busRoot, "threads"), { recursive: true });
  writeFileSync(join(busRoot, "threads", "th-live.json"), `${JSON.stringify({ hop: 2 })}\n`);
  writeFileSync(join(busRoot, "threads", "th-hot.json"), `${JSON.stringify({ hop: 5 })}\n`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("collectBus", () => {
  test("missing root is explicit and inactive", () => {
    expect(collectBus({ busRoot: join(root, "nope") })).toEqual(emptyBus());
    expect(collectBus({ busRoot: null })).toEqual(emptyBus());
  });

  test("empty existing root is active with no mailboxes", () => {
    const empty = join(root, "empty-bus");
    mkdirSync(empty, { recursive: true });
    expect(collectBus({ busRoot: empty })).toEqual({
      ...emptyBus(),
      active: true,
    });
  });

  test("reads mailboxes, recent lines, escalations and hop counters without bodies or secrets", () => {
    const bus = collectBus({ busRoot, labRoot });
    expect(bus.active).toBe(true);
    expect(bus.mailboxes.find((row) => row.project === "lab")).toMatchObject({
      inboxValid: 1,
      inboxInvalid: 1,
      acked: 1,
      escalated: 1,
      neighbors: [{ name: "front", role: "consumer" }],
    });
    expect(bus.mailboxes.find((row) => row.project === "front")?.inboxValid).toBe(1);
    expect(bus.recent[0]).toMatchObject({
      id: "aabbccdd",
      from: "front",
      to: "lab",
      kind: "request",
      status: "inbox",
      subject: "aligner le contrat pour la release",
    });
    expect(bus.pending.some((row) => row.id === "esc1" && row.status === "escalate")).toBe(true);
    expect(bus.rounds.threads).toBeGreaterThanOrEqual(2);
    expect(bus.rounds.maxHop).toBeGreaterThanOrEqual(2);
    expect(bus.rounds.roundTrips).toBeGreaterThanOrEqual(1);
    const raw = JSON.stringify(bus);
    expect(raw).not.toContain("sk-ant-");
    expect(raw).not.toContain("ANTHROPIC_API_KEY");
    expect(raw).not.toContain("should-not-leak");
    expect(raw).not.toContain("aa".repeat(32));
    expect(raw).not.toMatch(/hmac|TELEGRAM|ORCH_BUS/i);
  });

  test("collectDash exposes the same bus state on the snapshot", () => {
    const snap = collectDash({
      policy: { spend: { daily_usd: 8, embed_usd_per_million: 0.02, plan_tokens: null }, paid_routines: [] },
      machine: { cores: 2, memAvailableGib: 4 },
      limits: loadProfile("max20").limits,
      now: new Date("2026-11-01T12:00:00Z"),
      lanes: [],
      ledger: [],
      spendUsed: 0,
      planUsed: 0,
      projectsRoot: join(root, "empty-projects"),
      busRoot,
      labRoot,
      procRoot: null,
      claudeProjects: join(root, "empty-claude"),
      logs: [],
      skills: [],
      installed: [],
      hostName: "kev",
    });
    expect(snap.bus.active).toBe(true);
    expect(snap.bus.mailboxes.some((row) => row.project === "lab")).toBe(true);
    expect(snap.bus.pending.length).toBeGreaterThan(0);
    expect(JSON.stringify(snap.bus)).not.toContain("sk-ant-");
  });
});
