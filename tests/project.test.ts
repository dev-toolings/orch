import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyNotice, migrateProject, projectDir } from "../src/core/project.ts";

test("orch migrate moves <repo>/.orch into ~/.orch/<project> and never overwrites a different file", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-project-"));
  const repo = join(root, "atlas");
  const home = join(root, "home", ".orch");
  try {
    mkdirSync(join(repo, ".orch", "mem"), { recursive: true });
    mkdirSync(join(repo, ".orch", "specs"), { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, ".orch", "mem", "n1.md"), "note\n");
    writeFileSync(join(repo, ".orch", "mem", "same.md"), "same\n");
    writeFileSync(join(repo, ".orch", "specs", "s.md"), "old spec\n");
    mkdirSync(join(home, "atlas", "specs"), { recursive: true });
    mkdirSync(join(home, "atlas", "mem"), { recursive: true });
    writeFileSync(join(home, "atlas", "mem", "same.md"), "same\n");
    writeFileSync(join(home, "atlas", "specs", "s.md"), "new spec\n");

    expect(projectDir(join(repo, ".orch"), home)).toBe(join(home, "atlas"));
    expect(migrateProject(repo, { root: home, dry: true }).lines).toContain("would move  mem/n1.md");
    expect(existsSync(join(home, "atlas", "mem", "n1.md"))).toBe(false);

    const { conflicts } = migrateProject(repo, { root: home });
    expect(conflicts).toBe(1);
    expect(readFileSync(join(home, "atlas", "mem", "n1.md"), "utf8")).toBe("note\n");
    expect(existsSync(join(repo, ".orch", "mem"))).toBe(false);
    expect(readFileSync(join(repo, ".orch", "specs", "s.md"), "utf8")).toBe("old spec\n");
    expect(readFileSync(join(home, "atlas", "specs", "s.md"), "utf8")).toBe("new spec\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orch migrate refuses overlapping folders and leaves links and type clashes in place", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-project-"));
  const home = join(root, "home");
  const repo = join(root, "atlas");
  try {
    // run from a non-git HOME: <home>/.orch is both the old and the new root
    mkdirSync(join(home, ".orch", "beacon"), { recursive: true });
    writeFileSync(join(home, ".orch", "beacon", "keep.md"), "x\n");
    expect(migrateProject(home, { root: join(home, ".orch") }).lines[0]).toStartWith("refused:");
    expect(existsSync(join(home, ".orch", "beacon", "keep.md"))).toBe(true);

    mkdirSync(join(repo, ".orch", "specs"), { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, ".orch", "specs", "s.md"), "spec\n");
    writeFileSync(join(repo, ".orch", "note.md"), "note\n");
    symlinkSync("../scripts/setup.sh", join(repo, ".orch", "lane-setup"));
    mkdirSync(join(home, ".orch", "atlas"), { recursive: true });
    writeFileSync(join(home, ".orch", "atlas", "specs"), "a file where a folder goes\n");
    symlinkSync("missing", join(home, ".orch", "atlas", "note.md"));

    const { lines, conflicts } = migrateProject(repo, { root: join(home, ".orch") });
    expect(conflicts).toBe(3);
    expect(lines.filter((l) => l.startsWith("conflict")).length).toBe(3);
    expect(readFileSync(join(repo, ".orch", "specs", "s.md"), "utf8")).toBe("spec\n");
    expect(readFileSync(join(repo, ".orch", "note.md"), "utf8")).toBe("note\n");
    expect(existsSync(join(home, ".orch", "atlas", "lane-setup"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a leftover <repo>/.orch is flagged until migrated, and HOME itself is never flagged", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-project-"));
  const repo = join(root, "atlas");
  const home = join(root, "home", ".orch");
  try {
    mkdirSync(join(repo, ".orch", "specs"), { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, ".orch", "specs", "s.md"), "spec\n");
    expect(legacyNotice(repo, home)).toEndWith("run orch migrate");
    spawnSync("git", ["-C", repo, "add", ".orch"]);
    expect(legacyNotice(repo, home)).toContain("commit the removal");

    migrateProject(repo, { root: home });
    expect(legacyNotice(repo, home)).toBeNull();

    mkdirSync(join(home, "beacon"), { recursive: true });
    expect(legacyNotice(join(root, "home"), home)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
