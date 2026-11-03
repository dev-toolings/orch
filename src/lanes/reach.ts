// Does VERIFY reach the lane's worktree? A command that enters an already
// running container (`docker compose exec`, `docker exec`, `kubectl exec`)
// tests that container's checkout, usually the operator's main one, never
// the lane's: its exit 0 proves nothing about the lane (incident of
// 2026-11-02, core: `make test` ran `docker compose exec core phpunit` and
// passed 10/10 on the old code, then the lane was integrated).
// Wrappers are followed: make targets through `make -n` (a dry run, in the
// same directory VERIFY runs in), package.json and composer.json scripts.
// A segment naming $LANE_WORKTREE, or mounting the worktree's path (-v,
// --volume, --mount, -w, --workdir), is trusted: it points a container at
// the lane on purpose. A compose file path inside the worktree is not.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONTAINER_TOOLS = new Set(["docker", "docker-compose", "podman", "podman-compose", "nerdctl", "kubectl", "oc"]);
// Global flags of those CLIs that take a value: the value is not the subcommand.
const VALUE_FLAGS = new Set([
  "-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--profile", "-H", "--host",
  "-c", "--context", "--config", "--log-level", "-n", "--namespace", "--kubeconfig", "--ansi", "--progress",
]);
const MAX_DEPTH = 3;
const BUN_BUILTINS = new Set(["test", "run", "x", "exec", "install", "i", "add", "remove", "update", "build", "init", "create", "link", "pm", "upgrade", "repl"]);

function segments(text: string): string[] {
  return text.replace(/\\\n/g, " ").split(/\n|;|&&|\|\||\||\$\(|`|\bthen\b|\bdo\b/).map((s) => s.trim()).filter(Boolean);
}

const words = (segment: string) => segment.split(/\s+/).map((w) => w.replace(/^["'(@]+|["')]+$/g, "")).filter(Boolean);

// Words that may precede the command itself; `sudo -u x`, `env A=b` flags are skipped too.
const PREFIXES = new Set(["sudo", "env", "time", "nice", "nohup", "command", "exec", "if", "while", "until", "!", "{", "timeout"]);

// Index of the word in command position: an argument naming docker is not a docker call.
function commandAt(w: string[]): number {
  let i = 0;
  let prefixed = false;
  while (i < w.length) {
    const t = w[i]!;
    if (PREFIXES.has(t)) prefixed = true;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { /* VAR=value */ }
    else if (prefixed && t.startsWith("-")) { if (/^-[ug]$/.test(t)) i++; }
    else if (prefixed && w[i - 1] === "timeout" && /^\d+[smhd]?$/.test(t)) { /* duration */ }
    else break;
    i++;
  }
  return i;
}

// The subcommand of a container CLI in command position, when it is exec or attach.
function containerEntry(segment: string): string | null {
  const w = words(segment);
  const i = commandAt(w);
  if (i < w.length) {
    const tool = w[i]!.replace(/^.*\//, "");
    if (!CONTAINER_TOOLS.has(tool)) return null;
    for (let j = i + 1; j < w.length; j++) {
      const t = w[j]!;
      if (t === "compose") continue;
      if (t.startsWith("-")) { if (VALUE_FLAGS.has(t)) j++; continue; }
      return t === "exec" || t === "attach" ? segment : null;
    }
  }
  return null;
}

function mountsWorktree(segment: string, cwd: string): boolean {
  const path = cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:-v|--volume|--mount|-w|--workdir)(?:=|\\s+)\\S*${path}`).test(segment);
}

function scriptOf(cwd: string, file: string, name: string): string | null {
  const path = join(cwd, file);
  if (!existsSync(path)) return null;
  try {
    const scripts = (JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
    const s = scripts[name];
    return typeof s === "string" ? s : Array.isArray(s) ? s.filter((x) => typeof x === "string").join("\n") : null;
  } catch { return null; }
}

// What a wrapper segment runs, one level down; null when it is not a wrapper.
function expand(segment: string, cwd: string, env: NodeJS.ProcessEnv): { label: string; text: string } | null {
  const all = words(segment);
  const w = all.slice(commandAt(all));
  const head = w[0]?.replace(/^.*\//, "");
  // sh -c '<script>': the script is the command.
  if (head && ["sh", "bash", "zsh", "dash"].includes(head) && w[1] === "-c") {
    const at = segment.indexOf("-c");
    return { label: segment, text: segment.slice(at + 2).trim().replace(/^(["'])([\s\S]*)\1$/, "$2") };
  }
  if (head === "make" || head === "gmake") {
    const dry = spawnSync(w[0]!, ["-n", "--no-print-directory", ...w.slice(1)], { cwd, env, encoding: "utf8", timeout: 15_000 });
    return { label: segment, text: `${dry.stdout ?? ""}` };
  }
  let script: string | null = null;
  if (head === "composer" && w[1] && !w[1].startsWith("-")) script = scriptOf(cwd, "composer.json", w[1] === "run-script" || w[1] === "run" ? w[2] ?? "" : w[1]);
  else if (head && ["bun", "npm", "pnpm", "yarn"].includes(head)) {
    // `bun test` is Bun's own runner, `npm x` only runs `npm test` and `npm run x`.
    const name = w[1] === "run" ? w[2] : head === "npm" ? (w[1] === "test" ? "test" : undefined) : head === "bun" && BUN_BUILTINS.has(w[1] ?? "") ? undefined : w[1];
    if (name && !name.startsWith("-")) script = scriptOf(cwd, "package.json", name);
  }
  return script === null ? null : { label: segment, text: script };
}

/** Why VERIFY does not reach the worktree, or null when nothing says so. */
export function verifyReach(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env, depth = 0): string | null {
  for (const seg of segments(command)) {
    if (seg.includes("LANE_WORKTREE") || mountsWorktree(seg, cwd)) continue;
    const entry = containerEntry(seg);
    if (entry) {
      return `outside the worktree: \`${entry.slice(0, 160)}\` runs in an already running container, which sees its own checkout, not this lane's worktree; `
        + "run the tests from the worktree instead (a fresh `docker compose run --rm` with the worktree's compose files, or a container mounting $LANE_WORKTREE)";
    }
    if (depth >= MAX_DEPTH) continue;
    const inner = expand(seg, cwd, env);
    if (!inner || !inner.text.trim()) continue;
    const why = verifyReach(inner.text, cwd, env, depth + 1);
    if (why) return why.replace(/^outside the worktree: /, `outside the worktree: \`${inner.label.slice(0, 80)}\` -> `);
  }
  return null;
}
