import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { tabDescription, tabTitle } from "./lib/routes";
import { OverviewPage } from "./pages/Overview";

const RunsPage = lazy(async () => import("./pages/Runs").then((mod) => ({ default: mod.RunsPage })));
const LanePage = lazy(async () => import("./pages/Lane").then((mod) => ({ default: mod.LanePage })));
const ApprovalsPage = lazy(async () => import("./pages/Approvals").then((mod) => ({ default: mod.ApprovalsPage })));
const AgentsPage = lazy(async () => import("./pages/Agents").then((mod) => ({ default: mod.AgentsPage })));
const ToolsPage = lazy(async () => import("./pages/Tools").then((mod) => ({ default: mod.ToolsPage })));
const ProvidersPage = lazy(async () => import("./pages/Providers").then((mod) => ({ default: mod.ProvidersPage })));
const SpendPage = lazy(async () => import("./pages/Spend").then((mod) => ({ default: mod.SpendPage })));
const ActivityPage = lazy(async () => import("./pages/Activity").then((mod) => ({ default: mod.ActivityPage })));
const BusPage = lazy(async () => import("./pages/Bus").then((mod) => ({ default: mod.BusPage })));
const SkillsPage = lazy(async () => import("./pages/Skills").then((mod) => ({ default: mod.SkillsPage })));
const FluxPage = lazy(async () => import("./pages/Flux").then((mod) => ({ default: mod.FluxPage })));
const FloorPage = lazy(async () => import("./pages/Floor").then((mod) => ({ default: mod.FloorPage })));

function LegacyLane() {
  const { id = "" } = useParams();
  return <Navigate to={`/runs/${id}`} replace />;
}

/** Names the browser tab and sets the page description after the current route. */
function TabTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = tabTitle(pathname);
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.content = tabDescription(pathname);
  }, [pathname]);
  return null;
}

function RouteFallback() {
  return <div className="p-4 text-sm text-muted-foreground">Chargement...</div>;
}

export function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <TabTitle />
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<LanePage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/spend" element={<SpendPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/bus" element={<BusPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/atelier" element={<FloorPage />} />
        <Route path="/flux" element={<FluxPage />} />
        <Route path="/runtimes" element={<Navigate to="/spend" replace />} />
        <Route path="/projects/:name" element={<Navigate to="/runs" replace />} />
        <Route path="/projects/:name/lanes/:id" element={<LegacyLane />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
