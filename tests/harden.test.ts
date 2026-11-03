import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../src/core/profile.ts";

// infra/host/harden.sh against fake ip, ss, sshd, systemctl, ufw and getent
// on PATH and a temp root for /etc: nothing touches the host.
const SCRIPT = join(ROOT, "infra", "host", "harden.sh");
let base: string;
beforeAll(() => { base = mkdtempSync(join(tmpdir(), "orch-harden-")); });
afterAll(() => rmSync(base, { recursive: true, force: true }));

const FAKES: Record<string, string> = {
  ip: `case "$*" in *route*) echo "default via 192.168.1.254 dev enp34s0 proto dhcp src 192.168.1.2 metric 100";; *addr*) echo "2: enp34s0    inet 192.168.1.2/24 brd 192.168.1.255 scope global enp34s0";; esac`,
  ss: `case "$*" in *established*) for p in $FAKE_PEERS; do echo "0 0 192.168.1.2:22 $p"; done;; *) echo "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*"; echo "LISTEN 0 4096 127.0.0.1:5433 0.0.0.0:*"; echo "LISTEN 0 4096 0.0.0.0:8100 0.0.0.0:*";; esac`,
  sshd: `echo "sshd $*" >> "$LOG"
d="$HARDEN_ROOT/etc/ssh/sshd_config.d/10-orch-hardening.conf"
if [ "$2" = "-f" ]; then d="$(sed -nE 's#^Include (.*)/\\*\\.conf$#\\1#p' "$3")/10-orch-hardening.conf"; fi
case "$1" in
  -t) exit "\${FAKE_SSHD_T:-0}";;
  -T) if [ -f "$d" ] && [ -z "$FAKE_OTHER_WINS" ]; then v=no; else v=yes; fi
      echo "passwordauthentication $v"; echo "kbdinteractiveauthentication $v"; echo "permitrootlogin $v"; echo "port 22";;
esac`,
  systemctl: `echo "systemctl $*" >> "$LOG"`,
  ufw: `echo "ufw $*" >> "$LOG"; case "$1" in status) echo "Status: inactive";; esac`,
  getent: `echo "kev:x:1000:1000::/home/kev:/bin/bash"`,
};

function setup(opts: { keys?: boolean; dropin?: string; include?: boolean } = {}) {
  const dir = mkdtempSync(join(base, "case-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const root = join(dir, "root");
  mkdirSync(join(root, "etc", "ssh", "sshd_config.d"), { recursive: true });
  mkdirSync(join(root, "home", "kev", ".ssh"), { recursive: true });
  writeFileSync(join(root, "etc", "ssh", "sshd_config"), opts.include === false ? "Port 22\n" : "Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n");
  mkdirSync(join(root, "etc", "ufw"), { recursive: true });
  writeFileSync(join(root, "etc", "ufw", "ufw.conf"), "ENABLED=no\n");
  if (opts.keys !== false) writeFileSync(join(root, "home", "kev", ".ssh", "authorized_keys"), "ssh-ed25519 AAAAC3Nza kev@mac\n");
  if (opts.dropin) writeFileSync(join(root, "etc", "ssh", "sshd_config.d", "10-orch-hardening.conf"), opts.dropin);
  const log = join(dir, "log");
  writeFileSync(log, "");
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HARDEN_ROOT: root, HARDEN_EUID: "0", SUDO_USER: "kev", LOG: log, FAKE_PEERS: "192.168.1.56:51234", ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, log: readFileSync(log, "utf8") };
  };
  const dropin = join(root, "etc", "ssh", "sshd_config.d", "10-orch-hardening.conf");
  return { run, dropin, dir: join(root, "etc", "ssh", "sshd_config.d") };
}

const WANT = "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n";

describe("harden.sh", () => {
  test("is valid bash and documents itself", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    expect(spawnSync("bash", [SCRIPT, "--help"], { encoding: "utf8" }).stdout).toContain("sudo infra/host/harden.sh apply");
  });

  test("check writes nothing, finds the LAN and flags sessions from outside it", () => {
    const h = setup();
    const r = h.run(["check"], { HARDEN_EUID: "1000", FAKE_PEERS: "192.168.1.56:51234 [::ffff:203.0.113.9]:4000" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("SSH from 192.168.1.0/24");
    expect(r.out).toContain("192.168.1.56 (LAN)");
    expect(r.out).toContain("203.0.113.9 OUTSIDE 192.168.1.0/24");
    expect(r.out).toContain("0.0.0.0:8100");
    expect(r.out).not.toContain("127.0.0.1:5433");
    expect(existsSync(h.dropin)).toBe(false);
    expect(r.log).toBe("");
  });

  test("apply refuses without root, without sudo user, and without an SSH key, touching nothing", () => {
    expect(setup().run(["apply"], { HARDEN_EUID: "1000" }).out).toContain("apply needs root");
    expect(setup().run(["apply"], { SUDO_USER: "" }).out).toContain("run through sudo from your own account");
    const h = setup({ keys: false });
    const r = h.run(["apply"]);
    expect([r.status, r.out.includes("no SSH key in")]).toEqual([1, true]);
    expect(existsSync(h.dropin)).toBe(false);
    expect(r.log).toBe("");
  });

  test("apply refuses when a session comes from outside the LAN, unless --force or --lan covers it", () => {
    const h = setup();
    const r = h.run(["apply"], { FAKE_PEERS: "10.8.0.5:40000" });
    expect([r.status, r.out.includes("outside 192.168.1.0/24")]).toEqual([1, true]);
    expect(r.log).toBe("");
    expect(h.run(["apply", "--lan", "10.8.0.0/24"], { FAKE_PEERS: "10.8.0.5:40000" }).status).toBe(0);
    expect(setup().run(["apply", "--force"], { FAKE_PEERS: "10.8.0.5:40000" }).status).toBe(0);
  });

  test("apply: drop-in written and validated before the restart, then ufw with SSH allowed before enable", () => {
    const h = setup();
    const r = h.run(["apply"]);
    expect(r.status).toBe(0);
    expect(readFileSync(h.dropin, "utf8")).toBe(WANT);
    const calls = r.log.trim().split("\n");
    expect(calls.indexOf("sshd -t")).toBeLessThan(calls.indexOf("systemctl restart ssh"));
    const ssh = calls.indexOf("ufw allow from 192.168.1.0/24 to any port 22 proto tcp comment orch: ssh LAN");
    expect(ssh).toBeGreaterThan(-1);
    expect(calls.at(-1)).toBe("ufw --force enable");
    expect(calls.filter((c) => c.includes("orch: docker networks")).length).toBe(5);
    // a second run changes nothing and leaves no backup
    expect(h.run(["apply"]).status).toBe(0);
    expect(readdirSync(h.dir)).toEqual(["10-orch-hardening.conf"]);
  });

  test("a config sshd rejects is reverted (previous drop-in restored) and nothing is restarted", () => {
    const fresh = setup();
    const r = fresh.run(["apply"], { FAKE_SSHD_T: "1" });
    expect([r.status, r.out.includes("drop-in reverted")]).toEqual([1, true]);
    expect(existsSync(fresh.dropin)).toBe(false);
    expect(r.log).not.toContain("systemctl");
    expect(r.log).not.toContain("ufw");
    const old = setup({ dropin: "PermitRootLogin prohibit-password\n" });
    old.run(["apply"], { FAKE_SSHD_T: "1" });
    expect(readFileSync(old.dropin, "utf8")).toBe("PermitRootLogin prohibit-password\n");
    expect(readdirSync(old.dir)).toEqual(["10-orch-hardening.conf"]);
  });

  test("when another file still wins in sshd, apply stops before the firewall", () => {
    const r = setup().run(["apply"], { FAKE_OTHER_WINS: "1" });
    expect([r.status, r.out.includes("another file wins")]).toEqual([1, true]);
    expect(r.log).not.toContain("ufw");
  });

  test("apply --dry-run runs every check and the real sshd and ufw dry runs, changing nothing", () => {
    const h = setup();
    const r = h.run(["apply", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("would be: passwordauthentication no");
    expect(r.out).toContain("dry run: nothing changed");
    expect(existsSync(h.dropin)).toBe(false);
    const calls = r.log.trim().split("\n");
    expect(calls.filter((c) => c.startsWith("sshd -t -f ") || c.startsWith("sshd -T -f ")).length).toBe(2);
    expect(r.log).not.toContain("systemctl");
    expect(calls.filter((c) => c.startsWith("ufw ")).every((c) => c.startsWith("ufw --dry-run "))).toBe(true);
    expect(r.log).not.toContain("enable");
  });

  test("dry run fails where apply would: no key, outside session, ignored drop-in, rejected config", () => {
    expect(setup({ keys: false }).run(["apply", "--dry-run"]).out).toContain("no SSH key");
    expect(setup().run(["apply", "--dry-run"], { FAKE_PEERS: "10.8.0.5:40000" }).out).toContain("outside 192.168.1.0/24");
    expect(setup({ include: false }).run(["apply", "--dry-run"]).out).toContain("the drop-in would be ignored");
    expect(setup().run(["apply", "--dry-run"], { FAKE_SSHD_T: "1" }).out).toContain("sshd -t rejects");
    const other = setup().run(["apply", "--dry-run"], { FAKE_OTHER_WINS: "1" });
    expect([other.status, other.out.includes("another sshd file would still win")]).toEqual([1, true]);
  });

  test("rollback removes the drop-in, restarts sshd and disables ufw", () => {
    const h = setup({ dropin: WANT });
    const r = h.run(["rollback"]);
    expect(r.status).toBe(0);
    expect(existsSync(h.dropin)).toBe(false);
    expect(r.log).toContain("systemctl restart ssh");
    expect(r.log).toContain("ufw --force disable");
  });
});
