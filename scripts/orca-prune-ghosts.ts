#!/usr/bin/env -S bun --no-env-file
// Removes the records Orca keeps for worktrees whose directory is gone (see
// src/lanes/orca-prune.ts). The `orca-prune` routine runs `lane gc --orca`.
//   bun scripts/orca-prune-ghosts.ts           list what would go
//   bun scripts/orca-prune-ghosts.ts --apply   remove it (Orca quit)
import { pruneOrcaGhosts } from "../src/lanes/orca-prune.ts";

const apply = process.argv.includes("--apply");
const r = pruneOrcaGhosts({ apply });
for (const line of r.lines) (r.held ? console.error : console.log)(line);
if (!apply) {
  for (const k of r.keys.slice(0, 10)) console.log(`  ${k}`);
  if (r.keys.length || r.references) console.log("dry run: nothing changed (--apply to remove, Orca quit)");
}
if (r.held) process.exitCode = 2;
