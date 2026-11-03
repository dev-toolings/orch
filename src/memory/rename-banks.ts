// `orch brain hindsight-rename <from> <to>`: moves the operator bank `<from>`
// and every project bank `<from>-<project>` to `<to>` / `<to>-<project>`.
// Each bank is cloned (no LLM call), its node and document counts compared
// with the source, and only then the source is dropped. A target that
// already exists, a clone that fails or counts that differ leave the source
// in place and are reported. The seed manifest follows, so hindsight-seed
// does not send everything again to the new names (a paid extraction).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../lanes/lock.ts";
import { stateDir } from "../core/paths.ts";
import { bankStats, cloneBank, deleteBank, type HindsightConfig, listBanks, operationStatus } from "./hindsight.ts";
import { namespaceId } from "./seed.ts";

export interface RenameDeps {
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxWaitMs?: number;
  log?: (line: string) => void;
  // Banks never moved, dropped instead (a test run's bank).
  drop?: string[];
}

export interface RenameResult { moved: string[]; dropped: string[]; kept: string[] }

const valid = (name: string) => /^[A-Za-z0-9_-]+$/.test(name);

export function renamedBank(bank: string, from: string, to: string): string | null {
  if (bank === from) return to;
  return bank.startsWith(`${from}-`) ? `${to}${bank.slice(from.length)}` : null;
}

export async function renameBanks(c: HindsightConfig, from: string, to: string, d: RenameDeps = {}): Promise<RenameResult> {
  if (!valid(from) || !valid(to) || from === to) throw new Error("hindsight-rename: two different bank names (letters, digits, _ and -)");
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = d.log ?? (() => {});
  const banks = await listBanks(c);
  if (!banks.ok) throw new Error(`hindsight-rename: cannot list banks: ${banks.error}`);
  const out: RenameResult = { moved: [], dropped: [], kept: [] };
  for (const bank of banks.value) {
    const target = renamedBank(bank, from, to);
    if (!target) continue;
    if (d.drop?.includes(bank)) {
      const r = await deleteBank(c, bank);
      if (r.ok) { out.dropped.push(bank); log(`dropped ${bank}`); } else { out.kept.push(bank); log(`kept ${bank}: delete failed: ${r.error}`); }
      continue;
    }
    if (banks.value.includes(target)) { out.kept.push(bank); log(`kept ${bank}: ${target} already exists`); continue; }
    const before = await bankStats(c, bank);
    if (!before.ok) { out.kept.push(bank); log(`kept ${bank}: stats: ${before.error}`); continue; }
    if (before.value.pending > 0) { out.kept.push(bank); log(`kept ${bank}: ${before.value.pending} operation(s) still pending, run again later`); continue; }
    const op = await cloneBank(c, bank, target);
    if (!op.ok) { out.kept.push(bank); log(`kept ${bank}: clone: ${op.error}`); continue; }
    let status = "pending";
    for (let waited = 0; ["pending", "processing"].includes(status) && waited <= (d.maxWaitMs ?? 600_000); waited += d.pollMs ?? 2000) {
      await sleep(d.pollMs ?? 2000);
      const s = await operationStatus(c, bank, op.value);
      status = s.ok ? s.value : "unknown";
    }
    if (status !== "completed") { out.kept.push(bank); log(`kept ${bank}: clone ended ${status}`); continue; }
    const after = await bankStats(c, target);
    if (!after.ok || after.value.nodes !== before.value.nodes || after.value.documents !== before.value.documents) {
      out.kept.push(bank);
      log(`kept ${bank}: ${target} counts differ (${after.ok ? `${after.value.nodes}/${after.value.documents}` : after.error} vs ${before.value.nodes}/${before.value.documents})`);
      continue;
    }
    const gone = await deleteBank(c, bank);
    if (!gone.ok) { out.kept.push(bank); log(`kept ${bank}: cloned to ${target}, delete failed: ${gone.error}`); continue; }
    out.moved.push(bank);
    log(`moved ${bank} -> ${target} (${before.value.nodes} nodes, ${before.value.documents} documents)`);
  }
  return out;
}

// The seed manifest follows the banks, for every server: the namespace of
// base `from` becomes `to`'s, and in it every key `from` / `from-*` is renamed
// (keys of dropped banks removed). Only called once nothing was kept under the
// old name, so a run that resumes an interrupted one (some banks moved the
// first time, the namespace already at `to`) still renames every key.
export async function renameSeedBase(from: string, to: string, r: Pick<RenameResult, "dropped">, state = stateDir()): Promise<number> {
  const file = join(state, "hindsight-seed.json");
  if (!existsSync(file)) return 0;
  const done = await withFileLock(`${file}.lock`, () => {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { version: number; namespaces: Record<string, { server: string; base: string; hashes: Record<string, Record<string, string>> }> };
    if (manifest.version !== 2) throw new Error("hindsight-rename: seed manifest version is not 2");
    let n = 0;
    for (const [id, ns] of Object.entries(manifest.namespaces)) {
      if (ns.base !== from && ns.base !== to) continue;
      const hashes: typeof ns.hashes = {};
      for (const [bank, docs] of Object.entries(ns.hashes)) {
        if (r.dropped.includes(bank)) continue;
        const key = renamedBank(bank, from, to) ?? bank;
        hashes[key] = { ...(hashes[key] ?? {}), ...docs };
      }
      delete manifest.namespaces[id];
      manifest.namespaces[namespaceId(ns.server, to)] = { server: ns.server, base: to, hashes };
      n++;
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    return n;
  }, { waitMs: 30_000 });
  if (done === null) throw new Error("hindsight-rename: the seed manifest is locked by a running seed");
  return done;
}
