import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretEnv } from "../src/core/env.ts";

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-env-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("secretEnv", () => {
  test(".env wins over the shell; the shell only fills keys .env leaves unset or empty", () => {
    const file = join(root, ".env");
    writeFileSync(file, "DISCORD_WEBHOOK_URL=https://discord.test/orch\nANTHROPIC_API_KEY=\n", { mode: 0o600 });
    const shell = { DISCORD_WEBHOOK_URL: "https://discord.test/general", ANTHROPIC_API_KEY: "from-shell", PATH: "/bin" };
    const env = secretEnv(file, shell);
    expect(env.DISCORD_WEBHOOK_URL).toBe("https://discord.test/orch");
    expect(env.ANTHROPIC_API_KEY).toBe("from-shell");
    expect(env.PATH).toBe("/bin");
    expect(secretEnv(join(root, "missing.env"), shell).DISCORD_WEBHOOK_URL).toBe("https://discord.test/general");
  });
});
