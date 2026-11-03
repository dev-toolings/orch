// Mission: a DAG of specs. Each node is a normal lane (laneAuto + gate).
// The lead's history never reaches a worker: laneRun already sends only the
// spec. Budget is estimated and reserved before the first node; ORCH_PAUSE
// is re-checked between nodes. First blockage stops the graph.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { estimateConsultUsd, estimateLaneUsd } from "../core/paid.ts";
import { pauseReason, releaseSpend, reserveSpend, spentToday, type SpendHold } from "../core/policy.ts";
import { bound } from "../core/output.ts";
import type { Profile } from "../core/profile.ts";
import type { HarnessId } from "../harness/registry.ts";
import { liveLaneBudget } from "./budget.ts";
import { parseSpec } from "./spec.ts";
import { specFeatures } from "./route.ts";

export const MISSION_CONCURRENCY_DEFAULT = 3;

export interface MissionNode {
  id: string;
  spec: string;
  needs: string[];
}

export interface Mission {
  name: string;
  concurrency: number;
  nodes: MissionNode[];
}

export type NodeMark = "prêt" | "bloqué" | "skipped";

export interface NodeResult {
  id: string;
  mark: NodeMark;
  touched: boolean;
  files: string[];
  reason?: string;
  laneId?: string;
  report?: string;
}

export interface MissionResult {
  report: string;
  status: "complete" | "blocked" | "paused" | "refused";
  nodes: NodeResult[];
}

interface MissionDoc {
  name?: unknown;
  concurrency?: unknown;
  nodes?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNeeds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("mission: needs must be a list of node ids");
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function resolveSpec(spec: string, baseDir: string): string {
  const path = isAbsolute(spec) ? spec : resolve(baseDir, spec);
  if (!existsSync(path)) throw new Error(`mission: spec not found: ${spec}`);
  return path;
}

export function parseMission(raw: string, baseDir: string): Mission {
  const doc = parse(raw) as MissionDoc | null;
  if (!doc || typeof doc !== "object") throw new Error("mission: file must be a YAML object");
  const name = asString(doc.name) ?? "mission";
  const concurrency = doc.concurrency == null ? MISSION_CONCURRENCY_DEFAULT : Number(doc.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("mission: concurrency must be a positive integer");
  }
  const rows = doc.nodes;
  if (!Array.isArray(rows) || !rows.length) throw new Error("mission: nodes must be a non-empty list");
  const nodes: MissionNode[] = rows.map((row, i) => {
    if (!row || typeof row !== "object") throw new Error(`mission: node ${i} must be an object`);
    const rec = row as Record<string, unknown>;
    const id = asString(rec.id);
    const spec = asString(rec.spec);
    if (!id) throw new Error(`mission: node ${i} missing id`);
    if (!spec) throw new Error(`mission: node ${id} missing spec`);
    return { id, spec: resolveSpec(spec, baseDir), needs: asNeeds(rec.needs) };
  });
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`mission: duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    for (const need of node.needs) {
      if (!ids.has(need)) throw new Error(`mission: node ${node.id} needs unknown ${need}`);
      if (need === node.id) throw new Error(`mission: node ${node.id} cannot need itself`);
    }
  }
  const cycle = detectCycle(nodes);
  if (cycle) throw new Error(`mission: cycle ${cycle.join(" -> ")}`);
  return { name, concurrency, nodes };
}

export function detectCycle(nodes: MissionNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visiting = new Set<string>();
  const seen = new Set<string>();
  const stack: string[] = [];
  const walk = (id: string): string[] | null => {
    if (seen.has(id)) return null;
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    visiting.add(id);
    stack.push(id);
    for (const need of byId.get(id)?.needs ?? []) {
      const hit = walk(need);
      if (hit) return hit;
    }
    stack.pop();
    visiting.delete(id);
    seen.add(id);
    return null;
  };
  for (const node of nodes) {
    const hit = walk(node.id);
    if (hit) return hit;
  }
  return null;
}

export function readyNodes(nodes: MissionNode[], done: Set<string>): MissionNode[] {
  return nodes.filter((n) => !done.has(n.id) && n.needs.every((need) => done.has(need)));
}

export function estimateNodeUsd(specPath: string, effort?: string): number {
  const spec = parseSpec(readFileSync(specPath, "utf8"));
  const features = specFeatures(spec);
  let usd = estimateLaneUsd(effort ?? spec.reasoning);
  if (features.risk.length) {
    usd += estimateConsultUsd("high") * 3 + estimateConsultUsd("high") + estimateConsultUsd("high");
  }
  return usd;
}

export function estimateMissionUsd(mission: Mission): number {
  return mission.nodes.reduce((n, node) => n + estimateNodeUsd(node.spec), 0);
}

export function formatMissionRefusal(opts: {
  mission: Mission;
  reason: string;
  estimated: number;
}): string {
  return [
    "MISSION REFUSED",
    `NAME: ${opts.mission.name}`,
    `REASON: ${opts.reason}`,
    `ESTIMATED COST (TODAY): ${opts.estimated.toFixed(4)}`,
  ].join("\n") + "\n";
}

export function formatMissionReport(opts: {
  mission: Mission;
  status: MissionResult["status"];
  reason?: string;
  estimated: number;
  reserved: number;
  spent: number;
  concurrency: number;
  nodes: NodeResult[];
}): string {
  if (opts.status === "refused") {
    return formatMissionRefusal({
      mission: opts.mission,
      reason: opts.reason ?? "refused",
      estimated: opts.estimated,
    });
  }
  const counts = { prêt: 0, bloqué: 0, skipped: 0, touché: 0 };
  const lines = opts.nodes.map((n) => {
    counts[n.mark]++;
    if (n.touched) counts.touché++;
    const bits = [
      `NODE ${n.id}: ${n.mark}`,
      n.touched ? "touché" : "",
      n.files.length ? `files=${n.files.join(",")}` : "",
      n.laneId ? `lane=${n.laneId}` : "",
      n.reason ? `reason=${n.reason.replace(/\s+/g, " ").slice(0, 160)}` : "",
    ].filter(Boolean);
    return bits.join("  ");
  });
  return [
    "MISSION REPORT",
    `NAME: ${opts.mission.name}`,
    `STATUS: ${opts.status}`,
    opts.reason ? `REASON: ${opts.reason}` : "",
    `ESTIMATED COST (TODAY): estimated ${opts.estimated.toFixed(4)} reserved ${opts.reserved.toFixed(4)} spent ${opts.spent.toFixed(4)}`,
    `CONCURRENCY: ${opts.concurrency}`,
    ...lines,
    `RECAP: ${counts.prêt} prêt, ${counts.bloqué} bloqué, ${counts.skipped} skipped, ${counts.touché} touché`,
  ].filter(Boolean).join("\n") + "\n";
}

export function batchExitCode(status: MissionResult["status"], nodes: NodeResult[] = []): number {
  return status !== "complete" || nodes.some((n) => n.mark === "bloqué") ? 3 : 0;
}

function lastStatus(report: string): string | undefined {
  const matches = [...report.matchAll(/^STATUS: (.+)$/gm)];
  return matches.at(-1)?.[1];
}

function nodeMarkFromAuto(report: string, integrated: boolean): { mark: NodeMark; reason?: string } {
  if (integrated || /^STATUS: integrated$/m.test(report)) return { mark: "prêt" };
  if (/^STATUS: noop$/m.test(report) && /LANE REPORT/.test(report) && !/^STATUS: refused$/m.test(report)) {
    return { mark: "prêt", reason: "noop" };
  }
  return { mark: "bloqué", reason: lastStatus(report) ?? "not complete" };
}

export function summarizeLaneAuto(report: string, integrated: boolean): {
  laneId?: string;
  files: string[];
  touched: boolean;
} {
  const laneId = /^ID: (.+)$/m.exec(report)?.[1];
  const files = [...report.matchAll(/^SCOPE: .*?: (.+)$/gm)].flatMap((m) =>
    m[1].split(",").map((s) => s.trim()).filter(Boolean),
  );
  const touched = /CHANGES:\n(?!none)/.test(report) || Boolean(laneId && integrated);
  return { laneId, files, touched };
}

export async function laneBatch(opts: {
  missionPath: string;
  repo: string;
  profile: Profile;
  to?: HarnessId;
  effort?: string;
  model?: string;
  from?: string;
  concurrency?: number;
  runNode?: (node: MissionNode) => Promise<{ report: string; integrated: boolean; touched?: boolean; files?: string[]; laneId?: string }>;
}): Promise<MissionResult> {
  const { laneAuto, leadHarness } = await import("../lane.ts");
  const raw = readFileSync(opts.missionPath, "utf8");
  const mission = parseMission(raw, dirname(resolve(opts.missionPath)));
  const estimated = estimateMissionUsd(mission);
  const slots = liveLaneBudget(opts.profile.limits);
  if (slots.budget < 1) {
    const report = formatMissionRefusal({
      mission,
      reason: `lane budget 0 (limited by ${slots.limitedBy})`,
      estimated,
    });
    return { report: bound(report, opts.profile.limits.report_max_bytes), status: "refused", nodes: [] };
  }
  const width = Math.max(1, Math.min(
    opts.concurrency ?? mission.concurrency,
    mission.nodes.length,
    slots.budget,
  ));
  let reserved: SpendHold;
  try {
    reserved = reserveSpend({
      usd: estimated,
      source: `mission:${mission.name}`,
      label: "mission",
      watched: true,
    });
  } catch (error) {
    const reason = (error as Error).message;
    const report = formatMissionRefusal({ mission, reason, estimated });
    return { report: bound(report, opts.profile.limits.report_max_bytes), status: "refused", nodes: [] };
  }

  const pending = new Map(mission.nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const results = new Map<string, NodeResult>();
  let status: MissionResult["status"] = "complete";
  let reason: string | undefined;
  const spentBefore = spentToday();
  const run = opts.runNode ?? (async (node: MissionNode) => {
    const auto = await laneAuto({
      specPath: node.spec,
      repo: opts.repo,
      profile: opts.profile,
      to: opts.to,
      effort: opts.effort,
      model: opts.model,
      from: leadHarness(opts.from),
      forceLane: true,
      skipReserve: true,
      spendHold: reserved.id,
    });
    return { ...auto, ...summarizeLaneAuto(auto.report, auto.integrated) };
  });

  try {
    while (pending.size) {
      const paused = pauseReason();
      if (paused) {
        status = "paused";
        reason = paused;
        break;
      }
      const ready = readyNodes([...pending.values()], done);
      if (!ready.length) break;
      const wave = ready.slice(0, width);
      const waveResults = await Promise.all(wave.map(async (node) => {
        try {
          const out = await run(node);
          const mark = nodeMarkFromAuto(out.report, out.integrated);
          const result: NodeResult = {
            id: node.id,
            mark: mark.mark,
            touched: out.touched ?? out.integrated,
            files: out.files ?? [],
            reason: mark.reason,
            laneId: out.laneId,
            report: out.report,
          };
          return result;
        } catch (error) {
          return {
            id: node.id,
            mark: "bloqué" as const,
            touched: false,
            files: [],
            reason: (error as Error).message,
          };
        }
      }));
      for (const result of waveResults) {
        pending.delete(result.id);
        results.set(result.id, result);
        if (result.mark === "prêt") done.add(result.id);
        else {
          status = "blocked";
          reason = `${result.id}: ${result.reason ?? "bloqué"}`;
        }
      }
      if (status !== "complete") break;
    }
    for (const node of pending.values()) {
      results.set(node.id, {
        id: node.id,
        mark: "skipped",
        touched: false,
        files: [],
        reason: status === "paused" ? reason : reason ?? "not started",
      });
    }
  } catch (error) {
    status = "blocked";
    reason = (error as Error).message;
    for (const node of pending.values()) {
      if (results.has(node.id)) continue;
      results.set(node.id, {
        id: node.id,
        mark: "skipped",
        touched: false,
        files: [],
        reason,
      });
    }
  } finally {
    releaseSpend(reserved.id);
  }

  const spent = Math.max(0, spentToday() - spentBefore);
  const nodes = mission.nodes.map((n) => results.get(n.id) ?? { id: n.id, mark: "skipped" as const, touched: false, files: [] });
  const report = formatMissionReport({
    mission, status, reason, estimated, reserved: estimated, spent, concurrency: width, nodes,
  });
  const body = nodes.filter((n) => n.report).map((n) => n.report).join("");
  return { report: bound(report + body, opts.profile.limits.report_max_bytes), status, nodes };
}
