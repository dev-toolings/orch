// Lead-written spec file: KEY: value blocks, a key starts at column 0.
export interface Spec {
  raw: string;
  fields: Record<string, string>;
  verify?: string;
  reasoning?: string;
}

export const REQUIRED = ["OBJECTIVE", "FILES", "INTERFACES", "CONSTRAINTS", "VERIFY", "ACCEPT"];
export const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function parseSpec(raw: string): Spec {
  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of raw.split("\n")) {
    const m = /^([A-Z]+):\s?(.*)$/.exec(line);
    if (m) {
      key = m[1];
      fields[key] = m[2];
    } else if (key) {
      fields[key] += `\n${line}`;
    }
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].trim();
  const reasoning = fields.REASONING?.split(/\s/)[0];
  if (reasoning && !EFFORTS.has(reasoning)) throw new Error(`REASONING: unknown effort ${reasoning}`);
  return { raw, fields, verify: fields.VERIFY || undefined, reasoning };
}

export function missingFields(spec: Spec): string[] {
  return REQUIRED.filter((k) => !spec.fields[k]);
}
