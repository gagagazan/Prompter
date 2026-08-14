import type { WindowLabel } from "./lib/desktopBridge";

const surfaces = new Set<WindowLabel>(["launcher", "manager", "settings"]);

export function resolveSurface(search: string, windowLabel?: string): WindowLabel {
  const requested = new URLSearchParams(search).get("surface");
  if (requested && surfaces.has(requested as WindowLabel)) {
    return requested as WindowLabel;
  }
  if (windowLabel && surfaces.has(windowLabel as WindowLabel)) {
    return windowLabel as WindowLabel;
  }
  return "manager";
}
