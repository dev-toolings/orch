import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CodexAuthMode = "api-key" | "login" | "unknown";

function codexHome(home = process.env.HOME ?? process.env.ORCH_HOME ?? ""): string {
  return join(home, ".codex");
}

function hasApiKeyConfigMarker(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  let text = "";
  try { text = readFileSync(configPath, "utf8"); } catch { return false; }
  // Presence-only detection: never read or report secret values.
  return /(^|\n)\s*(api_key|openai_api_key|anthropic_api_key)\s*=/.test(text)
    || /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/.test(text);
}

function hasLoginMarker(homePath: string): boolean {
  return [
    "auth.json",
    "oauth.json",
    "session.json",
  ].some((name) => existsSync(join(homePath, name)));
}

export function detectCodexAuthMode(home = process.env.HOME ?? process.env.ORCH_HOME ?? ""): CodexAuthMode {
  const root = codexHome(home);
  const configPath = join(root, "config.toml");
  if (hasApiKeyConfigMarker(configPath)) return "api-key";
  if (hasLoginMarker(root)) return "login";
  return "unknown";
}

export function codexAuthLabel(mode: CodexAuthMode): "clé API" | "login" | "inconnu" {
  if (mode === "api-key") return "clé API";
  if (mode === "login") return "login";
  return "inconnu";
}
