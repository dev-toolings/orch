// Lane gate: run only the tests the change can break. Full bun test is
// the nightly bench. ORCH_GATE_FULL=1 forces the original VERIFY.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git } from "../core/git.ts";
import { isTestPath } from "../core/sensitive.ts";

const EXT = /\.[cm]?[jt]sx?$/;

export function isBunTest(verify: string): boolean {
  return /^\s*bun\s+test\b/.test(verify);
}

function stem(file: string): string {
  return basename(file).replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "").replace(EXT, "");
}

export function candidateTests(file: string): string[] {
  const n = file.replace(/\\/g, "/");
  if (isTestPath(n)) return [n];
  const name = stem(n);
  const dir = dirname(n);
  const base = n.replace(/^src\//, "").replace(/^lib\//, "");
  return [
    n.replace(EXT, ".test.ts"),
    n.replace(EXT, ".spec.ts"),
    join("tests", name + ".test.ts"),
    join("tests", name + ".spec.ts"),
    join("test", name + ".test.ts"),
    join(dir, name + ".test.ts"),
    join("tests", base.replace(EXT, ".test.ts")),
    join("checks", name + ".ts"),
  ].map((p) => p.replace(/\\/g, "/"));
}

export function affectedTests(files: string[], exists: (path: string) => boolean = existsSync): string[] {
  const out = new Set<string>();
  for (const file of files) {
    const n = file.replace(/\\/g, "/");
    if (isTestPath(n) && exists(n)) out.add(n);
    for (const cand of candidateTests(n)) if (exists(cand)) out.add(cand);
  }
  return [...out].sort();
}

function quote(path: string): string {
  if (!/[^A-Za-z0-9._/=+-]/.test(path)) return path;
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

export function gateVerify(
  verify: string,
  files: string[],
  opts?: { exists?: (path: string) => boolean; env?: NodeJS.ProcessEnv },
): { command: string; affected: string[]; full: boolean } {
  const env = opts?.env ?? process.env;
  if (env.ORCH_GATE_FULL === "1" || !isBunTest(verify)) {
    return { command: verify, affected: [], full: true };
  }
  const exists = opts?.exists ?? existsSync;
  const affected = affectedTests(files, exists);
  if (!affected.length) return { command: verify, affected: [], full: true };
  const extra = verify.replace(/^\s*bun\s+test\b/, "").trim();
  const filesArg = affected.map(quote).join(" ");
  return { command: extra ? `bun test ${filesArg} ${extra}` : `bun test ${filesArg}`, affected, full: false };
}

export function prePushFiles(repo: string, base = "HEAD"): string[] {
  const names = new Set<string>();
  for (const block of [
    git(repo, "diff", "--name-only", "--cached"),
    git(repo, "diff", "--name-only"),
    git(repo, "diff", "--name-only", base),
  ]) {
    if (block.ok) for (const f of block.out.split("\n").filter(Boolean)) names.add(f);
  }
  return [...names].sort();
}
