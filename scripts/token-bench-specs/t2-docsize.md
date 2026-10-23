OBJECTIVE: `orch docs status` should show how much disk each docs source takes and the total, so a heavy or orphaned clone is visible (an opencode clone took 38 MB unnoticed).
FILES: src/docs/docs.ts, tests/docs.test.ts, README.md
INTERFACES: in src/docs/docs.ts add `export function dirBytes(dir: string): number`: recursive sum of regular file sizes from lstat, never following symlinks, including `.git` and `.ctx` (they occupy disk), 0 when the directory does not exist. `statusLines(sources, root)`: each fetched source line and each orphan line ends with two spaces and the size as `${(bytes / 1048576).toFixed(1)} MB`; when at least one source or orphan is on disk, a last line `${"total".padEnd(20)} ${mb} on disk` sums them all. Lines for sources not fetched are unchanged. README.md: mention the size and total in the `orch docs status` row.
CONSTRAINTS: keep every existing statusLines field and its order; only append. Tests use temporary directories, never ~/.local/share/orch.
VERIFY: bun test tests/docs.test.ts && bunx tsc --noEmit
ACCEPT: tests cover dirBytes on a tree with a symlink (not followed), a fetched source line with its size, an orphan with its size, and the total line.
MECHANICAL: yes
