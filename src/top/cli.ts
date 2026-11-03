import { parseArgs } from "node:util";
import { collectTop, renderTop } from "./top.ts";

export const TOP_USAGE = `usage: orch top [--once] [--interval sec]`;

export async function top(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { once: { type: "boolean" }, interval: { type: "string" } },
  });
  const interval = values.interval === undefined ? 2 : Number(values.interval);
  if (!Number.isFinite(interval) || interval < 0.2) throw new Error("top: --interval must be at least 0.2");
  const once = values.once || process.stdout.isTTY !== true;
  const text = () => renderTop(collectTop());
  if (once) {
    process.stdout.write(text());
    return;
  }
  const tick = () => {
    process.stdout.write(`\x1b[2J\x1b[H${text()}q to quit · refresh ${interval}s\n`);
  };
  tick();
  const timer = setInterval(tick, Math.round(interval * 1000));
  const stop = () => {
    clearInterval(timer);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* already cooked */ }
      process.stdin.pause();
    }
    process.stdin.removeListener("data", onData);
  };
  const onData = (buf: Buffer) => {
    const s = buf.toString();
    if (s.includes("q") || s.includes("Q") || s.includes("\u0003")) {
      stop();
      process.exitCode = 0;
    }
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  }
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
}
