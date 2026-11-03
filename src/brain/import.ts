// Copies orch mem notes into a domain database. Replayable: a note already
// imported is found by its content hash, and the supersede and forget marks
// of the notes are carried over only where they are not set yet.
import type { Note } from "../mem/mem.ts";
import type { Db } from "./db.ts";
import { addMemory } from "./store.ts";

export const NOTE_SOURCE = "orch-mem";

export interface ImportReport { added: number; existing: number; superseded: number; forgotten: number; unresolved: string[] }

const when = (n: Note) => {
  const d = new Date(n.date);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

// Project notes are those of `project` (the repository they were read from).
export async function importNotes(db: Db, notes: Note[], project: string): Promise<ImportReport> {
  const r: ImportReport = { added: 0, existing: 0, superseded: 0, forgotten: 0, unresolved: [] };
  const ordered = [...notes].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const n of ordered) {
    const { created } = await addMemory(db, {
      source: NOTE_SOURCE, source_ref: n.id, scope: n.scope, project: n.scope === "project" ? project : undefined, body: n.body, tags: n.tags,
      harness: n.harness === "unknown" ? undefined : n.harness, occurred_at: when(n),
    });
    if (created) r.added++;
    else r.existing++;
  }
  for (const n of ordered) {
    // The newer note carries `supersedes`; the older one `superseded_by`.
    const older = n.supersedes;
    if (older) {
      if (!notes.some((o) => o.id === older)) r.unresolved.push(`${n.id} supersedes missing note ${older}`);
      else {
        const rows = await db.query(
          `WITH o AS (UPDATE memories SET superseded_by = (SELECT id FROM memories WHERE source = '${NOTE_SOURCE}' AND source_ref = $2) WHERE source = '${NOTE_SOURCE}' AND source_ref = $1 AND superseded_by IS NULL RETURNING id)
           UPDATE memories SET supersedes = (SELECT id FROM o) WHERE source = '${NOTE_SOURCE}' AND source_ref = $2 AND EXISTS (SELECT 1 FROM o) RETURNING id`,
          [older, n.id]);
        r.superseded += rows.length;
      }
    }
    if (n.status === "superseded" && !n.supersededBy) r.unresolved.push(`${n.id} is superseded without a successor`);
    if (n.status === "forgotten") {
      const rows = await db.query(
        `UPDATE memories SET forgotten_at = now(), forgotten_reason = $2 WHERE source = '${NOTE_SOURCE}' AND source_ref = $1 AND forgotten_at IS NULL RETURNING id`,
        [n.id, n.reason ?? "forgotten in orch mem"]);
      r.forgotten += rows.length;
    }
  }
  return r;
}
