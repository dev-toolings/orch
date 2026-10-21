#!/usr/bin/env bun
// Free, read-only check of the close-note detector on real notes: replays each
// note of a store as an add against the earlier notes of that store, and
// reports what `orch mem add` would have listed. A note recorded as a
// supersede is the ground truth: its old note should be listed. Nothing is
// written. Usage: bun scripts/mem-dedup-replay.ts [--threshold n] [--quiet] <store-dir>...
// (default stores: operator and lead under the state dir, and .orch/mem here).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stateDir } from "../src/core/paths.ts";
import { SIMILAR_THRESHOLD, similar } from "../src/mem/similar.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { threshold: { type: "string" }, quiet: { type: "boolean" } } });
const threshold = values.threshold ? Number(values.threshold) : SIMILAR_THRESHOLD;
const stores = positionals.length ? positionals : [join(stateDir(), "mem", "operator"), join(stateDir(), "mem", "lead"), join(process.cwd(), ".orch", "mem")];
const line = (s: string) => s.replace(/\s+/g, " ").slice(0, 140);
let adds = 0, flagged = 0, truth = 0, found = 0;
for (const dir of stores.filter(existsSync)) {
  const notes = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().flatMap((f) => {
    const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(readFileSync(join(dir, f), "utf8"));
    if (!m) return [];
    const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(m[1])?.[1];
    return [{ id: field("id") ?? f, body: m[2].trim(), supersedes: field("supersedes") }];
  });
  notes.forEach((n, i) => {
    if (!i) return;
    adds++;
    const hits = similar(n.body, notes.slice(0, i), (e) => e.body, threshold).slice(0, 3);
    if (n.supersedes) {
      truth++;
      if (hits.some((h) => h.item.id === n.supersedes)) found++;
      else if (!values.quiet) console.log(`MISSED supersede ${n.id}\n  new: ${line(n.body)}`);
    }
    if (!hits.length) return;
    flagged++;
    if (values.quiet) return;
    console.log(`FLAG ${n.id}${n.supersedes ? ` (supersedes ${n.supersedes})` : ""}\n  new: ${line(n.body)}`);
    for (const h of hits) console.log(`  ${h.score.toFixed(2)}${h.item.id === n.supersedes ? " TRUE" : ""} ${h.item.id}: ${line(h.item.body)}`);
  });
}
console.log(`threshold ${threshold}: ${flagged}/${adds} adds flagged, ${found}/${truth} recorded supersedes found`);
