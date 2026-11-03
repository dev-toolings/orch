import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupsToDrop } from "../src/brain/admin.ts";
import { purgeWorkerCache } from "../src/lane.ts";

describe("retention", () => {
  test("backups keep the newest of 7 days and of 4 earlier weeks", () => {
    const names: string[] = [];
    // Hourly retries on 1 Nov, then one per day back to 1 Sep 2026.
    for (const h of ["13", "14", "15", "16"]) names.push(`2026-11-01T${h}-45-00-000Z`);
    for (let d = new Date("2026-10-31T12:00:00Z"); d >= new Date("2026-09-01T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 1)) {
      names.push(`${d.toISOString().slice(0, 10)}T17-45-00-000Z`);
    }
    const keep = names.filter((n) => !backupsToDrop(names).includes(n)).sort();
    expect(keep).toEqual([
      // newest (Sunday) of each of the 4 weeks before the daily window, weeks starting on Monday
      "2026-10-04T17-45-00-000Z", "2026-10-11T17-45-00-000Z", "2026-10-18T17-45-00-000Z", "2026-10-25T17-45-00-000Z",
      // 7 days, the newest of the hourly retries for 1 Nov
      ...["10-26", "10-27", "10-28", "10-29", "10-30", "10-31"].map((d) => `2026-${d}T17-45-00-000Z`),
      "2026-11-01T16-45-00-000Z",
    ].sort());
  });

  test("the worker bun cache is purged only when no lane runs", () => {
    const state = mkdtempSync(join(tmpdir(), "orch-ret-"));
    const cache = join(state, "cache", "bun");
    mkdirSync(cache, { recursive: true });
    mkdirSync(join(state, "lanes", "l1"), { recursive: true });
    writeFileSync(join(state, "lanes", "l1", "state.json"), JSON.stringify({ id: "l1", status: "running", repo: state, worktree: state, branch: "lane/l1", to: "claude", started: "2026-11-02T10:00:00Z" }));
    const out: string[] = [];
    purgeWorkerCache(out, state);
    expect(existsSync(cache)).toBe(true);
    writeFileSync(join(state, "lanes", "l1", "state.json"), JSON.stringify({ id: "l1", status: "complete", repo: state, worktree: state, branch: "lane/l1", to: "claude", started: "2026-11-02T10:00:00Z" }));
    purgeWorkerCache(out, state);
    expect(existsSync(cache)).toBe(false);
  });
});
