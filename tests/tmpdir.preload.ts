// Suite-wide temp root: the run gets its own TMPDIR, removed after the last
// test. Whatever a test creates through os.tmpdir() (mkdtemp) goes with it,
// so a test that forgets its cleanup leaves nothing in /tmp, and the child
// processes it starts inherit the same root.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runRoot = mkdtempSync(join(tmpdir(), "orch-test-run-"));
process.env.TMPDIR = runRoot;
// The operator's hook policy (~/.orch/policy/hooks.yaml) never shapes a test:
// every test sees the defaults unless it points ORCH_HOOK_POLICY elsewhere.
process.env.ORCH_HOOK_POLICY = join(runRoot, "no-hook-policy.yaml");
// A preload's afterAll runs once, after every test file of the run.
afterAll(() => { rmSync(runRoot, { recursive: true, force: true }); });
