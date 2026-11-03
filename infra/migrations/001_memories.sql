-- One table per domain database. A memory keeps its source, is never
-- deleted (superseded or forgotten instead), and is unique by content hash
-- so an ingestion can be replayed without duplicates.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_ref text NOT NULL,
  scope text NOT NULL DEFAULT 'project',
  title text,
  body text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  harness text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL UNIQUE,
  supersedes uuid REFERENCES memories(id),
  superseded_by uuid REFERENCES memories(id),
  forgotten_at timestamptz,
  forgotten_reason text,
  fts tsvector NOT NULL,
  embedding vector(1024),
  embed_space text
);

CREATE INDEX IF NOT EXISTS memories_fts ON memories USING gin (fts);
CREATE INDEX IF NOT EXISTS memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memories_source ON memories (source, source_ref);
