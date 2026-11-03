// Model providers for the memory brain, switchable at run time. Two roles:
// `embed` turns text into vectors for pgvector, `decide` answers short
// classification or extraction prompts during ingestion and routines.
// `catalog/llm.yaml` declares the providers; `orch llm use` records the active
// one per role in the state dir. Keys come from the environment, else from
// `<repo>/.env` (never committed). Vectors from two embedding spaces are not
// comparable: switching to another `space` is refused unless forced, and then
// everything stored must be re-embedded. No silent fallback between providers.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { envFileWarning, envPath, secretEnv } from "../core/env.ts";
import { stateDir } from "../core/paths.ts";
import { ROOT } from "../core/profile.ts";

export type Role = "embed" | "decide";
export const ROLES: Role[] = ["embed", "decide"];
export type InputKind = "query" | "document";

interface Common { model: string; key_env?: string; timeout_seconds?: number }
export type EmbedProvider = Common & {
  kind: "voyage" | "openai" | "openai-compatible";
  base_url: string;
  space: string;
  query_prefix?: string;
  document_prefix?: string;
};
export type DecideProvider =
  | (Common & { kind: "anthropic"; effort?: string })
  | (Common & { kind: "openai-compatible"; base_url: string });

export interface LlmConfig {
  dimensions: number;
  embed: { default: string; providers: Record<string, EmbedProvider> };
  decide: { default: string; providers: Record<string, DecideProvider> };
}

interface Selection { name: string; space?: string; since: string }
type State = Partial<Record<Role, Selection>>;

export interface Opts { config?: string; state?: string; env?: Record<string, string | undefined>; timeoutMs?: number }

const KINDS: Record<Role, string[]> = { embed: ["voyage", "openai", "openai-compatible"], decide: ["anthropic", "openai-compatible"] };
const BATCH = 64;

export const LLM_USAGE = `usage: orch llm status
       orch llm use embed|decide <provider> [--force]
       orch llm test embed [--as query|document] <text>
       orch llm test decide <prompt>`;

const configPath = (o: Opts) => o.config ?? process.env.ORCH_LLM_CONFIG ?? join(ROOT, "catalog", "llm.yaml");
const statePath = (o: Opts) => join(o.state ?? stateDir(), "llm.json");

export function loadConfig(o: Opts = {}): LlmConfig {
  const path = configPath(o);
  const c = parse(readFileSync(path, "utf8")) as LlmConfig;
  const fail = (msg: string): never => { throw new Error(`llm: ${path}: ${msg}`); };
  if (!Number.isInteger(c?.dimensions) || c.dimensions <= 0) fail("dimensions must be a positive integer");
  for (const role of ROLES) {
    const section = c[role];
    if (!section?.providers || !Object.keys(section.providers).length) fail(`${role}: no provider`);
    if (!section.providers[section.default]) fail(`${role}: default ${section.default} is not declared`);
    for (const [name, p] of Object.entries(section.providers) as [string, EmbedProvider | DecideProvider][]) {
      if (!KINDS[role].includes(p?.kind)) fail(`${role}.${name}: kind must be ${KINDS[role].join(" or ")}`);
      if (!p.model) fail(`${role}.${name}: model is required`);
      if ("base_url" in p && !/^https?:\/\//.test(p.base_url)) fail(`${role}.${name}: base_url must be http(s)`);
      if (p.kind !== "anthropic" && !("base_url" in p)) fail(`${role}.${name}: base_url is required`);
      if (role === "embed" && !(p as EmbedProvider).space) fail(`embed.${name}: space is required`);
    }
  }
  return c;
}

function readState(o: Opts): State {
  const path = statePath(o);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as State;
}

function writeState(o: Opts, state: State) {
  const path = statePath(o);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path); // a crash leaves the old selection, never half a file
}

export function active(role: Role, o: Opts = {}): { name: string; selected: boolean } {
  const c = loadConfig(o);
  const picked = readState(o)[role]?.name;
  if (!picked) return { name: c[role].default, selected: false };
  if (!c[role].providers[picked]) {
    throw new Error(`llm: active ${role} provider ${picked} is no longer declared; run orch llm use ${role} <provider>`);
  }
  return { name: picked, selected: true };
}

export function use(role: Role, name: string, o: Opts & { force?: boolean } = {}): { previous: string; spaceChanged: boolean } {
  const c = loadConfig(o);
  if (!c[role].providers[name]) {
    throw new Error(`llm: unknown ${role} provider ${name} (declared: ${Object.keys(c[role].providers).join(", ")})`);
  }
  const state = readState(o);
  const previous = state[role]?.name ?? c[role].default;
  let spaceChanged = false;
  if (role === "embed") {
    const from = state.embed?.space ?? c.embed.providers[previous]?.space;
    const to = c.embed.providers[name].space;
    spaceChanged = from !== undefined && from !== to;
    if (spaceChanged && !o.force) {
      throw new Error(`llm: embedding space changes from ${from} to ${to}: stored vectors would no longer compare. Re-embed the memory, then rerun with --force`);
    }
    state.embed = { name, space: to, since: new Date().toISOString() };
  } else {
    state.decide = { name, since: new Date().toISOString() };
  }
  writeState(o, state);
  return { previous, spaceChanged };
}

function key(p: { key_env?: string }, role: Role, name: string, o: Opts): string | undefined {
  if (!p.key_env) return undefined;
  const env = o.env ?? secretEnv();
  const value = env[p.key_env];
  if (!value) throw new Error(`llm: ${role}.${name} needs ${p.key_env}: set it in ${envPath()} or the environment`);
  return value;
}

async function post(url: string, body: unknown, label: string, token: string | undefined, timeoutSeconds: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (e) {
    throw new Error(`llm: ${label}: ${url} unreachable (${(e as Error).message}); is the server running?`);
  }
  if (!res.ok) throw new Error(`llm: ${label}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Truncating a Matryoshka vector keeps its leading dimensions; it must then be
// normalized again. A shorter vector than the stored size cannot be used.
export function fit(v: unknown, dims: number, label: string): number[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error(`llm: ${label}: malformed embedding`);
  }
  if (v.length < dims) throw new Error(`llm: ${label}: ${v.length} dimensions, memory stores ${dims}`);
  const cut = v.slice(0, dims) as number[];
  const norm = Math.hypot(...cut);
  if (!norm) throw new Error(`llm: ${label}: zero vector`);
  return cut.map((x) => x / norm);
}

// The embedding space vectors are written in now: two spaces never mix.
export function activeSpace(o: Opts = {}): string {
  return loadConfig(o).embed.providers[active("embed", o).name].space;
}

export async function embed(texts: string[], kind: InputKind, o: Opts = {}): Promise<{ provider: string; space: string; vectors: number[][] }> {
  const c = loadConfig(o);
  const name = active("embed", o).name;
  const p = c.embed.providers[name];
  const label = `embed.${name}`;
  const token = key(p, "embed", name, o);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const prefix = (kind === "query" ? p.query_prefix : p.document_prefix) ?? "";
    const body = p.kind === "voyage"
      ? { model: p.model, input: batch, input_type: kind, output_dimension: c.dimensions }
      : p.kind === "openai"
        ? { model: p.model, input: batch, dimensions: c.dimensions, encoding_format: "float" }
        : { model: p.model, input: batch.map((t) => prefix + t) };
    const json = await post(`${p.base_url.replace(/\/$/, "")}/embeddings`, body, label, token, Math.min(p.timeout_seconds ?? 60, (o.timeoutMs ?? 60_000) / 1000)) as { data?: { index: number; embedding: unknown }[] };
    const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== batch.length) throw new Error(`llm: ${label}: ${data.length} embeddings for ${batch.length} inputs`);
    for (const d of data) vectors.push(fit(d.embedding, c.dimensions, label));
  }
  return { provider: name, space: p.space, vectors };
}

export async function decide(prompt: string, o: Opts & { schema?: Record<string, unknown> } = {}): Promise<{ provider: string; text: string }> {
  const c = loadConfig(o);
  const name = active("decide", o).name;
  const p = c.decide.providers[name];
  const label = `decide.${name}`;
  const token = key(p, "decide", name, o);
  const timeoutSeconds = p.timeout_seconds ?? 120;
  let text: string;
  if (p.kind === "anthropic") {
    text = await anthropicDecide(p, prompt, token, timeoutSeconds, label, o.schema);
  } else {
    const body = {
      model: p.model,
      messages: [{ role: "user", content: prompt }],
      ...(o.schema ? { response_format: { type: "json_schema", json_schema: { name: "decision", schema: o.schema, strict: true } } } : {}),
    };
    const json = await post(`${p.base_url.replace(/\/$/, "")}/chat/completions`, body, label, token, timeoutSeconds) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`llm: ${label}: no message in the response`);
    text = content;
  }
  if (o.schema) {
    try { JSON.parse(text); } catch { throw new Error(`llm: ${label}: answer is not the requested JSON`); }
  }
  return { provider: name, text };
}

async function anthropicDecide(
  p: Common & { effort?: string },
  prompt: string,
  apiKey: string | undefined,
  timeoutSeconds: number,
  label: string,
  schema?: Record<string, unknown>,
): Promise<string> {
  const client = new Anthropic({ apiKey, timeout: timeoutSeconds * 1000 });
  try {
    // fallbacks "default": on a policy decline the API reruns the request on
    // a fallback model inside the same call, instead of stopping.
    const res = await client.beta.messages.create({
      model: p.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        ...(p.effort ? { effort: p.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
        ...(schema ? { format: { type: "json_schema" as const, schema } } : {}),
      },
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new Error(`llm: ${label}: refused (${res.stop_details?.category ?? "no category"})`);
    if (res.stop_reason === "max_tokens") throw new Error(`llm: ${label}: answer cut at max_tokens`);
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text) throw new Error(`llm: ${label}: empty answer (stop_reason ${res.stop_reason})`);
    return text;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error(`llm: ${label}: API key rejected (${envPath()})`);
    if (e instanceof Anthropic.RateLimitError) throw new Error(`llm: ${label}: rate limited, retry later`);
    if (e instanceof Anthropic.APIConnectionError) throw new Error(`llm: ${label}: API unreachable (${e.message})`);
    if (e instanceof Anthropic.APIError) throw new Error(`llm: ${label}: API error ${e.status}: ${e.message}`);
    throw e;
  }
}

export function statusLines(o: Opts = {}): string[] {
  const c = loadConfig(o);
  const lines = [`dimensions ${c.dimensions}`];
  for (const role of ROLES) {
    const { name, selected } = active(role, o);
    for (const [n, p] of Object.entries(c[role].providers)) {
      const where = "base_url" in p ? p.base_url : "api.anthropic.com";
      const space = role === "embed" ? `  space ${(p as EmbedProvider).space}` : "";
      const mark = n === name ? (selected ? "*" : "* (default)") : " ";
      lines.push(`${role.padEnd(7)} ${mark.padEnd(12)} ${n.padEnd(20)} ${p.kind} ${p.model}  ${where}${space}`);
    }
  }
  const warning = envFileWarning();
  if (warning) lines.push(`warning: ${warning}`);
  return lines;
}
