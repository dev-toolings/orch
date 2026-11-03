// Orca keeps a record for every git worktree it discovers and drops it only
// when the removal goes through `orca worktree rm`, which refuses a path
// outside its allowed directories (lane checkouts under the state dir). A lane
// cut by git therefore leaves a ghost record. This removes the records whose
// directory is gone, only while no process holds Orca's profile state (Orca
// and its daemon quit): `lane gc --orca`, run by the `orca-prune` routine, and
// scripts/orca-prune-ghosts.ts for a dry run.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, accessSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The domains keyed by worktree id (`<repoId>::<path>`) or holding such keys.
const DOMAINS = ["worktreeMeta", "worktreeIdentityAliases", "workspaceSession"] as const;

export const orcaProfileDb = () => process.env.ORCA_PROFILE_DB ?? join(process.env.HOME ?? homedir(), ".orca", "profiles", "local-default", "profile-state.db");

// `<repoId>::<absolute path>`, optionally prefixed by a host (`local|`); a
// folder workspace (`::workspace:`) is not a worktree and stays.
function ghostPath(key: string): string | null {
  const base = key.split("@@")[0]!;
  const local = base.startsWith("headless-terminals:") ? base.slice("headless-terminals:".length) : base;
  const host = local.indexOf("|");
  if (host >= 0 && local.slice(0, host) !== "local") return null;
  const id = host >= 0 ? local.slice(host + 1) : local;
  const sep = id.indexOf("::");
  if (sep < 0 || id.includes("::workspace:")) return null;
  const path = id.slice(sep + 2);
  if (!path.startsWith("/")) return null;
  try { lstatSync(path); return null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
  // Do not infer absence through an unreadable ancestor or a missing root.
  let parent = dirname(path);
  for (;;) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || ["/", "/mnt", "/media", "/Volumes", "/run/media"].includes(parent)) return null;
      for (let ancestor = parent;; ancestor = dirname(ancestor)) {
        accessSync(ancestor, constants.R_OK | constants.X_OK);
        readdirSync(ancestor);
        if (ancestor === "/") break;
      }
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      parent = dirname(parent);
    }
  }
}

// Drops ghost keys at any depth, including objects nested in arrays.
function prune(value: unknown, gone: Set<string>, references: { removed: number }, field = ""): unknown {
  if (typeof value === "string" && ghostPath(value)) {
    references.removed++;
    return null;
  }
  if (Array.isArray(value)) {
    return value.filter(v => {
      if (typeof v !== "string" || !ghostPath(v)) return true;
      references.removed++;
      return false;
    }).map(v => prune(v, gone, references));
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (ghostPath(k)) { gone.add(k); continue; }
    if (field === "closedTerminalTabTombstonesByTabId" && v && typeof v === "object"
      && "worktreeId" in v && typeof v.worktreeId === "string" && ghostPath(v.worktreeId)) {
      references.removed++;
      continue;
    }
    out[k] = prune(v, gone, references, k);
  }
  return out;
}

// Pids holding the db or a sidecar; throws when that cannot be verified
// (fuser missing or failing), so an unknown state never counts as free.
function holders(dbPath: string): string[] {
  const files = [dbPath];
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { lstatSync(dbPath + suffix); files.push(dbPath + suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot inspect ${dbPath + suffix}: ${error}`);
    }
  }
  const held = spawnSync("fuser", files, { encoding: "utf8" });
  if (held.error || held.status === null || (held.status !== 0 && held.status !== 1) || (held.status === 1 && held.stderr.trim())) {
    throw new Error(`cannot verify database holders: ${held.error?.message ?? (held.stderr.trim() || held.status)}`);
  }
  return held.status === 0 ? held.stdout.trim().split(/\s+/).filter(pid => pid && pid !== String(process.pid)) : [];
}

export interface PruneResult { held?: string[]; keys: string[]; references: number; lines: string[]; revision?: number }

// Lists (apply false) or removes the ghost records. A held state is reported
// in `held` with nothing changed; a missing state is an empty result.
export function pruneOrcaGhosts(opts: { apply: boolean; dbPath?: string; holdersOf?: (dbPath: string) => string[] }): PruneResult {
  const dbPath = opts.dbPath ?? orcaProfileDb();
  const holdersOf = opts.holdersOf ?? holders;
  const lines: string[] = [];
  if (!existsSync(dbPath)) return { keys: [], references: 0, lines: [`no Orca state at ${dbPath}`] };
  if (opts.apply) {
    const held = holdersOf(dbPath);
    if (held.length) return { held, keys: [], references: 0, lines: [`${dbPath} or a sidecar is held by pid ${held.join(" ")}: quit Orca (its daemon orcad too), then run again`] };
  }
  const db = new Database(dbPath, { readonly: !opts.apply });
  try {
    const readRevision = () => Number((db.query("select value from profile_state_meta where key = 'revision'").get() as { value: string } | null)?.value ?? 0);
    const expectedRevision = readRevision();
    if (opts.apply) {
      const held = holdersOf(dbPath);
      if (held.length) return { held, keys: [], references: 0, lines: [`${dbPath} is held by pid ${held.join(" ")}: nothing changed`] };
    }
    db.exec(opts.apply ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      if (readRevision() !== expectedRevision) throw new Error("Orca state revision changed; run again");
      let revision = expectedRevision;
      const updates: { domain: string; payload: string; removed: number }[] = [];
      const all = new Set<string>();
      const references = { removed: 0 };
      for (const domain of DOMAINS) {
        const row = db.query("select payload from profile_state_documents where domain = ?").get(domain) as { payload: string } | null;
        if (!row) continue;
        const gone = new Set<string>();
        const before = references.removed;
        const next = JSON.stringify(prune(JSON.parse(row.payload), gone, references));
        for (const k of gone) all.add(k);
        if (gone.size || references.removed > before) updates.push({ domain, payload: next, removed: gone.size });
      }
      for (const u of updates) lines.push(`${u.domain}: ${u.removed} ghost entr${u.removed > 1 ? "ies" : "y"}`);
      lines.push(`${all.size} distinct ghost worktree key(s)`, `${references.removed} ghost value reference(s)`);
      if (!opts.apply || !updates.length) {
        db.exec("COMMIT");
        return { keys: [...all], references: references.removed, lines };
      }
      // Same shape as Orca's own writes: the payload, its sha256, a new revision.
      const now = Date.now();
      for (const u of updates) {
        revision++;
        db.query("update profile_state_documents set payload = ?, content_hash = ?, revision = ?, updated_at = ? where domain = ?")
          .run(u.payload, createHash("sha256").update(u.payload).digest("hex"), revision, now, u.domain);
      }
      db.query("update profile_state_meta set value = ? where key = 'revision'").run(String(revision));
      db.exec("COMMIT");
      lines.push(`removed: Orca state now at revision ${revision}`);
      return { keys: [...all], references: references.removed, lines, revision };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
