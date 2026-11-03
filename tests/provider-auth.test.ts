import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthLabel, detectCodexAuthMode } from "../src/core/provider-auth.ts";

describe("codex auth mode detection", () => {
  test("detects API key mode from config markers without reading secret values", () => {
    const home = mkdtempSync(join(tmpdir(), "orch-codex-auth-"));
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5-codex"\nopenai_api_key = "sk-***"\n');
      expect(detectCodexAuthMode(home)).toBe("api-key");
      expect(codexAuthLabel("api-key")).toBe("clé API");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("detects login mode from auth presence", () => {
    const home = mkdtempSync(join(tmpdir(), "orch-codex-auth-"));
    try {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "auth.json"), "{}\n");
      expect(detectCodexAuthMode(home)).toBe("login");
      expect(codexAuthLabel("login")).toBe("login");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("falls back to unknown when no auth markers exist", () => {
    const home = mkdtempSync(join(tmpdir(), "orch-codex-auth-"));
    try {
      expect(detectCodexAuthMode(home)).toBe("unknown");
      expect(codexAuthLabel("unknown")).toBe("inconnu");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
