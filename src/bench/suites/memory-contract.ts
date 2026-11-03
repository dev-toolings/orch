import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { git } from "../../core/git.ts";
import { ROOT } from "../../core/profile.ts";
import { allocateRun, type BenchObservation, type BenchRun, type SourceSnapshot } from "../index.ts";
import type { MemoryDeps } from "../../hooks/hook.ts";
import type { RecallHit } from "../../memory/hindsight.ts";

export interface MemoryContractOptions {
  root?: string;
  ref?: string;
  dryRun?: boolean;
  repositoryRoot?: string;
}

export interface MemoryContractResult {
  run: BenchRun;
  observations: BenchObservation[];
}

interface HookModule { runHook: (event: "prompt-submit", harness: "claude", input: unknown, env: NodeJS.ProcessEnv, deps: MemoryDeps) => Promise<string> }
interface ReflectModule {
  parseReflection: (message: string) => { memory: string | null; nothing: boolean };
  applyMemory: (previous: string, section: string) => string;
  guardMemory: (previous: string, next: string) => { ok: boolean; reason?: string };
}

const FIXTURES = {
  hook: {
    caseId: "hook.oversized-first-small-later",
    maxTokens: 5,
    project: "alpha",
    prompt: "Find a small memory that fits this prompt",
    hits: [
      { id: "oversized", text: "x".repeat(80), type: "world" as const, scores: { final: 1 } },
      { id: "small-later", text: "p2", type: "world" as const, scores: { final: 0.8 } },
    ],
  },
  noop: { caseId: "reflect.explicit-noop", input: "(nothing)", previous: "- stable decision\n\ncontext kept by the operator" },
  removals: {
    caseId: "reflect.more-than-three-removals",
    bullets: ["first old line", "second old line", "third old line", "fourth old line", "retained old line"],
    context: `context: ${"c".repeat(300)}`,
    removalLimit: 3,
  },
} as const;

function gitBuffer(repo: string, ...args: string[]): Buffer {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "buffer" });
  if (result.status !== 0) throw new Error(`memory-contract: git ${args[0]} failed: ${(result.stderr ?? Buffer.alloc(0)).toString("utf8").trim()}`);
  return Buffer.from(result.stdout ?? Buffer.alloc(0));
}

function dirtyHash(repo: string): string | null {
  const diff = gitBuffer(repo, "diff", "--binary", "HEAD", "--");
  const untracked = gitBuffer(repo, "ls-files", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter(Boolean);
  if (!diff.length && !untracked.length) return null;
  const hash = createHash("sha256").update(diff);
  for (const path of untracked.sort()) {
    const absolute = join(repo, path);
    hash.update(Buffer.from(path)).update(Buffer.from([0]));
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) hash.update("link:").update(readlinkSync(absolute));
    else if (info.isFile()) hash.update("file:").update(readFileSync(absolute));
    else hash.update(`other:${info.mode}:${info.size}`);
  }
  return hash.digest("hex");
}

function currentSource(repo: string): SourceSnapshot {
  const revision = git(repo, "rev-parse", "HEAD");
  if (!revision.ok || !revision.out) throw new Error(`memory-contract: cannot read current Git revision: ${revision.err}`);
  return { revision: revision.out, dirtyHash: dirtyHash(repo) };
}

function resolveRef(repo: string, ref: string): string {
  if (!ref.trim()) throw new Error("memory-contract: --ref must name a Git commit or ref");
  const resolved = git(repo, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  if (!resolved.ok || !resolved.out) throw new Error(`memory-contract: cannot resolve ref ${ref}: ${resolved.err}`);
  const currentLock = join(repo, "bun.lock");
  if (!existsSync(currentLock)) throw new Error("memory-contract: current bun.lock is unavailable; refusing ref isolation");
  let refLock: Buffer;
  try { refLock = gitBuffer(repo, "show", `${resolved.out}:bun.lock`); }
  catch { throw new Error(`memory-contract: ref ${ref} has no bun.lock; refusing dependency drift`); }
  const currentLockHash = createHash("sha256").update(readFileSync(currentLock)).digest("hex");
  const refLockHash = createHash("sha256").update(refLock).digest("hex");
  if (currentLockHash !== refLockHash) throw new Error(`memory-contract: ref ${ref} has a different bun.lock; install matching dependencies before comparing`);
  return resolved.out;
}

function addRefWorktree(repo: string, revision: string): { root: string; cleanup(): void } {
  const temporary = mkdtempSync(join(tmpdir(), "orch-memory-contract-"));
  const worktree = join(temporary, "source");
  try {
    const result = spawnSync("git", ["-C", repo, "worktree", "add", "--quiet", "--detach", worktree, revision], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`memory-contract: cannot prepare ref worktree: ${(result.stderr ?? "").trim()}`);
    const dependencies = join(repo, "node_modules");
    if (!existsSync(dependencies)) throw new Error("memory-contract: current node_modules is unavailable; refusing ref imports that could trigger installation");
    symlinkSync(dependencies, join(worktree, "node_modules"), "dir");
    return {
      root: worktree,
      cleanup() {
        const removed = spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { encoding: "utf8" });
        rmSync(temporary, { recursive: true, force: true });
        if (removed.status !== 0) throw new Error(`memory-contract: failed to remove ref worktree: ${(removed.stderr ?? "").trim()}`);
      },
    };
  } catch (error) {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { encoding: "utf8" });
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function moduleAt<T>(root: string, relativePath: string, nonce: string): Promise<T> {
  const path = join(root, relativePath);
  if (!existsSync(path)) throw new Error(`memory-contract: source module missing at ${relativePath}`);
  return import(`${pathToFileURL(path).href}?bench=${nonce}`) as Promise<T>;
}

function memoryDependencies(): MemoryDeps {
  const hits: RecallHit[] = [...FIXTURES.hook.hits];
  return {
    config: () => ({ url: "http://127.0.0.1:1", bank: "kiba", recall_max_tokens: FIXTURES.hook.maxTokens, recall_budget: "low", timeout_ms: 100, session_recall_tokens: 0 }),
    recall: async (_config, _query, options) => ({ ok: true, value: options?.bank === `kiba-${FIXTURES.hook.project}` ? hits : [] }),
    retain: async () => ({ ok: true, value: { items_count: 0 } }),
    format: (hits) => hits.map((hit) => hit.text).join("\n"),
  };
}

async function evaluate(sourceRoot: string, run: BenchRun): Promise<BenchObservation[]> {
  const [hook, reflect] = await Promise.all([
    moduleAt<HookModule>(sourceRoot, "src/hooks/hook.ts", run.id),
    moduleAt<ReflectModule>(sourceRoot, "src/reflect/reflect.ts", run.id),
  ]);
  const observations: BenchObservation[] = [];
  let started = performance.now();
  let hookQuality = 0;
  let hookError: string | undefined;
  try {
    const session = `bench-${run.id.slice(0, 12)}-hook`;
    const env = { ORCH_LEAD: "1", ORCH_SESSION: session, ORCH_STATE: run.stateDirFor("hook") };
    const output = await hook.runHook("prompt-submit", "claude", {
      session_id: session, prompt: FIXTURES.hook.prompt, cwd: `/repo/${FIXTURES.hook.project}`,
    }, env, memoryDependencies());
    hookQuality = output.includes("p2") && !output.includes(FIXTURES.hook.hits[0].text) ? 1 : 0;
  } catch (error) {
    hookError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }
  observations.push({ caseId: "hook.oversized-first-small-later", config: "current", attempt: 1, quality: hookQuality, cost: 0, latencyMs: performance.now() - started, ...(hookError ? { error: hookError } : {}) });

  started = performance.now();
  let noopQuality = 0;
  let noopError: string | undefined;
  try {
    const previous = FIXTURES.noop.previous;
    const parsed = reflect.parseReflection(FIXTURES.noop.input);
    const next = reflect.applyMemory(previous, parsed.nothing ? "(nothing)" : parsed.memory ?? "");
    noopQuality = parsed.nothing && next === previous ? 1 : 0;
  } catch (error) {
    noopError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }
  observations.push({ caseId: "reflect.explicit-noop", config: "current", attempt: 1, quality: noopQuality, cost: 0, latencyMs: performance.now() - started, ...(noopError ? { error: noopError } : {}) });

  started = performance.now();
  let guardQuality = 0;
  let guardError: string | undefined;
  try {
    const previous = [...FIXTURES.removals.bullets.map((line) => `- ${line}`), FIXTURES.removals.context].join("\n");
    const next = [`- ${FIXTURES.removals.bullets.at(-1)}`, FIXTURES.removals.context].join("\n");
    const guard = reflect.guardMemory(previous, next);
    let deltaRejected = false;
    try { reflect.applyMemory(previous, FIXTURES.removals.bullets.slice(0, FIXTURES.removals.bullets.length - 1).map((line) => `x ${line}`).join("\n")); }
    catch (error) { deltaRejected = /above the limit of 3/.test(error instanceof Error ? error.message : String(error)); }
    guardQuality = !guard.ok && /above the limit of 3/.test(guard.reason ?? "") && deltaRejected ? 1 : 0;
  } catch (error) {
    guardError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }
  observations.push({ caseId: "reflect.more-than-three-removals", config: "current", attempt: 1, quality: guardQuality, cost: 0, latencyMs: performance.now() - started, ...(guardError ? { error: guardError } : {}) });
  return observations;
}

export async function runMemoryContract(options: MemoryContractOptions = {}): Promise<MemoryContractResult> {
  const repo = options.repositoryRoot ?? ROOT;
  const revision = options.ref ? resolveRef(repo, options.ref) : undefined;
  const source: SourceSnapshot = options.ref
    ? { revision: revision!, dirtyHash: null, ref: options.ref }
    : currentSource(repo);
  const run = allocateRun({
    suite: "memory-contract", feature: "memory-recall-and-reflection-guards", source,
    corpus: FIXTURES,
    settings: { hookRecallMaxTokens: FIXTURES.hook.maxTokens, maxMemoryChanges: FIXTURES.removals.removalLimit, ambientEnvironment: "isolated" },
    models: [], protocol: { id: "memory-contract.v1", callsModels: false, dependencyLockHash: createHash("sha256").update(readFileSync(join(repo, "bun.lock"))).digest("hex") }, paid: false,
    root: options.root, dryRun: options.dryRun,
  });
  run.writeJsonArtifact("suite.json", { source, synthetic: true, fixtures: FIXTURES });
  if (run.dryRun) {
    run.finalize([]);
    return { run, observations: [] };
  }

  let sourceRoot = repo;
  let worktree: ReturnType<typeof addRefWorktree> | undefined;
  try {
    if (revision) {
      worktree = addRefWorktree(repo, revision);
      sourceRoot = worktree.root;
    }
    const observations = await evaluate(sourceRoot, run);
    run.finalize(observations);
    return { run, observations };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    try {
      run.finalize([{ caseId: "suite.execution", config: "current", attempt: 1, quality: 0, cost: 0, latencyMs: 0, error: detail }]);
    } catch {}
    throw error;
  } finally {
    worktree?.cleanup();
  }
}

