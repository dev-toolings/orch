// Where orch mem keeps its notes: Markdown files (the default) or the memory
// brain (`mem: brain` in catalog/brain.yaml). Same commands, ids and scope
// rules either way; the choice is explicit, never a fallback.
import { addNote, type Caller, closePairs, forgetNote, type Note, listNotes, readableScopes, recentNotes, type Scope, searchNotes, showNote, supersedeNote } from "./mem.ts";
import { projectKey } from "../core/project.ts";

export interface Pair { newer: Note; older: Note; score: number }
export interface ReadOpts { scope?: Scope; limit?: number; all?: boolean }
export interface Inventory {
  complete: true;
  notes: Note[];
  // `scopes` is complete across the backend's global operator/lead stores.
  // Project notes are complete only for the keys listed in `projects`.
  scopes: Scope[];
  projects: string[];
}

export interface MemBackend {
  add(input: { body: string; scope: Scope; tags?: string[] }, caller: Caller): Promise<Note>;
  search(query: string, caller: Caller, opts?: ReadOpts): Promise<Note[]>;
  recent(caller: Caller, opts?: ReadOpts): Promise<Note[]>;
  // Returns every readable note, including inactive notes, without a limit.
  // `complete: true` is the contract exporters require before reconciling.
  inventory(caller: Caller, opts?: Pick<ReadOpts, "scope">): Promise<Inventory>;
  review(caller: Caller, opts?: { scope?: Scope; limit?: number }): Promise<Pair[]>;
  show(id: string, caller: Caller): Promise<Note | undefined>;
  supersede(id: string, input: { body: string; tags?: string[] }, caller: Caller): Promise<Note>;
  forget(id: string, reason: string, caller: Caller): Promise<Note>;
  close(): Promise<void>;
}

export const fileBackend: MemBackend = {
  add: async (input, caller) => addNote(input, caller),
  search: async (query, caller, opts = {}) => searchNotes(query, caller, opts),
  recent: async (caller, opts = {}) => recentNotes(caller, opts),
  inventory: async (caller, opts = {}) => {
    const scopes = readableScopes(caller, opts.scope);
    return { complete: true, scopes, projects: scopes.includes("project") ? [projectKey()] : [], notes: listNotes(caller, { ...opts, all: true }) };
  },
  review: async (caller, opts = {}) => closePairs(caller, opts),
  show: async (id, caller) => showNote(id, caller),
  supersede: async (id, input, caller) => supersedeNote(id, input, caller),
  forget: async (id, reason, caller) => forgetNote(id, reason, caller),
  close: async () => {},
};
