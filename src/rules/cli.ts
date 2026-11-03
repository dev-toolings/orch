import { parseArgs } from "node:util";
import { readLedger } from "../lanes/ledger.ts";
import { addRule, harvestLedger, readRules } from "./rules.ts";
import { benchRules, dryRunner, REFERENCE_MISSIONS } from "./bench.ts";

const USAGE = "usage: orch rule harvest | add --from gate|review|correction --text t | list | bench [--live]";

export function ruleCli(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const [sub, ...rest] = args;
  if (sub === "harvest") {
    const added = harvestLedger(readLedger());
    return `RULE HARVEST\nADDED: ${added.length}\n${added.map((r) => `${r.id}  ${r.source}  ${r.text}`).join("\n")}${added.length ? "\n" : ""}`;
  }
  if (sub === "list") {
    const rules = readRules();
    if (!rules.length) return "RULE LIST\n(none)\n";
    return `RULE LIST\n${rules.map((r) => `${r.id}  ${r.status}  ${r.source}  ${r.text}`).join("\n")}\n`;
  }
  if (sub === "add") {
    const { values } = parseArgs({
      args: rest,
      options: { from: { type: "string" }, text: { type: "string" } },
      strict: false,
    });
    const from = typeof values.from === "string" ? values.from : "";
    const text = typeof values.text === "string" ? values.text : "";
    if (!text.trim() || (from !== "gate" && from !== "review" && from !== "correction")) throw new Error(USAGE);
    const rule = addRule({ source: from, text, provenance: "cli" });
    return `RULE ADD\nID: ${rule.id}\nSTATUS: ${rule.status}\n${rule.text}\n`;
  }
  if (sub === "bench") {
    const live = rest.includes("--live");
    if (live) throw new Error("orch rule bench --live: not in this checkout; run without --live (dry) or wait for a live adapter");
    const out = benchRules({ rules: readRules(), runner: dryRunner, env });
    if (out.refused) {
      process.exitCode = 2;
      return `RULE BENCH\nSTATUS: refused\nREASON: ${out.refused}\n`;
    }
    return [
      "RULE BENCH",
      `MISSIONS: ${REFERENCE_MISSIONS.map((m) => m.id).join(", ")}`,
      `PASS: ${(out.score.passRate * 100).toFixed(0)}%  COST: $${out.score.costUsd.toFixed(2)}  ESC: ${out.score.escalations}`,
      `KEPT: ${out.kept.join(", ") || "none"}`,
      `PRUNED: ${out.pruned.join(", ") || "none"}`,
      ...out.results.map((r) => `${r.id}  ${r.pass ? "pass" : "fail"}  $${r.costUsd}  esc=${r.escalated}`),
    ].join("\n") + "\n";
  }
  throw new Error(USAGE);
}
