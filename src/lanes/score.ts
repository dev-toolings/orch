// Cross-review findings: frequency (1-10) × severity (1-10). Product >= 5
// is fixed; below 5 is a backlog note only.
export interface ScoredFinding {
  text: string;
  frequency: number;
  severity: number;
  product: number;
  action: "fix" | "backlog";
}

const FINDING = /FINDING:\s*(.+?)\s*\|\s*FREQ:\s*(\d+)\s*\|\s*SEV:\s*(\d+)/gi;
const ALT = /(?:^|\n)\s*(?:[-*]|\d+\.)\s*(.+?)\s*[—-]\s*(?:freq(?:uency)?|f)\s*[:=]\s*(\d+)\s*(?:sev(?:erity)?|s)\s*[:=]\s*(\d+)/gi;

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, Math.round(n)));
}

export function scoreFindings(text: string): ScoredFinding[] {
  const out: ScoredFinding[] = [];
  const seen = new Set<string>();
  const push = (raw: string, freq: string, sev: string) => {
    const frequency = clamp(Number(freq));
    const severity = clamp(Number(sev));
    const product = frequency * severity;
    const item: ScoredFinding = {
      text: raw.trim().replace(/\s+/g, " ").slice(0, 240),
      frequency,
      severity,
      product,
      action: product >= 5 ? "fix" : "backlog",
    };
    const key = `${item.text}|${item.frequency}|${item.severity}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const re of [FINDING, ALT]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) push(m[1], m[2], m[3]);
  }
  return out;
}

export function formatFindings(findings: ScoredFinding[]): string {
  if (!findings.length) return "FINDINGS: none scored";
  const fix = findings.filter((f) => f.action === "fix");
  const backlog = findings.filter((f) => f.action === "backlog");
  return [
    `FINDINGS: ${findings.length} (${fix.length} fix, ${backlog.length} backlog)`,
    ...findings.map((f) => `${f.action.toUpperCase()}  ${f.frequency}x${f.severity}=${f.product}  ${f.text}`),
  ].join("\n");
}
