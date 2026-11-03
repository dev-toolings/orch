import type { ReactNode } from "react";
import { useSnapshot } from "../api";
import type { DashSnapshot } from "../types";
import { AppShell } from "./AppShell";
import { ErrorState, LoadingState } from "./States";

export function Page({
  children,
  crumbs,
}: {
  children: (snap: DashSnapshot) => ReactNode;
  crumbs?: string[];
}) {
  const state = useSnapshot();
  const snap = state.status === "ok" ? state.snap : null;
  return (
    <AppShell snap={snap} stream={state.stream} crumbs={crumbs}>
      {state.status === "loading" ? <LoadingState /> : null}
      {state.status === "error" ? <ErrorState message={state.message} /> : null}
      {snap ? children(snap) : null}
    </AppShell>
  );
}
