import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBrainConfig } from "../brain/db.ts";
import { stateDir } from "../core/paths.ts";
import { ROOT } from "../core/profile.ts";
import { projectKey } from "../core/project.ts";
import { withFileLock } from "../lanes/lock.ts";
import { fileBackend, type MemBackend } from "../mem/backend.ts";
import { isActive, type Caller, type Note } from "../mem/mem.ts";
import { pool } from "../core/pool.ts";
import { deleteDocument, ensureBank, retain, type HindsightConfig, type RetainItem } from "./hindsight.ts";
import { inspectSecrets } from "./privacy.ts";

export interface SeedOpts {
  // `state` remains the compatibility shorthand for both paths.
  state?: string;
  sourceState?: string;
  manifestState?: string;
  full?: boolean;
  concurrency?: number;
  log?: (line: string) => void;
  store?: MemBackend;
  now?: Date;
  includeExhaust?: boolean;
}
export interface SeedResult { notes: number; exhaust: number; sent: number; skipped: number; deleted: number; failed: number; ms: number }

interface SeedNamespace { server: string; base: string; hashes: Record<string, Record<string, string>> }
interface SeedManifest { version: 2; namespaces: Record<string, SeedNamespace> }

const caller: Caller = { lead: true, lane: false, harness: "claude", session: "seed" };
const project = projectKey(ROOT);

function serverIdentity(config: HindsightConfig): string {
  const url = new URL(config.url);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function emptyManifest(): SeedManifest { return { version: 2, namespaces: {} }; }

function loadManifest(path: string, server: string, base: string): { manifest: SeedManifest; namespaceId: string; hashes: SeedNamespace["hashes"] } {
  const manifest = emptyManifest();
  if (!existsSync(path)) return { manifest, namespaceId: namespaceId(server, base), hashes: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`seed manifest is unreadable: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("seed manifest has an invalid shape");
  const root = parsed as Record<string, unknown>;
  if (root.version === undefined) {
    // The old flat bank/document map has no server identity, so it is never
    // trusted for skips or deletion in any destination namespace.
    if (Object.values(root).some((value) => typeof value !== "string")) throw new Error("legacy seed manifest has an invalid shape");
    return { manifest, namespaceId: namespaceId(server, base), hashes: {} };
  }
  if (root.version !== 2 || !root.namespaces || typeof root.namespaces !== "object" || Array.isArray(root.namespaces)) {
    throw new Error("seed manifest has an unsupported version or invalid namespaces");
  }
  manifest.namespaces = root.namespaces as Record<string, SeedNamespace>;
  for (const [id, entry] of Object.entries(manifest.namespaces)) {
    if (!entry || typeof entry !== "object" || typeof entry.server !== "string" || typeof entry.base !== "string" || !entry.hashes || typeof entry.hashes !== "object" || Array.isArray(entry.hashes)) {
      throw new Error(`seed manifest namespace ${id} is invalid`);
    }
    for (const [bank, documents] of Object.entries(entry.hashes)) {
      if (!documents || typeof documents !== "object" || Array.isArray(documents) || Object.values(documents).some((value) => typeof value !== "string")) {
        throw new Error(`seed manifest hashes for ${id}/${bank} are invalid`);
      }
    }
  }
  const id = namespaceId(server, base);
  const current = manifest.namespaces[id];
  if (current && (current.server !== server || current.base !== base)) throw new Error("seed manifest namespace identity mismatch");
  return { manifest, namespaceId: id, hashes: current ? structuredClone(current.hashes) : {} };
}

export function namespaceId(server: string, base: string): string {
  return createHash("sha256").update(JSON.stringify([server, base])).digest("hex");
}

const recordKey = (bank: string, documentId: string) => `${bank}\0${documentId}`;

export function noteItem(n: Note): RetainItem {
  const head = `Note orch mem ${n.id} (portée ${n.scope}, ${n.date.slice(0, 10)}${n.tags.length ? `, tags : ${n.tags.join(", ")}` : ""}) :`;
  return { content: `${head}\n${n.body}`, context: "orch mem note", document_id: `mem:${n.id}`, update_mode: "replace", timestamp: n.date, tags: [`scope:${n.scope}`, "source:orch-mem"] };
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const since = (days: number, now: Date) => new Date(now.getTime() - days * 86_400_000).toISOString();

// Keep the same report and journal inputs as the memory bench.
// A ledger row reaches a project bank only when its repo is a known project
// (a project note, or a ~/.orch/<project> folder): rows written before the
// ledger used projectKey carry worktree names (dev-depl-55, wt-ds41) and
// scratch repos carry throwaway names, and each would create a stray bank.
export function exhaustItems(state: string, base: string, now = new Date(), known?: ReadonlySet<string>): { bank: string; item: RetainItem }[] {
  const items: { bank: string; item: RetainItem }[] = [];
  for (const row of readJsonl(join(state, "lanes.jsonl")).filter((r) => String(r.at) >= since(14, now)).slice(-120)) {
    if (typeof row.repo !== "string" || !row.repo.trim()) continue;
    if (known && !known.has(row.repo)) continue;
    const { features: _f, ...rest } = row;
    items.push({ bank: `${base}-${row.repo}`, item: { content: `Lane ${String(row.kind)} ${String(row.id)} le ${String(row.at)} : ${JSON.stringify(rest)}`, context: "lane ledger", document_id: `lane:${String(row.id)}:${String(row.kind)}:${String(row.at)}`, update_mode: "replace", timestamp: String(row.at), tags: ["source:lanes"] } });
  }
  const journal = readJsonl(join(state, "routines", "journal.jsonl"));
  const keep = new Map<string, Record<string, unknown>>();
  for (const row of journal) {
    const id = String(row.id);
    if (row.ok === false && String(row.start) >= since(7, now)) keep.set(`${id}:${String(row.start)}`, row);
    keep.set(`${id}:last-${row.ok ? "ok" : "ko"}`, row);
  }
  for (const row of new Set(keep.values())) {
    const steps = (row.steps as { command: string; exit: number; ms: number; tail: string }[] | undefined ?? []).map((s) => `${s.command} (exit ${s.exit}, ${s.ms} ms${s.tail ? `, sortie : ${s.tail.slice(0, 200).replace(/\n/g, " / ")}` : ""})`).join(" ; ");
    items.push({ bank: `${base}-${project}`, item: { content: `Routine ${String(row.id)} lancée le ${String(row.start)} : ${row.ok ? "ok" : "échec"} ; étapes : ${steps}`, context: "routines journal", document_id: `routine:${String(row.id)}:${String(row.start)}`, update_mode: "replace", timestamp: String(row.start), tags: ["source:routines"] } });
  }
  const improve = join(state, "improve");
  if (existsSync(improve)) for (const f of readdirSync(improve).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-5)) items.push({ bank: base, item: { content: `Propositions de la routine improve du ${f.slice(0, 10)} :\n${readFileSync(join(improve, f), "utf8").slice(0, 6000)}`, context: "improve brief", document_id: `improve:${f.slice(0, 10)}`, timestamp: `${f.slice(0, 10)}T20:00:00Z`, update_mode: "replace", tags: ["source:improve"] } });
  // Reports of docs/cr, and the dated ones archived under docs/archive/<date>-*/
  // (same document id: archiving a report moves it, never drops it from the bank).
  const reports: string[] = [];
  const cr = join(ROOT, "docs", "cr");
  if (existsSync(cr)) for (const f of readdirSync(cr).filter((f) => f.endsWith(".md"))) reports.push(`docs/cr/${f}`);
  const archive = join(ROOT, "docs", "archive");
  if (existsSync(archive)) for (const d of readdirSync(archive).filter((d) => /^\d{4}-\d{2}-\d{2}-/.test(d)).sort()) {
    for (const f of readdirSync(join(archive, d)).filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(f))) reports.push(`docs/archive/${d}/${f}`);
  }
  for (const rel of reports) {
    const f = rel.split("/").at(-1)!;
    items.push({ bank: `${base}-${project}`, item: { content: `Compte rendu ${rel} :\n${readFileSync(join(ROOT, rel), "utf8").slice(0, 8000)}`, context: "compte rendu", document_id: `cr:${f}`, timestamp: `${f.slice(0, 10)}T18:00:00Z`, update_mode: "replace", tags: ["source:docs-cr"] } });
  }
  const projects = join(process.env.ORCH_HOME ?? homedir(), ".orch");
  if (existsSync(projects)) for (const repo of readdirSync(projects)) {
    const projectAsks = join(projects, repo, "asks");
    if (!statSync(join(projects, repo)).isDirectory() || !existsSync(projectAsks)) continue;
    for (const d of readdirSync(projectAsks)) {
      const f = join(projectAsks, d, "answer.md");
      if (existsSync(f)) items.push({ bank: `${base}-${repo}`, item: { content: `Synthèse des recherches « ${d} » (${f}) :\n${readFileSync(f, "utf8").slice(0, 8000)}`, context: "synthèse de recherches", document_id: `synthese:${d}`, timestamp: statSync(f).mtime.toISOString(), update_mode: "replace", tags: ["source:asks"] } });
    }
  }
  return items;
}

async function selectedStore(): Promise<MemBackend> {
  const c = loadBrainConfig();
  return c.mem === "brain" ? (await import("../brain/notes.ts")).openBrainMem(c) : fileBackend;
}

export async function seedHindsight(config: HindsightConfig, base: string, opts: SeedOpts = {}): Promise<SeedResult> {
  if (opts.concurrency !== undefined && (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1)) throw new Error("seed concurrency must be a positive integer");
  const manifestState = opts.manifestState ?? opts.state ?? stateDir();
  const stateFile = join(manifestState, "hindsight-seed.json");
  const result = await withFileLock(`${stateFile}.lock`, () => seedHindsightLocked(config, base, opts), { waitMs: 0 });
  if (result === null) throw new Error("seed: another run is active for this manifest");
  return result;
}

async function seedHindsightLocked(config: HindsightConfig, base: string, opts: SeedOpts): Promise<SeedResult> {
  const started = Date.now();
  const defaultState = stateDir();
  const sourceState = opts.sourceState ?? opts.state ?? defaultState;
  const manifestState = opts.manifestState ?? opts.state ?? defaultState;
  const stateFile = join(manifestState, "hindsight-seed.json");
  const server = serverIdentity(config);
  const { manifest, namespaceId: id, hashes } = loadManifest(stateFile, server, base);
  const store = opts.store ?? await selectedStore();
  const owned = !opts.store;
  const rows: { bank: string; item: RetainItem; hash: string; key: string }[] = [];
  let notes = 0;
  let inventory;
  try {
    inventory = await store.inventory(caller);
  } finally { if (owned) await store.close(); }
  if (!inventory.complete) throw new Error("seed requires a complete memory source inventory");
  const completeScopes = new Set(inventory.scopes);
  const completeProjects = new Set(inventory.projects);
  const active = inventory.notes.filter(isActive);
  notes = active.length;
  for (const note of active) {
    let noteBank = base;
    if (note.scope === "project") {
      if (typeof note.project !== "string" || !note.project.trim()) throw new Error(`project note ${note.id} has no source project identity`);
      noteBank = `${base}-${note.project}`;
    }
    rows.push({ bank: noteBank, item: noteItem(note), hash: "", key: "" });
  }
  const projectsRoot = join(process.env.ORCH_HOME ?? homedir(), ".orch");
  const known = new Set<string>([
    ...inventory.projects,
    ...active.flatMap((note) => note.scope === "project" && typeof note.project === "string" ? [note.project] : []),
    ...(existsSync(projectsRoot) ? readdirSync(projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []),
  ]);
  const exhaust = opts.includeExhaust === false ? [] : exhaustItems(sourceState, base, opts.now, known);
  for (const { bank, item } of exhaust) rows.push({ bank, item, hash: "", key: "" });
  const rejectedSecret: typeof rows = [];
  const acceptedRows: typeof rows = [];
  for (const row of rows) {
    const scan = inspectSecrets(row.item.content);
    if (!scan.ok) { rejectedSecret.push(row); continue; }
    row.item = { ...row.item, content: scan.text };
    acceptedRows.push(row);
  }
  rows.length = 0;
  rows.push(...acceptedRows);
  for (const row of rows) {
    row.hash = createHash("sha256").update(row.item.content).digest("hex");
    row.key = recordKey(row.bank, row.item.document_id!);
  }
  const uniqueRows = new Set<string>();
  for (const row of rows) {
    if (uniqueRows.has(row.key)) throw new Error(`seed: duplicate document identity in bank ${row.bank}`);
    uniqueRows.add(row.key);
  }
  for (const bank of new Set([base, ...rows.map((row) => row.bank)])) {
    const result = await ensureBank(config, bank);
    if (!result.ok) throw new Error(`bank ${bank}: ${result.error}`);
  }
  const currentKeys = new Set(rows.map((row) => row.key));
  const currentBanksByDocument = new Map<string, Set<string>>();
  for (const row of rows) {
    const id = row.item.document_id;
    if (!id) continue;
    const set = currentBanksByDocument.get(id) ?? new Set<string>();
    set.add(row.bank);
    currentBanksByDocument.set(id, set);
  }
  const skippedRows = opts.full ? [] : rows.filter((row) => hashes[row.bank]?.[row.item.document_id!] === row.hash);
  const pending = rows.filter((row) => opts.full || hashes[row.bank]?.[row.item.document_id!] !== row.hash);
  const groups: typeof pending[] = [];
  let group: typeof pending = [];
  for (const row of pending) {
    const chars = group.reduce((n, x) => n + x.item.content.length, 0);
    if (group.length && (group[0].bank !== row.bank || group.length >= 4 || chars + row.item.content.length > 6000)) { groups.push(group); group = []; }
    group.push(row);
  }
  if (group.length) groups.push(group);
  let sent = 0;
  let failed = 0;
  let done = 0;
  const accepted = new Map<string, { bank: string; documentId: string; hash: string }>();
  await pool(groups, opts.concurrency ?? 3, async (batch) => {
    const result = await retain(config, batch.map((r) => r.item), { bank: batch[0].bank, async: false });
    if (result.ok && result.value.items_count === batch.length) {
      sent += batch.length;
      for (const row of batch) accepted.set(row.key, { bank: row.bank, documentId: row.item.document_id!, hash: row.hash });
    } else {
      failed += batch.length;
      const detail = result.ok ? `accepted ${result.value.items_count} of ${batch.length}` : result.error;
      opts.log?.(`seed failed (${batch[0].bank}): ${detail}`);
    }
    done++;
    if (done % 10 === 0) opts.log?.(`seed: ${done}/${groups.length}`);
  });
  if (failed) {
    opts.log?.(`seed: ${notes} notes + ${exhaust.length} exhaust items, ${failed} items not accepted; manifest and old documents kept`);
    return { notes, exhaust: exhaust.length, sent, skipped: skippedRows.length + rejectedSecret.length, deleted: 0, failed, ms: Date.now() - started };
  }

  const nextHashes: SeedNamespace["hashes"] = structuredClone(hashes);
  for (const row of pending) {
    const item = accepted.get(row.key);
    if (item) (nextHashes[item.bank] ??= {})[item.documentId] = item.hash;
  }

  // Reconcile only after every retain batch is accepted. Memory inventory is
  // complete; bounded exhaust inputs are eligible for deletion only when the
  // same document is present in a new bank, proving a route change.
  let deleted = 0;
  for (const [bank, documents] of Object.entries(nextHashes)) {
    if (bank !== base && !bank.startsWith(`${base}-`)) continue;
    for (const documentId of Object.keys(documents)) {
      const key = recordKey(bank, documentId);
      if (currentKeys.has(key)) continue;
      const currentBanks = currentBanksByDocument.get(documentId);
      const moved = !documentId.startsWith("mem:") && !!currentBanks?.size && !currentBanks.has(bank);
      const bankProject = bank.startsWith(`${base}-`) ? bank.slice(base.length + 1) : "";
      const staleMemory = documentId.startsWith("mem:") && (bank === base
        ? completeScopes.has("operator") && completeScopes.has("lead")
        : completeScopes.has("project") && !!bankProject && completeProjects.has(bankProject));
      if (!moved && !staleMemory) continue;
      const result = await deleteDocument(config, bank, documentId);
      if (result.ok) {
        delete documents[documentId];
        deleted++;
      } else {
        failed++;
        opts.log?.(`seed delete failed (${bank}/${documentId}): ${result.error}`);
      }
    }
    if (!Object.keys(documents).length) delete nextHashes[bank];
  }

  manifest.namespaces[id] = { server, base, hashes: nextHashes };
  mkdirSync(manifestState, { recursive: true });
  const temp = `${stateFile}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, stateFile);
  opts.log?.(`seed: ${notes} notes + ${exhaust.length} exhaust items in ${groups.length} retains, ${deleted} deleted to ${base}`);
  return { notes, exhaust: exhaust.length, sent, skipped: skippedRows.length + rejectedSecret.length, deleted, failed, ms: Date.now() - started };
}
