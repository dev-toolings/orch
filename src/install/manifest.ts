import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Target } from "./render.ts";
import type { HarnessId } from "../harness/registry.ts";

export interface Entry {
  path: string;
  kind: "file" | "symlink";
  sha256: string;
  harness?: HarnessId;
}

export interface Manifest {
  version: 1;
  profile: string;
  installed_at: string;
  entries: Entry[];
  created_dirs: string[];
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function manifestPath(stateDir: string) {
  return join(stateDir, "manifest.json");
}

export function readManifest(stateDir: string): Manifest | null {
  const f = manifestPath(stateDir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Manifest) : null;
}

// Current fingerprint of a path: file content hash or symlink target hash.
function current(abs: string): { kind: "file" | "symlink"; sha256: string } | null {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { kind: "symlink", sha256: sha(readlinkSync(abs)) };
  if (st.isFile()) return { kind: "file", sha256: sha(readFileSync(abs, "utf8")) };
  return { kind: "file", sha256: "not-a-file" };
}

export type Action = { path: string; op: "create" | "update" | "unchanged" | "conflict" | "kept"; reason?: string };

function entryHarness(entry: Entry): HarnessId | undefined {
  if (entry.harness) return entry.harness;
  if (entry.path.startsWith(".claude/")) return "claude";
  if (entry.path.startsWith(".codex/")) return "codex";
  if (entry.path.startsWith(".grok/")) return "grok";
  return undefined;
}

export function plan(home: string, targets: Target[], manifest: Manifest | null): Action[] {
  const owned = new Map((manifest?.entries ?? []).map((e) => [e.path, e]));
  const actions: Action[] = targets.map((t) => {
    const cur = current(join(home, t.path));
    const want = sha(t.content);
    if (!cur) return { path: t.path, op: "create" };
    if (cur.kind === t.kind && cur.sha256 === want) return { path: t.path, op: "unchanged" };
    const mine = owned.get(t.path);
    // An empty file holds nothing to lose (a harness creates some on first run).
    if (!mine && cur.kind === "file" && cur.sha256 === sha("")) return { path: t.path, op: "update" };
    if (!mine) return { path: t.path, op: "conflict", reason: "exists and was not installed by orch" };
    if (mine.sha256 !== cur.sha256) return { path: t.path, op: "conflict", reason: "edited since install" };
    return { path: t.path, op: "update" };
  });
  const targetPaths = new Set(targets.map((target) => target.path));
  const selected = new Set(targets.flatMap((target) => target.harness ? [target.harness] : []));
  for (const entry of manifest?.entries ?? []) {
    const harness = entryHarness(entry);
    if (!targetPaths.has(entry.path) && harness && !selected.has(harness) && current(join(home, entry.path))) {
      actions.push({ path: entry.path, op: "kept", reason: "harness absent" });
    }
  }
  return actions;
}

export function apply(home: string, stateDir: string, profile: string, targets: Target[], actions: Action[]): Manifest {
  if (actions.some((a) => a.op === "conflict")) throw new Error("refusing to install over conflicts");
  const prev = readManifest(stateDir);
  const created = new Set(prev?.created_dirs ?? []);
  const targetPaths = new Set(targets.map((t) => t.path));
  const keptPaths = new Set(actions.filter((action) => action.op === "kept").map((action) => action.path));
  const retiredKept: Entry[] = [];
  for (const e of prev?.entries ?? []) {
    if (targetPaths.has(e.path)) continue;
    const abs = join(home, e.path);
    const cur = current(abs);
    if (!cur) continue;
    if (keptPaths.has(e.path)) {
      retiredKept.push(e);
      continue;
    }
    if (cur.sha256 === e.sha256) rmSync(abs, { force: true });
    else retiredKept.push(e);
  }
  for (const t of targets) {
    const abs = join(home, t.path);
    let d = dirname(abs);
    const missing: string[] = [];
    while (!existsSync(d)) {
      missing.push(d);
      d = dirname(d);
    }
    for (const m of missing.reverse()) {
      mkdirSync(m);
      created.add(m);
    }
    if (t.kind === "symlink") {
      rmSync(abs, { force: true });
      symlinkSync(t.content, abs);
    } else {
      const tmp = `${abs}.orch-tmp`;
      writeFileSync(tmp, t.content);
      renameSync(tmp, abs);
    }
  }
  const m: Manifest = {
    version: 1,
    profile,
    installed_at: new Date().toISOString(),
    entries: [
      ...targets.map((t) => ({ path: t.path, kind: t.kind, sha256: sha(t.content), harness: t.harness })),
      ...retiredKept,
    ],
    created_dirs: [...created],
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(manifestPath(stateDir), JSON.stringify(m, null, 2));
  return m;
}

// Removes exactly what the manifest lists, and only if unchanged since install.
export function uninstall(home: string, stateDir: string, dryRun: boolean): string[] {
  const m = readManifest(stateDir);
  if (!m) return ["nothing installed"];
  const out: string[] = [];
  const kept: Entry[] = [];
  for (const e of m.entries) {
    const abs = join(home, e.path);
    const cur = current(abs);
    if (!cur) out.push(`gone ${e.path}`);
    else if (cur.sha256 !== e.sha256) {
      out.push(`kept ${e.path} (edited since install)`);
      kept.push(e);
    } else {
      out.push(`remove ${e.path}`);
      if (!dryRun) rmSync(abs, { force: true });
    }
  }
  if (!dryRun) {
    for (const d of [...m.created_dirs].sort((a, b) => b.length - a.length)) {
      try {
        rmdirSync(d);
        out.push(`rmdir ${d}`);
      } catch {}
    }
    if (kept.length) writeFileSync(manifestPath(stateDir), JSON.stringify({ ...m, entries: kept }, null, 2));
    else rmSync(manifestPath(stateDir), { force: true });
  }
  return out;
}

export function drift(home: string, stateDir: string, harnesses?: HarnessId[]): string[] {
  const m = readManifest(stateDir);
  if (!m) return ["nothing installed"];
  const selected = harnesses ? new Set(harnesses) : null;
  return m.entries.filter((entry) => {
    const harness = entryHarness(entry);
    return !selected || !harness || selected.has(harness);
  }).map((e) => {
    const cur = current(join(home, e.path));
    return `${!cur ? "missing" : cur.sha256 === e.sha256 ? "ok" : "edited"} ${e.path}`;
  });
}
