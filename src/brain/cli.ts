// orch brain: the memory brain's commands. Loaded on demand by orch.ts, so
// the Postgres client and the model SDK stay out of every other command.
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../core/paths.ts";
import { envFileWarning } from "../core/env.ts";
import { bound } from "../core/output.ts";
import { loadProfile } from "../core/profile.ts";
import { activeSpace, embed } from "../llm/llm.ts";
import { callerFromEnv, listNotes, projectKey } from "../mem/mem.ts";
import { backup, composeUp, initSecrets, provision, pruneBackups, restoreCheck, statusLines } from "./admin.ts";
import { type BrainConfig, loadBrainConfig, openDomain } from "./db.ts";
import { importNotes } from "./import.ts";
import { embedPending, type Hit, searchMemories } from "./store.ts";
import { seedHindsight } from "../memory/seed.ts";
import { loadHindsightConfig } from "../memory/hindsight.ts";

export const BRAIN_USAGE = `usage: orch brain init                 write missing credentials to .env
       orch brain up                   start brain-postgres and hindsight (infra/compose.yml)
       orch brain provision            databases, roles, grants, migrations, hindsight
       orch brain status
       orch brain import-notes [--domain projets]
       orch brain embed [--domain d]   fill missing vectors (calls the embed provider)
       orch brain search <query> [--domain d] [--limit n] [--all] [--text]
       orch brain eval                 recall cases of brain.yaml on the live base (embeds each query)
       orch brain hindsight-seed [--bank <base>] [--full]
       orch brain hindsight-rename <from> <to> [--drop bank,bank]   clone banks to the new name (no LLM), then drop the old
       orch brain snapshot --out <file>   export frozen vectors for a benchmark (no model call)
       orch brain ingest-transcripts [--projects <dir>] --allow-paid [--max-usd n] [--max-chunks n] [--dry-run]
       orch brain backup
       orch brain restore-check`;

// Searched by default: every domain but the explicit-only ones.
function domains(c: BrainConfig, picked?: string): string[] {
  if (!picked) return c.domains.filter((d) => !c.explicit_only.includes(d));
  if (!c.domains.includes(picked)) throw new Error(`brain: unknown domain ${picked} (domains: ${c.domains.join(", ")})`);
  return [picked];
}

export async function brain(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { domain: { type: "string" }, limit: { type: "string" }, all: { type: "boolean" }, text: { type: "boolean" }, bank: { type: "string" }, full: { type: "boolean" }, out: { type: "string" }, projects: { type: "string" }, "allow-paid": { type: "boolean" }, "max-usd": { type: "string" }, "max-chunks": { type: "string" }, "dry-run": { type: "boolean" }, drop: { type: "string" } },
  });
  const c = loadBrainConfig();
  const warning = envFileWarning();
  if (warning && sub !== "init") console.error(`warning: ${warning}`);
  if (sub === "init") {
    const written = initSecrets(c);
    console.log(written.length ? `wrote ${written.join(", ")} to .env` : "every brain credential is already set");
  } else if (sub === "up") {
    composeUp();
    console.log(`${c.container} up on ${c.host}:${c.port}`);
  } else if (sub === "provision") {
    for (const l of await provision(c)) console.log(l);
  } else if (sub === "status") {
    const { lines, unavailable } = await statusLines(c);
    for (const l of lines) console.log(l);
    if (unavailable) throw unavailable;
  } else if (sub === "import-notes") {
    const domain = domains(c, values.domain ?? "projets")[0];
    const notes = listNotes({ ...callerFromEnv(), lead: true, lane: false }, { all: true });
    const db = openDomain(c, domain, "rw");
    try {
      const r = await importNotes(db, notes, projectKey());
      console.log(`${domain}: ${notes.length} notes, ${r.added} added, ${r.existing} already there, ${r.superseded} supersede links, ${r.forgotten} forgotten`);
      for (const u of r.unresolved) console.log(`unresolved: ${u}`);
    } finally {
      await db.close();
    }
  } else if (sub === "embed") {
    const space = activeSpace();
    for (const d of domains(c, values.domain)) {
      const db = openDomain(c, d, "rw");
      try {
        const n = await embedPending(db, space, async (texts) => {
          const r = await embed(texts, "document");
          if (r.space !== space) throw new Error(`brain: embed provider switched to space ${r.space} during the run`);
          return r.vectors;
        });
        console.log(`${d}: ${n} vectors written (${space})`);
      } finally {
        await db.close();
      }
    }
  } else if (sub === "snapshot") {
    if (!values.out) throw new Error("brain snapshot: --out is required");
    const db = openDomain(c, "projets", "ro");
    try {
      const { writeBrainSnapshot } = await import("../memory/brain-recall.ts");
      const { loadConfig } = await import("../llm/llm.ts");
      await writeBrainSnapshot(db, values.out, { space: activeSpace(), dimensions: loadConfig().dimensions, project: projectKey() });
      console.log(`brain snapshot saved to ${values.out}`);
    } finally { await db.close(); }
  } else if (sub === "ingest-transcripts") {
    if (!values["allow-paid"] && !values["dry-run"]) throw new Error("brain ingest-transcripts: embeddings are billable; --allow-paid is required (or --dry-run)");
    if (process.env.ORCH_LANE === "1" || process.env.ORCH_MEM_SANDBOX || process.env.ORCH_BENCH_RUN || process.env.ORCH_MEMORY === "off") throw new Error("brain ingest-transcripts: refused in workers, benchmarks or disabled memory");
    const maxUsd = values["max-usd"] !== undefined ? Number(values["max-usd"]) : undefined;
    const maxChunks = values["max-chunks"] !== undefined ? Number(values["max-chunks"]) : undefined;
    if (maxUsd !== undefined && (!Number.isFinite(maxUsd) || maxUsd < 0)) throw new Error("brain ingest-transcripts: --max-usd must be a non-negative number");
    if (maxChunks !== undefined && (!Number.isInteger(maxChunks) || maxChunks < 0)) throw new Error("brain ingest-transcripts: --max-chunks must be a non-negative integer");
    const db = openDomain(c, "projets", "rw");
    try {
      const { ingestTranscripts } = await import("../memory/transcripts.ts");
      const { loadConfig } = await import("../llm/llm.ts");
      const space = activeSpace();
      const result = await ingestTranscripts(db, {
        projects: values.projects ?? join(homedir(), ".claude", "projects"), state: stateDir(), space, dimensions: loadConfig().dimensions,
        allowPaid: !!values["allow-paid"], allowProjects: c.ingest_projects, maxUsd, maxChunks, dryRun: !!values["dry-run"],
        embed: async (texts) => { const r = await embed(texts, "document"); if (r.space !== space) throw new Error("transcript: embedding space changed"); return r.vectors; },
      });
      console.log(`transcripts: ${result.files} files, ${result.added} chunks, ${result.embedded} embeddings, ${result.forgotten} superseded or removed chunks${values["dry-run"] ? " (dry-run)" : ""}`);
    } finally { await db.close(); }
  } else if (sub === "hindsight-rename") {
    // orch brain hindsight-rename <from> <to> [--drop bank,bank]: no LLM call;
    // the clone re-embeds facts (embedding provider, a few cents at most).
    const [from, to] = positionals;
    if (!from || !to) throw new Error("usage: orch brain hindsight-rename <from> <to> [--drop bank,bank]");
    const { renameBanks, renameSeedBase } = await import("../memory/rename-banks.ts");
    const r = await renameBanks(loadHindsightConfig(), from, to, { drop: values.drop?.split(",").filter(Boolean), log: (l) => console.log(l) });
    console.log(`hindsight-rename: ${r.moved.length} moved, ${r.dropped.length} dropped, ${r.kept.length} kept`);
    if (r.kept.length) {
      console.log("seed manifest left as is: banks were kept under the old name (run again once fixed)");
      process.exitCode = 1;
    } else console.log(`seed manifest: ${await renameSeedBase(from, to, r)} namespace(s) moved to ${to}`);
  } else if (sub === "hindsight-seed") {
    const r = await seedHindsight(loadHindsightConfig(), values.bank ?? c.hindsight.bank, { full: values.full });
    console.log(`hindsight-seed: ${r.sent} sent, ${r.skipped} unchanged, ${r.deleted} deleted, ${r.failed} failed, ${r.notes} notes + ${r.exhaust} exhaust, ${Math.round(r.ms / 1000)} s`);
    if (r.failed > 0) process.exitCode = 1;
  } else if (sub === "search" && positionals.length) {
    const query = positionals.join(" ");
    const limit = values.limit ? Number(values.limit) : 5;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("brain search: --limit must be a positive integer");
    const picked = domains(c, values.domain);
    // One query vector for every domain, recall by meaning; --text searches
    // the words instead, offline.
    const vector = values.text ? undefined : (await embed([query], "query").catch((e: Error) => {
      throw new Error(`${e.message} (orch brain search --text searches without it)`);
    })).vectors[0];
    const space = values.text ? undefined : activeSpace();
    const hits: (Hit & { domain: string })[] = [];
    for (const d of picked) {
      const db = openDomain(c, d, "ro");
      try {
        for (const h of await searchMemories(db, query, { limit, all: values.all, vector, space })) hits.push({ ...h, domain: d });
      } finally {
        await db.close();
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const lines = hits.slice(0, limit).map((h) =>
      `${h.domain}/${h.memory.id.slice(0, 8)}  ${h.memory.occurred_at.toISOString().slice(0, 10)}  [${h.via}]  ${h.memory.source}:${h.memory.source_ref}\n  ${(h.memory.title ?? h.memory.body).split("\n")[0].slice(0, 160)}`);
    console.log(bound(lines.length ? lines.join("\n") : "no memory", loadProfile().limits.report_max_bytes));
  } else if (sub === "eval") {
    if (!c.recall.length) throw new Error("brain eval: no recall case in catalog/brain.yaml");
    const space = activeSpace();
    const { vectors } = await embed(c.recall.map((k) => k.query), "query");
    let found = 0;
    for (const [i, k] of c.recall.entries()) {
      const db = openDomain(c, k.domain, "ro");
      try {
        const hits = await searchMemories(db, k.query, { limit: 3, vector: vectors[i], space });
        const rank = hits.findIndex((h) => h.memory.source_ref.includes(k.expect)) + 1;
        if (rank) found++;
        console.log(`${rank ? `ok #${rank}` : "MISS "}  ${k.domain}: "${k.query}" -> ${k.expect}${rank ? "" : ` (top: ${hits[0]?.memory.source_ref ?? "none"})`}`);
      } finally {
        await db.close();
      }
    }
    console.log(`${found}/${c.recall.length} in the top 3, minimum ${c.recall_min}`);
    if (found < c.recall_min) process.exitCode = 1;
  } else if (sub === "backup") {
    console.log(`backup written to ${await backup(c)}`);
  } else if (sub === "restore-check") {
    const r = await restoreCheck(c);
    for (const l of r.lines) console.log(l);
    if (!r.ok) process.exitCode = 1;
    // Rotate only once the newest backup is proven to restore: a failing check
    // keeps every dump, retries included.
    else {
      const dropped = pruneBackups(c);
      if (dropped.length) console.log(`rotation: ${dropped.length} old backups removed (7 daily, 4 weekly kept)`);
    }
  } else {
    console.log(BRAIN_USAGE);
    process.exitCode = 2;
  }
}
