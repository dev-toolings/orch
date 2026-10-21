import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSources, readMeta, searchDocs, type Source, statusLines, updateSource } from "../src/docs/docs.ts";

let root: string;
let docs: string;
let upstream: string;
const savedPath = process.env.PATH;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-docs-"));
  docs = join(root, "docs");
  upstream = join(root, "upstream");
  mkdirSync(join(upstream, "docs"), { recursive: true });
  mkdirSync(join(upstream, "src"));
  writeFileSync(join(upstream, "docs", "messenger.md"), "# Messenger\nretry strategy: max_retries\n");
  writeFileSync(join(upstream, "src", "code.php"), "<?php\n");
  const g = (...a: string[]) => spawnSync("git", ["-C", upstream, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  g("init", "-q", "-b", "main");
  g("add", ".");
  g("commit", "-qm", "docs");
  writeFileSync(join(root, "llms.txt"), "# Hono\n- [Routing](https://hono.dev/docs/routing)\n");
  // fake ctx: index writes a marker, search echoes one hit for "retry"
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ctx"), `#!/bin/sh
case "$1" in
  index) mkdir -p .ctx && touch .ctx/index.sqlite ;;
  search) [ -f docs/messenger.md ] || exit 0; case "$2" in *retry*) echo "docs/messenger.md:2 text : retry strategy"; echo "40 tokens; coverage=text_only; 1ms" ;; esac ;;
esac
`);
  chmodSync(join(bin, "ctx"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
});
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

const gitSrc = (): Source => ({ id: "sym@1", stack: "symfony", kind: "git", url: upstream, ref: "main", paths: ["docs"] });
const llmsSrc = (): Source => ({ id: "hono-llms", stack: "hono", kind: "llms", url: `file://${join(root, "llms.txt")}` });

describe("docs", () => {
  test("the shipped manifest is valid and covers the operator's stacks", () => {
    const stacks = new Set(loadSources().map((s) => s.stack));
    for (const s of ["php", "symfony", "laravel", "nodejs", "hono", "fastify", "express", "nextjs", "tanstack", "react", "vite", "python", "fastapi", "docker", "kubernetes", "k3s", "owasp", "owasp-ai", "claude", "codex", "grok"]) {
      expect(stacks.has(s)).toBe(true);
    }
  });

  test("git source: sparse clone of the docs path only, then indexed", async () => {
    const m = await updateSource(gitSrc(), { root: docs, now: new Date("2026-10-19T00:00:00Z") });
    expect(m.files).toBe(1);
    expect(existsSync(join(docs, "sym@1", "docs", "messenger.md"))).toBe(true);
    expect(existsSync(join(docs, "sym@1", "src"))).toBe(false);
    expect(m.indexed).toBe(true);
    expect(readMeta("sym@1", docs)?.version).toBe(m.version);
  });

  test("git source: a second update follows upstream", async () => {
    writeFileSync(join(upstream, "docs", "mailer.md"), "# Mailer\n");
    spawnSync("git", ["-C", upstream, "add", "."]);
    spawnSync("git", ["-C", upstream, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "more"]);
    const m = await updateSource(gitSrc(), { root: docs });
    expect(m.files).toBe(2);
  });

  test("llms source: one file, indexed", async () => {
    const m = await updateSource(llmsSrc(), { root: docs });
    expect(m.files).toBe(1);
    expect(m.version).toMatch(/b$/);
  });

  test("search prefixes hits with the source id, filters by stack, drops the ctx footer", () => {
    const all = searchDocs("retry strategy", [gitSrc(), llmsSrc()], { root: docs });
    expect(all).toEqual(["sym@1: docs/messenger.md:2  retry strategy: max_retries"]);
    expect(searchDocs("retry", [gitSrc(), llmsSrc()], { root: docs, stack: "hono" })).toEqual(["no match"]);
    expect(searchDocs("retry", [{ ...gitSrc(), id: "never" }], { root: docs })[0]).toContain("run orch docs update");
  });

  test("status reports fetched and missing sources", () => {
    const lines = statusLines([gitSrc(), { ...llmsSrc(), id: "missing" }], docs);
    expect(lines[0]).toContain("indexed");
    expect(lines[1]).toContain("not fetched");
  });
});
