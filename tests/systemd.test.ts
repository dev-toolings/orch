import { describe, expect, test } from "bun:test";
import { disableCommands, enableCommands, optInNotes, runAll, unitsOf } from "../src/install/systemd.ts";

const T = "[Unit]\n[Timer]\nOnCalendar=*:0/15\n[Install]\nWantedBy=timers.target\n";
const S_INSTALL = "[Unit]\n[Service]\nType=oneshot\nRemainAfterExit=yes\n[Install]\nWantedBy=default.target\n";
const S_PLAIN = "[Unit]\n[Service]\nType=oneshot\n";
const units = unitsOf([
  { path: ".claude/agents/kiba.md", content: "x" },
  { path: ".config/systemd/user/orch-kiba.service", content: S_INSTALL },
  { path: ".config/systemd/user/orch-routines.service", content: S_PLAIN },
  { path: ".config/systemd/user/orch-routines.timer", content: T },
  { path: ".config/systemd/user/orch-routine@.service", content: S_PLAIN },
]);

describe("systemd units", () => {
  test("only units with an [Install] section are enabled; a timer's service and templates are only stopped", () => {
    expect(units.map((u) => [u.name, u.installable])).toEqual([["orch-kiba.service", true], ["orch-routines.service", false], ["orch-routines.timer", true], ["orch-routine@.service", false]]);
    expect(enableCommands(units)).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "orch-routines.timer"]]);
    expect(disableCommands(units)).toEqual([
      ["systemctl", "--user", "disable", "--now", "orch-kiba.service", "orch-routines.timer"],
      ["systemctl", "--user", "stop", "orch-routines.service"],
      ["systemctl", "--user", "stop", "orch-routine@*.service"],
    ]);
    expect(disableCommands([])).toEqual([]);
  });

  test("install never enables an opt-in unit; a leftover enabled presence unit is reported as retired", () => {
    const optIn = unitsOf([{ path: ".config/systemd/user/orch-kiba.service", content: "x" }, { path: ".config/systemd/user/orch-serve.service", content: "x" }]);
    for (const cmd of enableCommands(optIn)) expect(cmd.join(" ")).not.toMatch(/orch-(kiba|serve)\.service/);
    expect(optInNotes(optIn, () => false)).toEqual([expect.stringContaining("orch-serve.service not enabled (opt-in: systemctl --user enable orch-serve.service)")]);
    expect(optInNotes(optIn, () => true)).toEqual([
      expect.stringContaining("WARN orch-kiba.service is enabled: the presence lead is retired"),
      expect.stringContaining("WARN orch-serve.service is enabled"),
    ]);
  });

  test("a unit whose file is already gone is still disabled", () => {
    expect(disableCommands(unitsOf([{ path: ".config/systemd/user/old.timer", content: null }]))).toEqual([["systemctl", "--user", "disable", "--now", "old.timer"]]);
  });

  test("every command runs even after a failure, which is reported; dry run runs nothing", () => {
    const ran: string[] = [];
    const log: string[] = [];
    const ok = runAll([["a"], ["b"]], false, (l) => log.push(l), (argv) => { ran.push(argv[0]); return argv[0] === "a" ? { ok: false, err: "Unit not loaded.\nmore" } : { ok: true, err: "" }; });
    expect([ok, ran]).toEqual([false, ["a", "b"]]);
    expect(log).toEqual(["FAILED  a: Unit not loaded.", "ran   b"]);
    const dry: string[] = [];
    expect(runAll([["a"]], true, (l) => dry.push(l), () => { throw new Error("must not run"); })).toBe(true);
    expect(dry).toEqual(["would run  a"]);
  });
});
