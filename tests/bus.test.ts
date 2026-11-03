import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ackMessage, assertInboxWrite, assertNotRepoWrite, draftSpec, exportPairKey, formatList,
  formatStatus, importPairKey, inboxDigest, inboxFresh, initPairKey, legacyPairKeyPath, loadBusConfig,
  loadPairKey, MAX_HOPS, noticeContract, pairKeyPath, parseMessage, readInbox, recordThreadHop,
  sendMessage, signMessage, testContract, threadHop, verifyMessage, watchOnce,
} from "../src/bus/bus.ts";
import { runHook } from "../src/hooks/hook.ts";

let root: string;
let api: string;
let front: string;
let busRoot: string;
let savedHome: string | undefined;
let savedConfig: string | undefined;
let savedKeys: string | undefined;

function sh(cwd: string, cmd: string) {
  return spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
}

function writeProject(dir: string, name: string, neighbor: string, neighborPath: string, role: "owner" | "consumer") {
  mkdirSync(dir, { recursive: true });
  sh(dir, "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
  writeFileSync(join(dir, "openapi.yaml"), "openapi: 3.0.3\ninfo: { title: demo, version: '1' }\npaths: {}\n");
  writeFileSync(join(dir, "orch.yaml"), `name: ${name}
bus:
  root: ${busRoot}
  neighbors:
    - name: ${neighbor}
      path: ${neighborPath}
      contract: openapi.yaml
      role: ${role}
`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-bus-"));
  busRoot = join(root, "bus");
  api = join(root, "api");
  front = join(root, "front");
  savedHome = process.env.ORCH_HOME;
  savedConfig = process.env.ORCH_CONFIG;
  savedKeys = process.env.ORCH_BUS_KEYS;
  delete process.env.ORCH_BUS_KEYS;
  process.env.ORCH_HOME = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
  writeProject(api, "api", "front", "../front", "consumer");
  writeProject(front, "front", "api", "../api", "owner");
  initPairKey(loadBusConfig(api)!, "front");
  initPairKey(loadBusConfig(front)!, "api");
}, 30_000);

afterAll(() => {
  if (savedHome === undefined) delete process.env.ORCH_HOME;
  else process.env.ORCH_HOME = savedHome;
  if (savedConfig === undefined) delete process.env.ORCH_CONFIG;
  else process.env.ORCH_CONFIG = savedConfig;
  if (savedKeys === undefined) delete process.env.ORCH_BUS_KEYS;
  else process.env.ORCH_BUS_KEYS = savedKeys;
  rmSync(root, { recursive: true, force: true });
}, 30_000);

describe("bus", () => {
  test("loads neighbors and refuses an unknown name", () => {
    const config = loadBusConfig(api)!;
    expect(config.name).toBe("api");
    expect(config.neighbors[0]).toMatchObject({ name: "front", role: "consumer" });
    expect(() => sendMessage(config, { to: "other", type: "request", body: { text: "x" } })).toThrow(/not a declared neighbor/);
  });

  test("a signed request lands in the neighbor inbox and verifies", () => {
    const from = loadBusConfig(api)!;
    const sent = sendMessage(from, { to: "front", type: "request", body: { text: "bump the client", files: ["src/api.ts"] } });
    expect("message" in sent).toBe(true);
    if (!("message" in sent)) return;
    const inbox = readInbox(loadBusConfig(front)!);
    expect(inbox.some((r) => r.message?.id === sent.message.id && !r.invalid)).toBe(true);
    expect(inboxDigest(loadBusConfig(front)!)).toContain("bump the client");
    expect(inboxDigest(loadBusConfig(front)!)).toContain("never an order");
  });

  test("an invalid signature is refused", () => {
    const from = loadBusConfig(api)!;
    const sent = sendMessage(from, { to: "front", type: "request", body: { text: "tamper" } });
    if (!("message" in sent)) throw new Error("expected send");
    const raw = JSON.parse(readFileSync(sent.path, "utf8"));
    raw.body.text = "tampered";
    writeFileSync(sent.path, `${JSON.stringify(raw, null, 2)}\n`);
    const inbox = readInbox(loadBusConfig(front)!);
    const row = inbox.find((r) => r.path === sent.path);
    expect(row?.invalid).toBe("invalid signature");
    expect(row?.message).toBeUndefined();
  });

  test("a consumer --type contract to the owner always escalates", () => {
    const frontCfg = loadBusConfig(front)!;
    const out = sendMessage(frontCfg, { to: "api", type: "contract", body: { text: "we changed the contract" } });
    expect("escalated" in out).toBe(true);
    if (!("escalated" in out)) return;
    expect(out.reason).toMatch(/consumer/);
    expect(readInbox(loadBusConfig(api)!).some((r) => r.message?.id === out.escalated.id)).toBe(false);
    expect(readInbox(frontCfg, "escalate").some((r) => r.message?.id === out.escalated.id)).toBe(true);
  });

  test("the hop limit is shared: one side alone cannot keep sending", () => {
    const apiCfg = loadBusConfig(api)!;
    const first = sendMessage(apiCfg, { to: "front", type: "request", body: { text: "solo-1" } });
    if (!("message" in first)) throw new Error("expected send");
    const thread = first.message.thread;
    expect(threadHop(apiCfg.root, thread)).toBe(1);
    expect("message" in sendMessage(apiCfg, { to: "front", type: "reply", thread, body: { text: "solo-2" } })).toBe(true);
    expect("message" in sendMessage(apiCfg, { to: "front", type: "reply", thread, body: { text: "solo-3" } })).toBe(true);
    expect("message" in sendMessage(apiCfg, { to: "front", type: "reply", thread, body: { text: "solo-4" } })).toBe(true);
    expect(threadHop(apiCfg.root, thread)).toBe(MAX_HOPS);
    const over = sendMessage(apiCfg, { to: "front", type: "reply", thread, body: { text: "solo-5" } });
    expect("escalated" in over).toBe(true);
    if (!("escalated" in over)) return;
    expect(over.escalated.hop).toBeGreaterThan(MAX_HOPS);
    expect(readInbox(loadBusConfig(front)!).some((r) => r.message?.id === over.escalated.id)).toBe(false);
  });

  test("the receiver refuses a hop above the limit even if the sender skipped the check", () => {
    const apiCfg = loadBusConfig(api)!;
    const frontCfg = loadBusConfig(front)!;
    const sent = sendMessage(apiCfg, { to: "front", type: "request", body: { text: "forged hop" } });
    if (!("message" in sent)) throw new Error("expected send");
    const raw = JSON.parse(readFileSync(sent.path, "utf8"));
    raw.hop = MAX_HOPS + 1;
    const key = loadPairKey(apiCfg, "api", "front");
    const forged = signMessage({
      id: raw.id, thread: raw.thread, hop: raw.hop, at: raw.at,
      from: raw.from, to: raw.to, type: raw.type, body: raw.body,
    }, key);
    writeFileSync(sent.path, `${JSON.stringify(forged, null, 2)}\n`);
    recordThreadHop(apiCfg.root, forged.thread, 1);
    const row = readInbox(frontCfg).find((r) => r.path === sent.path);
    expect(row?.invalid).toMatch(/hop limit/);
    expect(row?.message).toBeUndefined();
  });

  test("watchOnce and inboxFresh report only unseen ids", () => {
    const from = loadBusConfig(api)!;
    const sent = sendMessage(from, { to: "front", type: "request", body: { text: "watch me" } });
    if (!("message" in sent)) throw new Error("expected send");
    const frontCfg = loadBusConfig(front)!;
    const seen = new Set<string>();
    const first = inboxFresh(frontCfg, seen);
    expect(first.ids).toContain(sent.message.id);
    expect(first.digest).toContain("new message");
    expect(first.digest).toContain("watch me");
    for (const id of first.ids) seen.add(id);
    expect(inboxFresh(frontCfg, seen).ids).toEqual([]);
    const again = watchOnce(frontCfg, seen);
    expect(again.ids).toEqual([]);
    const extra = sendMessage(from, { to: "front", type: "request", body: { text: "another watch" } });
    if (!("message" in extra)) throw new Error("expected send");
    const tick = watchOnce(frontCfg, seen);
    expect(tick.ids).toContain(extra.message.id);
    expect(tick.lines.join("\n")).toContain(extra.message.id);
  });

  test("orch bus watch --once prints a new inbox row", async () => {
    const from = loadBusConfig(api)!;
    const sent = sendMessage(from, { to: "front", type: "request", body: { text: "cli watch" } });
    if (!("message" in sent)) throw new Error("expected send");
    const { bus } = await import("../src/bus/cli.ts");
    const lines: string[] = [];
    const orig = console.log;
    const prev = process.env.ORCH_CONFIG;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    process.env.ORCH_CONFIG = join(front, "orch.yaml");
    try {
      await bus(["watch", "--once"]);
    } finally {
      if (prev === undefined) delete process.env.ORCH_CONFIG;
      else process.env.ORCH_CONFIG = prev;
      console.log = orig;
    }
    expect(lines.join("\n")).toContain(sent.message.id);
  });

  test("more than two round-trips escalate instead of sending", () => {
    const apiCfg = loadBusConfig(api)!;
    const frontCfg = loadBusConfig(front)!;
    const first = sendMessage(apiCfg, { to: "front", type: "request", body: { text: "r1" } });
    if (!("message" in first)) throw new Error("expected send");
    let thread = first.message.thread;
    const reply = (from: typeof apiCfg, to: string, hopHint: number) => {
      const out = sendMessage(from, { to, type: "reply", thread, body: { text: `h${hopHint}` } });
      if ("message" in out) thread = out.message.thread;
      return out;
    };
    expect("message" in reply(frontCfg, "api", 2)).toBe(true);
    expect("message" in reply(apiCfg, "front", 3)).toBe(true);
    expect("message" in reply(frontCfg, "api", 4)).toBe(true);
    const over = reply(apiCfg, "front", 5);
    expect("escalated" in over).toBe(true);
    if (!("escalated" in over)) return;
    expect(over.reason).toMatch(/round-trips/);
    expect(over.escalated.hop).toBeGreaterThan(MAX_HOPS);
    expect(readInbox(frontCfg).some((r) => r.message?.id === over.escalated.id)).toBe(false);
    expect(readInbox(apiCfg, "escalate").some((r) => r.message?.id === over.escalated.id)).toBe(true);
  });

  test("a request that would change the owned contract escalates", () => {
    const frontCfg = loadBusConfig(front)!;
    const out = sendMessage(frontCfg, {
      to: "api", type: "request",
      body: { text: "break it", files: ["openapi.yaml"] },
    });
    expect("escalated" in out).toBe(true);
    if (!("escalated" in out)) return;
    expect(out.reason).toMatch(/owned contract/);
    expect(readInbox(loadBusConfig(api)!).some((r) => r.message?.id === out.escalated.id)).toBe(false);
  });

  test("writing outside the declared inbox or into a neighbor repo is refused", () => {
    const config = loadBusConfig(api)!;
    expect(() => assertInboxWrite(config.root, "front", join(front, "secret.txt"))).toThrow(/outside inbox/);
    expect(() => assertInboxWrite(config.root, "../etc", join(config.root, "etc", "inbox", "x.json"))).toThrow(/invalid project name/);
    expect(() => assertNotRepoWrite(config, join(front, "src", "hack.ts"))).toThrow(/neighbor repo/);
  });

  test("ack moves a valid message out of the inbox", () => {
    const from = loadBusConfig(api)!;
    const sent = sendMessage(from, { to: "front", type: "request", body: { text: "ack me" } });
    if (!("message" in sent)) throw new Error("expected send");
    const dest = ackMessage(loadBusConfig(front)!, sent.message.id);
    expect(dest).toContain("/ack/");
    expect(readInbox(loadBusConfig(front)!).some((r) => r.message?.id === sent.message.id)).toBe(false);
  });

  test("draft writes a spec in this project's folder, never in the neighbor repo", () => {
    const from = loadBusConfig(api)!;
    const sent = sendMessage(from, { to: "front", type: "request", body: { text: "add a header", files: ["src/client.ts"] } });
    if (!("message" in sent)) throw new Error("expected send");
    const out = draftSpec(loadBusConfig(front)!, sent.message.id);
    expect(out.path).toContain("/.orch/front/specs/");
    expect(out.spec).toContain("add a header");
    expect(out.spec).toContain("never write outside this repository");
    expect(out.path.startsWith(front)).toBe(false);
  });

  test("contract notice and consumer test", () => {
    const apiCfg = loadBusConfig(api)!;
    const first = noticeContract(apiCfg, new Date("2026-10-31T12:00:00Z"));
    expect("version" in first).toBe(true);
    if (!("version" in first)) return;
    expect(first.version).toBe(1);
    expect(first.sent).toEqual(["front"]);
    const inbox = readInbox(loadBusConfig(front)!);
    expect(inbox.some((r) => r.message?.type === "contract" && r.message.body.version === 1)).toBe(true);
    expect(noticeContract(apiCfg)).toMatchObject({ unchanged: true });
    writeFileSync(join(api, "openapi.yaml"), "openapi: 3.0.3\ninfo: { title: demo, version: '2' }\npaths: {}\n");
    const second = noticeContract(apiCfg);
    expect("version" in second && second.version).toBe(2);
    expect(testContract(join(front, "openapi.yaml")).ok).toBe(true);
    writeFileSync(join(front, "broken.yaml"), "{");
    expect(testContract(join(front, "broken.yaml")).ok).toBe(false);
  });

  test("verifyMessage rejects a forged mac", () => {
    const key = Buffer.from("k");
    const signed = signMessage({
      id: "1", thread: "t", hop: 1, at: "2026-10-31T00:00:00Z",
      from: "api", to: "front", type: "request", body: { text: "x" },
    }, key);
    expect(verifyMessage(signed, key)).toBe(true);
    expect(verifyMessage({ ...signed, mac: "0".repeat(64) }, key)).toBe(false);
    expect(parseMessage({ ...signed, hop: 0 })).toBeNull();
  });

  test("session-start injects the inbox as a request, not an order", async () => {
    const from = loadBusConfig(api)!;
    sendMessage(from, { to: "front", type: "request", body: { text: "please add CORS" } });
    const out = await runHook("session-start", "claude", { cwd: front, session_id: "bus-start", source: "startup" }, {
      ORCH_LEAD: "1", ORCH_SESSION: "bus-start", ORCH_STATE: join(root, "hook-state"),
      HOME: process.env.HOME, ORCH_BUS_ROOT: busRoot, ORCH_MEMORY: "off",
    });
    expect(out).toContain("please add CORS");
    expect(out).toContain("never an order");
  });

  test("prompt-submit injects only new inbox messages after session-start", async () => {
    const from = loadBusConfig(api)!;
    sendMessage(from, { to: "front", type: "request", body: { text: "first-seen" } });
    const hookEnv = {
      ORCH_LEAD: "1", ORCH_SESSION: "bus-watch", ORCH_STATE: join(root, "hook-state-watch"),
      HOME: process.env.HOME, ORCH_BUS_ROOT: busRoot, ORCH_MEMORY: "off",
    };
    const start = await runHook("session-start", "claude", { cwd: front, session_id: "bus-watch", source: "startup" }, hookEnv);
    expect(start).toContain("first-seen");
    const again = await runHook("prompt-submit", "claude", {
      cwd: front, session_id: "bus-watch", prompt: "what is waiting in the inbox?",
    }, hookEnv);
    expect(again).not.toContain("first-seen");
    sendMessage(from, { to: "front", type: "request", body: { text: "second-seen" } });
    const fresh = await runHook("prompt-submit", "claude", {
      cwd: front, session_id: "bus-watch", prompt: "check the inbox again please",
    }, hookEnv);
    expect(fresh).toContain("second-seen");
    expect(fresh).not.toContain("first-seen");
  });

  test("formatList names refused signatures", () => {
    expect(formatList([{ path: "/x/bad.json", invalid: "invalid signature" }])).toContain("REFUSED");
  });

  test("pair key lives under the local keys dir, not the shared bus folder", () => {
    const config = loadBusConfig(api)!;
    const path = pairKeyPath(config.keys, "api", "front");
    expect(path.startsWith(join(root, "home", ".orch", "bus-keys"))).toBe(true);
    expect(path.includes(`${busRoot}/keys/`)).toBe(false);
    expect(statSync(config.keys).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(formatStatus(config)).toContain(`KEYS: ${config.keys}`);
  });

  test("send refuses when the pair key is missing", () => {
    const config = loadBusConfig(api)!;
    const path = pairKeyPath(config.keys, "api", "front");
    const kept = readFileSync(path);
    unlinkSync(path);
    try {
      expect(() => sendMessage(config, { to: "front", type: "request", body: { text: "no key" } })).toThrow(/missing pair key/);
    } finally {
      writeFileSync(path, kept, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
  });

  test("send refuses when the pair key is world-readable", () => {
    const config = loadBusConfig(api)!;
    const path = pairKeyPath(config.keys, "api", "front");
    chmodSync(path, 0o644);
    try {
      expect(() => loadPairKey(config, "api", "front")).toThrow(/too open/);
      expect(() => sendMessage(config, { to: "front", type: "request", body: { text: "open" } })).toThrow(/too open/);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test("warns when a key still lives under the shared bus folder", () => {
    const config = loadBusConfig(api)!;
    const legacy = legacyPairKeyPath(config.root, "api", "front");
    mkdirSync(join(config.root, "keys"), { recursive: true });
    writeFileSync(legacy, "00".repeat(32));
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      loadPairKey(config, "api", "front");
      expect(warnings.join("\n")).toMatch(/shared bus folder/);
      expect(warnings.join("\n")).toContain(legacy);
    } finally {
      console.warn = orig;
      unlinkSync(legacy);
    }
  });

  test("orch bus key init/export/import via the CLI", () => {
    const dest = join(root, "exported.key");
    const orch = join(import.meta.dir, "../src/orch.ts");
    const env = { ...process.env, ORCH_HOME: join(root, "home"), ORCH_BUS_ROOT: busRoot, HOME: process.env.HOME };
    const init = spawnSync(process.execPath, [orch, "bus", "key", "init", "--to", "front"], { cwd: api, encoding: "utf8", env });
    expect(init.status).toBe(0);
    expect(init.stdout).toMatch(/EXISTS|CREATED/);
    const exp = spawnSync(process.execPath, [orch, "bus", "key", "export", "--to", "front", "--file", dest], { cwd: api, encoding: "utf8", env });
    expect(exp.status).toBe(0);
    expect(existsSync(dest)).toBe(true);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    const imp = spawnSync(process.execPath, [orch, "bus", "key", "import", "--to", "api", "--file", dest], { cwd: front, encoding: "utf8", env });
    expect(imp.status).toBe(0);
    expect(imp.stdout).toContain("IMPORTED");
  });

  test("export/import provisions the same key on a neighbor with a private store", () => {
    const isolated = join(root, "front-keys");
    const isoYaml = join(front, "orch.iso.yaml");
    writeFileSync(isoYaml, `name: front
bus:
  root: ${busRoot}
  keys: ${isolated}
  neighbors:
    - name: api
      path: ${api}
      contract: openapi.yaml
      role: owner
`);
    const prev = process.env.ORCH_CONFIG;
    const apiCfg = loadBusConfig(api)!;
    const sent = sendMessage(apiCfg, { to: "front", type: "request", body: { text: "need import" } });
    expect("message" in sent).toBe(true);
    process.env.ORCH_CONFIG = isoYaml;
    try {
      const isolatedFront = loadBusConfig(front)!;
      expect(isolatedFront.keys).toBe(isolated);
      const unread = readInbox(isolatedFront);
      expect(unread.some((r) => r.invalid?.includes("missing pair key"))).toBe(true);
      const hex = exportPairKey(apiCfg, "front");
      importPairKey(isolatedFront, "api", hex);
      const inbox = readInbox(isolatedFront);
      expect(inbox.some((r) => r.message && !r.invalid)).toBe(true);
      expect(statSync(isolated).mode & 0o777).toBe(0o700);
      expect(statSync(pairKeyPath(isolated, "api", "front")).mode & 0o777).toBe(0o600);
    } finally {
      if (prev === undefined) delete process.env.ORCH_CONFIG;
      else process.env.ORCH_CONFIG = prev;
    }
  });
});
