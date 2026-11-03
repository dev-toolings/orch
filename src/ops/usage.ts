// Token consumption from Claude Code's own transcripts (~/.claude/projects),
// per day and model: what Hublot and TokenFlex show Emilien. Read-only; a
// streamed message appears several times, so each message id counts once.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Usage { input: number; output: number; cache_read: number; cache_write: number; messages: number }
const empty = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0 });

export function claudeProjectsDir(home = process.env.ORCH_HOME ?? homedir()): string {
  return join(home, ".claude", "projects");
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function usageTokens(u: Usage): number {
  return u.input + u.output + u.cache_read + u.cache_write;
}

export function tokensOnDay(map: Map<string, Map<string, Usage>>, day: string): number {
  const byModel = map.get(day);
  if (!byModel) return 0;
  let n = 0;
  for (const u of byModel.values()) n += usageTokens(u);
  return n;
}

function* jsonlFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

// day (YYYY-MM-DD, UTC) -> model -> usage, for messages since `since`.
export function tokenUsage(root: string, since: Date): Map<string, Map<string, Usage>> {
  const out = new Map<string, Map<string, Usage>>();
  const seen = new Set<string>();
  for (const file of jsonlFiles(root)) {
    if (statSync(file).mtime < since) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      let rec: { timestamp?: string; message?: { id?: string; model?: string; usage?: Record<string, number> } };
      try { rec = JSON.parse(line); } catch { continue; }
      const m = rec.message;
      if (!m?.usage || !m.id || !rec.timestamp || m.model === "<synthetic>" || seen.has(m.id)) continue;
      if (Date.parse(rec.timestamp) < since.getTime()) continue;
      seen.add(m.id);
      const day = rec.timestamp.slice(0, 10);
      const byModel = out.get(day) ?? new Map<string, Usage>();
      const u = byModel.get(m.model ?? "unknown") ?? empty();
      u.input += m.usage.input_tokens ?? 0;
      u.output += m.usage.output_tokens ?? 0;
      u.cache_read += m.usage.cache_read_input_tokens ?? 0;
      u.cache_write += m.usage.cache_creation_input_tokens ?? 0;
      u.messages++;
      byModel.set(m.model ?? "unknown", u);
      out.set(day, byModel);
    }
  }
  return out;
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

export function usageLines(u: Map<string, Map<string, Usage>>): string[] {
  const lines: string[] = [];
  for (const day of [...u.keys()].sort()) {
    for (const [model, x] of [...u.get(day)!].sort()) {
      lines.push(`${day}  ${model.padEnd(22)} in ${k(x.input).padStart(6)}  out ${k(x.output).padStart(6)}  cache read ${k(x.cache_read).padStart(7)}  write ${k(x.cache_write).padStart(6)}  ${x.messages} msgs`);
    }
  }
  return lines.length ? lines : ["no usage in the period"];
}
