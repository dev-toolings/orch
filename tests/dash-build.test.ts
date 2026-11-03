import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("ui build check", () => {
  test("the SPA package is wired for a production build", () => {
    const pkg = JSON.parse(readFileSync(join(root, "ui", "package.json"), "utf8")) as { scripts?: { build?: string } };
    expect(pkg.scripts?.build).toContain("vite build");
    expect(existsSync(join(root, "ui", "vite.config.ts"))).toBe(true);
    expect(existsSync(join(root, "ui", "src", "pages", "Floor3D.tsx"))).toBe(true);
    expect(existsSync(join(root, "src", "dash", "serve.ts"))).toBe(true);
    const orch = readFileSync(join(root, "src", "orch.ts"), "utf8");
    expect(orch).toContain('cmd === "dash"');
    const make = readFileSync(join(root, "Makefile"), "utf8");
    expect(make).toMatch(/^dash:/m);
    expect(make).toMatch(/^dev:/m);
    expect(make).toMatch(/\.PHONY:.*\bdev\b/);
  });
});
