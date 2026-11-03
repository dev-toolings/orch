import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../src/core/profile.ts";
import { applyRole, mergeRoles, parseRoles, projectRoles, roleChoice, withExplicit } from "../src/core/roles.ts";
import { workerArgv } from "../src/harness/harness.ts";

let root: string;
let savedConfig: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-roles-"));
  savedConfig = process.env.ORCH_CONFIG;
  writeFileSync(join(root, "orch.yaml"), `name: demo
roles:
  explore:
    claude: { model: haiku, effort: low }
  edit:
    claude: { effort: xhigh }
    codex: { model: gpt-6-luna, effort: xhigh }
  coordinator:
    claude: { effort: high }
`);
});

afterAll(() => {
  if (savedConfig === undefined) delete process.env.ORCH_CONFIG;
  else process.env.ORCH_CONFIG = savedConfig;
  rmSync(root, { recursive: true, force: true });
});

describe("roles", () => {
  test("parseRoles reads coordinator, explore, edit, review per harness", () => {
    const table = parseRoles({
      coordinator: { claude: { model: "opus", effort: "high" }, junk: { model: "x" } },
      explore: { claude: { model: "haiku", effort: "low" }, codex: { effort: "low" } },
      edit: { claude: { effort: "xhigh" } },
    });
    expect(table.coordinator?.claude).toEqual({ model: "opus", effort: "high" });
    expect(table.explore?.codex).toEqual({ effort: "low" });
    expect(table.edit?.claude).toEqual({ effort: "xhigh" });
    expect(table.review).toBeUndefined();
  });

  test("orch.yaml overlays the profile roles", () => {
    process.env.ORCH_CONFIG = join(root, "orch.yaml");
    const profile = loadProfile("max20");
    expect(roleChoice("explore", "claude", profile, root)).toMatchObject({ model: "haiku", effort: "low" });
    expect(roleChoice("edit", "codex", profile, root)).toMatchObject({ model: "gpt-6-luna", effort: "xhigh" });
    expect(roleChoice("coordinator", "claude", profile, root).effort).toBe("high");
    const merged = mergeRoles({ explore: { claude: { effort: "medium" } } }, projectRoles(root));
    expect(merged.explore?.claude).toMatchObject({ model: "haiku", effort: "low" });
  });

  test("applyRole keeps permission_mode and fills model/effort", () => {
    expect(applyRole(
      { model: "opus", effort: "high", permission_mode: "default" },
      { effort: "low" },
    )).toEqual({ model: "opus", effort: "low", permission_mode: "default" });
  });

  test("shipped profiles pin explore to haiku and edits to medium on max20", () => {
    const max20 = loadProfile("max20");
    expect(max20.explore?.claude).toBe("haiku");
    expect(max20.lanes.claude.effort).toBe("medium");
    expect(max20.lanes.codex.effort).toBe("medium");
    expect(max20.roles).toBeDefined();
    const lean = loadProfile("lean");
    expect(lean.explore?.claude).toBe("haiku");
    expect(lean.lanes.codex.effort).toBe("medium");
  });

  test("a Claude explore worker is haiku at low effort without plan mode", () => {
    const choice = applyRole({ model: "sonnet", effort: "high" }, { model: "haiku", effort: "low" });
    const { argv } = workerArgv("claude", choice, {
      cwd: "/w", promptPath: "/p", readOnly: true, lastMessagePath: "/l",
    });
    expect(argv).toContain("haiku");
    expect(argv).toContain("low");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("Read");
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("Edit");
    expect(argv).toContain("Bash");
    expect(argv).not.toContain("--permission-mode");
    expect(argv).not.toContain("plan");
  });

  test("an explicit --model wins over the role overlay", () => {
    expect(withExplicit(
      { model: "sonnet", effort: "high" },
      { model: "haiku", effort: "low" },
      { model: "opus" },
    )).toEqual({ model: "opus", effort: "low" });
    expect(withExplicit(
      { model: "sonnet", effort: "high" },
      { model: "haiku", effort: "low" },
      { effort: "xhigh" },
    )).toEqual({ model: "haiku", effort: "xhigh" });
  });
});
