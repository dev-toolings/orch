// lane route: pick who does a spec (the lead itself, or which lane harness),
// and whether its integration needs a review, from the spec's own features and
// the lane ledger. Deterministic, no model call: the same inputs give the same
// route, and every choice carries its reason.
import type { HarnessId } from "../harness/registry.ts";
import { type LedgerRow, verdicts } from "./ledger.ts";
import type { Spec } from "./spec.ts";

export type Risk = "migration" | "security" | "public-api";
export const RISKS: Risk[] = ["migration", "security", "public-api"];

export interface SpecFeatures {
  files: string[];
  stacks: string[];
  risk: Risk[];
  objective: string;
}

export interface RouteConfig {
  // Harnesses tried in this order when the ledger has no verdict yet.
  order: HarnessId[];
  // A spec touching this many files or fewer is cheaper inline: a worker
  // costs about 10k tokens of fixed prefix before doing anything.
  self_max_files: number;
  // Closed runs a harness needs on a stack before its record outranks the order.
  min_samples: number;
}

export const DEFAULT_ROUTE: RouteConfig = { order: ["codex", "claude", "grok"], self_max_files: 2, min_samples: 5 };

const STACKS: [RegExp, string][] = [
  [/\.(ts|tsx|mts|cts)$/, "typescript"], [/\.(js|jsx|mjs|cjs)$/, "javascript"], [/\.py$/, "python"],
  [/\.php$/, "php"], [/\.go$/, "go"], [/\.rs$/, "rust"], [/\.sql$/, "sql"], [/\.(sh|bash|zsh)$/, "shell"],
  [/\.(vue|svelte|astro)$/, "frontend"], [/\.(css|scss)$/, "css"], [/\.(ya?ml|toml|json)$/, "config"],
  [/(^|\/)(Dockerfile|docker-compose[^/]*|compose[^/]*\.ya?ml)$/, "docker"], [/\.mdx?$/, "docs"],
  [/(^|\/)Makefile$/, "make"],
];

// Path patterns that raise risk on their own; the spec's RISK field adds to them.
const RISK_PATHS: [RegExp, Risk][] = [
  [/(^|\/)migrations?\/|\.sql$/i, "migration"],
  [/(^|\/)[^/]*(auth|security|crypto|secret|password|permission|acl|oauth|jwt|session|sandbox)[^/]*/i, "security"],
  [/(^|\/)[^/]*(openapi|swagger)[^/]*|\.proto$|(^|\/)public\//i, "public-api"],
];

// FILES is free text: one path per line or comma-separated, bullets and
// trailing notes allowed. A token is a path when it has a slash or an extension.
export function declaredFiles(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const token of raw.split(/[\n,]/)) {
    const t = token.replace(/^\s*[-*]\s*/, "").replace(/`/g, "").trim().split(/\s+/)[0] ?? "";
    const path = t.replace(/^\.\//, "").replace(/[:;]$/, "");
    if (path && (path.includes("/") || /\.[A-Za-z0-9]+$/.test(path) || /^(Makefile|Dockerfile)$/.test(path))) out.add(path);
  }
  return [...out];
}

export function specFeatures(spec: Spec): SpecFeatures {
  const files = declaredFiles(spec.fields.FILES);
  const stacks = [...new Set(files.flatMap((f) => STACKS.filter(([re]) => re.test(f)).map(([, s]) => s)))].sort();
  const risk = new Set<Risk>();
  for (const f of files) for (const [re, r] of RISK_PATHS) if (re.test(f)) risk.add(r);
  for (const word of (spec.fields.RISK ?? "").toLowerCase().split(/[\s,]+/)) {
    if ((RISKS as string[]).includes(word)) risk.add(word as Risk);
  }
  return { files, stacks, risk: RISKS.filter((r) => risk.has(r)), objective: (spec.fields.OBJECTIVE ?? "").split("\n")[0].slice(0, 120) };
}

// A declared entry ending in `/` covers its directory; `*` matches inside one
// path segment, `**` across segments. Anything else must match exactly.
export function inScope(file: string, declared: string[]): boolean {
  return declared.some((d) => {
    if (d.endsWith("/")) return file.startsWith(d);
    if (!d.includes("*")) return file === d;
    const re = d.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
    return new RegExp(`^${re}$`).test(file);
  });
}

export interface HarnessStats { to: HarnessId; n: number; ok: number; score: number; scope: "stack" | "all" }

// Laplace-smoothed success rate: 0 runs reads 0.5, never 0 or 1.
export function harnessStats(rows: LedgerRow[], to: HarnessId, stacks: string[]): HarnessStats {
  const mine = verdicts(rows).filter((v) => v.run.to === to);
  const onStack = mine.filter((v) => v.run.features?.stacks?.some((s) => stacks.includes(s)));
  const scope = stacks.length && onStack.length ? "stack" : "all";
  const pool = scope === "stack" ? onStack : mine;
  const ok = pool.filter((v) => v.ok).length;
  return { to, n: pool.length, ok, score: (ok + 1) / (pool.length + 2), scope };
}

export interface Route {
  action: "self" | "lane";
  to?: HarnessId;
  review: "none" | "high";
  reasons: string[];
  stats: HarnessStats[];
}

export function routeSpec(features: SpecFeatures, rows: LedgerRow[], opts: { installed: HarnessId[]; config?: Partial<RouteConfig>; to?: HarnessId }): Route {
  const cfg = { ...DEFAULT_ROUTE, ...opts.config };
  const review = features.risk.length ? "high" : "none";
  const reasons: string[] = [];
  if (review === "high") reasons.push(`risk ${features.risk.join(", ")}: integration needs lane review --risk high first`);
  const eligible = cfg.order.filter((h) => opts.installed.includes(h));
  const stats = eligible.map((h) => harnessStats(rows, h, features.stacks));
  if (opts.to) {
    if (!opts.installed.includes(opts.to)) return { action: "lane", to: undefined, review, reasons: [`${opts.to} is not installed`, ...reasons], stats };
    return { action: "lane", to: opts.to, review, reasons: [`--to ${opts.to} (explicit)`, ...reasons], stats };
  }
  if (features.files.length <= cfg.self_max_files) {
    return { action: "self", review, reasons: [`${features.files.length} declared file(s) <= ${cfg.self_max_files}: do it yourself, a worker costs ~10k tokens of prefix`, ...reasons], stats };
  }
  if (!eligible.length) return { action: "lane", to: undefined, review, reasons: ["no lane harness installed", ...reasons], stats };
  const measured = stats.filter((s) => s.n >= cfg.min_samples).sort((a, b) => b.score - a.score);
  const best = measured[0];
  if (best && best.score >= 0.5) {
    reasons.unshift(`${best.to}: ${best.ok}/${best.n} integrated on ${best.scope === "stack" ? features.stacks.join(", ") : "all stacks"} (score ${best.score.toFixed(2)})`);
    return { action: "lane", to: best.to, review, reasons, stats };
  }
  // No harness has a good enough record yet: keep the configured order, but
  // skip one whose record is measured and bad.
  const bad = new Set(measured.filter((s) => s.score < 0.5).map((s) => s.to));
  const pick = eligible.find((h) => !bad.has(h)) ?? eligible[0];
  reasons.unshift(measured.length
    ? `${pick}: first in order without a bad record (${measured.map((s) => `${s.to} ${s.ok}/${s.n}`).join(", ")})`
    : `${pick}: first installed in order, no harness has ${cfg.min_samples} closed runs yet`);
  return { action: "lane", to: pick, review, reasons, stats };
}

export function routeReport(r: Route, features: SpecFeatures): string {
  return [
    "LANE ROUTE",
    `ACTION: ${r.action}${r.to ? ` --to ${r.to}` : ""}`,
    `REVIEW: ${r.review}`,
    `FILES: ${features.files.length} (${features.stacks.join(", ") || "no stack"})${features.risk.length ? `; risk ${features.risk.join(", ")}` : ""}`,
    ...r.reasons.map((x) => `WHY: ${x}`),
    r.stats.length ? `RECORD: ${r.stats.map((s) => `${s.to} ${s.ok}/${s.n}`).join(", ")}` : "",
  ].filter(Boolean).join("\n") + "\n";
}
