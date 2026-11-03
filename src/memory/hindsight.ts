// Hindsight client: the living memory of the lead (retain each turn, recall
// before each prompt). HTTP only, over fetch; the server runs in Docker on
// localhost (infra/compose.yml, service `hindsight`). Config in
// catalog/brain.yaml under `hindsight:`; secrets from .env (src/core/env.ts).
// Never throws on a network failure: every call returns a result the hooks
// can ignore, because a hook must never block the lead.
import { loadBrainConfig } from "../brain/db.ts";
import { secretEnv } from "../core/env.ts";
import { flattenUntrusted, inspectSecrets, wrapUntrusted } from "./privacy.ts";

export interface HindsightConfig {
  url: string;                 // http://127.0.0.1:8899
  bank: string;                // operator-wide bank: "kiba"
  recall_max_tokens: number;   // injected context cap, 1500
  recall_budget: "low" | "mid" | "high";
  timeout_ms: number;          // per call, 4000 for recall (sync hook), 10000 for retain
  recall_min_semantic?: number; // per-prompt hits below this semantic score are dropped (0: off)
  session_recall_tokens?: number; // recall added at session start, 800 (0: none)
  retain?: boolean;             // retain each turn at Stop, true
  facts_only?: boolean;         // exclude consolidated observations, true
  token?: string;              // authorization header when the server asks for one
}

export interface RetainItem {
  content: string;
  timestamp?: string;          // ISO 8601
  context?: string;            // "claude-code turn", "lane report", "orch mem note"
  metadata?: Record<string, string>;
  document_id?: string;        // one per session: append mode
  update_mode?: "replace" | "append";
  tags?: string[];
}

export interface RecallHit {
  id: string;
  text: string;
  type: "world" | "experience" | "observation";
  context?: string;
  tags?: string[];
  mentioned_at?: string;
  scores?: { final?: number; reranker?: number; semantic?: number; keyword?: number };
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const success = <T>(value: T): Result<T> => ({ ok: true, value });
const failure = (error: string): Result<never> => ({ ok: false, error });

const RETAIN_ASYNC_TIMEOUT_MS = 10_000;
const RETAIN_SYNC_TIMEOUT_MS = 60_000;

function redact(error: string, token?: string): string {
  return token ? error.split(token).join("[redacted]") : error;
}

// timeoutMs: recall keeps the sync hook budget (c.timeout_ms); a synchronous retain waits for the extraction.
async function request(c: HindsightConfig, path: string, body?: unknown, timeoutMs = c.timeout_ms): Promise<Result<Response>> {
  try {
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    if (c.token) headers.set("authorization", `Bearer ${c.token}`);
    const response = await fetch(`${c.url.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200).replace(/[\r\n\t]+/g, " ");
      return failure(redact(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`, c.token));
    }
    return success(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(redact(message, c.token));
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function loadHindsightConfig(path?: string): HindsightConfig {
  const { hindsight } = loadBrainConfig(path);
  const token = secretEnv().HINDSIGHT_API_TOKEN || undefined;
  return { ...hindsight, token };
}

// A 200 is not enough: another service on the port (a web UI) also answers
// 200 with HTML. Hindsight answers JSON with a `status` string.
export async function health(_c: HindsightConfig): Promise<Result<void>> {
  const response = await request(_c, "/health");
  if (!response.ok) return response;
  try {
    const body = asObject(await response.value.json());
    return typeof body?.status === "string" ? success(undefined) : failure("not a Hindsight server (no JSON status)");
  } catch {
    return failure("not a Hindsight server (no JSON status)");
  }
}

export async function retain(_c: HindsightConfig, _items: RetainItem[], _opts?: { bank?: string; async?: boolean }): Promise<Result<{ items_count: number }>> {
  const items: RetainItem[] = [];
  for (const item of _items) {
    const scan = inspectSecrets(item.content);
    if (!scan.ok) return failure(`secret: rejected chunk (${scan.kinds.join(",")})`);
    items.push({ ...item, content: scan.text });
  }
  const bank = encodeURIComponent(_opts?.bank ?? _c.bank);
  const asynchronous = _opts?.async ?? true;
  // Extraction runs inline on a synchronous retain (seconds); async returns at once.
  const response = await request(_c, `/v1/default/banks/${bank}/memories`, { items, async: asynchronous }, asynchronous ? RETAIN_ASYNC_TIMEOUT_MS : RETAIN_SYNC_TIMEOUT_MS);
  if (!response.ok) return response;
  try {
    const text = await response.value.text();
    const payload = text ? asObject(JSON.parse(text)) : null;
    const count = payload?.items_count;
    if (typeof count === "number" && Number.isFinite(count)) return success({ items_count: count });
    if (asynchronous) return success({ items_count: _items.length });
    return failure("invalid retain response: missing items_count");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(redact(`invalid retain response: ${message}`, _c.token));
  }
}

export async function deleteDocument(_c: HindsightConfig, _bank: string, _documentId: string): Promise<Result<void>> {
  try {
    const headers = new Headers();
    if (_c.token) headers.set("authorization", `Bearer ${_c.token}`);
    const bank = encodeURIComponent(_bank);
    const documentId = encodeURIComponent(_documentId);
    const response = await fetch(`${_c.url.replace(/\/$/, "")}/v1/default/banks/${bank}/documents/${documentId}`, {
      method: "DELETE", headers, signal: AbortSignal.timeout(_c.timeout_ms),
    });
    if (response.status === 404) return success(undefined);
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200).replace(/[\r\n\t]+/g, " ");
      return failure(redact(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`, _c.token));
    }
    return success(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(redact(message, _c.token));
  }
}

// Drops a whole bank; a missing bank is already gone. Only for banks a caller
// owns (a bench run's UUID banks), or a production bank renameBanks has just
// cloned and checked (src/memory/rename-banks.ts).
export async function deleteBank(_c: HindsightConfig, bank: string): Promise<Result<void>> {
  try {
    const headers = new Headers();
    if (_c.token) headers.set("authorization", `Bearer ${_c.token}`);
    const response = await fetch(`${_c.url.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(bank)}`, {
      method: "DELETE", headers, signal: AbortSignal.timeout(_c.timeout_ms),
    });
    if (response.status === 404 || response.ok) return success(undefined);
    return failure(redact(`HTTP ${response.status}`, _c.token));
  } catch (error) {
    return failure(redact(error instanceof Error ? error.message : String(error), _c.token));
  }
}

// Banks appear at the first write; the operator-wide bank gets no write
// before its first recall, so provisioning creates it (PUT is idempotent).
export async function ensureBank(_c: HindsightConfig, bank: string): Promise<Result<void>> {
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (_c.token) headers.set("authorization", `Bearer ${_c.token}`);
    const response = await fetch(`${_c.url.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(bank)}`, {
      method: "PUT", headers, body: JSON.stringify({ name: bank }), signal: AbortSignal.timeout(_c.timeout_ms),
    });
    if (!response.ok) return failure(redact(`HTTP ${response.status}`, _c.token));
    return success(undefined);
  } catch (error) {
    return failure(redact(error instanceof Error ? error.message : String(error), _c.token));
  }
}

export async function recall(_c: HindsightConfig, _query: string, _opts?: { bank?: string; max_tokens?: number; tags?: string[] }): Promise<Result<RecallHit[]>> {
  const inspected = inspectSecrets(_query);
  if (!inspected.ok) return failure(`secret: rejected (${inspected.kinds.join(",")})`);
  const bank = encodeURIComponent(_opts?.bank ?? _c.bank);
  const body = {
    query: inspected.text,
    ...(_c.facts_only === false ? {} : { types: ["world", "experience"] }),
    budget: _c.recall_budget,
    max_tokens: _opts?.max_tokens ?? _c.recall_max_tokens,
    ...(_opts?.tags ? { tags: _opts.tags } : {}),
  };
  const response = await request(_c, `/v1/default/banks/${bank}/memories/recall`, body);
  if (!response.ok) return response;
  try {
    const payload = asObject(await response.value.json());
    if (!Array.isArray(payload?.results)) return failure("invalid recall response: results must be an array");
    const hits: RecallHit[] = payload.results.map((value) => {
      const hit = asObject(value);
      const scores = asObject(hit?.scores);
      if (!hit || typeof hit.id !== "string" || typeof hit.text !== "string" || !["world", "experience", "observation"].includes(String(hit.type))) {
        throw new Error("invalid recall result");
      }
      return {
        id: hit.id,
        text: hit.text,
        type: hit.type as RecallHit["type"],
        ...(typeof hit.context === "string" ? { context: hit.context } : {}),
        ...(Array.isArray(hit.tags) && hit.tags.every((tag) => typeof tag === "string") ? { tags: hit.tags as string[] } : {}),
        ...(typeof hit.mentioned_at === "string" ? { mentioned_at: hit.mentioned_at } : {}),
        ...(scores ? { scores: {
          ...(typeof scores.final === "number" ? { final: scores.final } : {}),
          ...(typeof scores.reranker === "number" ? { reranker: scores.reranker } : {}),
          ...(typeof scores.semantic === "number" ? { semantic: scores.semantic } : {}),
          ...(typeof scores.keyword === "number" ? { keyword: scores.keyword } : {}),
        } } : {}),
      };
    });
    hits.sort((a, b) => (b.scores?.final ?? Number.NEGATIVE_INFINITY) - (a.scores?.final ?? Number.NEGATIVE_INFINITY));
    return success(_c.facts_only === false ? hits : hits.filter((hit) => hit.type !== "observation"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(redact(`invalid recall response: ${message}`, _c.token));
  }
}
export function recallLine(hit: RecallHit): string {
  const parsed = hit.mentioned_at ? Date.parse(hit.mentioned_at) : Number.NaN;
  const date = hit.mentioned_at
    ? Number.isNaN(parsed) ? flattenUntrusted(hit.mentioned_at).slice(0, 10) : new Date(parsed).toISOString().slice(0, 10)
    : undefined;
  return `- [${hit.type}] ${flattenUntrusted(hit.text)}${date ? ` (${date})` : ""}`;
}

// Lines ready for additionalContext: flattened (no newline forging), wrapped
// as an untrusted block with source and trust. Cut at max_tokens (~4 chars per token).
export function formatRecall(_hits: RecallHit[], _max_tokens: number, meta: { source?: string; trust?: string } = {}): string {
  const limit = Math.max(0, Math.floor(_max_tokens * 4));
  if (!limit || !_hits.length) return "";
  const mark = { source: meta.source ?? "hindsight", trust: meta.trust ?? "untrusted" };
  const overhead = wrapUntrusted("", mark).length;
  const lines: string[] = [];
  let length = overhead;
  for (const hit of _hits) {
    const line = recallLine(hit);
    const nextLength = length + line.length;
    if (nextLength > limit) continue;
    lines.push(line);
    length = nextLength;
  }
  if (!lines.length) return "";
  return wrapUntrusted(lines.join("\n"), mark);
}

export async function listBanks(c: HindsightConfig): Promise<Result<string[]>> {
  const response = await request(c, "/v1/default/banks");
  if (!response.ok) return response;
  try {
    const body = asObject(await response.value.json());
    const rows = Array.isArray(body?.banks) ? body.banks : [];
    return success(rows.map((row) => asObject(row)?.bank_id).filter((id): id is string => typeof id === "string"));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export interface BankStats { nodes: number; documents: number; pending: number }

export async function bankStats(c: HindsightConfig, bank: string): Promise<Result<BankStats>> {
  const response = await request(c, `/v1/default/banks/${encodeURIComponent(bank)}/stats`);
  if (!response.ok) return response;
  try {
    const body = asObject(await response.value.json()) ?? {};
    const n = (k: string) => (typeof body[k] === "number" ? body[k] as number : 0);
    return success({ nodes: n("total_nodes"), documents: n("total_documents"), pending: n("pending_operations") });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

// Hindsight's clone: export and import on this instance, no LLM call (facts
// are re-embedded). The target must not exist. Returns the operation id,
// recorded against the source bank.
export async function cloneBank(c: HindsightConfig, from: string, to: string): Promise<Result<string>> {
  const q = new URLSearchParams({ target_bank_id: to, include_data: "true", include_bank_config: "true", include_history: "true" });
  const response = await request(c, `/v1/default/banks/${encodeURIComponent(from)}/clone?${q}`, {}, 60_000);
  if (!response.ok) return response;
  try {
    const body = asObject(await response.value.json());
    const id = body?.operation_id;
    return typeof id === "string" ? success(id) : failure("clone: no operation_id in the answer");
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function operationStatus(c: HindsightConfig, bank: string, id: string): Promise<Result<string>> {
  const response = await request(c, `/v1/default/banks/${encodeURIComponent(bank)}/operations/${encodeURIComponent(id)}`);
  if (!response.ok) return response;
  try {
    const status = asObject(await response.value.json())?.status;
    return typeof status === "string" ? success(status) : failure("operation: no status");
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
