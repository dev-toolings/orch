// GitHub as an event source, with no model call: failed CI runs and
// "changes requested" reviews on open pull requests become events (source
// ci, untrusted text). Extracted from src/kiba/github.ts, which keeps the
// old conductor's poll; orch serve polls its declared repositories.
import { spawnSync } from "node:child_process";
import type { InboundEvent } from "./inbound.ts";

export type Gh = (args: string[], cwd: string) => string | null;

export const ghDefault: Gh = (args, cwd) => {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout : null;
};

interface Run { databaseId: number; headBranch: string; headSha: string; workflowName: string; conclusion: string; url: string; createdAt: string }
interface Review { id: string; state: string; submittedAt: string; author?: { login?: string } }
interface Pr { number: number; headRefName: string; title: string; url: string; reviews?: Review[] }

// New events since the last poll, oldest first, and the ids now known.
export function githubEvents(repos: { path: string; slug: string }[], seen: Set<string>, gh: Gh = ghDefault): { events: InboundEvent[]; ids: string[] } {
  const events: InboundEvent[] = [];
  const ids: string[] = [];
  for (const { path, slug } of repos) {
    const runs = JSON.parse(gh(["run", "list", "--repo", slug, "--status", "failure", "--limit", "20",
      "--json", "databaseId,headBranch,headSha,workflowName,conclusion,url,createdAt"], path) ?? "[]") as Run[];
    for (const r of [...runs].reverse()) {
      const id = `gh-run-${slug}-${r.databaseId}`;
      ids.push(id);
      if (seen.has(id)) continue;
      events.push({ id, source: "ci", kind: "ci_fail", task: r.headBranch, repo: path,
        text: `${slug}: ${r.workflowName} failed on ${r.headBranch} (${r.headSha.slice(0, 7)}) ${r.url}` });
    }
    const prs = JSON.parse(gh(["pr", "list", "--repo", slug, "--state", "open", "--limit", "30",
      "--json", "number,headRefName,title,url,reviews"], path) ?? "[]") as Pr[];
    for (const p of prs) {
      for (const rv of p.reviews ?? []) {
        if (rv.state !== "CHANGES_REQUESTED") continue;
        const id = `gh-review-${slug}-${rv.id}`;
        ids.push(id);
        if (seen.has(id)) continue;
        events.push({ id, source: "ci", kind: "comment", task: p.headRefName, repo: path,
          text: `${slug}#${p.number} ${p.title}: changes requested by ${rv.author?.login ?? "a reviewer"} ${p.url}` });
      }
    }
  }
  return { events, ids };
}

