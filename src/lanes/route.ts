// lane route: pick who does a spec (the lead itself, or the first installed
// lane harness in the profile's order), with which effort, and whether its
// integration needs a review. A fixed rule on the spec's own features; the
// lane ledger only tunes the effort. Deterministic, no model call.
import { createHash } from "node:crypto";
import type { HarnessId } from "../harness/registry.ts";
import { type LedgerRow, verdicts } from "./ledger.ts";
import type { Spec } from "./spec.ts";

// `declared`: the spec says it is risky (KIND: risky, or RISK: declared)
// without a risky path; it still needs the review before integration.
export type Risk = "migration" | "security" | "public-api" | "declared";
export const RISKS: Risk[] = ["migration", "security", "public-api", "declared"];

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
  // Lane harnesses, first installed wins.
  order: HarnessId[];
  // A spec touching this many files or fewer is cheaper inline: a worker
  // costs about 10k tokens of fixed prefix before doing anything.
  self_max_files: number;
  // Twice this many closed MECHANICAL runs at low before their failure
  // rate can switch low off.
  min_samples: number;
  // A MECHANICAL spec without risk, on one code stack and at most this many
  // files, runs at low.
  mechanical_max_files: number;
}

export const DEFAULT_ROUTE: RouteConfig = {
  order: ["codex", "claude", "grok"], self_max_files: 2, min_samples: 5, mechanical_max_files: 4,
};

const EFFORT_RANK = ["low", "medium", "high", "xhigh", "max"];
const rank = (e?: string) => (e ? EFFORT_RANK.indexOf(e) : -1);
// Stacks that only accompany code (docs, config, Makefile) do not make a change multi-stack.
const SUPPORT_STACKS = new Set(["docs", "config", "make"]);

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
  // A declared risky kind never loses its risk, whatever FILES says.
  if (/^risky\b/i.test((spec.fields.KIND ?? "").trim())) risk.add("declared");
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

// Effort ladder for a worker lane (deterministic, no model call):
//   spec REASONING        -> as written (the only way to xhigh or max)
//   failed twice          -> escalate: back to the lead, nothing is run
//   risk / failed once    -> high
//   MECHANICAL, no risk   -> low (one code stack, few files)
//   anything else         -> the profile's effort (medium), capped at high
// A profile never puts a worker above high on its own.
export const DEFAULT_EFFORT = "medium";
export const ESCALATE_AFTER = 2;

// Failed runs of this very spec (same fingerprint) recorded in the ledger.
export function specFailures(f: SpecFeatures, rows: LedgerRow[]): number {
  if (!f.fingerprint) return 0;
  return verdicts(rows).filter((v) => !v.ok && v.run.features?.fingerprint === f.fingerprint).length;
}

export function routeEffort(f: SpecFeatures, rows: LedgerRow[], profileEffort: string | undefined, cfg: RouteConfig): { effort?: string; why: string; escalate?: boolean } {
  if (f.reasoning) return { effort: f.reasoning, why: `spec REASONING: effort ${f.reasoning}` };
  const failures = specFailures(f, rows);
  if (failures >= ESCALATE_AFTER) {
    return { escalate: true, why: `this spec already failed ${failures} times in lanes: escalate to the lead (do it inline, split or rewrite the spec, or set REASONING to retry)` };
  }
  if (f.risk.length) return { effort: "high", why: `risk ${f.risk.join(", ")}: effort high` };
  if (failures === 1) return { effort: "high", why: "this spec already failed once: effort high" };
  const base = !profileEffort ? DEFAULT_EFFORT : rank(profileEffort) > rank("high") ? "high" : profileEffort;
  const baseWhy = `profile effort ${base}${profileEffort && profileEffort !== base ? ` (profile ${profileEffort} capped: xhigh/max only through REASONING)` : ""}`;
  if (!f.mechanical) return { effort: base, why: `${baseWhy} (spec not marked MECHANICAL)` };
  // Low pays only while it rarely fails: a failure costs the low run plus the
  // escalated retry. Break-even measured for the cheap rung on 2026-10-23
  // (medium then: -25% tokens, -52% time) is a 25% failure rate.
  const cheap = verdicts(rows).filter((v) => v.run.features?.mechanical && v.run.effort === "low");
  const cheapFails = cheap.filter((v) => !v.ok).length;
  if (cheap.length >= cfg.min_samples * 2 && cheapFails / cheap.length >= 0.25) {
    return { effort: base, why: `low failed ${cheapFails}/${cheap.length} MECHANICAL runs (>= 25%): ${baseWhy}` };
  }
  const codeStacks = f.stacks.filter((s) => !SUPPORT_STACKS.has(s));
  if (f.files.length <= cfg.mechanical_max_files && codeStacks.length <= 1) {
    return { effort: "low", why: `MECHANICAL, no risk, ${f.files.length} file(s), ${codeStacks.length || "no"} code stack: effort low` };
  }
  return { effort: base, why: `${baseWhy} (MECHANICAL but ${f.files.length} file(s), ${codeStacks.length} code stacks)` };
}

export interface Route {
  // escalate: the spec failed twice in lanes; nothing is run, the lead decides.
  action: "self" | "lane" | "escalate";
  to?: HarnessId;
  effort?: string;
  // Set only by the router profile's ladder (Claude lanes): the worker model.
  model?: string;
  review: "none" | "high";
  reasons: string[];
}

export function routeSpec(
  features: SpecFeatures, rows: LedgerRow[],
  opts: { installed: HarnessId[]; config?: Partial<RouteConfig>; to?: HarnessId; efforts?: Partial<Record<HarnessId, string>> },
): Route {
  const cfg = { ...DEFAULT_ROUTE, ...opts.config };
  const r = pickHarness(features, opts, cfg);
  if (r.action !== "lane" || !r.to) return r;
  const e = routeEffort(features, rows, opts.efforts?.[r.to], cfg);
  if (e.escalate) return { ...r, action: "escalate", reasons: [...r.reasons, e.why] };
  return { ...r, ...(e.effort ? { effort: e.effort } : {}), reasons: [...r.reasons, e.why] };
}

function pickHarness(features: SpecFeatures, opts: { installed: HarnessId[]; to?: HarnessId }, cfg: RouteConfig): Route {
  const review = features.risk.length ? "high" : "none";
  const reasons: string[] = [];
  if (review === "high") reasons.push(`risk ${features.risk.join(", ")}: integration needs lane review --risk high first`);
  if (opts.to) {
    if (!opts.installed.includes(opts.to)) return { action: "lane", to: undefined, review, reasons: [`${opts.to} is not installed`, ...reasons] };
    return { action: "lane", to: opts.to, review, reasons: [`--to ${opts.to} (explicit)`, ...reasons] };
  }
  if (features.files.length <= cfg.self_max_files) {
    return { action: "self", review, reasons: [`${features.files.length} declared file(s) <= ${cfg.self_max_files}: do it yourself, a worker costs ~10k tokens of prefix`, ...reasons] };
  }
  const pick = cfg.order.find((h) => opts.installed.includes(h));
  if (!pick) return { action: "lane", to: undefined, review, reasons: ["no lane harness installed", ...reasons] };
  return { action: "lane", to: pick, review, reasons: [`${pick}: first installed in order ${cfg.order.join(", ")}`, ...reasons] };
}

export function routeReport(r: Route, features: SpecFeatures, specPath?: string): string {
  const next = r.action === "escalate"
    ? `NEXT: do it inline, or split or rewrite the spec (a new OBJECTIVE or FILES starts a fresh count); REASONING: high|xhigh in the spec forces one more lane`
    : r.action === "self"
    ? r.review === "high"
      ? `NEXT: lane contest --spec ${specPath ?? "<spec>"} (risk: GO first), then do it inline`
      : "NEXT: do it inline, no lane (pass --to to force one)"
    : !r.to
      ? "NEXT: install a lane harness (codex, claude or grok)"
      : `NEXT: lane auto --spec ${specPath ?? "<spec>"}${r.reasons[0]?.startsWith("--to ") ? ` --to ${r.to}` : ""}${r.review === "high" ? "  (risk: lane auto puts the spec to a contest first, then reviews the lane; the gate needs a recorded ship)" : ""}`;
  return [
    "LANE ROUTE",
    `ACTION: ${r.action}${r.to && r.action !== "escalate" ? ` --to ${r.to}` : ""}${r.effort ? ` --effort ${r.effort}` : ""}${r.model ? ` --model ${r.model}` : ""}`,
    `REVIEW: ${r.review}`,
    `FILES: ${features.files.length} (${features.stacks.join(", ") || "no stack"})${features.risk.length ? `; risk ${features.risk.join(", ")}` : ""}`,
    ...r.reasons.map((x) => `WHY: ${x}`),
    next,
  ].filter(Boolean).join("\n") + "\n";
}
