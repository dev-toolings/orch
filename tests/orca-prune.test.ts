import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOrcaGhosts } from "../src/lanes/orca-prune.ts";

function orcaState() {
  const dir = mkdtempSync(join(tmpdir(), "orca-prune-"));
  const live = join(dir, "live");
  mkdirSync(live);
  const ghost = join(dir, "lanes", "x", "wt");
  const remote = "/nowhere/remote-wt";
  const dbPath = join(dir, "profile-state.db");
  const db = new Database(dbPath);
  db.exec("create table profile_state_meta (key text primary key, value text)");
  db.exec("create table profile_state_documents (domain text primary key, payload text, content_hash text, revision integer, updated_at integer)");
  db.query("insert into profile_state_meta values ('revision', '7')").run();
  const docs = {
    worktreeMeta: { [`r::${live}`]: { displayName: "lead" }, [`local|r::${ghost}`]: { displayName: "lane" }, [`ssh1|r::${remote}`]: {} },
    workspaceSession: { activeWorktreeIdsOnShutdown: [`r::${live}`, `r::${ghost}`], tabsByWorktree: { [`r::${ghost}`]: [] } },
  };
  for (const [domain, payload] of Object.entries(docs)) db.query("insert into profile_state_documents values (?, ?, '', 7, 0)").run(domain, JSON.stringify(payload));
  db.close();
  return { dbPath, live, ghost, remote };
}

test("lane gc --orca drops records of removed lane worktrees only when Orca is quit", () => {
  const s = orcaState();
  const held = pruneOrcaGhosts({ apply: true, dbPath: s.dbPath, holdersOf: () => ["4242"] });
  expect(held.held).toEqual(["4242"]);
  expect(held.keys).toEqual([]);

  const r = pruneOrcaGhosts({ apply: true, dbPath: s.dbPath, holdersOf: () => [] });
  expect(r.revision).toBe(9);
  const db = new Database(s.dbPath, { readonly: true });
  const doc = (d: string) => db.query("select payload, content_hash from profile_state_documents where domain = ?").get(d) as { payload: string; content_hash: string };
  const meta = doc("worktreeMeta");
  expect(Object.keys(JSON.parse(meta.payload)).sort()).toEqual([`r::${s.live}`, `ssh1|r::${s.remote}`]);
  expect(meta.content_hash).toBe(createHash("sha256").update(meta.payload).digest("hex"));
  expect(JSON.parse(doc("workspaceSession").payload)).toEqual({ activeWorktreeIdsOnShutdown: [`r::${s.live}`], tabsByWorktree: {} });
  db.close();
});
