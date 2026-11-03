import { useMemo, useState } from "react";
import { Page } from "../components/Page";
import { Card, Field, PageHead, Pager } from "../components/ui";
import { Persona } from "../components/Persona";
import { when } from "../lib/format";
import type { DashEvent } from "../types";

const PAGE_SIZE = 15;

export function ActivityPage() {
  return (
    <Page crumbs={["orch", "kev", "Activité"]}>
      {(snap) => (
        <div>
          <PageHead title="Activité" subtitle="Kiba, lanes et notes orch log (RESUME / NEXT), sans secrets." />
          {snap.activity.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">Le fil est vide.</p>
          ) : (
            <ActivityTable events={snap.activity} />
          )}
        </div>
      )}
    </Page>
  );
}

function ActivityTable({ events }: { events: DashEvent[] }) {
  const [query, setQuery] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const kept = q ? events.filter((event) => haystack(event).includes(q)) : events;
    return [...kept].sort((a, b) => (newestFirst ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at)));
  }, [events, query, newestFirst]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // The feed is live: a shorter list must not leave the table on an empty page.
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  return (
    <Card className="mx-6 mb-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Field
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Filtrer (projet, action, détail)"
          aria-label="Filtrer l'activité"
          className="max-w-xs"
        />
        <p className="text-xs tabular-nums text-muted-foreground">
          {rows.length === events.length ? `${events.length} événements` : `${rows.length} sur ${events.length} événements`}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="w-36 px-4 py-2 font-medium" aria-sort={newestFirst ? "descending" : "ascending"}>
                <button type="button" onClick={() => setNewestFirst(!newestFirst)} className="inline-flex items-center gap-1 hover:text-foreground">
                  Quand <span aria-hidden>{newestFirst ? "↓" : "↑"}</span>
                </button>
              </th>
              <th className="w-48 px-4 py-2 font-medium">Qui</th>
              <th className="w-44 px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Détail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((event, i) => (
              <tr key={`${event.at}-${event.actor.id}-${event.verb}-${i}`} className="border-t border-border align-top">
                <td className="px-4 py-2 whitespace-nowrap tabular-nums text-muted-foreground">{when(event.at)}</td>
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    {event.actor.harness
                      ? <Persona harness={event.actor.harness} size="sm" role={event.actor.kind === "lead" ? "lead" : "lane"} />
                      : <span aria-hidden className="inline-block h-6 w-6 shrink-0 rounded-full bg-muted" />}
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{event.actor.project ?? "—"}</span>
                      <span className="block text-xs text-muted-foreground">{actorLabel(event)}</span>
                    </span>
                  </span>
                </td>
                <td className="px-4 py-2">{event.verb}</td>
                <td className="px-4 py-2 break-words text-muted-foreground">{event.text || "—"}</td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr className="border-t border-border">
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">Aucun événement ne correspond.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pager page={current} pages={pages} total={rows.length} size={PAGE_SIZE} onPage={setPage} />
    </Card>
  );
}

function actorLabel(event: DashEvent): string {
  if (event.actor.kind === "lead") return "Kiba";
  if (event.actor.kind === "log") return "note Kiba";
  return "lane";
}

function haystack(event: DashEvent): string {
  return [event.actor.project, event.actor.kind, event.actor.harness, event.verb, event.text].filter(Boolean).join(" ").toLowerCase();
}
