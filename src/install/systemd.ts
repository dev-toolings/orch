// The systemd user units orch installs. Files go through the manifest like
// every other target; this adds what files alone cannot do: enable them on
// `orch install --enable`, and stop and disable them before `orch uninstall`
// (or before an install that retires one) removes their files, so no
// running service, timer or dangling .wants link outlives its unit file.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export const UNIT_DIR = ".config/systemd/user/";

export interface Unit { name: string; installable: boolean }

// Units among installed files. Only a unit with an [Install] section can be
// enabled (a timer, the presence service); a service a timer starts has none
// and is only ever started or stopped. Content is the file body; a unit
// whose file is gone counts as installable, so disabling it is still tried.
export function unitsOf(files: { path: string; content: string | null }[]): Unit[] {
  return files.filter((f) => f.path.startsWith(UNIT_DIR)).map((f) => ({ name: basename(f.path), installable: f.content === null || /^\[Install\]/m.test(f.content) }));
}

// Units `orch install --enable` never enables: orch-serve.service starts an
// unattended engine at every boot, which only the operator decides
// (`systemctl --user enable`); orch-kiba.service is the retired presence
// lead, kept here so a leftover enabled copy is reported. They are still
// stopped and disabled on uninstall like any other.
export const OPT_IN_UNITS = ["orch-kiba.service", "orch-serve.service"];

const templates = (units: Unit[]) => units.filter((u) => u.name.includes("@."));
const installable = (units: Unit[]) => units.filter((u) => u.installable && !u.name.includes("@.")).map((u) => u.name);
export const enableable = (units: Unit[]) => installable(units).filter((name) => !OPT_IN_UNITS.includes(name));
const startedOnly = (units: Unit[]) => units.filter((u) => !u.installable && !u.name.includes("@.")).map((u) => u.name);

export function enableCommands(units: Unit[]): string[][] {
  const on = enableable(units);
  return [["systemctl", "--user", "daemon-reload"], ...(on.length ? [["systemctl", "--user", "enable", "--now", ...on]] : [])];
}

// Timers first (no new start), then what they or a template started.
export function disableCommands(units: Unit[]): string[][] {
  const on = installable(units);
  const started = startedOnly(units);
  return [
    ...(on.length ? [["systemctl", "--user", "disable", "--now", ...on]] : []),
    ...(started.length ? [["systemctl", "--user", "stop", ...started]] : []),
    ...templates(units).map((t) => ["systemctl", "--user", "stop", t.name.replace("@.", "@*.")]),
  ];
}

export const reloadCommand = ["systemctl", "--user", "daemon-reload"];

export type Runner = (argv: string[]) => { ok: boolean; err: string };

export const runSystemctl: Runner = (argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return { ok: r.status === 0, err: (r.stderr || r.error?.message || "").trim() };
};

// Runs each command, reporting rather than stopping: on uninstall the files
// must go even when a unit was never loaded. Returns whether all succeeded.
export function runAll(cmds: string[][], dry: boolean, log: (line: string) => void, run: Runner = runSystemctl): boolean {
  let ok = true;
  for (const c of cmds) {
    if (dry) { log(`would run  ${c.join(" ")}`); continue; }
    const r = run(c);
    log(`${r.ok ? "ran " : "FAILED"}  ${c.join(" ")}${r.ok ? "" : `: ${r.err.split("\n")[0]}`}`);
    ok &&= r.ok;
  }
  return ok;
}

// What install says about the opt-in units: never enabled by orch, and a
// warning when one is enabled anyway (it starts a lead at boot).
// orch-kiba.service is the retired presence lead: only a leftover enabled
// copy is reported.
export function optInNotes(units: Unit[], isEnabled: (name: string) => boolean = unitEnabled): string[] {
  return units.filter((u) => OPT_IN_UNITS.includes(u.name)).flatMap((u) => {
    if (u.name === "orch-kiba.service") return isEnabled(u.name) ? [`WARN ${u.name} is enabled: the presence lead is retired, orch serve replaced it (systemctl --user disable --now ${u.name})`] : [];
    return [isEnabled(u.name)
      ? `WARN ${u.name} is enabled: it starts orch serve at every boot (systemctl --user disable ${u.name} keeps it off)`
      : `${u.name} not enabled (opt-in: systemctl --user enable ${u.name})`];
  });
}

export function unitEnabled(name: string): boolean {
  const r = spawnSync("systemctl", ["--user", "is-enabled", name], { encoding: "utf8" });
  return (r.stdout ?? "").trim() === "enabled";
}
