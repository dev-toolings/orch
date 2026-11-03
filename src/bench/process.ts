import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogged } from "../harness/proc.ts";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TRUNCATED = "\n[output truncated]\n";
const TRUNCATED_BYTES = Buffer.byteLength(TRUNCATED);

export interface CaptureProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdin?: string;
}

export interface CapturedProcess {
  stdout: string;
  stderr: string;
  exit: number;
  timedOut: boolean;
}

function readPrefix(path: string, limit: number): { data: Buffer; size: number } {
  const size = statSync(path).size;
  const length = Math.max(0, Math.min(size, limit));
  const data = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, data, offset, length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return { data: offset === length ? data : data.subarray(0, offset), size };
  } finally { closeSync(fd); }
}

function text(data: Buffer): string {
  const decoded = data.toString("utf8");
  return Buffer.byteLength(decoded) <= data.length ? decoded : data.toString("latin1");
}

function readOutputs(stdoutPath: string, stderrPath: string): { stdout: string; stderr: string } {
  const stdoutSize = statSync(stdoutPath).size;
  const stderrSize = statSync(stderrPath).size;
  const available = MAX_OUTPUT_BYTES - TRUNCATED_BYTES * 2;
  let stdoutLimit = Math.min(stdoutSize, Math.floor(available / 2));
  let stderrLimit = Math.min(stderrSize, available - stdoutLimit);
  let remaining = available - stdoutLimit - stderrLimit;
  const stdoutExtra = Math.min(stdoutSize - stdoutLimit, remaining);
  stdoutLimit += stdoutExtra;
  remaining -= stdoutExtra;
  stderrLimit += Math.min(stderrSize - stderrLimit, remaining);

  const stdout = readPrefix(stdoutPath, stdoutLimit);
  const stderr = readPrefix(stderrPath, stderrLimit);
  return {
    stdout: `${text(stdout.data)}${stdout.size > stdout.data.length ? TRUNCATED : ""}`,
    stderr: `${text(stderr.data)}${stderr.size > stderr.data.length ? TRUNCATED : ""}`,
  };
}

/** Captures a process in an owned process group and waits for descendants to stop before cleanup. */
export async function captureProcess(argv: string[], options: CaptureProcessOptions): Promise<CapturedProcess> {
  if (!argv.length || !argv[0]) throw new Error("captureProcess: argv must include an executable");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("captureProcess: timeoutMs must be positive");
  const temporary = mkdtempSync(join(tmpdir(), "orch-process-"));
  const stdoutPath = join(temporary, "stdout.log");
  const stderrPath = join(temporary, "stderr.log");
  const stdinPath = options.stdin === undefined ? undefined : join(temporary, "stdin.txt");
  try {
    if (stdinPath) writeFileSync(stdinPath, options.stdin!);
    const result = await runLogged(argv, {
      cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs,
      logPath: stdoutPath, stderrPath, stdinPath,
    });
    const output = readOutputs(stdoutPath, stderrPath);
    if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > MAX_OUTPUT_BYTES) throw new Error("captureProcess: output exceeded the configured limit");
    return { ...output, exit: result.code ?? 1, timedOut: result.timedOut };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
