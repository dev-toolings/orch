// docs: a local, versioned corpus of official documentation, indexed by ctx
// and searched on demand. The lead keeps pointers in memory, never the docs.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { git as runGit } from "../core/git.ts";
import { ROOT } from "../core/profile.ts";

export interface Source {
  id: string;
  stack: string;
  kind: "git" | "llms";
  url: string;
  ref?: string;
  paths?: string[];
}

export interface SourceMeta {
  id: string;
  version: string; // commit sha for git, byte length for llms
  fetched: string;
  files: number;
  indexed: boolean;
}

export const docsDir = () => process.env.ORCH_DOCS ?? join(homedir(), ".local", "share", "orch", "docs");

export function loadSources(path = join(ROOT, "catalog", "docs.yaml")): Source[] {
  const { sources } = parse(readFileSync(path, "utf8")) as { sources: Source[] };
  const ids = new Set<string>();
  for (const s of sources) {
    if (!s.id || !s.stack || !s.url || (s.kind !== "git" && s.kind !== "llms")) throw new Error(`docs.yaml: bad entry ${JSON.stringify(s)}`);
    if (s.kind === "git" && !s.ref) throw new Error(`docs.yaml: ${s.id} needs a ref`);
    if (ids.has(s.id)) throw new Error(`docs.yaml: duplicate id ${s.id}`);
    ids.add(s.id);
  }
  return sources;
}

function git(cwd: string, ...args: string[]): string {
  const r = runGit(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args[0]}: ${(r.err || r.out).split("\n").pop()}`);
  return r.out;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === ".ctx" || e.name === ".orch-docs.json") continue;
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

export function dirBytes(dir: string): number {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  return readdirSync(dir).reduce((total, name) => total + dirBytes(join(dir, name)), 0);
}

const metaPath = (dir: string) => join(dir, ".orch-docs.json");

export function readMeta(id: string, root = docsDir()): SourceMeta | null {
  const p = metaPath(join(root, id));
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as SourceMeta) : null;
}

async function fetchText(url: string): Promise<string> {
  if (url.startsWith("file://")) return readFileSync(url.slice("file://".length), "utf8");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// Shallow, blob-filtered, sparse when paths are given: a docs tree, not a repo.
function syncGit(s: Source, dir: string): string {
  if (!existsSync(join(dir, ".git"))) {
    const args = ["clone", "-q", "--depth", "1", "--filter=blob:none", "--branch", s.ref!];
    if (s.paths?.length) args.push("--sparse");
    git(".", ...args, s.url, dir);
    if (s.paths?.length) git(dir, "sparse-checkout", "set", ...s.paths);
  } else {
    git(dir, "fetch", "-q", "--depth", "1", "origin", s.ref!);
    git(dir, "reset", "-q", "--hard", "FETCH_HEAD");
  }
  return git(dir, "rev-parse", "--short", "HEAD");
}

export async function updateSource(s: Source, opts: { root?: string; now?: Date; index?: boolean } = {}): Promise<SourceMeta> {
  const dir = join(opts.root ?? docsDir(), s.id);
  mkdirSync(dir, { recursive: true });
  let version: string;
  if (s.kind === "git") version = syncGit(s, dir);
  else {
    const text = await fetchText(s.url);
    writeFileSync(join(dir, "llms.txt"), text);
    version = `${Buffer.byteLength(text)}b`;
  }
  const files = countFiles(dir);
  let indexed = false;
  if (opts.index !== false) {
    const r = spawnSync("ctx", ["index", "."], { cwd: dir, encoding: "utf8" });
    indexed = r.status === 0;
  }
  const meta: SourceMeta = { id: s.id, version, fetched: (opts.now ?? new Date()).toISOString(), files, indexed };
  writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
  return meta;
}

export function orphanSources(sources: Source[], root = docsDir()): string[] {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!rootStat.isDirectory()) return [];
  const declared = new Set(sources.map((s) => s.id));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !declared.has(entry.name))
    .filter((entry) => {
      try {
        return lstatSync(join(root, entry.name, ".orch-docs.json")).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    })
    .map((entry) => entry.name)
    .sort();
}

export function pruneSources(sources: Source[], root = docsDir()): string[] {
  const orphans = orphanSources(sources, root);
  for (const id of orphans) rmSync(join(root, id), { recursive: true, force: true });
  return orphans;
}

export function statusLines(sources: Source[], root = docsDir()): string[] {
  let totalBytes = 0;
  let onDisk = false;
  const lines = sources.map((s) => {
    const m = readMeta(s.id, root);
    if (!m) return `${s.id.padEnd(20)} ${s.stack.padEnd(12)} not fetched`;
    const bytes = dirBytes(join(root, s.id));
    totalBytes += bytes;
    onDisk = true;
    return `${s.id.padEnd(20)} ${s.stack.padEnd(12)} ${m.version.padEnd(9)} ${m.fetched.slice(0, 10)}  ${String(m.files).padStart(6)} files  ${m.indexed ? "indexed" : "NOT INDEXED"}  ${(bytes / 1048576).toFixed(1)} MB`;
  });
  lines.push(...orphanSources(sources, root).map((id) => {
    const bytes = dirBytes(join(root, id));
    totalBytes += bytes;
    onDisk = true;
    return `${id.padEnd(20)} orphan       not in catalog/docs.yaml (orch docs update removes it)  ${(bytes / 1048576).toFixed(1)} MB`;
  }));
  if (onDisk) lines.push(`${"total".padEnd(20)} ${(totalBytes / 1048576).toFixed(1)} MB on disk`);
  return lines;
}

// ctx prints `path:line kind : note`; add the line's text so the lead can
// judge a hit without opening the file.
// ctx points at a paragraph start: show the first of its lines that holds a
// query word, so an acronym hit is readable at a glance.
function withSnippet(dir: string, hit: string, words: string[]): string {
  const m = /^(\S+?):(\d+)\s/.exec(hit);
  if (!m) return hit;
  try {
    const all = readFileSync(join(dir, m[1]), "utf8").split("\n");
    const start = Number(m[2]) - 1;
    let at = start;
    for (let i = start; i < Math.min(start + 6, all.length); i++) {
      if (words.some((w) => all[i].toLowerCase().includes(w))) {
        at = i;
        break;
      }
    }
    const text = (all[at] ?? "").trim();
    return `${m[1]}:${at + 1}  ${text.length > 140 ? `${text.slice(0, 137)}...` : text}`;
  } catch {
    return hit;
  }
}

// One ctx search per matching source, each line prefixed with the source id.
export function searchDocs(query: string, sources: Source[], opts: { root?: string; stack?: string; budgetTokens?: number } = {}): string[] {
  const root = opts.root ?? docsDir();
  const picked = sources.filter((s) => (!opts.stack || s.stack === opts.stack) && readMeta(s.id, root)?.indexed);
  if (!picked.length) return [opts.stack ? `no indexed source for stack ${opts.stack}: run orch docs update` : "no indexed source: run orch docs update"];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const s of picked) {
    const r = spawnSync("ctx", ["search", query, "--budget-tokens", String(opts.budgetTokens ?? 600)], { cwd: join(root, s.id), encoding: "utf8" });
    const lines = (r.stdout ?? "").trim().split("\n").filter((l) => l && !/^\d+ tokens;/.test(l));
    if (r.status === 0 && lines.length) out.push(...lines.map((l) => `${s.id}: ${withSnippet(join(root, s.id), l, words)}`));
  }
  return out.length ? out : ["no match"];
}

export const DOCS_USAGE = "usage: orch docs update [id...] | status | search <words> [--stack s] [--budget n]";
