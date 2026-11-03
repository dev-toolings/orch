// Docs retrieval eval: does `orch docs search` return the expected page?
// Free (local ctx only, no model call). Run: bun scripts/docs-eval.ts
// Arms: "fr" = the question as the operator would ask it, "kw" = the query the lead would write.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { docsDir, loadSources, searchDocs } from "../src/docs/docs.ts";

type Q = { id: string; stack: string; fr: string; kw: string; expect: string[] };
const questions: Q[] = JSON.parse(readFileSync(join(import.meta.dir, "docs-eval.questions.json"), "utf8"));
const root = docsDir();
const sources = loadSources();

const missing = questions.flatMap((q) => q.expect.filter((e) => {
  const [id, path] = e.split(/:(.+)/);
  return !existsSync(join(root, id, path));
}).map((e) => `${q.id} ${e}`));
if (missing.length) { console.error(`expected pages not in corpus:\n${missing.join("\n")}`); process.exit(1); }

// Ranked distinct files from search output lines "<source>: <path>".
function rankedFiles(lines: string[]): string[] {
  const files: string[] = [];
  for (const l of lines) {
    const m = l.match(/^([^:\s]+): (\S+\.(?:md|mdx|rst|txt))$/);
    if (m && !files.includes(`${m[1]}:${m[2]}`)) files.push(`${m[1]}:${m[2]}`);
  }
  return files;
}

const budgets = [600, 3000];
const arms = ["fr", "kw"] as const;
const tally: Record<string, { at1: number; at5: number; seen: number }> = {};
const misses: string[] = [];
for (const b of budgets) for (const a of arms) {
  const key = `${a} budget=${b}`;
  tally[key] = { at1: 0, at5: 0, seen: 0 };
  for (const q of questions) {
    const files = rankedFiles(searchDocs(q[a], sources, { stack: q.stack, budgetTokens: b }));
    const rank = files.findIndex((f) => q.expect.includes(f));
    if (rank === 0) tally[key].at1++;
    if (rank >= 0 && rank < 5) tally[key].at5++;
    if (rank >= 0) tally[key].seen++;
    else misses.push(`${key.padEnd(16)} ${q.id.padEnd(8)} got: ${files.slice(0, 3).join(", ") || "(nothing)"}`);
  }
}

const n = questions.length;
const pct = (x: number) => `${x}/${n} (${Math.round((100 * x) / n)} %)`;
console.log(`questions: ${n}\n`);
console.log("arm              hit@1          hit@5          anywhere");
for (const [k, t] of Object.entries(tally)) console.log(`${k.padEnd(16)} ${pct(t.at1).padEnd(14)} ${pct(t.at5).padEnd(14)} ${pct(t.seen)}`);
console.log(`\nmisses:\n${misses.join("\n")}`);
