// Connection and migrations of the memory brain. One Postgres database per
// domain (catalog/brain.yaml); `Db` hides the driver so tests run on PGlite
// and production on Bun's built-in Postgres client.
import { SQL } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { secretEnv } from "../core/env.ts";
import { ROOT } from "../core/profile.ts";

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  // Several statements, no parameters (migrations, provisioning). They run as
  // one implicit transaction: CREATE/DROP DATABASE must be sent alone.
  exec(text: string): Promise<void>;
  close(): Promise<void>;
}

export type Role = "ro" | "rw";

export const EXIT_UNAVAILABLE = 75;

const UNAVAILABLE_CODES = new Set([
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "57P03",
]);

// Connection failures can be wrapped, so inspect the cause chain as well.
export function isBrainUnavailable(e: unknown): boolean {
  const seen = new Set<unknown>();
  let current = e;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current !== "object") return false;
    const error = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (UNAVAILABLE_CODES.has(String(error.code)) || String(error.errno) === "57P03") return true;
    current = error.cause;
  }
  return false;
}

export interface Control { domain: string; query: string; expect: string }

export interface BrainConfig {
  host: string;
  port: number;
  container: string;
  domains: string[];
  explicit_only: string[];
  backup_dir: string;
  controls: Control[];
  // orch brain eval: questions worded away from the notes, each with the
  // memory (source_ref) it must find in the top 3, and how many must pass.
  recall: Control[];
  recall_min: number;
  // Where orch mem keeps its notes.
  mem: "files" | "brain";
  memory_provider?: "hindsight" | "brain";
  // Project keys allowed for transcript ingest. Empty = deny all (cannot
  // bypass explicit_only by landing a transcript in `projets`).
  ingest_projects?: string[];
  hindsight: {
    url: string;
    container: string;
    bank: string;
    recall_max_tokens: number;
    recall_budget: "low" | "mid" | "high";
    timeout_ms: number;
    // Per-prompt recall keeps only hits at least this close in meaning (0: off).
    recall_min_semantic?: number;
    // Recall added to the session-start injection (0: none).
    session_recall_tokens?: number;
    // Retain each turn at Stop (benches turn it off to keep their banks still).
    retain?: boolean;
    facts_only?: boolean;
  };
}

export const MIGRATIONS_DIR = join(ROOT, "infra", "migrations");

export function loadBrainConfig(path = process.env.ORCH_BRAIN_CONFIG ?? join(ROOT, "catalog", "brain.yaml")): BrainConfig {
  const c = parse(readFileSync(path, "utf8")) as BrainConfig;
  const fail = (msg: string): never => { throw new Error(`brain: ${path}: ${msg}`); };
  if (!c?.host || !Number.isInteger(c.port)) fail("host and port are required");
  if (!Array.isArray(c.domains) || !c.domains.length) fail("domains must list at least one domain");
  for (const d of c.domains) if (!/^[a-z][a-z0-9_]*$/.test(d)) fail(`domain ${d}: lowercase letters, digits and _ only`);
  c.explicit_only ??= [];
  c.controls ??= [];
  c.mem ??= "files";
  if (c.mem !== "files" && c.mem !== "brain") fail(`mem: files or brain, not ${String(c.mem)}`);
  c.memory_provider ??= "hindsight";
  if (!["hindsight", "brain"].includes(c.memory_provider)) fail("memory_provider: hindsight or brain");
  c.ingest_projects ??= [];
  if (!Array.isArray(c.ingest_projects) || c.ingest_projects.some((name) => typeof name !== "string" || !name.trim() || name.includes("/") || name.includes("\0"))) {
    fail("ingest_projects must be a list of project keys");
  }
  c.container ??= "brain-postgres";
  c.backup_dir = (c.backup_dir ?? "~/.local/state/orch/brain/backups").replace(/^~(?=\/)/, homedir());
  for (const k of c.controls) if (!c.domains.includes(k.domain)) fail(`control "${k.query}": unknown domain ${k.domain}`);
  c.recall ??= [];
  for (const k of c.recall) {
    if (!k?.query || !k.expect) fail("recall: each case needs query and expect");
    if (!c.domains.includes(k.domain)) fail(`recall "${k.query}": unknown domain ${k.domain}`);
  }
  c.recall_min ??= c.recall.length;
  if (!Number.isInteger(c.recall_min) || c.recall_min < 0 || c.recall_min > c.recall.length) fail(`recall_min: an integer from 0 to ${c.recall.length}`);
  // The block is optional (tests and older catalogs): localhost defaults, validated like an explicit block.
  if (c.hindsight === undefined) c.hindsight = { url: "http://127.0.0.1:8899", container: "brain-hindsight", bank: "kiba", recall_max_tokens: 1500, recall_budget: "low", timeout_ms: 4000 };
  if (!c.hindsight || typeof c.hindsight !== "object") fail("hindsight must be a block of settings");
  if (typeof c.hindsight.url !== "string") fail("hindsight.url must be an HTTP URL");
  let hindsightUrl: URL | undefined;
  try { hindsightUrl = new URL(c.hindsight.url); } catch {}
  if (!hindsightUrl || !/^https?:$/.test(hindsightUrl.protocol) || !hindsightUrl.hostname || hindsightUrl.username || hindsightUrl.password) fail("hindsight.url must be an HTTP URL without credentials");
  if (typeof c.hindsight.container !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(c.hindsight.container)) fail("hindsight.container must be a container name");
  if (typeof c.hindsight.bank !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(c.hindsight.bank)) fail("hindsight.bank must be a bank name");
  if (!Number.isInteger(c.hindsight.recall_max_tokens) || c.hindsight.recall_max_tokens < 1) fail("hindsight.recall_max_tokens must be a positive integer");
  if (!["low", "mid", "high"].includes(c.hindsight.recall_budget)) fail("hindsight.recall_budget must be low, mid or high");
  if (!Number.isInteger(c.hindsight.timeout_ms) || c.hindsight.timeout_ms < 1) fail("hindsight.timeout_ms must be a positive integer");
  c.hindsight.recall_min_semantic ??= 0;
  c.hindsight.session_recall_tokens ??= 800;
  c.hindsight.retain ??= true;
  c.hindsight.facts_only ??= true;
  if (typeof c.hindsight.recall_min_semantic !== "number" || c.hindsight.recall_min_semantic < 0 || c.hindsight.recall_min_semantic > 1) fail("hindsight.recall_min_semantic must be a number from 0 to 1");
  if (!Number.isInteger(c.hindsight.session_recall_tokens) || c.hindsight.session_recall_tokens < 0) fail("hindsight.session_recall_tokens must be an integer, 0 or more");
  if (typeof c.hindsight.retain !== "boolean") fail("hindsight.retain must be true or false");
  if (typeof c.hindsight.facts_only !== "boolean") fail("hindsight.facts_only must be true or false");
  return c;
}

export const dbName = (domain: string) => `brain_${domain}`;
export const roleName = (domain: string, role: Role) => `brain_${domain}_${role}`;
export const passwordKey = (domain: string, role: Role) => `BRAIN_${domain.toUpperCase()}_${role.toUpperCase()}_PASSWORD`;
export const ADMIN_KEY = "BRAIN_PG_ADMIN_PASSWORD";

function need(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`brain: ${key} is missing: run orch brain init`);
  return v;
}

export function connectionUrl(c: BrainConfig, target: { domain: string; role: Role } | { admin: true; database: string }, env = secretEnv()): string {
  const [user, password, database] = "admin" in target
    ? ["postgres", need(env, ADMIN_KEY), target.database]
    : [roleName(target.domain, target.role), need(env, passwordKey(target.domain, target.role)), dbName(target.domain)];
  return `postgres://${user}:${encodeURIComponent(password)}@${c.host}:${c.port}/${database}`;
}

// One connection: migrations send BEGIN and COMMIT as plain statements, which
// Bun only allows when every query goes through the same connection.
export function openUrl(url: string): Db {
  const sql = new SQL(url, { max: 1, idleTimeout: 30 });
  return {
    query: async <T>(text: string, params: unknown[] = []) => (await sql.unsafe(text, params)) as T[],
    exec: async (text: string) => { await sql.unsafe(text).simple(); },
    close: () => sql.close(),
  };
}

export function openDomain(c: BrainConfig, domain: string, role: Role, env = secretEnv()): Db {
  if (!c.domains.includes(domain)) throw new Error(`brain: unknown domain ${domain} (domains: ${c.domains.join(", ")})`);
  return openUrl(connectionUrl(c, { domain, role }, env));
}

// Applies every infra/migrations/NNN_*.sql not yet recorded, each in its own
// transaction with its record: a failure leaves the base at the last good one.
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ version: string }>("SELECT version FROM schema_migrations")).map((r) => r.version));
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort() : [];
  const applied: string[] = [];
  for (const f of files) {
    const version = f.slice(0, -4);
    if (done.has(version)) continue;
    const body = readFileSync(join(dir, f), "utf8");
    try {
      await db.exec(`BEGIN;\n${body}\nINSERT INTO schema_migrations (version) VALUES ('${version}');\nCOMMIT;`);
    } catch (e) {
      await db.exec("ROLLBACK").catch(() => {});
      throw new Error(`brain: migration ${version} failed, nothing applied: ${(e as Error).message}`);
    }
    applied.push(version);
  }
  return applied;
}
