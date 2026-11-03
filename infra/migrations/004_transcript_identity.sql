-- A transcript chunk revision has one identity even when two importers race.
CREATE UNIQUE INDEX memories_transcript_identity ON memories (source, source_ref)
  WHERE source = 'claude-transcript';
