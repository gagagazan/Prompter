import { describe, expect, it } from "vitest";
import { resolveSurface } from "./appSurface";

describe("surface resolution", () => {
  it("prefers an explicit query surface over the Tauri window label", () => {
    expect(resolveSurface("?surface=launcher", "settings")).toBe("launcher");
  });

  it("uses a known Tauri label and safely defaults to manager", () => {
    expect(resolveSurface("", "settings")).toBe("settings");
    expect(resolveSurface("?surface=unknown", "main")).toBe("manager");
  });
});
