import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import {
  ackMessage, BUS_TYPES, draftSpec, exportPairKey, formatList, formatStatus,
  importPairKey, initPairKey, loadBusConfig, noticeContract, readInbox,
  sendMessage, testContract, watchOnce, type BusType,
} from "./bus.ts";

export const BUS_USAGE = `usage: orch bus list|status|send|ack|draft|notice|test|key|watch
  orch bus list
  orch bus status
  orch bus send --to <neighbor> --type request|contract|reply [--text t | --file f] [--thread id]
  orch bus ack <id>
  orch bus draft <id>
  orch bus notice
  orch bus test
  orch bus key init --to <neighbor>
  orch bus key export --to <neighbor> [--file f]
  orch bus key import --to <neighbor> --file f
  orch bus watch [--once] [--interval sec]`;

function requireConfig() {
  const config = loadBusConfig();
  if (!config) throw new Error("bus: no orch.yaml in this repository");
  return config;
}

function isType(value?: string): value is BusType {
  return !!value && (BUS_TYPES as readonly string[]).includes(value);
}

export async function bus(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      to: { type: "string" },
      type: { type: "string" },
      text: { type: "string" },
      file: { type: "string" },
      thread: { type: "string" },
      once: { type: "boolean" },
      interval: { type: "string" },
    },
  });
  if (sub === "list") {
    console.log(formatList(readInbox(requireConfig())));
  } else if (sub === "status") {
    process.stdout.write(formatStatus(requireConfig()));
  } else if (sub === "send") {
    if (!values.to || !isType(values.type)) throw new Error(BUS_USAGE);
    let body: Record<string, unknown> = {};
    if (values.file) {
      const raw = readFileSync(resolve(values.file), "utf8");
      const parsed = values.file.endsWith(".json") ? JSON.parse(raw) : parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bus send: file must be an object");
      body = parsed as Record<string, unknown>;
    }
    if (values.text) body = { ...body, text: values.text };
    if (!Object.keys(body).length) throw new Error("bus send: pass --text or --file");
    const out = sendMessage(requireConfig(), { to: values.to, type: values.type, body, thread: values.thread });
    if ("escalated" in out) {
      console.log(`ESCALATED ${out.escalated.id}  ${out.reason}\n${out.path}`);
      process.exitCode = 3;
    } else {
      console.log(`SENT ${out.message.id}  ${out.message.type}  ${out.message.from}->${out.message.to}  hop ${out.message.hop}\n${out.path}`);
    }
  } else if (sub === "ack") {
    const id = positionals[0];
    if (!id) throw new Error("usage: orch bus ack <id>");
    console.log(`ACK ${ackMessage(requireConfig(), id)}`);
  } else if (sub === "draft") {
    const id = positionals[0];
    if (!id) throw new Error("usage: orch bus draft <id>");
    const out = draftSpec(requireConfig(), id);
    console.log(`SPEC ${out.path}`);
  } else if (sub === "notice") {
    const out = noticeContract(requireConfig());
    if ("unchanged" in out) console.log(`UNCHANGED ${out.sha}`);
    else console.log(`NOTICE v${out.version}  ${out.sha}  to ${out.sent.join(", ") || "none"}`);
  } else if (sub === "test") {
    const config = requireConfig();
    const contracts = [...new Set(config.neighbors.map((n) => n.contract))];
    let failed = 0;
    for (const path of contracts) {
      const r = testContract(path);
      console.log(`${r.ok ? "OK" : "FAIL"}  ${path}${r.reason ? `  ${r.reason}` : ""}`);
      if (!r.ok) failed++;
    }
    if (!contracts.length) console.log("bus: no contract declared");
    if (failed) process.exitCode = 3;
  } else if (sub === "watch") {
    const config = requireConfig();
    const seen = new Set<string>();
    const tick = () => {
      const out = watchOnce(config, seen);
      for (const id of out.ids) seen.add(id);
      for (const line of out.lines) console.log(line);
    };
    tick();
    if (values.once) return;
    const sec = values.interval !== undefined ? Number(values.interval) : 2;
    if (!Number.isFinite(sec) || sec < 0.2) throw new Error("orch bus watch: --interval must be >= 0.2");
    const wait = Math.round(sec * 1000);
    await new Promise<void>((resolve) => {
      const timer = setInterval(tick, wait);
      const stop = () => { clearInterval(timer); resolve(); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } else if (sub === "key") {
    const action = positionals[0];
    if (!values.to || (action !== "init" && action !== "export" && action !== "import")) {
      throw new Error("usage: orch bus key init|export|import --to <neighbor> [--file f]");
    }
    const config = requireConfig();
    if (action === "init") {
      const out = initPairKey(config, values.to);
      console.log(`${out.created ? "CREATED" : "EXISTS"} ${out.path}`);
    } else if (action === "export") {
      const hex = exportPairKey(config, values.to);
      if (values.file) {
        const dest = resolve(values.file);
        writeFileSync(dest, `${hex}\n`, { mode: 0o600 });
        chmodSync(dest, 0o600);
        console.log(`EXPORTED ${dest}`);
      } else {
        process.stdout.write(`${hex}\n`);
      }
    } else {
      if (!values.file) throw new Error("usage: orch bus key import --to <neighbor> --file f");
      const out = importPairKey(config, values.to, readFileSync(resolve(values.file), "utf8"));
      console.log(`IMPORTED ${out.path}`);
    }
  } else {
    console.log(BUS_USAGE);
    process.exitCode = 2;
  }
}
