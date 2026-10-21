#!/usr/bin/env bun
// mem-bench-report <root>: one comparison table from mem-bench cell folders
// (any results.json under root). No model call: it reads the recorded runs and
// re-runs `orch mem search` locally for the recall column.
// Columns, per question of the memory arm: correct answers, corrections kept,
// seconds (mean and median), tokens (total, input, cached, output, reasoning),
// output tokens per second, USD; then the learn session; then recall@3, the
// share of questions whose note is in the top 3 of a search on the question.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { searchNotes } from "../src/mem/mem.ts";
import { FACTS } from "./mem-bench.ts";

type Run = { input?: number; cached?: number; output?: number; reasoning?: number; usd?: number | null; secs?: number; correct?: boolean };
type Row = { mem: Run; corrected: boolean };
type Result = { harness: string; config?: { model?: string; effort?: string; fast?: boolean | null; tags?: boolean }; learn: Run; rows: Row[] };

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const caller = { lead: false, lane: false, harness: "report", session: "" };

function cells(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "results.json"))) out.push(p);
    else out.push(...cells(p));
  }
  return out;
}

function recall(cell: string): number {
  const cwd = join(cell, "mem-repo"), state = join(cell, "mem-state");
  return FACTS.filter((f) => searchNotes(f.q, caller, { cwd, state, limit: 3 }).some((n) => norm(n.body).includes(norm(f.a)))).length;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

const root = process.argv[2];
if (!root) { console.error("usage: bun scripts/mem-bench-report.ts <root>"); process.exit(2); }
const head = ["harness", "model", "fast", "effort", "tags", "ok", "fix", "s/q", "p50", "tok/q", "in", "cached", "out", "reason", "out/s", "usd/q", "learn s", "learn usd", "recall@3"];
const table: string[][] = [];
for (const cell of cells(root)) {
  const r = JSON.parse(readFileSync(join(cell, "results.json"), "utf8")) as Result;
  const runs = r.rows.map((x) => x.mem);
  const n = runs.length;
  if (!n) continue;
  const sum = (key: keyof Run) => runs.reduce((s, x) => s + (Number(x[key]) || 0), 0);
  const secs = runs.map((x) => x.secs ?? 0);
  const tokens = sum("input") + sum("cached") + sum("output");
  const priced = runs.some((x) => x.usd != null);
  const fixes = r.rows.filter((x) => x.corrected);
  const c = r.config ?? {};
  table.push([
    r.harness, c.model ?? "?", c.fast == null ? "-" : c.fast ? "yes" : "no", c.effort ?? "?", c.tags == null ? "?" : c.tags ? "yes" : "no",
    `${runs.filter((x) => x.correct).length}/${n}`, `${fixes.filter((x) => x.mem.correct).length}/${fixes.length}`,
    (sum("secs") / n).toFixed(1), median(secs).toFixed(1),
    k(tokens / n), k(sum("input") / n), k(sum("cached") / n), String(Math.round(sum("output") / n)), String(Math.round(sum("reasoning") / n)),
    (sum("output") / Math.max(sum("secs"), 1)).toFixed(0),
    priced ? (sum("usd") / n).toFixed(4) : "quota",
    (r.learn.secs ?? 0).toFixed(0), r.learn.usd != null ? r.learn.usd.toFixed(2) : "quota",
    `${recall(cell)}/${FACTS.length}`,
  ]);
}
table.sort((a, b) => a.slice(0, 5).join(" ").localeCompare(b.slice(0, 5).join(" ")));
const width = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
const line = (row: string[]) => row.map((v, i) => (i < 5 ? v.padEnd(width[i]) : v.padStart(width[i]))).join("  ");
console.log([line(head), ...table.map(line)].join("\n"));
