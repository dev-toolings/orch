-- Keep the oldest note's id and suffix later duplicates without losing
-- rows or UUID links. Reserve existing suffixed ids, including inactive notes.
LOCK TABLE memories IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  note record;
  candidate text;
  suffix integer;
BEGIN
  FOR note IN
    SELECT * FROM (
      SELECT id, source, source_ref, body, created_at,
             row_number() OVER (PARTITION BY source, source_ref ORDER BY created_at, id) AS position
      FROM memories WHERE source = 'orch-mem'
    ) ranked WHERE position > 1 ORDER BY created_at, id
  LOOP
    suffix := 2;
    LOOP
      candidate := note.source_ref || '-' || suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM memories WHERE source = note.source AND source_ref = candidate
      );
      suffix := suffix + 1;
    END LOOP;
    UPDATE memories SET source_ref = candidate,
      content_hash = encode(sha256(convert_to(note.source, 'UTF8') || decode('00', 'hex') ||
        convert_to(candidate, 'UTF8') || decode('00', 'hex') || convert_to(note.body, 'UTF8')), 'hex')
    WHERE id = note.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX memories_note_identity ON memories (source, source_ref)
  WHERE source = 'orch-mem';
