import { useMemo } from "react";
import type { DashTask, DashSnapshot, DashSubagent, LeadActivity, Selection } from "../types";
import { harnessLabel } from "../lib/format";
import { AgentBloub } from "../components/Bloub";
import type { Role } from "../lib/bloub";
import { ACTIVITY_HEX, ago, buildRoom, deskTasks, taskLine, lastWord, laneActivity, type RoomDesk } from "../lib/room";

// Top view of the same room: one plan tile per desk, same paper palette as
// the scale model, so switching view keeps every place and colour.
export function Floor2D({
  snap,
  selection,
  onSelect,
}: {
  snap: DashSnapshot;
  selection: Selection;
  onSelect: (next: Selection) => void;
}) {
  const room = useMemo(() => buildRoom(snap), [snap]);
  if (!room.desks.length) return null;
  return (
    <div className="flex min-h-full items-start justify-center p-4 pb-16">
      <div
        className="grid w-full max-w-[110rem] gap-3 rounded-[14px] bg-[#d9d4cb] p-3"
        style={{ gridTemplateColumns: `repeat(${room.cols}, minmax(0, 1fr))` }}
      >
        {room.desks.map((desk) => (
          <PlanTile
            key={desk.project}
            desk={desk}
            word={lastWord(room, desk.project)}
            tasks={deskTasks(snap, desk)}
            subagents={snap.subagents ?? []}
            selection={selection}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function PlanTile({
  desk,
  word,
  tasks,
  subagents,
  selection,
  onSelect,
}: {
  desk: RoomDesk;
  word: ReturnType<typeof lastWord>;
  tasks: DashTask[];
  subagents: DashSubagent[];
  selection: Selection;
  onSelect: (next: Selection) => void;
}) {
  const selected = selection?.kind === "project" && selection.name === desk.project;
  return (
    <section
      className={`relative flex min-h-56 flex-col rounded-[10px] bg-[#e6e2da] p-4 text-[#1f1d1a] ${selected ? "outline-2 outline-[#1f1d1a]" : ""}`}
      aria-label={desk.project}
    >
      <div className="min-h-16">
        {word ? (
          <div className="atelier-bubble" data-plan data-tone={word.tone}>
            <p className="atelier-bubble-who">
              <span>{word.speaker.name}</span>
              <time dateTime={word.at}>{ago(word.at)}</time>
            </p>
            <p className="atelier-bubble-text">{word.text}</p>
          </div>
        ) : null}
      </div>
      <div className="mt-5 flex flex-1 items-center gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap gap-3">
            {desk.leads.map((lead) => (
              <div key={lead.id} className="min-w-0 max-w-full">
                <Token
                  harness={lead.harness}
                  activity={lead.activity}
                  role="lead"
                  size="lg"
                  selected={selection?.kind === "lead" && selection.id === lead.id}
                  label={`Kiba ${harnessLabel(lead.harness)}, ${desk.project}`}
                  onClick={() => onSelect({ kind: "lead", id: lead.id })}
                />
                <ul aria-label="Native subagents" className="mt-2 max-w-64 space-y-1 break-words text-xs">
                  {subagents.filter((agent) => lead.pid !== null && agent.lead_pid === lead.pid).map((agent) => (
                    <li key={`${agent.session}:${agent.agent_id}`}>
                      {agent.agent_type || agent.agent_id}: {agent.running ? "running" : "finished"}
                      {agent.last_assistant_message ? <p>{agent.last_assistant_message}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div aria-hidden className="h-7 w-32 rounded-[4px] bg-[#f6f3ee] shadow-[0_2px_4px_rgb(20_16_10/0.18)]" />
        </div>
        {desk.lanes.length ? (
          <div className="grid grid-flow-col grid-rows-3 gap-2 border-l border-dashed border-[#1f1d1a]/30 pl-5">
            {desk.lanes.map((lane) => (
              <Token
                key={lane.id}
                harness={lane.harness}
                activity={laneActivity(lane)}
                role="lane"
                size="sm"
                selected={selection?.kind === "lane" && selection.id === lane.id}
                label={`Lane ${harnessLabel(lane.harness)}, ${desk.project}`}
                onClick={() => onSelect({ kind: "lane", id: lane.id })}
              />
            ))}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onSelect({ kind: "project", name: desk.project })}
        className="mt-4 self-start rounded-md text-left text-sm font-semibold tracking-tight hover:underline focus-visible:outline-2 focus-visible:outline-[#1f1d1a]"
      >
        {desk.project}
      </button>
      {tasks.length ? (
        <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-[#1f1d1a]/70">
          {tasks.map((i) => (
            <li key={i.id} className="truncate" title={i.progress?.lastText ?? i.objective}>
              <span className="font-mono">{i.id}</span> · {taskLine(i)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Token({
  harness,
  activity,
  role,
  size,
  selected,
  label,
  onClick,
}: {
  harness: string;
  activity: LeadActivity;
  role: Role;
  size: "lg" | "sm";
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  const dim = size === "lg" ? "h-10 w-10" : "h-7 w-7";
  const halo = activity === "idle" ? "transparent" : ACTIVITY_HEX[activity];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      className={`${dim} relative flex items-end justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1f1d1a] ${selected ? "-translate-y-0.5" : ""}`}
      style={{
        background: role === "lead" ? "#1f1d1a" : "#fffdf9",
        boxShadow: `0 0 0 3px #e6e2da, 0 0 0 5px ${halo}${selected ? ", 0 0 0 8px #e6e2da, 0 0 0 9.5px #1f1d1a" : ""}`,
      }}
    >
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <AgentBloub harness={harness} activity={activity} role={role} size={size === "lg" ? 40 : 28} />
      </span>
    </button>
  );
}
