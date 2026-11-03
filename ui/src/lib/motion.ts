export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function lowPower(): boolean {
  if (typeof navigator === "undefined") return false;
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return cores <= 2 || (typeof memory === "number" && memory <= 2);
}

export type ViewMode = "3d" | "2d";

export function storedView(): ViewMode | null {
  try {
    const v = localStorage.getItem("orch-dash-view");
    return v === "2d" || v === "3d" ? v : null;
  } catch {
    return null;
  }
}

export function storeView(mode: ViewMode) {
  try { localStorage.setItem("orch-dash-view", mode); } catch { /* ignore */ }
}

export function hasWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function initialView(): ViewMode {
  const stored = storedView();
  if (stored === "2d") return "2d";
  if (prefersReducedMotion() || lowPower() || !hasWebGL()) return "2d";
  return stored ?? "3d";
}
