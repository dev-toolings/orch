import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeReceipt } from "../../../src/serve/workers.ts";
import { fakeClaude, fakeCodex, fakeGh, fakeHindsight, runCommand, runLane, runOrch, tempEnv, tempRepo } from "./harness.ts";

test("backend harness owns its repo, delivery records, model receipts, memory and sealed cleanup", async () => {
  const fixture = tempEnv();
  const memory = fakeHindsight();
  const retaining = fakeHindsight({ allowRetain: true });
  try {
    const { repo, origin, git } = tempRepo(fixture, { develop: true, files: { "value.txt": "initial\n" } });
    expect(git("rev-list", "--count", "main")).toBe("1");
    expect(git("--git-dir", origin, "rev-parse", "develop")).toBe(git("rev-parse", "HEAD"));
    expect(git("--git-dir", origin, "show", "main:value.txt")).toBe("initial");
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("agent-local <agent-local@localhost>");

    const gh = fakeGh(fixture);
    const created = await runCommand(fixture, ["gh", "pr", "create", "--head", "fix/one", "--base", "develop", "--title", "Fixture", "--body", "Local only"], { cwd: repo });
    expect(created.status).toBe(0);
    const listed = await runCommand(fixture, ["gh", "pr", "list", "--head", "fix/one", "--base", "develop", "--state", "all", "--json", "url,state", "--limit", "1"], { cwd: repo });
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([{ url: created.stdout.trim(), state: "OPEN" }]);
    const viewed = await runCommand(fixture, ["gh", "pr", "view", "1", "--json", "number,url"], { cwd: repo });
    expect(viewed.status).toBe(0);
    expect(JSON.parse(viewed.stdout)).toEqual({ number: 1, url: created.stdout.trim() });
    expect(readFileSync(gh.calls, "utf8").trim().split("\n").map(line => JSON.parse(line).argv[1])).toEqual(["create", "list", "view"]);
    expect(readFileSync(gh.prs, "utf8").trim().split("\n")).toHaveLength(1);
    const second = await runCommand(fixture, ["gh", "pr", "create", "--head", "develop", "--base", "main", "--title", "Second"], { cwd: repo });
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toEndWith("/pull/2");
    const current = await runCommand(fixture, ["gh", "pr", "view", "--json", "number"], { cwd: repo });
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout)).toEqual({ number: 2 });

    const { live } = fakeClaude(fixture, `
if (prompt !== "write value" || flags["--agent"] !== "kiba" || flags["--effort"] !== "medium" ||
    flags["--permission-mode"] !== "dontAsk" || JSON.parse(flags["--agents"]).kiba === undefined ||
    JSON.parse(flags["--settings"]).hooks === undefined) throw new Error("CLI flags lost");
return {files:{"value.txt":"changed\\n"},costUSD:0.25};
`);
    // The foundation smoke is fake-only even under make e2e-live. Future scenario
    // files own live execution and subscription authentication.
    if (!live) {
      const session = "5b0f6c1e-2f4a-4c8e-9d3b-7a1e2c4f6b80";
      for (const identityFlag of ["--session-id", "--resume"]) {
        const run = await runCommand(fixture, ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
          identityFlag, session, "--agent", "kiba", "--agents", '{"kiba":{}}', "--settings", '{"hooks":{}}',
          "--model", "fake-opus", "--effort", "medium", "--permission-mode", "dontAsk"], {
          cwd: repo, stdin: JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "write value" }] } }) + "\n",
        });
        expect(run.status).toBe(0);
        const events = run.stdout.trim().split("\n").map(line => JSON.parse(line));
        expect(events.map(event => event.type)).toEqual(["system", "assistant", "result"]);
        expect(nativeReceipt(events.filter(event => event.type === "result"), run.status, session,
          events[0].session_id, false, events[0].model)).toMatchObject({ ok: true, session, cost: 0.25, costComplete: true, model: "fake-opus" });
      }
      expect(readFileSync(join(repo, "value.txt"), "utf8")).toBe("changed\n");
    } else expect(existsSync(join(fixture.bin, "claude"))).toBe(false);
    fixture.env.ORCH_E2E_LIVE = "1";
    expect(fakeClaude(fixture).live).toBe(true);
    expect(existsSync(join(fixture.bin, "claude"))).toBe(false);
    fixture.env.ORCH_E2E_LIVE = live ? "1" : "0";
    // Restore a fake immediately: the smoke never launches the real executable.
    if (!live) fakeClaude(fixture);

    fakeCodex(fixture, { files: { "codex.txt": "ok\n" }, result: "LANE: done" });
    const codex = await runCommand(fixture, ["codex", "exec", "--json", "--model", "fake-codex", "-c", 'model_reasoning_effort="low"',
      "-s", "workspace-write", "-C", repo, "-o", join(fixture.root, "last-message"), "-"], { stdin: "write codex" });
    expect(codex.status).toBe(0);
    expect(readFileSync(join(repo, "codex.txt"), "utf8")).toBe("ok\n");
    expect(readFileSync(join(fixture.root, "last-message"), "utf8")).toBe("LANE: done");

    const directory = await runOrch(fixture, ["dir"], { cwd: repo });
    expect(directory.status).toBe(0);
    expect(directory.stdout.trim()).toBe(join(fixture.env.ORCH_HOME, ".orch", "repo"));
    expect((await runLane(fixture, ["status"], { cwd: repo })).status).toBe(0);
    const timeout = await runCommand(fixture, [process.execPath, "--no-env-file", "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
    expect(timeout).toMatchObject({ status: 124, timedOut: true });

    const bank = "/v1/default/banks/e2e";
    expect(await (await fetch(memory.url + "/health")).json()).toEqual({ status: "ok" });
    expect((await fetch(memory.url + bank, { method: "PUT", body: "{}" })).status).toBe(200);
    expect(await (await fetch(memory.url + bank + "/memories/recall", { method: "POST", body: '{"query":"test"}' })).json()).toEqual({ results: [] });
    expect(await (await fetch(memory.url + bank + "/stats")).json()).toEqual({ total_nodes: 0, total_documents: 0, pending_operations: 0 });
    expect((await fetch(memory.url + bank + "/memories", { method: "POST", body: '{"items":[]}' })).status).toBe(403);
    expect(await (await fetch(retaining.url + bank + "/memories", { method: "POST", body: '{"items":[{"content":"fixture"}]}' })).json()).toEqual({ items_count: 1 });
    expect((await fetch(memory.url + bank, { method: "DELETE" })).status).toBe(200);
    expect(memory.requests).toHaveLength(6);
    expect(memory.requests[2].body).toEqual({ query: "test" });

    const sealed = join(fixture.root, "sealed"), artifact = join(sealed, "receipt.json");
    mkdirSync(sealed); writeFileSync(artifact, "{}");
    chmodSync(artifact, 0o444); chmodSync(sealed, 0o555);
    symlinkSync(import.meta.dir, join(fixture.root, "outside"));
  } finally {
    await memory.cleanup(); await retaining.cleanup(); fixture.cleanup();
  }
  expect(existsSync(fixture.root)).toBe(false);
  fixture.cleanup();
}, 30_000);
