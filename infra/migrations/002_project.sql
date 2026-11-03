-- Project-scoped memories belong to one repository (its main worktree's
-- folder name); other scopes leave it empty.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS project text;
CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope, project);
