// Under Orca, a lane's git worktree shows as a child of the lead's card, with
// a status comment and a terminal following the worker log. Git creates the
// worktree, in Orca's workspace directory for the repo (orcaLaneWorktree), and
// Orca removes it (orcaRemoveWorktree): Orca forgets a worktree only when its
// own `worktree rm` removes it, a git removal leaves a ghost card, and that
// command refuses a path outside the repo and that directory. The only Orca
// calls are worktree show/set/rm (rm on a lane checkout only), repo show/set,
// terminal create and terminal close --terminal. Never worktree create or
// terminal close --all.
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { which } from "../core/which.ts";

type BoardStatus = "in-progress" | "in-review" | "completed";

export interface OrcaView {
  repo: string;
  worktreeId?: string;
  terminal?: string;
  note?: string;
  comment: string;
  status: BoardStatus;
  stopped: boolean;
  attached: Promise<void>;
  queue: Promise<void>;
  // Called once the child and its terminal exist, so the lane record can keep
  // them: a lane killed later is retired from that record (orcaRetire).
  onShown?: (saved: OrcaSaved) => void;
}

// What the lane record keeps of its Orca display, enough to retire it after
// the lane process is gone (reaper, gc).
export interface OrcaSaved { repo: string; worktreeId: string; terminal?: string }

// Orca discovers a fresh git worktree on its own periodic scan (23 to 30 s
// measured on Orca 1.4.239), so the attach polls in the background while the
// worker runs instead of holding the lane.
const POLL_MS = 2000;
const POLL_LIMIT_MS = 120_000;
// Tests shorten the polling through the environment.
const pollMs = () => Number(process.env.ORCH_ORCA_POLL_MS) || POLL_MS;
const pollLimitMs = () => Number(process.env.ORCH_ORCA_POLL_LIMIT_MS) || POLL_LIMIT_MS;

function orca(args: string[], repo: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("orca", [...args, "--json"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as { ok?: unknown; result?: unknown };
        resolve(parsed.ok === true && parsed.result && typeof parsed.result === "object" ? parsed.result as Record<string, unknown> : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function realpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function attach(v: OrcaView, o: { worktree: string; id: string; to: string; logPath: string; leadCard: string }): Promise<void> {
  // The parent is the card the lead's terminal belongs to, not the lane
  // repo's own worktree: a lead often works in a repo that is not the card
  // it was opened from, and that repo may not even be in the sidebar.
  // Bounded retries on both lookups: Orca may answer late or not have
  // discovered the new worktree yet (the race seen as "not shown").
  const deadline = Date.now() + pollLimitMs();
  let parentId: string | null = null;
  while (!v.stopped && Date.now() < deadline) {
    parentId = string(record((await orca(["worktree", "show", "--worktree", `id:${o.leadCard}`], v.repo))?.worktree)?.id);
    if (parentId) break;
    await Bun.sleep(pollMs());
  }
  const repoRealpath = realpath(v.repo);
  const worktreeRealpath = realpath(o.worktree);
  if (!parentId || !repoRealpath || !worktreeRealpath || worktreeRealpath === repoRealpath) return;

  let worktreeId: string | null = null;
  let repoId: string | null = null;
  while (!v.stopped && Date.now() < deadline) {
    const shown = record((await orca(["worktree", "show", "--worktree", `path:${o.worktree}`], v.repo))?.worktree);
    const shownPath = string(shown?.path);
    if (shownPath && realpath(shownPath) === worktreeRealpath) {
      worktreeId = string(shown?.id);
      repoId = string(shown?.repoId);
      break;
    }
    await Bun.sleep(pollMs());
  }
  if (v.stopped || !worktreeId || !repoId) return;

  const repoResult = record((await orca(["repo", "show", "--repo", `id:${repoId}`], v.repo))?.repo);
  if (repoResult?.externalWorktreeVisibility === "hide") {
    if (!await orca(["repo", "set", "--repo", `id:${repoId}`, "--external-worktree-visibility", "show"], v.repo)) return;
    v.note = "repo set to show non-Orca worktrees";
  }

  if (v.stopped || !await orca([
    "worktree", "set", "--worktree", `id:${worktreeId}`,
    "--parent-worktree", `id:${parentId}`,
    "--display-name", `lane ${o.to} ${o.id.slice(-4)}`,
    "--comment", v.comment,
    "--workspace-status", v.status,
  ], v.repo)) return;
  v.worktreeId = worktreeId;

  if (v.stopped) return;
  const quotedLogPath = `'${o.logPath.replace(/'/g, "'\\''")}'`;
  const terminalResult = record((await orca([
    "terminal", "create", "--worktree", `id:${worktreeId}`,
    "--title", `lane ${o.to}`,
    "--command", `tail -n +1 -F ${quotedLogPath}`,
  ], v.repo))?.terminal);
  v.terminal = string(terminalResult?.handle) ?? undefined;
  try { v.onShown?.({ repo: v.repo, worktreeId, ...(v.terminal ? { terminal: v.terminal } : {}) }); } catch { /* display only */ }
}

// Where a lane checkout goes under Orca: `<Orca workspaces>/<repo>/orch-lanes/<id>`
// (ORCH_ORCA_WORKSPACES overrides Orca's default `~/orca/workspaces`). Null,
// so the lane keeps `<lane dir>/wt`, unless the lane runs from an Orca
// terminal with an orca binary on PATH.
export function orcaLaneWorktree(repo: string, id: string): string | null {
  if (!process.env.ORCA_WORKTREE_ID || !which("orca")) return null;
  const root = process.env.ORCH_ORCA_WORKSPACES || join(process.env.HOME ?? homedir(), "orca", "workspaces");
  return join(root, basename(realpath(repo) ?? repo), "orch-lanes", id);
}

// Removes a lane checkout of orcaLaneWorktree through Orca, which forgets it
// at once and deletes the folder in the background; it keeps a branch it
// cannot prove merged. Synchronous and bounded (10 s). False for any other
// path or when Orca refuses or is unreachable: the caller then removes it
// with git, and the `orca-prune` routine drops the record later.
export function orcaRemoveWorktree(repo: string, wt: string): boolean {
  if (basename(dirname(wt)) !== "orch-lanes" || !which("orca")) return false;
  try {
    const r = spawnSync("orca", ["worktree", "rm", "--worktree", `path:${wt}`, "--force", "--json"],
      { cwd: repo, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
    return (JSON.parse(r.stdout || "null") as { ok?: unknown } | null)?.ok === true;
  } catch { return false; }
}

// Returns null, with no Orca call, unless the lane runs from an Orca terminal
// (ORCA_WORKTREE_ID) and an orca binary is on PATH. Never throws, never waits.
export function orcaAttach(o: { repo: string; worktree: string; id: string; to: string; logPath: string; onShown?: (saved: OrcaSaved) => void }): OrcaView | null {
  const leadCard = process.env.ORCA_WORKTREE_ID;
  if (!leadCard || !which("orca")) return null;
  const v: OrcaView = {
    repo: o.repo, comment: `${o.to}: starting`, status: "in-progress", stopped: false,
    attached: Promise.resolve(), queue: Promise.resolve(), onShown: o.onShown,
  };
  v.attached = attach(v, { ...o, leadCard }).catch(() => {});
  return v;
}

// Records the card comment and board status; applied now if the child is
// shown, else at attach time. Updates run in order. Never throws.
export function orcaStatus(v: OrcaView | null, comment: string, status: BoardStatus): void {
  if (!v) return;
  v.comment = comment;
  v.status = status;
  v.queue = v.queue.then(async () => {
    if (!v.worktreeId) return;
    await orca(["worktree", "set", "--worktree", `id:${v.worktreeId}`, "--comment", v.comment, "--workspace-status", v.status], v.repo);
  }).catch(() => {});
}

// The report line: what the operator should expect in the sidebar.
export function orcaLine(v: OrcaView | null): string | undefined {
  if (!v) return undefined;
  if (!v.worktreeId) return "not shown (Orca had not discovered the worktree yet)";
  return v.note ?? "child of the lead in Orca";
}

// Stops a pending attach, flushes status updates, closes the observer
// terminal by handle. Idempotent; the handle is kept until a close succeeds,
// so a later call (or orcaRetire from the lane record) retries it. Returns
// true once no observer terminal is left. Call before git removes the worktree.
export async function orcaDetach(v: OrcaView | null): Promise<boolean> {
  if (!v) return true;
  try {
    v.stopped = true;
    await v.attached;
    await v.queue;
    const terminal = v.terminal;
    if (!terminal) return true;
    if (!await orca(["terminal", "close", "--terminal", terminal], v.repo)) return false;
    if (v.terminal === terminal) v.terminal = undefined;
    return true;
  } catch { return false; /* display cleanup cannot affect the lane */ }
}

// Retires the display of a lane whose process is gone, from its saved record:
// sets the final comment and status, closes the observer terminal by handle.
// Never removes the worktree (orcaRemoveWorktree does, from the lane). Synchronous
// and bounded (5 s per call): the reaper and gc run it inline. Returns true
// once the terminal is closed (or there was none); false keeps the record for
// a retry on the next pass.
export function orcaRetire(saved: OrcaSaved, comment: string, status: BoardStatus): boolean {
  // No orca binary on PATH here: Orca may still run (another PATH), so the
  // handle is kept for a pass that can reach it; `lane gc --drop` overrides.
  if (!which("orca")) return false;
  const call = (args: string[]): { ok: boolean; code?: string } => {
    try {
      const r = spawnSync("orca", [...args, "--json"], { cwd: saved.repo, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
      const j = JSON.parse(r.stdout || "null") as { ok?: unknown; error?: { code?: unknown } } | null;
      return { ok: j?.ok === true, code: typeof j?.error?.code === "string" ? j.error.code : undefined };
    } catch { return { ok: false }; }
  };
  call(["worktree", "set", "--worktree", `id:${saved.worktreeId}`, "--comment", comment, "--workspace-status", status]);
  if (!saved.terminal) return true;
  const closed = call(["terminal", "close", "--terminal", saved.terminal]);
  // A handle Orca no longer knows (terminal already gone, Orca restarted) has
  // nothing left to close: retrying it on every pass would never succeed.
  return closed.ok || closed.code === "terminal_handle_stale";
}
