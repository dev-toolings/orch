import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFileWarning, loadEnvFile } from "../src/core/env.ts";
import { active, activeSpace, decide, embed, fit, loadConfig, use } from "../src/llm/llm.ts";

// A fake server stands in for Voyage, OpenAI, an OpenAI-compatible server and the
// Anthropic API: no test calls a model.
let root: string;
let server: ReturnType<typeof Bun.serve>;
const seen: { path: string; headers: Headers; body: Record<string, unknown> }[] = [];
let anthropicStatus = 200;
let anthropicStop = "end_turn";
const savedBase = process.env.ANTHROPIC_BASE_URL;

const vector = (n: number, seed: number) => Array.from({ length: n }, (_, i) => (i === 0 ? seed : 1));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-llm-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.json() as Record<string, unknown>;
      seen.push({ path, headers: req.headers, body });
      if (path === "/bad/embeddings") return new Response("boom", { status: 500 });
      if (path === "/short/embeddings") return Response.json({ data: [{ index: 0, embedding: vector(8, 2) }] });
      if (path.endsWith("/embeddings")) {
        const input = body.input as string[];
        // answered out of order: the client must sort by index
        return Response.json({ data: input.map((_, i) => ({ index: i, embedding: vector(2048, i + 2) })).reverse() });
      }
      if (path.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: '{"keep":true}' } }] });
      if (path === "/v1/messages") {
        if (anthropicStatus !== 200) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: anthropicStatus });
        return Response.json({
          id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: anthropicStop, stop_sequence: null,
          content: [{ type: "text", text: '{"keep":false}' }], usage: { input_tokens: 3, output_tokens: 4 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedBase;
  rmSync(root, { recursive: true, force: true });
});

function setup(name: string, extra = "") {
  const dir = join(root, name);
  const base = `http://127.0.0.1:${server.port}`;
  const config = join(root, `${name}.yaml`);
  writeFileSync(config, `dimensions: 1024
embed:
  default: voyage
  providers:
    voyage: { kind: voyage, base_url: ${base}/voyage, model: voyage-4, space: voyage-4, key_env: VOYAGE_API_KEY }
    oa: { kind: openai, base_url: ${base}/openai, model: text-embedding-3-large, space: oa, key_env: OPENAI_API_KEY }
    nano: { kind: openai-compatible, base_url: ${base}/local, model: nano, space: voyage-4, query_prefix: "Q: ", document_prefix: "D: " }
    qwen: { kind: openai-compatible, base_url: ${base}/qwen, model: qwen, space: qwen }
    bad: { kind: openai-compatible, base_url: ${base}/bad, model: x, space: voyage-4 }
    short: { kind: openai-compatible, base_url: ${base}/short, model: x, space: voyage-4 }
decide:
  default: claude
  providers:
    claude: { kind: anthropic, model: claude-opus-5-5, effort: low, key_env: ANTHROPIC_API_KEY }
    qwen: { kind: openai-compatible, base_url: ${base}/qwen, model: qwen }
${extra}`);
  return { config, state: dir, env: { VOYAGE_API_KEY: "vk", OPENAI_API_KEY: "ok", ANTHROPIC_API_KEY: "ak" } };
}

describe("llm config and switching", () => {
  test("the shipped catalog is valid and starts on OpenAI and Claude", () => {
    const c = loadConfig({ config: join(import.meta.dir, "..", "catalog", "llm.yaml") });
    expect(c.embed.default).toBe("openai");
    expect(c.embed.providers.openai).toMatchObject({ kind: "openai", key_env: "OPENAI_API_KEY" });
    expect(c.decide.providers[c.decide.default].kind).toBe("anthropic");
  });

  test("an invalid provider is rejected with its path", () => {
    const o = setup("invalid");
    writeFileSync(o.config, readFileSync(o.config, "utf8").replace("kind: anthropic", "kind: magic"));
    expect(() => loadConfig(o)).toThrow(/decide.claude: kind must be/);
  });

  test("use switches a role, persists it, and stays within one space without --force", () => {
    const o = setup("switch");
    expect(active("embed", o)).toEqual({ name: "voyage", selected: false });
    expect(use("embed", "nano", o)).toEqual({ previous: "voyage", spaceChanged: false });
    expect(active("embed", o)).toEqual({ name: "nano", selected: true });
    expect(() => use("embed", "qwen", o)).toThrow(/space changes from voyage-4 to qwen/);
    expect(active("embed", o).name).toBe("nano");
    expect(activeSpace(o)).toBe("voyage-4");
    expect(use("embed", "qwen", { ...o, force: true }).spaceChanged).toBe(true);
    expect(activeSpace(o)).toBe("qwen");
    expect(use("decide", "qwen", o).previous).toBe("claude");
    expect(() => use("decide", "nope", o)).toThrow(/unknown decide provider nope/);
  });

  test("a selection whose provider was removed fails instead of falling back", () => {
    const o = setup("removed");
    use("decide", "qwen", o);
    writeFileSync(o.config, readFileSync(o.config, "utf8").replace(/\n    qwen: \{ kind: openai-compatible, base_url: [^\n]*model: qwen \}\n$/, "\n"));
    expect(() => active("decide", o)).toThrow(/no longer declared/);
  });

  test(".env is parsed without overriding, and a world-readable file is flagged", () => {
    const file = join(root, "test.env");
    writeFileSync(file, "# comment\nexport ANTHROPIC_API_KEY='sk-test'\nVOYAGE_API_KEY=\"v\"\nnot a line\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(loadEnvFile(file)).toEqual({ ANTHROPIC_API_KEY: "sk-test", VOYAGE_API_KEY: "v" });
    expect(envFileWarning(file)).toMatch(/chmod 600/);
    chmodSync(file, 0o600);
    expect(envFileWarning(file)).toBeNull();
  });
});

describe("embed", () => {
  test("voyage: input_type and output_dimension sent, vectors cut to 1024 and normalized, order kept", async () => {
    const o = setup("voyage");
    const r = await embed(["a", "b"], "query", o);
    const req = seen.at(-1)!;
    expect(req.path).toBe("/voyage/embeddings");
    expect(req.headers.get("authorization")).toBe("Bearer vk");
    expect(req.body).toMatchObject({ model: "voyage-4", input_type: "query", output_dimension: 1024 });
    expect(r.space).toBe("voyage-4");
    expect(r.vectors.map((v) => v.length)).toEqual([1024, 1024]);
    expect(Math.hypot(...r.vectors[0])).toBeCloseTo(1, 6);
    expect(r.vectors[0][0]).toBeLessThan(r.vectors[1][0]); // index 0 got seed 2, index 1 seed 3
  });

  test("openai: dimensions sent, no input_type or prefix, key as bearer", async () => {
    const o = setup("openai");
    use("embed", "oa", { ...o, force: true });
    const r = await embed(["a"], "query", o);
    const req = seen.at(-1)!;
    expect(req.path).toBe("/openai/embeddings");
    expect(req.headers.get("authorization")).toBe("Bearer ok");
    expect(req.body).toEqual({ model: "text-embedding-3-large", input: ["a"], dimensions: 1024, encoding_format: "float" });
    expect(r.space).toBe("oa");
    expect(r.vectors[0]).toHaveLength(1024);
    await expect(embed(["a"], "query", { ...o, env: {} })).rejects.toThrow(/needs OPENAI_API_KEY/);
  });

  test("openai-compatible: the model's prefix is added, no key needed, batches of 64", async () => {
    const o = setup("local");
    use("embed", "nano", o);
    const before = seen.length;
    const r = await embed(Array.from({ length: 70 }, (_, i) => `t${i}`), "document", o);
    const calls = seen.slice(before);
    expect(calls.map((c) => (c.body.input as string[]).length)).toEqual([64, 6]);
    expect((calls[0].body.input as string[])[0]).toBe("D: t0");
    expect(calls[0].headers.get("authorization")).toBeNull();
    expect(r.vectors).toHaveLength(70);
  });

  test("a missing key, an HTTP error, a short vector or a wrong count fail loudly", async () => {
    const o = setup("errors");
    await expect(embed(["a"], "query", { ...o, env: {} })).rejects.toThrow(/needs VOYAGE_API_KEY/);
    use("embed", "bad", o);
    await expect(embed(["a"], "query", o)).rejects.toThrow(/HTTP 500 boom/);
    use("embed", "short", o);
    await expect(embed(["a"], "query", o)).rejects.toThrow(/8 dimensions, memory stores 1024/);
    await expect(embed(["a", "b"], "query", o)).rejects.toThrow(/1 embeddings for 2 inputs/);
  });

  test("fit rejects malformed and zero vectors", () => {
    expect(() => fit([1, Number.NaN], 2, "x")).toThrow(/malformed/);
    expect(() => fit([0, 0], 2, "x")).toThrow(/zero vector/);
  });
});

describe("decide", () => {
  test("anthropic: key, model, effort, schema and server-side fallbacks are sent", async () => {
    const o = setup("claude");
    const schema = { type: "object", properties: { keep: { type: "boolean" } }, required: ["keep"], additionalProperties: false };
    const r = await decide("keep this?", { ...o, schema });
    const req = seen.at(-1)!;
    expect(req.path).toBe("/v1/messages");
    expect(req.headers.get("authorization")).toBe("Bearer ak"); // SDK 1.x sends the key as a bearer token
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low", format: { type: "json_schema", schema } } });
    expect(r).toEqual({ provider: "claude", text: '{"keep":false}' });
  });

  test("anthropic: a rejected key and a refusal are explicit errors", async () => {
    const o = setup("claude-errors");
    anthropicStatus = 401;
    await expect(decide("x", o)).rejects.toThrow(/API key rejected/);
    anthropicStatus = 200;
    anthropicStop = "refusal";
    await expect(decide("x", o)).rejects.toThrow(/refused/);
    anthropicStop = "end_turn";
  });

  test("openai-compatible: json_schema response format, JSON checked", async () => {
    const o = setup("qwen-decide");
    use("decide", "qwen", o);
    const r = await decide("keep?", { ...o, schema: { type: "object" } });
    expect(seen.at(-1)!.body).toMatchObject({ model: "qwen", response_format: { type: "json_schema" } });
    expect(JSON.parse(r.text)).toEqual({ keep: true });
  });
});
