// lane route: pick who does a spec (the lead itself, or which lane harness),
// and whether its integration needs a review, from the spec's own features and
// the lane ledger. Deterministic, no model call: the same inputs give the same
// route, and every choice carries its reason.
import { createHash } from "node:crypto";
import type { Usage } from "../harness/harness.ts";
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
  // Same OBJECTIVE and FILES give the same fingerprint: a retry of a spec
  // that already failed is recognised and gets more effort, not less.
  fingerprint?: string;
  // The lead's own `MECHANICAL: yes`: file count alone is weak evidence.
  mechanical?: boolean;
  reasoning?: string;
}

export interface RouteConfig {
  // Harnesses tried in this order when the ledger has no verdict yet.
  order: HarnessId[];
  // A spec touching this many files or fewer is cheaper inline: a worker
  // costs about 10k tokens of fixed prefix before doing anything.
  self_max_files: number;
  // Closed runs a harness needs on a stack before its record outranks the order.
  min_samples: number;
  // A MECHANICAL spec without risk, on one code stack and at most this many
  // files, runs at medium (never above the profile's own effort).
  medium_max_files: number;
  // Cost-aware choice: closed runs, share of them with token usage, and the
  // 90% lower confidence bound on success a harness needs to compete on cost.
  cost_min_samples: number;
  cost_floor: number;
}

export const DEFAULT_ROUTE: RouteConfig = {
  order: ["codex", "claude", "grok"], self_max_files: 2, min_samples: 5, medium_max_files: 4, cost_min_samples: 10, cost_floor: 0.7,
};

const EFFORT_RANK = ["low", "medium", "high", "xhigh", "max"];
const rank = (e?: string) => (e ? EFFORT_RANK.indexOf(e) : -1);
// Stacks that only accompany code (docs, config, Makefile) do not make a change multi-stack.
const SUPPORT_STACKS = new Set(["docs", "config", "make"]);

export function tokensOf(u: Usage | undefined): number | undefined {
  if (!u) return undefined;
  if (typeof u.total === "number" && u.total > 0) return u.total;
  const sum = (u.input ?? 0) + (u.output ?? 0);
  return sum > 0 ? sum : undefined;
}

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
  const fingerprint = createHash("sha256").update(`${(spec.fields.OBJECTIVE ?? "").replace(/\s+/g, " ").trim()}\n${[...files].sort().join("\n")}`).digest("hex").slice(0, 16);
  return {
    files, stacks, risk: RISKS.filter((r) => risk.has(r)), objective: (spec.fields.OBJECTIVE ?? "").split("\n")[0].slice(0, 120),
    fingerprint, mechanical: /^(yes|true|oui)\b/i.test(spec.fields.MECHANICAL ?? ""), ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
  };
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

export interface HarnessStats { to: HarnessId; n: number; ok: number; score: number; scope: "stack" | "all"; tokens?: number; usageShare: number; lower: number }

// Wilson lower bound at 90% (z = 1.645): a success rate the record supports.
export function wilsonLower(ok: number, n: number, z = 1.645): number {
  if (!n) return 0;
  const p = ok / n;
  const d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

// Comparable history covers every requested stack: a TypeScript-only record
// says nothing about a TypeScript and SQL change. score is Laplace-smoothed
// (0 runs reads 0.5); tokens is the mean per attempt, failures included.
export function harnessStats(rows: LedgerRow[], to: HarnessId, stacks: string[]): HarnessStats {
  const mine = verdicts(rows).filter((v) => v.run.to === to);
  const pool = stacks.length ? mine.filter((v) => stacks.every((s) => v.run.features?.stacks?.includes(s))) : mine;
  const ok = pool.filter((v) => v.ok).length;
  const spent = pool.map((v) => tokensOf(v.run.usage)).filter((t): t is number => t !== undefined);
  return {
    to, n: pool.length, ok, score: (ok + 1) / (pool.length + 2), scope: stacks.length ? "stack" : "all",
    ...(spent.length ? { tokens: Math.round(spent.reduce((a, b) => a + b, 0) / spent.length) } : {}),
    usageShare: pool.length ? spent.length / pool.length : 0, lower: wilsonLower(ok, pool.length),
  };
}

// Effort: spec REASONING wins. A risky spec, or a retry of a spec that already
// failed, runs at high at least. A MECHANICAL spec without risk, on one code
// stack and few files, runs at medium. Everything else keeps the profile's.
export function routeEffort(f: SpecFeatures, rows: LedgerRow[], profileEffort: string | undefined, cfg: RouteConfig): { effort?: string; why: string } {
  if (f.reasoning) return { effort: f.reasoning, why: "spec REASONING" };
  const atLeastHigh = rank(profileEffort) >= rank("high") ? profileEffort : "high";
  if (f.risk.length) return { effort: atLeastHigh, why: `risk ${f.risk.join(", ")}: effort ${atLeastHigh} at least` };
  const failedBefore = f.fingerprint && verdicts(rows).some((v) => !v.ok && v.run.features?.fingerprint === f.fingerprint);
  if (failedBefore) return { effort: atLeastHigh, why: `this spec already failed once: effort ${atLeastHigh} at least` };
  const codeStacks = f.stacks.filter((s) => !SUPPORT_STACKS.has(s));
  // Medium pays only while it rarely fails: a failure costs the medium run
  // plus the escalated retry. Measured on 2026-10-23: medium -25% tokens,
  // -52% time, 1 failure in 3. Break-even is a 25% failure rate.
  const medium = verdicts(rows).filter((v) => v.run.features?.mechanical && v.run.effort === "medium");
  const mediumFails = medium.filter((v) => !v.ok).length;
  if (f.mechanical && medium.length >= cfg.min_samples * 2 && mediumFails / medium.length >= 0.25) {
    return { effort: profileEffort, why: `medium failed ${mediumFails}/${medium.length} MECHANICAL runs (>= 25%): profile effort ${profileEffort ?? "default"}` };
  }
  if (f.mechanical && f.files.length <= cfg.medium_max_files && codeStacks.length <= 1) {
    const effort = profileEffort && rank(profileEffort) < rank("medium") ? profileEffort : "medium";
    return { effort, why: `MECHANICAL, no risk, ${f.files.length} file(s), ${codeStacks.length || "no"} code stack: effort ${effort}` };
  }
  return { effort: profileEffort, why: `profile effort ${profileEffort ?? "default"}${f.mechanical ? "" : " (spec not marked MECHANICAL)"}` };
}

export interface Route {
  action: "self" | "lane";
  to?: HarnessId;
  effort?: string;
  review: "none" | "high";
  reasons: string[];
  stats: HarnessStats[];
}

export function routeSpec(
  features: SpecFeatures, rows: LedgerRow[],
  opts: { installed: HarnessId[]; config?: Partial<RouteConfig>; to?: HarnessId; efforts?: Partial<Record<HarnessId, string>> },
): Route {
  const cfg = { ...DEFAULT_ROUTE, ...opts.config };
  const r = pickHarness(features, rows, opts, cfg);
  if (r.action !== "lane" || !r.to) return r;
  const e = routeEffort(features, rows, opts.efforts?.[r.to], cfg);
  return { ...r, ...(e.effort ? { effort: e.effort } : {}), reasons: [...r.reasons, e.why] };
}

function pickHarness(features: SpecFeatures, rows: LedgerRow[], opts: { installed: HarnessId[]; to?: HarnessId }, cfg: RouteConfig): Route {
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
  // Cost first, but only among harnesses whose record is long, metered and
  // reliable enough: a cheap but flaky harness never qualifies.
  const reliable = stats.filter((s) => s.n >= cfg.cost_min_samples && s.usageShare >= 0.9 && s.tokens !== undefined && s.lower >= cfg.cost_floor);
  if (reliable.length) {
    const cheapest = [...reliable].sort((a, b) => a.tokens! / a.score - b.tokens! / b.score)[0];
    reasons.unshift(`${cheapest.to}: ${Math.round(cheapest.tokens! / cheapest.score)} tokens per integrated lane, ${cheapest.ok}/${cheapest.n} integrated (lower bound ${cheapest.lower.toFixed(2)})`);
    return { action: "lane", to: cheapest.to, review, reasons, stats };
  }
  const measured = stats.filter((s) => s.n >= cfg.min_samples).sort((a, b) => b.score - a.score);
  const best = measured[0];
  if (best && best.score >= 0.5) {
    reasons.unshift(`${best.to}: ${best.ok}/${best.n} integrated on ${best.scope === "stack" ? features.stacks.join(" + ") : "all stacks"} (score ${best.score.toFixed(2)})`);
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

export function routeReport(r: Route, features: SpecFeatures, specPath?: string): string {
  const next = r.action === "self"
    ? "NEXT: do it inline, no lane (pass --to to force one)"
    : !r.to
      ? "NEXT: install a lane harness (codex, claude or grok)"
      : `NEXT: lane auto --spec ${specPath ?? "<spec>"}${r.reasons[0]?.startsWith("--to ") ? ` --to ${r.to}` : ""}${r.review === "high" ? "  (risk: lane auto reviews it, the gate needs a recorded ship)" : ""}`;
  return [
    "LANE ROUTE",
    `ACTION: ${r.action}${r.to ? ` --to ${r.to}` : ""}${r.effort ? ` --effort ${r.effort}` : ""}`,
    `REVIEW: ${r.review}`,
    `FILES: ${features.files.length} (${features.stacks.join(", ") || "no stack"})${features.risk.length ? `; risk ${features.risk.join(", ")}` : ""}`,
    ...r.reasons.map((x) => `WHY: ${x}`),
    r.stats.length ? `RECORD: ${r.stats.map((s) => `${s.to} ${s.ok}/${s.n}${s.tokens ? ` ~${s.tokens} tok` : ""}`).join(", ")}` : "",
    next,
  ].filter(Boolean).join("\n") + "\n";
}
