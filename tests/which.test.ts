import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "../src/core/which.ts";

test("which follows a runtime PATH change", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-which-"));
  const saved = process.env.PATH;
  try {
    const bin = join(dir, "zzfake");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(which("zzfake")).toBeNull();
    process.env.PATH = `${dir}:/usr/bin:/bin`;
    expect(which("zzfake")).toBe(realpathSync(bin));
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
