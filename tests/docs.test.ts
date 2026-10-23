import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirBytes, loadSources, pruneSources, readMeta, searchDocs, type Source, statusLines, updateSource } from "../src/docs/docs.ts";

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
    expect(lines[0]).toContain("indexed  ");
    expect(lines[0]).toMatch(/\d+\.\d MB$/);
    expect(lines[1]).toContain("not fetched");
    expect(lines.at(-1)).toMatch(/^total\s+\d+\.\d MB on disk$/);
  });

  test("dirBytes counts regular files recursively without following symlinks", () => {
    const tree = join(root, "bytes-tree");
    mkdirSync(join(tree, "nested"), { recursive: true });
    writeFileSync(join(tree, "nested", "data"), Buffer.alloc(13));
    const external = join(root, "bytes-external");
    mkdirSync(external);
    writeFileSync(join(external, "large"), Buffer.alloc(37));
    symlinkSync(external, join(tree, "linked"), "dir");
    expect(dirBytes(tree)).toBe(13);
    expect(dirBytes(join(root, "does-not-exist"))).toBe(0);
  });

  test("status lists orphans and pruning removes only marked undeclared directories", () => {
    const orphanRoot = join(root, "orphan-case");
    const declared = { ...llmsSrc(), id: "active" };
    mkdirSync(join(orphanRoot, declared.id), { recursive: true });
    writeFileSync(join(orphanRoot, declared.id, ".orch-docs.json"), JSON.stringify({
      id: declared.id, version: "v1", fetched: "2026-10-22T00:00:00.000Z", files: 0, indexed: false,
    }));
    mkdirSync(join(orphanRoot, "retired"), { recursive: true });
    writeFileSync(join(orphanRoot, "retired", ".orch-docs.json"), "{}");
    mkdirSync(join(orphanRoot, "unowned"));
    const external = join(root, "external");
    mkdirSync(external);
    writeFileSync(join(external, ".orch-docs.json"), "{}");
    symlinkSync(external, join(orphanRoot, "external-link"), "dir");

    writeFileSync(join(orphanRoot, declared.id, "payload"), Buffer.alloc(1048576));
    writeFileSync(join(orphanRoot, "retired", "payload"), Buffer.alloc(524288));
    const lines = statusLines([declared], orphanRoot);
    expect(lines[0]).toMatch(/indexed|NOT INDEXED/);
    expect(lines[0]).toMatch(/1\.0 MB$/);
    expect(lines[1]).toBe(`${"retired".padEnd(20)} orphan       not in catalog/docs.yaml (orch docs update removes it)  0.5 MB`);
    expect(lines.at(-1)).toBe(`${"total".padEnd(20)} 1.5 MB on disk`);
    expect(pruneSources([declared], orphanRoot)).toEqual(["retired"]);
    expect(existsSync(join(orphanRoot, declared.id))).toBe(true);
    expect(existsSync(join(orphanRoot, "retired"))).toBe(false);
    expect(existsSync(join(orphanRoot, "unowned"))).toBe(true);
    expect(existsSync(join(external, ".orch-docs.json"))).toBe(true);
  });
});
