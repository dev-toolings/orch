#!/usr/bin/env bun
// Report for scripts/token-bench.ts, no model call: per harness and arm, the
// quality and token medians, and the paired ratio against the base arm (same
// question, same repetition) with a 90% bootstrap interval.
// Usage: bun scripts/token-bench-report.ts <outDir> [<outDir>...]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = { h: string; arm: string; q: string; rep: number; warm: boolean; ok: boolean; score: number; max: number; verify: boolean | null; outScope: string[];
  uncached: number; cacheWrite: number; cacheRead: number; output: number; total: number; turns: number | null; usd: number | null; secs: number; rtkCmds: number | null; session: string | null };

import { QUESTIONS } from "./token-bench.ts";

// Answers are rescored with the current facts, so a fixed regex needs no rerun.
const facts = new Map(QUESTIONS.map((q) => [q.id, q.facts]));
const rows: Row[] = process.argv.slice(2).flatMap((d) => readFileSync(join(d, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row & { answer?: string }))
  .filter((r) => !r.warm)
  .map((r) => (r.verify == null && facts.get(r.q)?.length ? { ...r, score: facts.get(r.q)!.filter((re) => re.test(r.answer ?? "")).length } : r));
// Input-equivalent tokens: cache writes cost about 1.25x input, cache reads about 0.1x (Anthropic and OpenAI list prices).
const eq = (r: Row) => r.uncached + 1.25 * r.cacheWrite + 0.1 * r.cacheRead;
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2) : NaN; };
const k = (n: number) => (Number.isNaN(n) ? "-" : n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
// Geometric mean of paired ratios, bootstrapped over pairs.
function ratioCI(ratios: number[]): string {
  if (ratios.length < 3) return "-";
  const gm = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
  const boots = Array.from({ length: 2000 }, () => gm(ratios.map(() => ratios[Math.floor(rand() * ratios.length)]!))).sort((a, b) => a - b);
  const pct = (x: number) => `${x >= 1 ? "+" : ""}${((x - 1) * 100).toFixed(0)}%`;
  return `${pct(gm(ratios))} [${pct(boots[100]!)}, ${pct(boots[1899]!)}]`;
}

const groups = new Map<string, Row[]>();
for (const r of rows) { const key = `${r.h}|${r.arm}|${r.q === "floor" ? "floor" : r.q.startsWith("e") ? "edit" : "qa"}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
const base = new Map(rows.filter((r) => r.arm === "base").map((r) => [`${r.h}|${r.q}|${r.rep}`, r]));

console.log("| harness | kind | arm | n | quality | eq. input (med) | output (med) | turns (med) | secs (med) | USD (mean) | eq. input vs base | output vs base | rtk cmds |");
console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|");
for (const [key, rs] of [...groups].sort()) {
  const [h, arm, kind] = key.split("|");
  const quality = kind === "floor" ? "-" : `${((100 * rs.reduce((a, r) => a + r.score, 0)) / rs.reduce((a, r) => a + r.max, 0)).toFixed(0)}%`;
  const pairs = rs.map((r) => [r, base.get(`${r.h}|${r.q}|${r.rep}`)] as const).filter(([r, b]) => b && arm !== "base" && eq(b) > 0 && eq(r) > 0);
  const usd = rs.filter((r) => r.usd != null);
  console.log(`| ${h} | ${kind} | ${arm} | ${rs.length} | ${quality} | ${k(med(rs.map(eq)))} | ${k(med(rs.map((r) => r.output)))} | ${med(rs.map((r) => r.turns ?? NaN).filter((x) => !Number.isNaN(x))) || "-"} | ${med(rs.map((r) => r.secs)).toFixed(0)} | ${usd.length ? (usd.reduce((a, r) => a + r.usd!, 0) / usd.length).toFixed(3) : "-"} | ${ratioCI(pairs.map(([r, b]) => eq(r) / eq(b!)))} | ${ratioCI(pairs.map(([r, b]) => (r.output || 1) / (b!.output || 1)))} | ${rs.some((r) => r.rtkCmds != null) ? (rs.reduce((a, r) => a + (r.rtkCmds ?? 0), 0) / rs.length).toFixed(1) : "-"} |`);
}

const failed = rows.filter((r) => !r.ok);
if (failed.length) console.log(`\nfailed runs: ${failed.length} (${[...new Set(failed.map((r) => `${r.h}/${r.arm}`))].join(", ")})`);
const scope = rows.filter((r) => r.outScope?.length);
if (scope.length) console.log(`edits outside FILES: ${scope.map((r) => `${r.h}/${r.arm}/${r.q}#${r.rep}: ${r.outScope.join(" ")}`).join("; ")}`);
// Grok loads the operator's skills (ctx-explore among them): did a non-ctx arm call ctx anyway?
const sessions = join(process.env.HOME!, ".grok", "sessions");
if (existsSync(sessions)) {
  // Only the bench's own session folders; prompt_context.json lists every skill name, so it is skipped.
  const dirs = readdirSync(sessions).filter((n) => n.includes("tokbench"));
  const leaks = rows.filter((r) => r.h === "grok" && !r.arm.includes("ctx") && r.session).filter((r) => {
    const d = dirs.map((n) => join(sessions, n, r.session!)).find((p) => existsSync(p));
    if (!d) return false;
    // Only the model's own tool calls count: the system prompt lists every skill path.
    try {
      return readFileSync(join(d, "chat_history.jsonl"), "utf8").split("\n").filter(Boolean).some((l) => {
        const m = JSON.parse(l);
        return m.type === "assistant" && /\bctx (search|graph|pack|map|explore)\b|ctx-explore\/SKILL/.test(JSON.stringify(m.tool_calls ?? []));
      });
    } catch { return false; }
  });
  console.log(`grok non-ctx runs that used ctx anyway: ${leaks.length}${leaks.length ? ` (${leaks.map((r) => `${r.arm}/${r.q}#${r.rep}`).join(", ")})` : ""}`);
}
