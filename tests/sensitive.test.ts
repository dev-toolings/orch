import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  askDecision, denyCommandReason, denyDecision, denyPathReason, isTestPath,
  normalizeRepoPath, orchGuardPath, protectedPath, secretPath, sensitiveCommandReason,
} from "../src/core/sensitive.ts";

const trash: string[] = [];
const savedHome = process.env.HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  while (trash.length) rmSync(trash.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function secretWorld(opts: { tracked?: string[]; untracked?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orch-secret-"));
  trash.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  process.env.HOME = home;
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "secret-test");
  git(repo, "config", "user.email", "secret@test.invalid");
  const write = (rel: string, track: boolean) => {
    const path = join(repo, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${rel}\n`);
    if (track) git(repo, "add", rel);
  };
  for (const rel of opts.tracked ?? []) write(rel, true);
  for (const rel of opts.untracked ?? []) write(rel, false);
  if ((opts.tracked ?? []).length) git(repo, "commit", "-qm", "tracked");
  else git(repo, "commit", "--allow-empty", "-qm", "base");
  return { root, home, repo };
}

describe("protected paths", () => {
  test("guardrail files and hook dirs are protected, ordinary sources are not", () => {
    for (const path of [
      "CLAUDE.md", "AGENTS.md", "package.json", "orch.yaml",
      "catalog/policy.yaml", "catalog/lead.md", ".git/config",
      ".github/workflows/ci.yml", ".claude/settings.json", ".grok/hooks/orch.json",
      ".git/hooks/pre-commit",
    ]) {
      expect(protectedPath(path)).toBe(true);
    }
    expect(protectedPath("src/lane.ts")).toBe(false);
    expect(protectedPath("tests/lane.test.ts")).toBe(false);
    expect(protectedPath("docs/architecture.md")).toBe(false);
  });

  test("absolute paths, .. and symlinks are compared to the checkout root", () => {
    const repo = mkdtempSync(join(tmpdir(), "orch-prot-"));
    try {
      expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
      mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "CLAUDE.md"), "x");
      writeFileSync(join(repo, ".github", "workflows", "x.yml"), "x");
      symlinkSync(join(repo, "CLAUDE.md"), join(repo, "src", "lead.md"));
      expect(protectedPath(join(repo, "CLAUDE.md"), repo)).toBe(true);
      expect(protectedPath(join(repo, ".github", "workflows", "x.yml"), repo)).toBe(true);
      expect(protectedPath(join(repo, "src", "..", "CLAUDE.md"), repo)).toBe(true);
      expect(protectedPath(join(repo, "src", "lead.md"), repo)).toBe(true);
      expect(normalizeRepoPath(join(repo, ".github", "workflows", "x.yml"), repo)).toBe(".github/workflows/x.yml");
      expect(protectedPath(join(repo, "src", "lane.ts"), repo)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("test paths include tests/, checks/ and *.test.ts", () => {
    expect(isTestPath("tests/lane.test.ts")).toBe(true);
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("checks/parity.ts")).toBe(true);
    expect(isTestPath("src/lane.ts")).toBe(false);
  });
});

describe("secrets and orch guards", () => {
  test("secretPath matches untracked env, keys, credentials, ssh and token files", () => {
    const { repo, home } = secretWorld({ untracked: [".env", ".env.local"] });
    for (const path of [".env", ".env.local", "prod.pem", "id_rsa", "id_ed25519", "credentials", "api.token"]) {
      expect(secretPath(path, repo)).toBe(true);
    }
    expect(secretPath("src/lane.ts", repo)).toBe(false);
    expect(secretPath("src/tokenizer.ts", repo)).toBe(false);
    expect(secretPath("docs/credentials.md", repo)).toBe(false);
    expect(secretPath(join(home, ".ssh", "id_ed25519"), repo)).toBe(true);
  });

  test("secretPath allows env templates and git-tracked env files", () => {
    const { repo } = secretWorld({
      tracked: [".env", ".env.prod"],
      untracked: [".env.example", ".env.dev", ".env.local"],
    });
    expect(secretPath(".env", repo)).toBe(false);
    expect(secretPath(".env.prod", repo)).toBe(false);
    expect(secretPath(".env.example", repo)).toBe(false);
    expect(secretPath(".env.dev", repo)).toBe(false);
    expect(secretPath(".env.dist", repo)).toBe(false);
    expect(secretPath(".env.sample", repo)).toBe(false);
    expect(secretPath(".env.template", repo)).toBe(false);
    expect(secretPath(".env.test", repo)).toBe(false);
    expect(secretPath(".env.local", repo)).toBe(true);
  });

  test("orchGuardPath matches hook config, lead-settings, policy and hook source", () => {
    for (const path of [
      "src/hooks/hook.ts", "src/core/sensitive.ts", "src/install/render.ts",
      "catalog/policy.yaml", ".claude/orch/lead-settings.json", ".grok/hooks/orch.json",
    ]) {
      expect(orchGuardPath(path)).toBe(true);
    }
    expect(orchGuardPath("src/lane.ts")).toBe(false);
    expect(orchGuardPath("CLAUDE.md")).toBe(false);
  });

  test("denyCommandReason allows the sentry env/config greps", () => {
    const { repo } = secretWorld({
      tracked: [
        ".env", ".env.example", ".env.dev",
        "config/packages/sentry.yaml", "composer.lock", "config/bundles.php", "src/Kernel.php",
      ],
    });
    expect(denyCommandReason(
      "grep -n -i -E 'SENTRY|ERRORTRACK' .env .env.example .env.dev",
      repo,
    )).toBeNull();
    expect(denyCommandReason(
      "cat config/packages/sentry.yaml; grep -n -i sentry composer.lock; grep -rn -i sentry config/bundles.php src",
      repo,
    )).toBeNull();
    expect(denyCommandReason("grep -n token src/Kernel.php", repo)).toBeNull();
    expect(denyCommandReason("grep secret composer.lock", repo)).toBeNull();
    expect(denyCommandReason("grep DSN config/packages/sentry.yaml", repo)).toBeNull();
    expect(denyCommandReason("cd config && cat packages/sentry.yaml", repo)).toBeNull();
  });

  test("denyCommandReason and denyPathReason name the denied path and why", () => {
    const { repo } = secretWorld({
      tracked: [".env.example"],
      untracked: [".env", ".env.local", ".env.prod"],
    });
    expect(denyCommandReason("cat .env.local", repo)).toBe(
      "orch: denied .env.local (untracked env file, may hold secrets)",
    );
    expect(denyCommandReason("cat .env", repo)).toBe(
      "orch: denied .env (untracked env file, may hold secrets)",
    );
    expect(denyCommandReason("cat .env.prod", repo)).toBe(
      "orch: denied .env.prod (untracked env file, may hold secrets)",
    );
    expect(denyCommandReason("cat ~/.ssh/id_ed25519", repo)).toBe(
      "orch: denied ~/.ssh/id_ed25519 (private key)",
    );
    expect(denyCommandReason("cat ~/.ssh/config", repo)).toBe(
      "orch: denied ~/.ssh/config (ssh path)",
    );
    expect(denyCommandReason("cat ~/.aws/credentials", repo)).toBe(
      "orch: denied ~/.aws/credentials (credential store)",
    );
    expect(denyCommandReason("cat key.pem", repo)).toBe("orch: denied key.pem (private key)");
    expect(denyCommandReason("cat secret.key", repo)).toBe("orch: denied secret.key (private key)");
    expect(denyCommandReason("cat id_rsa", repo)).toBe("orch: denied id_rsa (private key)");
    expect(denyCommandReason("cat api.token", repo)).toBe("orch: denied api.token (token file)");
    expect(denyCommandReason("cat ~/.claude/.credentials.json", repo)).toBe(
      "orch: denied ~/.claude/.credentials.json (credential store)",
    );
    expect(denyCommandReason("cat ~/.codex/auth.json", repo)).toBe(
      "orch: denied ~/.codex/auth.json (credential store)",
    );
    expect(denyCommandReason("cat ~/.grok/auth.json", repo)).toBe(
      "orch: denied ~/.grok/auth.json (credential store)",
    );
    expect(denyCommandReason("cat ~/.netrc", repo)).toBe("orch: denied ~/.netrc (credential store)");
    expect(denyCommandReason("cat ~/.npmrc", repo)).toBe("orch: denied ~/.npmrc (credential store)");
    expect(denyCommandReason("printenv OPENAI_API_KEY", repo)).toBe(
      "orch: denied printenv OPENAI_API_KEY (env dump of secret variable)",
    );
    expect(denyCommandReason("printenv", repo)).toMatch(/env dump of secret variables/);
    expect(denyCommandReason("env", repo)).toMatch(/env dump of secret variables/);
    expect(denyCommandReason("env | grep SECRET", repo)).toMatch(/env dump of secret variables/);
    expect(denyCommandReason("sed -i s/x/y/ src/hooks/hook.ts", repo)).toMatch(/orch guard/);
    expect(denyCommandReason("cp catalog/policy.yaml /tmp/", repo)).toMatch(/orch guard/);
    expect(denyCommandReason("git status", repo)).toBeNull();
    expect(denyCommandReason("env PATH=foo bun test", repo)).toBeNull();
    expect(denyCommandReason("printenv PATH", repo)).toBeNull();
    expect(denyCommandReason("cat .env*", repo)).toMatch(
      /orch: denied \.env\.(local|prod) \(untracked env file, may hold secrets\)/,
    );
    expect(denyPathReason(".env.local", repo, "read")).toBe(
      "orch: denied .env.local (untracked env file, may hold secrets)",
    );
    expect(denyPathReason(".env.example", repo, "read")).toBeNull();
    expect(denyPathReason("src/hooks/hook.ts", repo, "edit")).toMatch(/orch guard/);
    expect(denyPathReason("src/hooks/hook.ts", repo, "read")).toBeNull();
  });
});

describe("sensitive commands", () => {
  test("git push, network, rm outside or recursive, secrets and guardrail edits ask", () => {
    expect(sensitiveCommandReason("git push origin feat")).toMatch(/git push/);
    expect(sensitiveCommandReason("curl https://example.invalid")).toMatch(/network/);
    expect(sensitiveCommandReason("wget -q https://example.invalid")).toMatch(/network/);
    expect(sensitiveCommandReason("ssh host")).toMatch(/network/);
    expect(sensitiveCommandReason("rm -rf /tmp/x")).toMatch(/rm/);
    expect(sensitiveCommandReason("rm -rf x")).toMatch(/recursive/);
    expect(sensitiveCommandReason("rm ../secret")).toMatch(/outside/);
    expect(sensitiveCommandReason("rm ~/lab/x")).toMatch(/outside/);
    expect(sensitiveCommandReason("git config core.hooksPath /tmp/hooks")).toMatch(/hooks/);
    expect(sensitiveCommandReason("sed -i s/x/y/ package.json")).toMatch(/guardrail/);
    expect(sensitiveCommandReason("cp orch.yaml /tmp/")).toMatch(/guardrail/);
  });

  test("ordinary local commands are left alone", () => {
    expect(sensitiveCommandReason("git status")).toBeNull();
    expect(sensitiveCommandReason("rm out.txt")).toBeNull();
    expect(sensitiveCommandReason("ls src")).toBeNull();
    expect(sensitiveCommandReason("bun test")).toBeNull();
  });

  test("askDecision is a Claude PreToolUse ask payload", () => {
    const parsed = JSON.parse(askDecision("git push needs approval"));
    expect(parsed.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: "git push needs approval",
    });
  });

  test("denyDecision is a Claude PreToolUse deny payload", () => {
    const parsed = JSON.parse(denyDecision("reading or writing secrets is denied"));
    expect(parsed.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "reading or writing secrets is denied",
    });
  });
});
