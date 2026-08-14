import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppSurface } from "./App";
import { I18nProvider } from "./i18n/I18nProvider";
import type { AppSettings, DesktopBridge } from "./lib/desktopBridge";

describe("AppSurface", () => {
  it.each([
    ["macOS", { metaKey: true }],
    ["Windows", { ctrlKey: true }],
  ])("opens Settings with the %s primary shortcut", async (_platform, modifier) => {
    const bridge = {
      settingsGet: vi.fn().mockRejectedValue(new Error("not needed")),
      librarySearch: vi.fn().mockResolvedValue([]),
      showWindow: vi.fn().mockResolvedValue(undefined),
      closeCurrentWindow: vi.fn().mockResolvedValue(undefined),
      onLibraryUpdate: vi.fn().mockResolvedValue(() => undefined),
      onSettingsUpdate: vi.fn().mockResolvedValue(() => undefined),
    } as unknown as DesktopBridge;

    render(
      <I18nProvider initialLocale="en">
        <AppSurface bridge={bridge} surface="launcher" />
      </I18nProvider>,
    );
    await screen.findByText("Manage library");

    fireEvent.keyDown(window, { key: ",", code: "Comma", ...modifier });

    await waitFor(() => expect(bridge.showWindow).toHaveBeenCalledWith("settings"));
  });

  it("updates a resident window language when settings change elsewhere", async () => {
    let settingsListener: (() => void) | undefined;
    const settings: AppSettings = {
      language: "en",
      launchAtLogin: false,
      globalShortcut: "⌘⇧P",
      shortcutStatus: "ready",
      libraryRoot: { id: "root", displayPath: "/Demo", status: "ready" },
      fileExtension: ".prompt",
      promptCount: 0,
      folderCount: 0,
    };
    const bridge = {
      settingsGet: vi.fn().mockResolvedValue(settings),
      librarySearch: vi.fn().mockResolvedValue([]),
      onLibraryUpdate: vi.fn().mockResolvedValue(() => undefined),
      onSettingsUpdate: vi.fn().mockImplementation(async (listener) => {
        settingsListener = listener;
        return () => undefined;
      }),
    } as unknown as DesktopBridge;

    render(
      <I18nProvider initialLocale="en">
        <AppSurface bridge={bridge} surface="launcher" />
      </I18nProvider>,
    );
    expect(await screen.findByText("Manage library")).toBeVisible();

    bridge.settingsGet = vi.fn().mockResolvedValue({
      ...settings,
      language: "zh-CN",
    });
    settingsListener?.();

    await waitFor(() => expect(screen.getByText("管理文件库")).toBeVisible());
  });

  it("contains rejected settings subscriptions and refreshes", async () => {
    let settingsListener: (() => void) | undefined;
    const bridge = {
      settingsGet: vi.fn().mockResolvedValue({
        language: "en",
        launchAtLogin: false,
        globalShortcut: "Ctrl+Shift+P",
        shortcutStatus: "ready",
        libraryRoot: { id: "root", displayPath: "/Demo", status: "ready" },
        fileExtension: ".prompt",
        promptCount: 0,
        folderCount: 0,
      }),
      librarySearch: vi.fn().mockResolvedValue([]),
      onLibraryUpdate: vi.fn().mockResolvedValue(() => undefined),
      onSettingsUpdate: vi.fn().mockImplementation(async (listener) => {
        settingsListener = listener;
        return () => undefined;
      }),
    } as unknown as DesktopBridge;
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    const view = render(
      <I18nProvider initialLocale="en">
        <AppSurface bridge={bridge} surface="launcher" />
      </I18nProvider>,
    );
    await screen.findByText("Manage library");
    bridge.settingsGet = vi.fn().mockRejectedValue(new Error("read failed"));
    await act(async () => settingsListener?.());
    await Promise.resolve();
    view.unmount();

    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("contains a settings subscription setup rejection", async () => {
    const bridge = {
      settingsGet: vi.fn().mockRejectedValue(new Error("read failed")),
      librarySearch: vi.fn().mockResolvedValue([]),
      onLibraryUpdate: vi.fn().mockResolvedValue(() => undefined),
      onSettingsUpdate: vi.fn().mockRejectedValue(new Error("listen failed")),
    } as unknown as DesktopBridge;
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    const view = render(
      <I18nProvider initialLocale="en">
        <AppSurface bridge={bridge} surface="launcher" />
      </I18nProvider>,
    );
    await screen.findByText("Manage library");
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();

    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
