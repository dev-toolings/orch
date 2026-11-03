import { parseArgs } from "node:util";
import { loadPolicy, resolveLogsPolicy } from "../core/policy.ts";
import { formatPruneResult, pruneHarnessLogs } from "./prune.ts";

const USAGE = "usage: orch logs prune [--days N] [--dry-run]";

export async function logs(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "prune") {
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  // It deletes files: an unknown option (a typo, --help) never falls through
  // to a real run, it stops on the usage.
  let values: { days?: string; "dry-run"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        days: { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(`logs prune: ${(error as Error).message}`);
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const days = values.days === undefined ? resolveLogsPolicy(loadPolicy()).retention_days : Number(values.days);
  if (!Number.isInteger(days) || days < 1) throw new Error("logs prune: --days must be a positive integer");
  const result = pruneHarnessLogs({ days, dryRun: values["dry-run"] === true });
  process.stdout.write(formatPruneResult(result));
}
