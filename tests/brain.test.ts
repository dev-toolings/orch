import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, checkControl, initSecrets, provision, restoreCheck } from "../src/brain/admin.ts";
import { type BrainConfig, connectionUrl, type Db, isBrainUnavailable, loadBrainConfig, migrate, MIGRATIONS_DIR, passwordKey } from "../src/brain/db.ts";
import { importNotes } from "../src/brain/import.ts";
import { addMemory, contentHash, countMemories, embedPending, forgetMemory, getMemory, searchMemories, supersedeMemory, tsQuery } from "../src/brain/store.ts";
import { loadEnvFile, setEnvIfMissing } from "../src/core/env.ts";
import type { Note } from "../src/mem/mem.ts";

// PGlite is a real Postgres compiled to WASM, with pgvector: the schema and
// queries run as in production, without a server or a model call.
let root: string;
let pg: PGlite;
let db: Db;

const wrap = (p: PGlite): Db => ({
  query: async <T>(text: string, params: unknown[] = []) => (await p.query(text, params)).rows as T[],
  exec: async (text: string) => { await p.exec(text); },
  close: async () => {},
});

// A unit vector along one axis, so nearest neighbours are known in advance.
const axis = (i: number) => Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));

describe("brain availability errors", () => {
  test("recognizes refused and wrapped startup errors, and ignores unrelated errors", () => {
    for (const code of ["ERR_POSTGRES_CONNECTION_REFUSED", "ERR_POSTGRES_CONNECTION_CLOSED", "ERR_POSTGRES_CONNECTION_TIMEOUT", "57P03"]) {
      expect(isBrainUnavailable({ code, message: "Failed to connect" })).toBe(true);
    }
    expect(isBrainUnavailable({ cause: { errno: "57P03" } })).toBe(true);
    expect(isBrainUnavailable(new Error("bad query"))).toBe(false);
  });
});

const config = (over: Partial<BrainConfig> = {}): BrainConfig => ({
  host: "127.0.0.1", port: 5433, container: "brain-postgres", domains: ["projets", "compta"], explicit_only: ["compta"],
  backup_dir: join(root, "backups"), controls: [], recall: [], recall_min: 0, mem: "files",
  hindsight: { url: "http://127.0.0.1:1", container: "brain-hindsight", bank: "kiba", recall_max_tokens: 1500, recall_budget: "low", timeout_ms: 4000 },
  ...over,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orch-brain-"));
  pg = new PGlite({ extensions: { vector } });
  db = wrap(pg);
  await migrate(db);
});
afterAll(async () => {
  await pg.close();
  rmSync(root, { recursive: true, force: true });
});

// One instance for speed (about a second to start); each test starts empty.
beforeEach(async () => { await db.exec("TRUNCATE memories"); });

describe("migrate", () => {
  test("applies each migration once and records it", async () => {
    expect(await migrate(db)).toEqual([]);
    expect((await db.query<{ version: string }>("SELECT version FROM schema_migrations")).map((r) => r.version)).toEqual(["001_memories", "002_project", "003_note_identity", "004_transcript_identity"]);
  });

  test("note identity migration preserves duplicate rows and links with deterministic unused suffixes", async () => {
    const legacy = new PGlite({ extensions: { vector } });
    const fresh = wrap(legacy);
    try {
      await fresh.exec(readFileSync(join(MIGRATIONS_DIR, "001_memories.sql"), "utf8"));
      await fresh.exec(readFileSync(join(MIGRATIONS_DIR, "002_project.sql"), "utf8"));
      await fresh.exec("CREATE TABLE schema_migrations (version text PRIMARY KEY); INSERT INTO schema_migrations VALUES ('001_memories'), ('002_project');");
      const first = await addMemory(fresh, { source: "orch-mem", source_ref: "note", body: "first" });
      const second = await supersedeMemory(fresh, first.id, { source: "orch-mem", source_ref: "note", body: "second" });
      const third = await addMemory(fresh, { source: "orch-mem", source_ref: "note", body: "third" });
      const occupied = await addMemory(fresh, { source: "orch-mem", source_ref: "note-2", body: "occupied" });
      await forgetMemory(fresh, occupied.id, "retired");
      await fresh.query("UPDATE memories SET created_at = '2026-10-24T09:00:00Z' WHERE id = $1", [first.id]);
      await fresh.query("UPDATE memories SET created_at = '2026-10-24T09:00:01Z' WHERE id = ANY($1)", [[second, third.id]]);
      await addMemory(fresh, { source: "mail", source_ref: "note", body: "mail one" });
      await addMemory(fresh, { source: "mail", source_ref: "note", body: "mail two" });

      expect(await migrate(fresh)).toEqual(["003_note_identity", "004_transcript_identity"]);
      expect((await getMemory(fresh, first.id))?.source_ref).toBe("note");
      for (const [i, id] of [second, third.id].sort().entries()) {
        expect((await getMemory(fresh, id))?.source_ref).toBe(`note-${i + 3}`);
      }
      expect((await getMemory(fresh, first.id))?.superseded_by).toBe(second);
      expect((await getMemory(fresh, second))?.supersedes).toBe(first.id);
      expect((await getMemory(fresh, occupied.id))?.forgotten_reason).toBe("retired");
      const rows = await fresh.query<{ source: string; source_ref: string; body: string; content_hash: string }>("SELECT source, source_ref, body, content_hash FROM memories");
      expect(rows).toHaveLength(6);
      for (const row of rows) expect(row.content_hash).toBe(contentHash(row));
      const renamed = (await getMemory(fresh, second))!;
      expect(await addMemory(fresh, { source: renamed.source, source_ref: renamed.source_ref, body: renamed.body })).toEqual({ id: second, created: false });
      await expect(addMemory(fresh, { source: "orch-mem", source_ref: "note", body: "collision" })).rejects.toMatchObject({ code: "23505", constraint: "memories_note_identity" });
      await expect(addMemory(fresh, { source: "orch-mem", source_ref: "note-2", body: "inactive collision" })).rejects.toMatchObject({ code: "23505", constraint: "memories_note_identity" });
      expect(await migrate(fresh)).toEqual([]);
    } finally {
      await legacy.close();
    }
  });

  test("a failing migration leaves nothing behind and names itself", async () => {
    const dir = join(root, "bad-migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE first_one (x int);");
    writeFileSync(join(dir, "002_broken.sql"), "CREATE TABLE half_done (x int);\nSELECT no_such_function();");
    const fresh = wrap(new PGlite());
    await expect(migrate(fresh, dir)).rejects.toThrow(/migration 002_broken failed/);
    expect((await fresh.query<{ version: string }>("SELECT version FROM schema_migrations")).map((r) => r.version)).toEqual(["001_ok"]);
    expect(await fresh.query("SELECT 1 FROM pg_tables WHERE tablename = 'half_done'")).toEqual([]);
  });
});

describe("store", () => {
  test("the same source, reference and text twice is one memory", async () => {
    const input = { source: "mail", source_ref: "msg-1", body: "Le client valide le devis" };
    const a = await addMemory(db, input);
    const b = await addMemory(db, input);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect((await countMemories(db)).total).toBe(1);
    await expect(addMemory(db, { ...input, body: "  " })).rejects.toThrow(/empty memory/);
  });

  test("supersede links both ways in one statement and hides the old memory", async () => {
    const old = await addMemory(db, { source: "orch-mem", source_ref: "n1", body: "API port 4817" });
    const id = await supersedeMemory(db, old.id, { source: "orch-mem", source_ref: "n2", body: "API port 4818" });
    expect((await getMemory(db, old.id))?.superseded_by).toBe(id);
    expect((await getMemory(db, id))?.supersedes).toBe(old.id);
    expect((await searchMemories(db, "API port")).map((h) => h.memory.id)).toEqual([id]);
    expect((await searchMemories(db, "API port", { all: true })).length).toBe(2);
    await expect(supersedeMemory(db, old.id, { source: "orch-mem", source_ref: "n3", body: "API port 4819" })).rejects.toThrow(/no active memory/);
    expect((await countMemories(db)).total).toBe(2);
  });

  test("forget keeps the row with its reason, once", async () => {
    const m = await addMemory(db, { source: "mail", source_ref: "m", body: "ancien numéro" });
    await forgetMemory(db, m.id, "numéro changé");
    expect((await getMemory(db, m.id))?.forgotten_reason).toBe("numéro changé");
    expect(await searchMemories(db, "numero")).toEqual([]);
    await expect(forgetMemory(db, m.id, "again")).rejects.toThrow(/no memory/);
    expect((await countMemories(db))).toEqual({ total: 1, active: 0, unembedded: 1 });
  });

  test("text search ignores accents and case, and only letters and digits reach to_tsquery", async () => {
    await addMemory(db, { source: "doc", source_ref: "d", body: "Le Modèle de Décision tourne en local" });
    expect((await searchMemories(db, "modele decision")).length).toBe(1);
    expect(tsQuery("a' | b:* & (c) !!")).toBeNull();
    expect(tsQuery("Hôtel 'Zurich' & co")).toBe("hotel:* | zurich:* | co:*");
    // stop words would match nearly every memory as prefixes
    expect(tsQuery("comment on écrase les commits de la branche")).toBe("comment:* | ecrase:* | commits:* | branche:*");
    expect(tsQuery("de la, the and")).toBeNull();
  });

  test("with a query vector, recall ranks by vector alone, within the query's space", async () => {
    const a = await addMemory(db, { source: "doc", source_ref: "a", body: "réservation train Zurich" });
    const b = await addMemory(db, { source: "doc", source_ref: "b", body: "billet acheté" });
    const c = await addMemory(db, { source: "doc", source_ref: "c", body: "autre espace" });
    await embedPending(db, "voyage-4", async (texts) => texts.map((t) => axis(t.includes("billet") ? 1 : t.includes("autre") ? 1 : 0)));
    await db.query("UPDATE memories SET embed_space = 'qwen' WHERE id = $1", [c.id]);
    const hits = await searchMemories(db, "train", { vector: axis(1), space: "voyage-4" });
    expect(hits.map((h) => [h.memory.id, h.via])).toEqual([[b.id, "vector"], [a.id, "vector"]]);
    expect(hits[0].score).toBeCloseTo(1, 6);
    expect(Object.keys(hits[0].memory)).not.toContain("distance");
    // no vector: the words, offline
    expect((await searchMemories(db, "train")).map((h) => [h.memory.id, h.via])).toEqual([[a.id, "text"]]);
  });

  test("embedding resumes after a failed batch and re-embeds another space", async () => {
    for (let i = 0; i < 5; i++) await addMemory(db, { source: "doc", source_ref: `r${i}`, body: `note ${i}` });
    let calls = 0;
    const flaky = async (texts: string[]) => {
      if (++calls === 2) throw new Error("provider down");
      return texts.map(() => axis(0));
    };
    await expect(embedPending(db, "voyage-4", flaky, 2)).rejects.toThrow(/provider down/);
    expect((await countMemories(db)).unembedded).toBe(3);
    expect(await embedPending(db, "voyage-4", flaky, 2)).toBe(3);
    expect(await embedPending(db, "qwen", async (t) => t.map(() => axis(2)))).toBe(5);
    await addMemory(db, { source: "doc", source_ref: "x", body: "short" });
    await expect(embedPending(db, "qwen", async () => [])).rejects.toThrow(/0 vectors for 1 memories/);
  });
});

describe("import notes", () => {
  const note = (id: string, body: string, extra: Partial<Note> = {}): Note =>
    ({ id, scope: "project", harness: "claude", session: "", date: `2026-10-${id.slice(1)}T10:00:00.000Z`, tags: ["t"], body, ...extra });

  test("carries supersede and forget marks, and a replay adds nothing", async () => {
    const notes = [
      note("n10", "port 4817", { status: "superseded", supersededBy: "n11" }),
      note("n11", "port 4818", { supersedes: "n10" }),
      note("n12", "obsolète", { status: "forgotten", reason: "plus vrai" }),
      note("n13", "orphan", { supersedes: "n09" }),
    ];
    const r = await importNotes(db, notes, "orch");
    expect(r).toEqual({ added: 4, existing: 0, superseded: 1, forgotten: 1, unresolved: ["n13 supersedes missing note n09"] });
    expect((await countMemories(db)).active).toBe(2);
    expect((await searchMemories(db, "port")).map((h) => h.memory.source_ref)).toEqual(["n11"]);
    expect(await importNotes(db, notes, "orch")).toEqual({ added: 0, existing: 4, superseded: 0, forgotten: 0, unresolved: ["n13 supersedes missing note n09"] });
    expect((await countMemories(db)).total).toBe(4);
  });
});

describe("config and credentials", () => {
  test("brain.yaml is validated", () => {
    const file = join(root, "brain.yaml");
    writeFileSync(file, "host: 127.0.0.1\nport: 5433\ndomains: [projets, Bad-Name]\n");
    expect(() => loadBrainConfig(file)).toThrow(/domain Bad-Name/);
    writeFileSync(file, "host: 127.0.0.1\nport: 5433\ndomains: [projets]\ncontrols: [{ domain: compta, query: q, expect: e }]\n");
    expect(() => loadBrainConfig(file)).toThrow(/unknown domain compta/);
    writeFileSync(file, "host: 127.0.0.1\nport: 5433\ndomains: [projets]\nrecall: [{ domain: mails, query: q, expect: e }]\n");
    expect(() => loadBrainConfig(file)).toThrow(/recall "q": unknown domain mails/);
    writeFileSync(file, "host: 127.0.0.1\nport: 5433\ndomains: [projets]\nrecall: [{ domain: projets, query: q, expect: e }]\nrecall_min: 2\n");
    expect(() => loadBrainConfig(file)).toThrow(/recall_min: an integer from 0 to 1/);
    writeFileSync(file, "host: 127.0.0.1\nport: 5433\ndomains: [projets]\nhindsight: { url: http://127.0.0.1:1, container: brain-hindsight, bank: kiba, recall_max_tokens: 1500, recall_budget: low, timeout_ms: 4000 }\n");
    expect(loadBrainConfig(file).backup_dir).not.toContain("~");
    expect(loadBrainConfig(file).recall_min).toBe(0);
    expect(loadBrainConfig(file).hindsight).toMatchObject({ recall_min_semantic: 0, session_recall_tokens: 800, retain: true });
    expect(loadBrainConfig(file).ingest_projects).toEqual([]);
    writeFileSync(file, "host: 127.0.0.1\nport: 5433\ndomains: [projets]\nhindsight: { url: http://127.0.0.1:1, container: brain-hindsight, bank: kiba, recall_max_tokens: 1500, recall_budget: low, timeout_ms: 4000, recall_min_semantic: 2 }\n");
    expect(() => loadBrainConfig(file)).toThrow(/recall_min_semantic must be a number from 0 to 1/);
  });

  test("init writes only the missing credentials, mode 600, never replacing one", () => {
    const file = join(root, "init.env");
    writeFileSync(file, "ANTHROPIC_API_KEY=keep-me\nBRAIN_PROJETS_RO_PASSWORD=operator-chosen-password-123\n", { mode: 0o644 });
    const written = initSecrets(config(), file);
    expect(written).not.toContain("BRAIN_PROJETS_RO_PASSWORD");
    expect(written).toContain("BRAIN_PG_ADMIN_PASSWORD");
    expect(written).toContain("HINDSIGHT_PG_PASSWORD");
    expect(written).not.toContain("HINDSIGHT_API_TOKEN");
    expect(written).toHaveLength(6);
    const env = loadEnvFile(file);
    expect(env.ANTHROPIC_API_KEY).toBe("keep-me");
    expect(env.BRAIN_PROJETS_RO_PASSWORD).toBe("operator-chosen-password-123");
    expect(env.BRAIN_COMPTA_RW_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(initSecrets(config(), file)).toEqual([]);
    expect(setEnvIfMissing("ANTHROPIC_API_KEY", "other", file)).toBe(false);
  });

  test("connection URLs encode the password and name the domain role", () => {
    const env = { [passwordKey("projets", "ro")]: "a/b@c" };
    expect(connectionUrl(config(), { domain: "projets", role: "ro" }, env)).toBe("postgres://brain_projets_ro:a%2Fb%40c@127.0.0.1:5433/brain_projets");
    expect(() => connectionUrl(config(), { domain: "projets", role: "rw" }, env)).toThrow(/BRAIN_PROJETS_RW_PASSWORD is missing/);
  });
});

describe("provision", () => {
  const secrets = () => {
    const file = join(root, `prov-${Math.random()}.env`);
    initSecrets(config(), file);
    return loadEnvFile(file);
  };
  const recorder = () => {
    const sql: string[] = [];
    const hindsightRoles = new Set<string>();
    const hindsightDatabases = new Set<string>();
    const hindsightExtensions = new Set<string>();
    const open = (url: string): Db => ({
      query: async (text: string, params: unknown[] = []) => {
        sql.push(new URL(url).pathname + " " + text);
        if (params[0] === "hindsight" && text.includes("FROM pg_roles")) return (hindsightRoles.has("hindsight") ? [{ "?column?": 1 }] : []) as never;
        if (params[0] === "hindsight" && text.includes("FROM pg_database")) return (hindsightDatabases.has("hindsight") ? [{ "?column?": 1 }] : []) as never;
        if (params[0] === "vector" && text.includes("FROM pg_extension")) return (hindsightExtensions.has("vector") ? [{ "?column?": 1 }] : []) as never;
        return [];
      },
      exec: async (text: string) => {
        sql.push(new URL(url).pathname + " " + text);
        if (text.startsWith("CREATE ROLE hindsight ")) hindsightRoles.add("hindsight");
        if (text === "CREATE DATABASE hindsight OWNER hindsight") hindsightDatabases.add("hindsight");
        if (text === "CREATE EXTENSION IF NOT EXISTS vector") hindsightExtensions.add("vector");
      },
      close: async () => {},
    });
    return { sql, open };
  };

  test("each role reaches its own database; rw inserts and updates, nobody deletes", async () => {
    const { sql, open } = recorder();
    await provision(config(), secrets(), open);
    const all = sql.join("\n");
    expect(all).toContain("CREATE ROLE brain_projets_ro LOGIN PASSWORD");
    expect(all).toContain("REVOKE ALL ON DATABASE brain_compta FROM PUBLIC; GRANT CONNECT ON DATABASE brain_compta TO brain_compta_ro, brain_compta_rw");
    expect(all).toContain("GRANT SELECT ON memories TO brain_projets_ro;");
    expect(all).toContain("GRANT SELECT, INSERT, UPDATE ON memories TO brain_projets_rw;");
    expect(all).toContain("REVOKE DELETE, TRUNCATE ON memories FROM brain_projets_rw");
    expect(all).not.toMatch(/GRANT[^;]*DELETE/);
    expect(sql.filter((s) => s.startsWith("/brain_projets ")).join("\n")).not.toContain("brain_compta");
  });

  test("Hindsight role, database and vector extension are provisioned once", async () => {
    const { sql, open } = recorder();
    const env = secrets();
    await provision(config(), env, open);
    const statements = sql.filter((s) =>
      (s.startsWith("/postgres ") && (s.includes("CREATE ROLE hindsight ") || s.includes("CREATE DATABASE hindsight OWNER"))) ||
      (s.startsWith("/hindsight ") && s.includes("CREATE EXTENSION IF NOT EXISTS vector")));
    expect(statements).toHaveLength(3);
    expect(statements.join("\n")).toContain("CREATE ROLE hindsight LOGIN PASSWORD");
    expect(statements.join("\n")).toContain("CREATE DATABASE hindsight OWNER hindsight");
    expect(statements.join("\n")).toContain("CREATE EXTENSION IF NOT EXISTS vector");

    const beforeSecond = sql.length;
    const second = await provision(config(), env, open);
    expect(sql.slice(beforeSecond).some((s) =>
      (s.startsWith("/postgres ") && (s.includes("CREATE ROLE hindsight ") || s.includes("CREATE DATABASE hindsight OWNER"))) ||
      (s.startsWith("/hindsight ") && s.includes("CREATE EXTENSION IF NOT EXISTS vector")))).toBe(false);
    expect(second).toContain("role hindsight up to date");
    expect(second).toContain("database hindsight up to date");
    expect(second).toContain("hindsight: pgvector extension up to date");
  });

  test("a password that could break out of the statement is refused before any role is written", async () => {
    const { sql, open } = recorder();
    const env = { ...secrets(), BRAIN_PROJETS_RO_PASSWORD: "x'; DROP ROLE postgres; --aaaaaaaaaaaa" };
    await expect(provision(config(), env, open)).rejects.toThrow(/BRAIN_PROJETS_RO_PASSWORD must be/);
    expect(sql.some((s) => s.includes("ROLE brain_projets_ro"))).toBe(false);
  });
});

describe("backup", () => {
  test("a backup that cannot reach the brain removes its own directory, and only it", async () => {
    const backups = join(root, `backups-${Math.random()}`);
    const kept = join(backups, "2026-10-24T00-00-00-000Z");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "manifest.json"), "{}");
    const file = join(root, `bk-${Math.random()}.env`);
    initSecrets(config(), file);
    const down: Db = {
      query: async () => { throw Object.assign(new Error("Failed to connect"), { code: "ERR_POSTGRES_CONNECTION_REFUSED" }); },
      exec: async () => {},
      close: async () => {},
    };
    await expect(backup(config({ backup_dir: backups }), loadEnvFile(file), () => down)).rejects.toThrow(/Failed to connect/);
    expect(readdirSync(backups)).toEqual(["2026-10-24T00-00-00-000Z"]);
    expect(readdirSync(kept)).toEqual(["manifest.json"]);
  });
});

describe("restore check", () => {
  test("a control finds its memory in the top 3, and names a superseded or forgotten one as stale", async () => {
    const old = await addMemory(db, { source: "orch-mem", source_ref: "20261020T160426Z-git-workflow", body: "git workflow: squash develop into main" });
    await supersedeMemory(db, old.id, { source: "orch-mem", source_ref: "20261029T135451Z-workflow-git-d-orch", body: "git workflow: no squash, develop merged into main" });
    const stale = await checkControl(db, { domain: "projets", query: "git workflow squash develop main", expect: "20261020T160426Z-git-workflow" });
    expect(stale).toEqual({ ok: false, line: 'FAIL projets: "git workflow squash develop main" -> 20261020T160426Z-git-workflow (stale control: that memory was superseded by 20261029T135451Z-workflow-git-d-orch, update catalog/brain.yaml)' });
    expect(await checkControl(db, { domain: "projets", query: "git workflow squash develop main", expect: "20261029T135451Z-workflow-git-d-orch" }))
      .toEqual({ ok: true, line: 'ok   projets: "git workflow squash develop main" -> 20261029T135451Z-workflow-git-d-orch' });
    const vm = await addMemory(db, { source: "orch-mem", source_ref: "vm-du-lab", body: "VM proxmox pvecli" });
    await forgetMemory(db, vm.id, "obsolete");
    expect((await checkControl(db, { domain: "projets", query: "VM proxmox pvecli", expect: "vm-du-lab" })).line).toEndWith("(stale control: that memory was forgotten, update catalog/brain.yaml)");
    expect(await checkControl(db, { domain: "projets", query: "nothing matches", expect: "absent" })).toEqual({ ok: false, line: 'FAIL projets: "nothing matches" -> absent' });
  });

  test("fails without a backup, and with fewer than 5 control queries", async () => {
    const env = { BRAIN_BACKUP_PASSPHRASE: "p".repeat(32), BRAIN_PG_ADMIN_PASSWORD: "a".repeat(32) };
    expect(await restoreCheck(config(), env, () => db)).toEqual({ ok: false, lines: ["no backup found: run orch brain backup"] });
    const dir = join(root, "backups", "2026-10-24T00-00-00-000Z");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: "x", counts: {} }));
    const r = await restoreCheck(config({ domains: [] }), env, () => db, dir);
    expect(r.ok).toBe(false);
    expect(r.lines).toContain("FAIL controls: 0/5 defined in catalog/brain.yaml");
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toContain("counts");
  });
});
