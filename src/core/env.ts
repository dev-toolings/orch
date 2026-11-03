// Secrets for orch: `<repo>/.env` first (git-ignored, chmod 600, see
// .env.example), the environment only for keys it leaves unset or empty. The
// operator's shell can hold other projects' keys under the same names (a
// general Discord webhook in ~/.zshenv): orch's own file must win. Values
// are never logged.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./profile.ts";

export const envPath = () => process.env.ORCH_ENV_FILE ?? join(ROOT, ".env");

// KEY=VALUE lines, optional `export` and quotes; anything else is skipped.
export function loadEnvFile(path = envPath()): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function secretEnv(path = envPath(), env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const file = Object.fromEntries(Object.entries(loadEnvFile(path)).filter(([, v]) => v !== ""));
  return { ...env, ...file };
}

export function envFileWarning(path = envPath()): string | null {
  if (!existsSync(path)) return `no ${path}: keys must come from the environment (see .env.example)`;
  return statSync(path).mode & 0o077 ? `${path} is readable by other users: chmod 600 ${path}` : null;
}

// Sets KEY only when it is absent or empty, so a value the operator wrote is
// never replaced. Written to a temp file then renamed, mode 600: a crash
// leaves the previous file intact. Returns whether it wrote.
export function setEnvIfMissing(key: string, value: string, path = envPath()): boolean {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (loadEnvFile(path)[key]) return false;
  const kept = text.split("\n").filter((line) => !new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line));
  const body = `${kept.join("\n").replace(/\n*$/, "")}\n${key}=${value}\n`.replace(/^\n/, "");
  writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
  return true;
}
