import { Link, useParams } from "react-router-dom";
import { Page } from "../components/Page";
import { Badge, Card, PageHead } from "../components/ui";
import { Persona } from "../components/Persona";
import { harnessLabel, lifeLabel, money, tokens, uptime, when } from "../lib/format";

export function LanePage() {
  const { id = "" } = useParams();
  const laneId = decodeURIComponent(id);

  return (
    <Page crumbs={["orch", "kev", "Lanes", laneId]}>
      {(snap) => {
        const lane = snap.lanes.find((row) => row.id === laneId);
        if (!lane) {
          return (
            <div className="px-6 py-10">
              <h1 className="text-lg font-semibold">Lane introuvable</h1>
              <Link className="mt-3 inline-block text-sm underline" to="/runs">Retour aux lanes</Link>
            </div>
          );
        }
        const working = snap.working.find((row) => row.laneId === lane.id);
        const events = snap.activity.filter((e) => e.actor.id === lane.id || (e.actor.project === lane.project && e.actor.kind === "log"));
        const logs = snap.logs.filter((l) => l.project === lane.project);
        return (
          <div>
            <PageHead
              title={`Lane / ${lane.id}`}
              subtitle={`${harnessLabel(lane.harness)} · ${lane.project} · ${lane.model}`}
              live={lane.life === "running" || lane.life === "verify"}
              actions={
                <Badge tone={lane.blocked ? "danger" : lane.life === "failed" ? "danger" : "muted"}>
                  {lifeLabel(lane.life)}
                </Badge>
              }
            />
            {lane.blocked ? (
              <p className="mx-6 mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="status">
                Bloquée — la lane attend une décision, elle ne progresse plus.
              </p>
            ) : null}
            <div className="grid gap-3 px-6 pb-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
              <Card className="p-4">
                <h2 className="text-sm font-medium">Trace des étapes</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {working
                    ? `${working.toolCalls == null ? "appels inconnus" : `${working.toolCalls} appels${working.live ? "" : " estimés"}`} · ${uptime(working.elapsedSec)}${working.live ? ` · effort ${working.effort ?? "—"}` : ""}`
                    : "Dernier état connu, pas de flux d'outils en direct."}
                </p>
                <ol className="mt-4 space-y-3">
                  {(working?.steps ?? [{ label: "État connu", durationSec: lane.durationSec ?? 0 }]).map((step) => (
                    <li key={step.label} className="rounded-lg border border-border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">{step.label}</span>
                        <span className="tabular-nums text-xs text-muted-foreground">{uptime(step.durationSec)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
                {working?.stream.length ? (
                  <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
                    {working.stream.map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}
                  </ul>
                ) : null}
                <h3 className="mt-6 text-sm font-medium">Journal</h3>
                <ol className="mt-2 space-y-2 text-sm">
                  {events.slice(0, 12).map((event, i) => (
                    <li key={`${event.at}-${i}`} className="flex gap-2">
                      {event.actor.harness ? <Persona harness={event.actor.harness} size="sm" /> : <span className="h-6 w-6 rounded-full bg-muted" />}
                      <span>
                        <span className="font-medium">{event.verb}</span>
                        <span className="text-muted-foreground"> {event.text}</span>
                        <span className="block text-[11px] text-muted-foreground">{when(event.at)}</span>
                      </span>
                    </li>
                  ))}
                  {logs.filter((l) => !events.some((e) => e.text === l.text)).slice(0, 4).map((log) => (
                    <li key={`${log.at}-${log.kind}`} className="text-muted-foreground">{log.kind} · {log.text}</li>
                  ))}
                </ol>
              </Card>
              <Card className="p-4">
                <h2 className="text-sm font-medium">Propriétés</h2>
                <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Cycle</dt><dd>{lifeLabel(lane.life)}</dd>
                  <dt className="text-muted-foreground">Statut</dt><dd>{lane.status}</dd>
                  <dt className="text-muted-foreground">Modèle</dt><dd>{lane.model}</dd>
                  <dt className="text-muted-foreground">Effort</dt><dd>{lane.effort ?? "—"}</dd>
                  <dt className="text-muted-foreground">Coût</dt><dd className="tabular-nums">{money(lane.costUsd)}</dd>
                  <dt className="text-muted-foreground">Durée</dt><dd>{uptime(lane.durationSec)}</dd>
                  <dt className="text-muted-foreground">VERIFY</dt><dd>{lane.verifyOk == null ? "en attente" : lane.verifyOk ? "ok" : "échec"}</dd>
                  <dt className="text-muted-foreground">Worktree</dt><dd className="break-all">{lane.worktree}</dd>
                  <dt className="text-muted-foreground">Tokens</dt>
                  <dd className="tabular-nums">in {tokens(lane.tokens.input)} / out {tokens(lane.tokens.output)}</dd>
                </dl>
              </Card>
            </div>
          </div>
        );
      }}
    </Page>
  );
}
