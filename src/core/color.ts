// ANSI colours for status words, only on a terminal: output captured by
// systemd, a routine journal, a notification or a pipe stays plain text.
// NO_COLOR (https://no-color.org) turns them off, FORCE_COLOR on.
export function useColor(env: NodeJS.ProcessEnv = process.env, tty = process.stdout.isTTY === true): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return tty && env.TERM !== "dumb";
}

const CODES = { green: 32, red: 31, yellow: 33, dim: 2, bold: 1 } as const;
export type Tint = keyof typeof CODES;

export const paint = (text: string, tint: Tint, on: boolean) => (on ? `\x1b[${CODES[tint]}m${text}\x1b[0m` : text);

// The four-column status words used across orch output.
export function status(ok: boolean | null, on: boolean): string {
  return ok === true ? paint("ok  ", "green", on) : ok === false ? paint("FAIL", "red", on) : paint("?   ", "yellow", on);
}
