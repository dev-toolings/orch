OBJECTIVE: `lane route` should end with the exact next command, so the lead copies it instead of rebuilding it from ACTION and REVIEW.
FILES: src/lanes/route.ts, src/lane.ts, tests/route.test.ts, README.md
INTERFACES: `routeReport(r: Route, features: SpecFeatures, specPath?: string): string` appends one last line. self: `NEXT: do it inline, no lane (pass --to to force one)`. lane with a harness: `NEXT: lane auto --spec ${specPath ?? "<spec>"}` followed by ` --to ${r.to}` only when the first reason starts with `--to ` (explicit choice), and, when `r.review === "high"`, the suffix `  (risk: lane auto reviews it, the gate needs a recorded ship)`. lane without a harness: `NEXT: install a lane harness (codex, claude or grok)`. In src/lane.ts, `laneRoute` passes `opts.specPath` to routeReport. README.md: mention the NEXT line in the `lane route` row.
CONSTRAINTS: no other output line changes; existing tests keep passing.
VERIFY: bun test tests/route.test.ts && bunx tsc --noEmit
ACCEPT: tests cover the self, lane, explicit --to, risky and no-harness NEXT lines.
MECHANICAL: yes
