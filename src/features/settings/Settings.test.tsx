import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import { markDirtyEditor } from "../../lib/dirtyEditor";
import type { AppSettings, DesktopBridge } from "../../lib/desktopBridge";
import { Settings } from "./Settings";

afterEach(() => {
  vi.restoreAllMocks();
});

const settings: AppSettings = {
  language: "system",
  launchAtLogin: false,
  globalShortcut: "⌘⇧P",
  shortcutStatus: "ready",
  libraryRoot: {
    id: "root-demo",
    displayPath: "/Demo/Prompts",
    status: "ready",
  },
  fileExtension: ".prompt",
  promptCount: 24,
  folderCount: 3,
};

function makeBridge(initial = settings) {
  let current = initial;
  return {
    librarySnapshot: vi.fn(),
    libraryRead: vi.fn(),
    librarySearch: vi.fn(),
    libraryMutate: vi.fn(),
    chooseLibraryRoot: vi.fn().mockResolvedValue(initial),
    copyPrompt: vi.fn(),
    openPrompt: vi.fn(),
    revealPrompt: vi.fn().mockResolvedValue(undefined),
    settingsGet: vi.fn().mockResolvedValue(initial),
    settingsUpdate: vi.fn().mockImplementation(async (patch) => {
      current = { ...current, ...patch };
      return current;
    }),
    showWindow: vi.fn().mockResolvedValue(undefined),
    closeCurrentWindow: vi.fn().mockResolvedValue(undefined),
    onLibraryUpdate: vi.fn().mockResolvedValue(() => undefined),
    onSettingsUpdate: vi.fn().mockResolvedValue(() => undefined),
  } satisfies DesktopBridge;
}

describe("Settings", () => {
  it("closes the Settings window with Escape", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await screen.findByRole("heading", { name: "Prompt library" });
    await user.keyboard("{Escape}");

    expect(bridge.closeCurrentWindow).toHaveBeenCalledOnce();
  });

  it("shows only the settings that belong to the selected category", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Prompt library" }),
    ).toBeVisible();
    expect(screen.queryByText("Global shortcut")).toBeNull();
    expect(screen.queryByText("Choose the interface language")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Shortcut" }));
    expect(screen.getByRole("heading", { name: "Shortcut" })).toBeVisible();
    expect(screen.getByText("Global shortcut")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Prompt library" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Language" }));
    expect(screen.getByRole("heading", { name: "Language" })).toBeVisible();
    expect(screen.getByText("Choose the interface language")).toBeVisible();
    expect(screen.queryByText("Global shortcut")).toBeNull();
  });

  it("does not repeat the native Settings window title inside the page", async () => {
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={makeBridge()} />
      </I18nProvider>,
    );

    await screen.findByRole("heading", { name: "Prompt library" });
    expect(document.querySelector(".settings-titlebar")).toBeNull();
  });

  it("refreshes confirmed settings after settings and library events", async () => {
    let settingsListener: (() => void) | undefined;
    let libraryListener: (() => void) | undefined;
    const bridge = makeBridge();
    bridge.onSettingsUpdate = vi.fn().mockImplementation(async (listener) => {
      settingsListener = listener;
      return () => undefined;
    });
    bridge.onLibraryUpdate = vi.fn().mockImplementation(async (listener) => {
      libraryListener = listener;
      return () => undefined;
    });
    bridge.settingsGet = vi
      .fn()
      .mockResolvedValueOnce(settings)
      .mockResolvedValue({
        ...settings,
        shortcutStatus: "unavailable",
        promptCount: 25,
        folderCount: 4,
      });
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );
    await screen.findByText("Found 24 prompts and 3 folders");

    await act(async () => settingsListener?.());
    expect(
      await screen.findByText(
        "The configured shortcut is unavailable. Choose another shortcut to restore launcher access.",
      ),
    ).toBeVisible();

    await act(async () => libraryListener?.());
    expect(await screen.findByText("Found 25 prompts and 4 folders")).toBeVisible();
  });

  it("remains usable when optional update subscriptions reject", async () => {
    const bridge = makeBridge();
    bridge.onSettingsUpdate = vi.fn().mockRejectedValue(new Error("listen failed"));
    bridge.onLibraryUpdate = vi.fn().mockRejectedValue(new Error("listen failed"));

    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Prompt library")).toBeVisible();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("defaults login launch off and persists a general setting", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "General" }));
    const launchToggle = await screen.findByRole("switch", {
      name: "Launch at login",
    });
    expect(launchToggle).not.toBeChecked();
    await user.click(launchToggle);

    await waitFor(() =>
      expect(bridge.settingsUpdate).toHaveBeenCalledWith({
        launchAtLogin: true,
      }),
    );
  });

  it("restores confirmed settings and explains a failed update", async () => {
    const bridge = makeBridge();
    bridge.settingsUpdate = vi.fn().mockRejectedValue(new Error("write failed"));
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "General" }));
    const launchToggle = screen.getByRole("switch", {
      name: "Launch at login",
    });
    await user.click(launchToggle);

    expect(
      await screen.findByText(
        "Couldn't save settings. Your confirmed settings were restored.",
      ),
    ).toBeVisible();
    expect(launchToggle).not.toBeChecked();
  });

  it("restores confirmed settings with a Chinese update error", async () => {
    const bridge = makeBridge({ ...settings, language: "zh-CN" });
    bridge.settingsUpdate = vi.fn().mockRejectedValue(new Error("write failed"));
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="zh-CN">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "常规" }));
    const launchToggle = screen.getByRole("switch", { name: "登录时启动" });
    await user.click(launchToggle);

    expect(
      await screen.findByText("无法保存设置，已恢复上次确认的设置。"),
    ).toBeVisible();
    expect(launchToggle).not.toBeChecked();
  });

  it("captures a cross-platform shortcut from keyboard input", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    const dialog = screen.getByRole("dialog", { name: "Record shortcut" });
    expect(dialog).toHaveTextContent("Press your new shortcut now.");

    fireEvent.keyDown(dialog, {
      code: "KeyP",
      key: "p",
      metaKey: true,
      shiftKey: true,
    });

    await waitFor(() =>
      expect(bridge.settingsUpdate).toHaveBeenCalledWith({
        globalShortcut: "Super+Shift+P",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Record shortcut" })).toBeNull();
    expect(
      await screen.findByText("Super+Shift+P", { selector: "kbd" }),
    ).toBeVisible();
  });

  it.each([
    [
      "number",
      { code: "Digit7", ctrlKey: true, key: "7", shiftKey: true },
      "Ctrl+Shift+7",
    ],
    ["function key", { altKey: true, code: "F24", key: "F24" }, "Alt+F24"],
    ["Space", { code: "Space", key: " ", metaKey: true }, "Super+Space"],
  ])("captures a supported %s accelerator", async (_label, key, expected) => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Record shortcut" }),
      key,
    );

    await waitFor(() =>
      expect(bridge.settingsUpdate).toHaveBeenCalledWith({
        globalShortcut: expected,
      }),
    );
  });

  it("keeps waiting when only a modifier key is pressed", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    const dialog = screen.getByRole("dialog", { name: "Record shortcut" });
    fireEvent.keyDown(dialog, {
      code: "ControlLeft",
      key: "Control",
      ctrlKey: true,
    });

    expect(bridge.settingsUpdate).not.toHaveBeenCalled();
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent("Waiting for keys…");
  });

  it("preserves simultaneous Ctrl and Meta modifiers", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Record shortcut" }),
      {
        code: "KeyK",
        ctrlKey: true,
        key: "k",
        metaKey: true,
      },
    );

    await waitFor(() =>
      expect(bridge.settingsUpdate).toHaveBeenCalledWith({
        globalShortcut: "Ctrl+Super+K",
      }),
    );
  });

  it("cancels shortcut capture with Escape", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    const dialog = screen.getByRole("dialog", { name: "Record shortcut" });
    fireEvent.keyDown(dialog, { code: "Escape", key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Record shortcut" })).toBeNull();
    expect(bridge.settingsUpdate).not.toHaveBeenCalled();
    expect(bridge.closeCurrentWindow).not.toHaveBeenCalled();
    expect(screen.getByText("⌘⇧P", { selector: "kbd" })).toBeVisible();
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("lets %s activate the focused Cancel button", async (_label, key) => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard(key);

    expect(screen.queryByRole("dialog", { name: "Record shortcut" })).toBeNull();
    expect(bridge.settingsUpdate).not.toHaveBeenCalled();
  });

  it("shows a validation error when the required modifier is missing", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    const dialog = screen.getByRole("dialog", { name: "Record shortcut" });
    fireEvent.keyDown(dialog, {
      code: "KeyP",
      key: "P",
      shiftKey: true,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Include Ctrl, Command, or Alt.",
    );
    expect(dialog).toBeVisible();
    expect(bridge.settingsUpdate).not.toHaveBeenCalled();
  });

  it("localizes shortcut capture guidance and validation in Chinese", async () => {
    const bridge = makeBridge({ ...settings, language: "zh-CN" });
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="zh-CN">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "快捷键" }));
    await user.click(screen.getByRole("button", { name: "更改…" }));
    const dialog = screen.getByRole("dialog", { name: "录入快捷键" });
    expect(dialog).toHaveTextContent("等待按键…");
    fireEvent.keyDown(dialog, {
      code: "KeyP",
      key: "P",
      shiftKey: true,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "请包含 Ctrl、Command 或 Alt。",
    );
  });

  it("rejects keys outside the supported accelerator set", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    const dialog = screen.getByRole("dialog", { name: "Record shortcut" });
    fireEvent.keyDown(dialog, {
      code: "ArrowUp",
      key: "ArrowUp",
      ctrlKey: true,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Use a letter, number, F1–F24, or Space.",
    );
    expect(bridge.settingsUpdate).not.toHaveBeenCalled();
  });

  it("rolls back to the previous shortcut when registration conflicts", async () => {
    const bridge = makeBridge();
    bridge.settingsUpdate = vi.fn().mockRejectedValue(new Error("shortcut busy"));
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Record shortcut" }),
      {
        altKey: true,
        code: "KeyP",
        ctrlKey: true,
        key: "p",
      },
    );

    expect(
      await screen.findByText(
        "That shortcut is unavailable. Your previous shortcut is still active.",
      ),
    ).toBeVisible();
    expect(screen.getByText("⌘⇧P", { selector: "kbd" })).toBeVisible();
    expect(
      screen.queryByText("Ctrl+Alt+P", { selector: "kbd" }),
    ).toBeNull();
  });

  it("reports when the confirmed shortcut could not be registered at startup", async () => {
    const bridge = makeBridge({
      ...settings,
      shortcutStatus: "unavailable",
    });
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    expect(
      await screen.findByText(
        "The configured shortcut is unavailable. Choose another shortcut to restore launcher access.",
      ),
    ).toBeVisible();
  });

  it("clears the startup shortcut warning after a replacement is registered", async () => {
    const unavailableSettings: AppSettings = {
      ...settings,
      shortcutStatus: "unavailable",
    };
    const bridge = makeBridge(unavailableSettings);
    bridge.settingsUpdate = vi.fn().mockResolvedValue({
      ...unavailableSettings,
      globalShortcut: "Ctrl+Alt+P",
      shortcutStatus: "ready",
    });
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    expect(
      await screen.findByText(
        "The configured shortcut is unavailable. Choose another shortcut to restore launcher access.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Shortcut" }));
    await user.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Record shortcut" }),
      {
        altKey: true,
        code: "KeyP",
        ctrlKey: true,
        key: "p",
      },
    );

    expect(
      await screen.findByText("Ctrl+Alt+P", { selector: "kbd" }),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "The configured shortcut is unavailable. Choose another shortcut to restore launcher access.",
      ),
    ).toBeNull();
  });

  it("switches the whole interface language and persists the preference", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await screen.findByText("Prompt library");
    await user.click(screen.getByRole("button", { name: "Language" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Language" }),
      "zh-CN",
    );

    expect(await screen.findByText("选择界面语言")).toBeVisible();
    expect(bridge.settingsUpdate).toHaveBeenCalledWith({ language: "zh-CN" });
  });

  it("renders a directory error and disables reveal", async () => {
    const bridge = makeBridge({
      ...settings,
      libraryRoot: {
        ...settings.libraryRoot,
        status: "missing",
        errorCode: "not_found",
      },
    });
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    expect(
      await screen.findByText("The directory does not exist or cannot be accessed."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show in file manager" }),
    ).toBeDisabled();
  });

  it("shows a localized error when the library folder cannot be revealed", async () => {
    const bridge = makeBridge();
    bridge.revealPrompt = vi
      .fn()
      .mockRejectedValue(new Error("file manager unavailable"));
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(
      await screen.findByRole("button", { name: "Show in file manager" }),
    );

    expect(
      await screen.findByText(
        "Couldn't show the prompt library in the file manager. Try again.",
      ),
    ).toBeVisible();
  });

  it("keeps the settings window usable when hiding it fails", async () => {
    const bridge = makeBridge();
    bridge.closeCurrentWindow = vi
      .fn()
      .mockRejectedValue(new Error("presenter unavailable"));
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Done" }));

    expect(
      await screen.findByText("Couldn't close Settings. Try again."),
    ).toBeVisible();
  });

  it("blocks changing the library root while another window has a dirty editor", async () => {
    const bridge = makeBridge();
    bridge.chooseLibraryRoot = vi.fn().mockImplementation(async () => {
      throw { code: "dirty_editor" };
    });
    markDirtyEditor();
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="en">
        <Settings bridge={bridge} />
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Change directory…" }));
    expect(
      await screen.findByText(
        "Handle the unsaved prompt in the manager before changing the library folder.",
      ),
    ).toBeVisible();
    localStorage.clear();
  });
});
