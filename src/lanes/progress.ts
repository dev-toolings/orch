// Live progress of a running lane: a small progress.json in the lane dir,
// rebuilt from the worker's stream-json events (Claude) while it runs, so
// the dash can show what a headless worker is doing without reading its log.
// Only tool names, file paths, counts and a short assistant snippet are kept:
// never a tool input beyond its file path, never the environment.
import { basename, join } from "node:path";
import { closeSync, openSync, readSync, renameSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { inspectSecrets } from "../memory/privacy.ts";

export type LanePhase = "setup" | "worker" | "verify" | "done";

export interface LaneProgress {
  v: 1;
  harness: string;
  model: string | null;
  effort: string | null;
  phase: LanePhase;
  started: string;
  updated: string;
  elapsedS: number;
  turns: number;
  toolCalls: number;
  verifyRuns?: number;
  stepsSinceVerify?: number;
  lastVerifyTurn?: number | null;
  lastTool: string | null;
  lastFile: string | null;
  filesTouched: number;
  lastText: string | null;
}

export const PROGRESS_FILE = "progress.json";
export const SNIPPET_MAX = 200;
// progress.json stays far below this; anything larger is not ours.
export const PROGRESS_MAX_BYTES = 16 * 1024;
// A stream line longer than this (a huge tool result) is skipped, not buffered.
const LINE_MAX = 1024 * 1024;
// Bytes read from the log per poll: a burst is caught up over a few ticks.
const READ_MAX = 4 * 1024 * 1024;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PHASES: LanePhase[] = ["setup", "worker", "verify", "done"];

function matchesVerify(command: unknown, verify?: string): boolean {
  if (typeof command !== "string" || !verify?.trim()) return false;
  const unwrapped = command.trim().replace(/^(?:\/[^\s]+\/)?(?:bash|sh|zsh) -l?c (['"])([\s\S]*)\1$/, "$2");
  const normalized = unwrapped.replace(/\s+/g, " ").trim();
  // Workers are asked to run targeted checks, leaving the full VERIFY to lane.
  // A standalone test invocation counts too; unrelated shell activity does not.
  return normalized === verify.replace(/\s+/g, " ").trim()
    || /^(?:bun test|cargo test|go test|pytest|python(?:3)? -m pytest|vendor\/bin\/phpunit)(?: [^;&|<>`$\n]*)?$/.test(normalized);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function snippet(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const scan = inspectSecrets(flat);
  return scan.ok ? clip(scan.text, SNIPPET_MAX) : "[masqué : secret détecté]";
}

export class ProgressTracker {
  private model: string | null;
  private phase: LanePhase = "setup";
  private turns = 0;
  private toolCalls = 0;
  private lastTool: string | null = null;
  private lastFile: string | null = null;
  private lastText: string | null = null;
  private files = new Set<string>();
  private seen = new Set<string>();
  private rest = "";
  private skipping = false;
  private verifyRuns = 0;
  private lastVerifyTurn: number | null = null;
  private checks = new Set<string>();
  private lastVerifyStep = 0;

  constructor(private base: { harness: string; model?: string | null; effort?: string | null; started: string; cwd?: string; verify?: string }) {
    this.model = base.model ?? null;
  }

  setPhase(phase: LanePhase): void {
    this.phase = phase;
  }

  private check(command: unknown, id?: string): void {
    if (!matchesVerify(command, this.base.verify) || id && this.checks.has(id)) return;
    if (id) this.checks.add(id);
    this.verifyRuns++;
    this.lastVerifyTurn = this.turns;
    this.lastVerifyStep = this.base.harness === "codex" ? this.toolCalls : this.turns;
  }

  // Feeds raw log bytes; partial lines wait for the next chunk. True when
  // something the snapshot shows changed.
  feed(chunk: string): boolean {
    let changed = false;
    let text = this.rest + chunk;
    this.rest = "";
    if (this.skipping) {
      const nl = text.indexOf("\n");
      if (nl < 0) return false;
      text = text.slice(nl + 1);
      this.skipping = false;
    }
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    if (tail.length > LINE_MAX) this.skipping = true;
    else this.rest = tail;
    for (const line of lines) if (this.line(line)) changed = true;
    return changed;
  }

  private path(p: string): string {
    const cwd = this.base.cwd?.replace(/\/+$/, "");
    const rel = cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p.startsWith("/") ? basename(p) : p;
    return clip(rel, SNIPPET_MAX);
  }

  private line(raw: string): boolean {
    const line = raw.trim();
    if (!line.startsWith("{") || line.length > LINE_MAX) return false;
    let ev: any;
    try { ev = JSON.parse(line); } catch { return false; }
    if (!ev || typeof ev !== "object") return false;
    if (this.base.harness === "codex") {
      if (ev.type === "turn.completed") { this.turns++; return true; }
      if (ev.type === "turn.started") return true;
      if (!["item.started", "item.updated", "item.completed"].includes(ev.type) || !ev.item) return false;
      const item = ev.item;
      if (item.type === "agent_message" && typeof item.text === "string") this.lastText = snippet(item.text);
      if (["command_execution", "file_change", "mcp_tool_call"].includes(item.type)) {
        const id = typeof item.id === "string" ? `codex:${item.id}` : null;
        if (!id || !this.seen.has(id)) {
          if (id) this.seen.add(id);
          this.toolCalls++;
        }
        // Use the same tool names as Claude so the watchdog recognises checks.
        this.lastTool = item.type === "command_execution" ? "Bash" : item.type === "file_change" ? "Edit" : "mcp_tool_call";
        if (item.type === "command_execution") this.check(item.command, id ?? undefined);
        this.lastFile = null;
        if (item.type === "file_change") for (const change of Array.isArray(item.changes) ? item.changes : []) {
          if (typeof change.path === "string") {
            this.lastFile = this.path(change.path);
            this.files.add(this.lastFile);
          }
        }
      }
      return true;
    }
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string" && ev.model.trim()) {
      this.model = clip(ev.model.trim(), 80);
      return true;
    }
    if (ev.type === "result") {
      const n = Number(ev.num_turns);
      if (Number.isFinite(n) && n > this.turns) { this.turns = n; return true; }
      return false;
    }
    if (ev.type !== "assistant" || !ev.message || typeof ev.message !== "object") return false;
    const msg = ev.message;
    // One API turn can arrive as several events, one per content block.
    const id = typeof msg.id === "string" ? msg.id : null;
    if (!id || !this.seen.has(id)) {
      if (id) this.seen.add(id);
      this.turns++;
    }
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === "text" && typeof block.text === "string") {
        const s = snippet(block.text);
        if (s) this.lastText = s;
      } else if (block?.type === "tool_use") {
        this.toolCalls++;
        const name = typeof block.name === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(block.name) ? block.name : "tool";
        this.lastTool = name;
        const input = block.input && typeof block.input === "object" ? block.input : {};
        if (name === "Bash") this.check(input.command, typeof block.id === "string" ? block.id : undefined);
        const p = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
        this.lastFile = p ? this.path(p) : null;
        if (p && EDIT_TOOLS.has(name)) this.files.add(this.lastFile!);
      }
    }
    return true;
  }

  snapshot(now = new Date()): LaneProgress {
    const from = Date.parse(this.base.started);
    return {
      v: 1,
      harness: this.base.harness,
      model: this.model,
      effort: this.base.effort ?? null,
      phase: this.phase,
      started: this.base.started,
      updated: now.toISOString(),
      elapsedS: Number.isFinite(from) ? Math.max(0, Math.floor((now.getTime() - from) / 1000)) : 0,
      turns: this.turns,
      toolCalls: this.toolCalls,
      stepsSinceVerify: Math.max(0, (this.base.harness === "codex" ? this.toolCalls : this.turns) - this.lastVerifyStep),
      verifyRuns: this.verifyRuns,
      lastVerifyTurn: this.lastVerifyTurn,
      lastTool: this.lastTool,
      lastFile: this.lastFile,
      filesTouched: this.files.size,
      lastText: this.lastText,
    };
  }
}

export function writeProgress(dir: string, p: LaneProgress): void {
  try {
    const tmp = join(dir, "progress.tmp");
    writeFileSync(tmp, JSON.stringify(p));
    renameSync(tmp, join(dir, PROGRESS_FILE));
  } catch {
    // progress is display only: never fail a lane over it
  }
}

export interface ProgressWatch {
  phase(p: LanePhase): void;
  stop(): void;
}

// Writes progress.json now and on every phase change; with a log to follow,
// polls its new bytes every intervalMs and rewrites the file only when the
// snapshot changed (so at most one small write per interval).
export function watchProgress(opts: {
  dir: string; tracker: ProgressTracker; logPath?: string; intervalMs?: number;
}): ProgressWatch {
  const { dir, tracker, logPath } = opts;
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const write = () => writeProgress(dir, tracker.snapshot());
  const poll = (): boolean => {
    if (!logPath) return false;
    let fd: number | undefined;
    try {
      const size = statSync(logPath).size;
      if (size < offset) offset = 0;
      if (size === offset) return false;
      const len = Math.min(size - offset, READ_MAX);
      const buf = Buffer.alloc(len);
      fd = openSync(logPath, "r");
      const n = readSync(fd, buf, 0, len, offset);
      offset += n;
      return tracker.feed(buf.subarray(0, n).toString("utf8"));
    } catch {
      return false;
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch {}
    }
  };
  write();
  return {
    phase(p) {
      if (stopped) return;
      poll();
      tracker.setPhase(p);
      write();
      if (p === "worker" && logPath && !timer) {
        timer = setInterval(() => { if (poll()) write(); }, opts.intervalMs ?? 2000);
        timer.unref?.();
      } else if (p !== "worker" && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      poll();
      tracker.setPhase("done");
      write();
    },
  };
}

const str = (v: unknown, n = SNIPPET_MAX): string | null => (typeof v === "string" && v ? clip(v, n) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// Bounded, tolerant read for the dash: a missing, oversized or corrupt file
// gives null, never an exception.
export function readLaneProgress(dir: string): LaneProgress | null {
  const path = join(dir, PROGRESS_FILE);
  try {
    if (statSync(path).size > PROGRESS_MAX_BYTES) return null;
    const o = JSON.parse(readFileSync(path, "utf8"));
    if (!o || typeof o !== "object" || o.v !== 1 || typeof o.harness !== "string" || typeof o.started !== "string") return null;
    return {
      v: 1,
      harness: clip(o.harness, 32),
      model: str(o.model, 80),
      effort: str(o.effort, 16),
      phase: PHASES.includes(o.phase) ? o.phase : "worker",
      started: clip(o.started, 40),
      updated: str(o.updated, 40) ?? o.started,
      elapsedS: num(o.elapsedS),
      turns: num(o.turns),
      toolCalls: num(o.toolCalls),
      stepsSinceVerify: typeof o.stepsSinceVerify === "number" ? num(o.stepsSinceVerify) : undefined,
      verifyRuns: num(o.verifyRuns),
      lastVerifyTurn: typeof o.lastVerifyTurn === "number" && o.lastVerifyTurn >= 0 ? Math.floor(o.lastVerifyTurn) : null,
      lastTool: str(o.lastTool, 64),
      lastFile: str(o.lastFile),
      filesTouched: num(o.filesTouched),
      lastText: str(o.lastText),
    };
  } catch {
    return null;
  }
}
