// Operations on the memory brain: credentials, container, provisioning,
// status, encrypted backups and the restore check that validates them.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envPath, secretEnv, setEnvIfMissing } from "../core/env.ts";
import { ROOT } from "../core/profile.ts";
import { ensureBank, health } from "../memory/hindsight.ts";
import { ADMIN_KEY, type BrainConfig, connectionUrl, type Db, dbName, isBrainUnavailable, migrate, MIGRATIONS_DIR, openUrl, passwordKey, type Role, roleName } from "./db.ts";
import { countMemories, type Memory, searchMemories } from "./store.ts";

export const BACKUP_KEY = "BRAIN_BACKUP_PASSPHRASE";
const ROLES: Role[] = ["ro", "rw"];
const SAFE_SECRET = /^[A-Za-z0-9_-]{24,}$/;

// Generates every missing credential into .env; never replaces one the
// operator set. Returns the keys written, never their values.
export function initSecrets(c: BrainConfig, path = envPath()): string[] {
  const keys = [ADMIN_KEY, BACKUP_KEY, "HINDSIGHT_PG_PASSWORD", ...c.domains.flatMap((d) => ROLES.map((r) => passwordKey(d, r)))];
  return keys.filter((k) => setEnvIfMissing(k, randomBytes(24).toString("base64url"), path));
}

function run(cmd: string[], opts: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; out: string; err: string; stdout: Buffer } {
  const r = spawnSync(cmd[0], cmd.slice(1), { input: opts.input, env: opts.env ?? process.env, maxBuffer: 1 << 30 });
  return { ok: r.status === 0, out: r.stdout?.toString() ?? "", err: (r.stderr?.toString() ?? r.error?.message ?? "").trim(), stdout: r.stdout ?? Buffer.alloc(0) };
}

export function composeUp(): void {
  const r = run(["docker", "compose", "-f", join(ROOT, "infra", "compose.yml"), "--env-file", envPath(), "up", "-d", "--wait"]);
  if (!r.ok) throw new Error(`brain: docker compose up failed: ${r.err.split("\n").slice(-3).join(" ")}`);
}

// DDL takes no bind parameters: secrets are checked to be plain tokens before
// they are written into a statement.
function secret(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`brain: ${key} is missing: run orch brain init`);
  if (!SAFE_SECRET.test(v)) throw new Error(`brain: ${key} must be 24+ characters of A-Z a-z 0-9 _ -`);
  return v;
}

// Databases, roles and grants, idempotent. Each role reaches only its own
// database; rw may insert and update, ro only read; nobody may delete.
export async function provision(c: BrainConfig, env = secretEnv(), open: (url: string) => Db = openUrl, migrations = MIGRATIONS_DIR): Promise<string[]> {
  const out: string[] = [];
  const admin = open(connectionUrl(c, { admin: true, database: "postgres" }, env));
  try {
    for (const d of c.domains) {
      for (const r of ROLES) {
        const role = roleName(d, r);
        const pw = secret(env, passwordKey(d, r));
        const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).length > 0;
        await admin.exec(`${exists ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      }
      if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName(d)])).length) {
        await admin.exec(`CREATE DATABASE ${dbName(d)}`);
        out.push(`created ${dbName(d)}`);
      }
      await admin.exec(`REVOKE ALL ON DATABASE ${dbName(d)} FROM PUBLIC; GRANT CONNECT ON DATABASE ${dbName(d)} TO ${roleName(d, "ro")}, ${roleName(d, "rw")}`);
    }
    const hindsightPassword = secret(env, "HINDSIGHT_PG_PASSWORD");
    const hindsightRoleExists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", ["hindsight"])).length > 0;
    if (hindsightRoleExists) out.push("role hindsight up to date");
    else {
      await admin.exec(`CREATE ROLE hindsight LOGIN PASSWORD '${hindsightPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      out.push("created role hindsight");
    }
    const hindsightDatabaseExists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", ["hindsight"])).length > 0;
    if (hindsightDatabaseExists) out.push("database hindsight up to date");
    else {
      await admin.exec("CREATE DATABASE hindsight OWNER hindsight");
      out.push("created database hindsight");
    }
  } finally {
    await admin.close();
  }
  const up = await health(c.hindsight);
  if (up.ok) {
    const bank = await ensureBank(c.hindsight, c.hindsight.bank);
    out.push(bank.ok ? `hindsight: bank ${c.hindsight.bank} ready` : `hindsight: bank ${c.hindsight.bank} not created (${bank.error})`);
  } else {
    out.push(`hindsight: server not reachable, bank ${c.hindsight.bank} is created on the next provision after orch brain up`);
  }
  for (const d of c.domains) {
    const db = open(connectionUrl(c, { admin: true, database: dbName(d) }, env));
    try {
      const applied = await migrate(db, migrations);
      await db.exec(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO ${roleName(d, "ro")}, ${roleName(d, "rw")};
        GRANT SELECT ON memories TO ${roleName(d, "ro")};
        GRANT SELECT, INSERT, UPDATE ON memories TO ${roleName(d, "rw")};
        REVOKE DELETE, TRUNCATE ON memories FROM ${roleName(d, "rw")}`);
      out.push(`${dbName(d)}: ${applied.length ? `migrated ${applied.join(", ")}` : "schema up to date"}`);
    } finally {
      await db.close();
    }
  }
  const hindsightDb = open(connectionUrl(c, { admin: true, database: "hindsight" }, env));
  try {
    const extensionExists = (await hindsightDb.query("SELECT 1 FROM pg_extension WHERE extname = $1", ["vector"])).length > 0;
    if (extensionExists) out.push("hindsight: pgvector extension up to date");
    else {
      await hindsightDb.exec("CREATE EXTENSION IF NOT EXISTS vector");
      out.push("hindsight: created pgvector extension");
    }
  } finally {
    await hindsightDb.close();
  }
  return out;
}

// unavailable: the first connection error, so the caller can exit 75 after
// printing every domain.
export async function statusLines(c: BrainConfig, env = secretEnv(), open: (url: string) => Db = openUrl): Promise<{ lines: string[]; unavailable?: unknown }> {
  const lines: string[] = [];
  let unavailable: unknown;
  for (const d of c.domains) {
    let db: Db | undefined;
    try {
      db = open(connectionUrl(c, { domain: d, role: "ro" }, env));
      const n = await countMemories(db);
      lines.push(`${d.padEnd(9)} ${String(n.active).padStart(6)} active  ${String(n.total).padStart(6)} total  ${String(n.unembedded).padStart(6)} without vector${c.explicit_only.includes(d) ? "  (searched only by name)" : ""}`);
    } catch (e) {
      lines.push(`${d.padEnd(9)} unreachable: ${(e as Error).message}`);
      if (!unavailable && isBrainUnavailable(e)) unavailable = e;
    } finally {
      await db?.close();
    }
  }
  if (c.controls.length < 5) lines.push(`controls: ${c.controls.length}/5 defined in catalog/brain.yaml (restore-check fails until 5)`);
  const hindsight = await health({ ...c.hindsight, token: env.HINDSIGHT_API_TOKEN });
  lines.push(`hindsight     ${c.hindsight.url}  ${hindsight.ok ? "ok" : `unreachable (${hindsight.error})`}`);
  return { lines, unavailable };
}

interface BackupManifest { at: string; counts: Record<string, number> }

// One custom-format dump per domain, encrypted with the .env passphrase
// (openssl AES-256, PBKDF2) before it touches the disk, mode 600, plus the
// counts the restore check compares against. A failed backup removes its
// directory: a brain-backup deferred every 15 minutes while the brain is
// down would otherwise leave one empty directory per attempt.
export async function backup(c: BrainConfig, env = secretEnv(), open: (url: string) => Db = openUrl): Promise<string> {
  const pass = secret(env, BACKUP_KEY);
  const dir = join(c.backup_dir, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    await dumpAll(c, env, open, pass, dir);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

const HINDSIGHT_DB = "hindsight";

async function hindsightUnits(db: Db): Promise<number> {
  try { return Number((await db.query("SELECT count(*)::int AS n FROM memory_units"))[0]?.n ?? 0); } finally { await db.close(); }
}

function dumpEncrypted(c: BrainConfig, database: string, pass: string, file: string): void {
  const dump = run(["docker", "exec", c.container, "pg_dump", "-U", "postgres", "-Fc", database]);
  if (!dump.ok) throw new Error(`brain: pg_dump ${database} failed: ${dump.err}`);
  const enc = run(["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt", "-pass", "env:ORCH_BRAIN_PASS"],
    { input: dump.stdout, env: { ...process.env, ORCH_BRAIN_PASS: pass } });
  if (!enc.ok) throw new Error(`brain: encryption of ${database} failed: ${enc.err}`);
  writeFileSync(file, enc.stdout, { mode: 0o600 });
}

function restoreInto(c: BrainConfig, file: string, pass: string, scratch: string): void {
  const dec = run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-pass", "env:ORCH_BRAIN_PASS", "-in", file],
    { env: { ...process.env, ORCH_BRAIN_PASS: pass } });
  if (!dec.ok) throw new Error(`decryption failed (wrong passphrase or damaged file): ${dec.err.split("\n")[0]}`);
  const restore = run(["docker", "exec", "-i", c.container, "pg_restore", "-U", "postgres", "--no-owner", "--no-privileges", "-d", scratch], { input: dec.stdout });
  if (!restore.ok) throw new Error(`pg_restore failed: ${restore.err.split("\n").slice(-2).join(" ")}`);
}

async function dumpAll(c: BrainConfig, env: Record<string, string | undefined>, open: (url: string) => Db, pass: string, dir: string): Promise<void> {
  const counts: Record<string, number> = {};
  for (const d of c.domains) {
    const db = open(connectionUrl(c, { domain: d, role: "ro" }, env));
    try { counts[d] = (await countMemories(db)).total; } finally { await db.close(); }
    dumpEncrypted(c, dbName(d), pass, join(dir, `${d}.dump.enc`));
  }
  // Hindsight's own database (the living memory) when it exists: same dump,
  // counted on memory_units so the restore check can compare.
  const admin = open(connectionUrl(c, { admin: true, database: "postgres" }, env));
  let hindsight = false;
  try { hindsight = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [HINDSIGHT_DB])).length > 0; } finally { await admin.close(); }
  if (hindsight) {
    counts[HINDSIGHT_DB] = await hindsightUnits(open(connectionUrl(c, { admin: true, database: HINDSIGHT_DB }, env)));
    dumpEncrypted(c, HINDSIGHT_DB, pass, join(dir, `${HINDSIGHT_DB}.dump.enc`));
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ at: new Date().toISOString(), counts } satisfies BackupManifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(dir, 0o700);
}

/**
 * Backups to delete: keep the newest of each of the last `daily` days and of
 * each of the `weekly` weeks (Monday to Sunday) before them. Names are the ISO stamps
 * backup() writes. The newest is always kept.
 */
export function backupsToDrop(names: string[], daily = 7, weekly = 4): string[] {
  const sorted = [...names].sort().reverse();
  const keep = new Set<string>(sorted.slice(0, 1));
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const name of sorted) {
    const day = name.slice(0, 10);
    if (days.size < daily && !days.has(day)) {
      days.add(day);
      keep.add(name);
      continue;
    }
    if (days.has(day)) continue;
    const week = isoWeek(day);
    if (weeks.size < weekly && !weeks.has(week)) {
      weeks.add(week);
      keep.add(name);
    }
  }
  return sorted.filter((name) => !keep.has(name));
}

/** The Monday of the day's week: one key per week, no year arithmetic. */
function isoWeek(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Deletes the backups `backupsToDrop` selects; only complete ones (with a manifest) count. */
export function pruneBackups(c: BrainConfig): string[] {
  if (!existsSync(c.backup_dir)) return [];
  const names = readdirSync(c.backup_dir).filter((n) => existsSync(join(c.backup_dir, n, "manifest.json")));
  const drop = backupsToDrop(names);
  for (const name of drop) rmSync(join(c.backup_dir, name), { recursive: true, force: true });
  return drop;
}

export function latestBackup(c: BrainConfig): string | null {
  if (!existsSync(c.backup_dir)) return null;
  const dirs = readdirSync(c.backup_dir).filter((n) => existsSync(join(c.backup_dir, n, "manifest.json"))).sort();
  return dirs.length ? join(c.backup_dir, dirs.at(-1)!) : null;
}

type Control = BrainConfig["controls"][number];

// One control query of the restore check: the expected memory must be in the
// top 3 of the active memories. When it is not because that memory was
// superseded or forgotten since the control was written, the line says so:
// the control is stale (update catalog/brain.yaml), the backup is not at fault.
export async function checkControl(db: Db, k: Control): Promise<{ ok: boolean; line: string }> {
  const hits = await searchMemories(db, k.query, { limit: 3 });
  const hit = hits.some((h) => h.memory.source_ref.includes(k.expect) || h.memory.body.includes(k.expect));
  const line = `${hit ? "ok  " : "FAIL"} ${k.domain}: "${k.query}" -> ${k.expect}`;
  if (hit) return { ok: true, line };
  const [gone] = await db.query<Pick<Memory, "superseded_by" | "forgotten_at">>(
    `SELECT superseded_by, forgotten_at FROM memories WHERE strpos(source_ref, $1) > 0
     ORDER BY (superseded_by IS NULL AND forgotten_at IS NULL) DESC, occurred_at DESC LIMIT 1`, [k.expect]);
  if (gone?.superseded_by && !gone.forgotten_at) {
    const [next] = await db.query<Pick<Memory, "source_ref">>("SELECT source_ref FROM memories WHERE id = $1", [gone.superseded_by]);
    return { ok: false, line: `${line} (stale control: that memory was superseded by ${next?.source_ref ?? gone.superseded_by}, update catalog/brain.yaml)` };
  }
  if (gone?.forgotten_at) return { ok: false, line: `${line} (stale control: that memory was forgotten, update catalog/brain.yaml)` };
  return { ok: false, line };
}

// A backup counts only once restored: each dump goes into a scratch database,
// which must hold the recorded count and answer every control query of its
// domain with the expected memory in the top 3. The scratch databases are
// dropped whatever happens.
export async function restoreCheck(c: BrainConfig, env = secretEnv(), open: (url: string) => Db = openUrl, dir = latestBackup(c)): Promise<{ ok: boolean; lines: string[] }> {
  if (!dir) return { ok: false, lines: ["no backup found: run orch brain backup"] };
  const pass = secret(env, BACKUP_KEY);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
  const lines = [`backup ${dir}`];
  let ok = c.controls.length >= 5;
  if (!ok) lines.push(`FAIL controls: ${c.controls.length}/5 defined in catalog/brain.yaml`);
  for (const d of c.domains) {
    const scratch = `brain_check_${d}`;
    const admin = open(connectionUrl(c, { admin: true, database: "postgres" }, env));
    try {
      await admin.exec(`DROP DATABASE IF EXISTS ${scratch}`);
      await admin.exec(`CREATE DATABASE ${scratch}`);
      restoreInto(c, join(dir, `${d}.dump.enc`), pass, scratch);
      const db = open(connectionUrl(c, { admin: true, database: scratch }, env));
      try {
        const total = (await countMemories(db)).total;
        const want = manifest.counts[d];
        const countOk = total === want;
        lines.push(`${countOk ? "ok  " : "FAIL"} ${d}: ${total} memories restored, ${want} recorded`);
        ok &&= countOk;
        for (const k of c.controls.filter((x) => x.domain === d)) {
          const r = await checkControl(db, k);
          lines.push(r.line);
          ok &&= r.ok;
        }
      } finally {
        await db.close();
      }
    } catch (e) {
      ok = false;
      lines.push(`FAIL ${d}: ${(e as Error).message}`);
    } finally {
      await admin.exec(`DROP DATABASE IF EXISTS ${scratch}`).catch(() => {});
      await admin.close();
    }
  }
  if (manifest.counts[HINDSIGHT_DB] !== undefined) {
    const scratch = `brain_check_${HINDSIGHT_DB}`;
    const admin = open(connectionUrl(c, { admin: true, database: "postgres" }, env));
    try {
      await admin.exec(`DROP DATABASE IF EXISTS ${scratch}`);
      await admin.exec(`CREATE DATABASE ${scratch}`);
      restoreInto(c, join(dir, `${HINDSIGHT_DB}.dump.enc`), pass, scratch);
      const total = await hindsightUnits(open(connectionUrl(c, { admin: true, database: scratch }, env)));
      const want = manifest.counts[HINDSIGHT_DB];
      lines.push(`${total === want ? "ok  " : "FAIL"} ${HINDSIGHT_DB}: ${total} memory units restored, ${want} recorded`);
      ok &&= total === want;
    } catch (e) {
      ok = false;
      lines.push(`FAIL ${HINDSIGHT_DB}: ${(e as Error).message}`);
    } finally {
      await admin.exec(`DROP DATABASE IF EXISTS ${scratch}`).catch(() => {});
      await admin.close();
    }
  }
  return { ok, lines };
}
