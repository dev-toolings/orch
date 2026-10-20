// scripts/claude-sandbox-apparmor.sh against a fake AppArmor: a temp
// APPARMOR_DIR, a fake loaded-profiles list, and stubs for sudo (runs the
// command unprivileged and logs it), sysctl, apparmor_parser and bwrap,
// driven by STUB_* variables. No root, no real policy is touched.
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "claude-sandbox-apparmor.sh");
const MARK = "# Installed by orch scripts/claude-sandbox-apparmor.sh";

let root: string;
let dir: string;
let loadedList: string;
let log: string;

function stub(bin: string, name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apparmor-test-"));
  dir = join(root, "apparmor.d");
  mkdirSync(join(dir, "disable"), { recursive: true });
  writeFileSync(join(dir, "bwrap-userns-restrict"), "profile bwrap /usr/bin/bwrap {}\nprofile unpriv_bwrap {}\n");
  loadedList = join(root, "profiles");
  writeFileSync(loadedList, "bwrap (enforce)\nunpriv_bwrap (enforce)\n");
  log = join(root, "log");
  writeFileSync(log, "");
  const bin = join(root, "bin");
  mkdirSync(bin);
  stub(bin, "sudo", `echo "sudo $*" >> "$STUB_LOG"; [ "$1" = -n ] && shift; exec "$@"`);
  stub(bin, "sysctl", `echo "\${STUB_RESTRICT:-1}"`);
  // -Q -K parses, -r loads, -R unloads; the fake list tracks what is loaded.
  stub(bin, "apparmor_parser", `
echo "apparmor_parser $*" >> "$STUB_LOG"
case "$1" in
  -Q) [ "\${STUB_PARSE_FAIL:-0}" = 1 ] && exit 1; exit 0 ;;
  -r) case "$2" in
        */bwrap) [ "\${STUB_LOAD_FAIL:-0}" = 1 ] && exit 1
                 grep -v '^bwrap ' "$APPARMOR_PROFILES" > "$APPARMOR_PROFILES.n"; echo "bwrap (unconfined)" >> "$APPARMOR_PROFILES.n" ;;
        *) grep -v 'bwrap ' "$APPARMOR_PROFILES" > "$APPARMOR_PROFILES.n"; printf 'bwrap (enforce)\\nunpriv_bwrap (enforce)\\n' >> "$APPARMOR_PROFILES.n" ;;
      esac
      mv "$APPARMOR_PROFILES.n" "$APPARMOR_PROFILES" ;;
  -R) grep -v 'bwrap ' "$APPARMOR_PROFILES" > "$APPARMOR_PROFILES.n" || true; mv "$APPARMOR_PROFILES.n" "$APPARMOR_PROFILES" ;;
esac`);
  // The nested probe passes only once the replacement profile is loaded, unless STUB_NESTED forces it.
  stub(bin, "bwrap", `
case "$*" in
  *unshare*) [ -n "\${STUB_NESTED:-}" ] && exit "$STUB_NESTED"; grep -q '^bwrap (unconfined)' "$APPARMOR_PROFILES" ;;
  *) exit 0 ;;
esac`);
  process.env.STUB_PATH = `${bin}:/usr/bin:/bin`;
});

function run(arg: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, arg], {
    encoding: "utf8",
    env: { PATH: process.env.STUB_PATH!, HOME: root, APPARMOR_DIR: dir, APPARMOR_PROFILES: loadedList, STUB_LOG: log, ...env },
  });
}

const profile = () => join(dir, "bwrap");
const disabled = () => join(dir, "disable", "bwrap-userns-restrict");
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

describe("claude-sandbox-apparmor.sh", () => {
  test("install: Ubuntu profile disabled, replacement loaded world-readable, probes pass", () => {
    const r = run("--install");
    expect(r.status).toBe(0);
    expect(readFileSync(profile(), "utf8").split("\n")[0]).toBe(MARK);
    expect(lstatSync(profile()).mode & 0o777).toBe(0o644);
    expect(isLink(disabled())).toBe(true);
    expect(readFileSync(loadedList, "utf8")).toBe("bwrap (unconfined)\n");
    expect(r.stdout).toContain("ok   a user namespace can nest inside bwrap");
  });

  test("a replacement that does not parse changes nothing", () => {
    const r = run("--install", { STUB_PARSE_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not parse; nothing changed");
    expect(existsSync(profile())).toBe(false);
    expect(isLink(disabled())).toBe(false);
    expect(readFileSync(loadedList, "utf8")).toContain("unpriv_bwrap (enforce)");
  });

  test("a load failure rolls back to the Ubuntu profile", () => {
    const r = run("--install", { STUB_LOAD_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not load");
    expect(existsSync(profile())).toBe(false);
    expect(isLink(disabled())).toBe(false);
    expect(readFileSync(loadedList, "utf8")).toContain("unpriv_bwrap (enforce)");
  });

  test("a probe still failing after the swap rolls back too", () => {
    const r = run("--install", { STUB_NESTED: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("probe still fails");
    expect(existsSync(profile())).toBe(false);
    expect(isLink(disabled())).toBe(false);
    expect(readFileSync(loadedList, "utf8")).toContain("unpriv_bwrap (enforce)");
  });

  test("uninstall restores the Ubuntu profile", () => {
    expect(run("--install").status).toBe(0);
    const r = run("--uninstall");
    expect(r.status).toBe(0);
    expect(existsSync(profile())).toBe(false);
    expect(isLink(disabled())).toBe(false);
    expect(readFileSync(loadedList, "utf8")).toContain("unpriv_bwrap (enforce)");
  });

  test("never overwrites a bwrap profile it did not write", () => {
    writeFileSync(profile(), "profile bwrap /usr/bin/bwrap { # someone else's }\n");
    const r = run("--install");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not written by this script");
    expect(readFileSync(profile(), "utf8")).toContain("someone else's");
    expect(run("--uninstall").stdout).toContain("kept");
    expect(existsSync(profile())).toBe(true);
  });

  test("status never asks for a password on a root-only profile", () => {
    expect(run("--install").status).toBe(0);
    chmodSync(profile(), 0o000);
    writeFileSync(log, "");
    const r = run("--status");
    chmodSync(profile(), 0o644);
    expect(readFileSync(log, "utf8")).toContain("sudo -n head");
    expect(readFileSync(log, "utf8")).not.toMatch(/^sudo head/m);
    expect(r.stdout).toContain("root-only");
  });

  test("an unrestricted kernel needs no change", () => {
    // Without the restriction, nesting works with the stock profile.
    const r = run("--install", { STUB_RESTRICT: "0", STUB_NESTED: "0" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to change");
    expect(existsSync(profile())).toBe(false);
    expect(readFileSync(log, "utf8")).not.toContain("apparmor_parser");
  });
});
