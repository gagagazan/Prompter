import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import type { DesktopBridge, PromptSummary } from "../../lib/desktopBridge";
import { Launcher } from "./Launcher";

const results: PromptSummary[] = [
  {
    id: "prompt-review",
    name: "Code review",
    folderName: "Engineering",
    modifiedAt: "2026-08-12T08:00:00.000Z",
    preview: "Review correctness, readability, and risk.",
  },
  {
    id: "prompt-debug",
    name: "Debug an issue",
    folderName: "Engineering",
    modifiedAt: "2026-08-11T08:00:00.000Z",
    preview: "Find the cause before proposing a fix.",
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function launcherBridge() {
  return {
    librarySearch: vi.fn().mockResolvedValue(results),
    copyPrompt: vi.fn().mockResolvedValue(undefined),
    closeCurrentWindow: vi.fn().mockResolvedValue(undefined),
    showWindow: vi.fn().mockResolvedValue(undefined),
    onLibraryUpdate: vi.fn().mockResolvedValue(() => undefined),
    onSettingsUpdate: vi.fn().mockResolvedValue(() => undefined),
  } as unknown as DesktopBridge;
}

describe("Launcher", () => {
  it("renders the brand as a non-draggable image instead of selectable text", async () => {
    render(
      <I18nProvider initialLocale="en">
        <Launcher bridge={launcherBridge()} />
      </I18nProvider>,
    );

    await screen.findByText("Code review");
    const lockup = screen.getByText("Prompter").closest(".brand-lockup");
    const mark = lockup?.querySelector("img");
    expect(mark).toHaveAttribute("src", "/prompter.svg");
    expect(mark).toHaveAttribute("draggable", "false");
  });

  it("shows recent prompts and closes immediately after copying the selection", async () => {
    const bridge = launcherBridge();
    const copyResult = deferred<void>();
    vi.mocked(bridge.copyPrompt).mockReturnValue(copyResult.promise);
    const user = userEvent.setup();

    render(
      <I18nProvider initialLocale="en">
        <Launcher bridge={bridge} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Code review")).toBeVisible();
    expect(bridge.librarySearch).toHaveBeenCalledWith("");

    await user.keyboard("{ArrowDown}{Enter}");

    expect(bridge.copyPrompt).toHaveBeenCalledWith("prompt-debug");
    expect(bridge.closeCurrentWindow).not.toHaveBeenCalled();
    await act(async () => {
      copyResult.resolve();
    });
    expect(bridge.closeCurrentWindow).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not render decorative chevrons on prompt results", async () => {
    const { container } = render(
      <I18nProvider initialLocale="en">
        <Launcher bridge={launcherBridge()} />
      </I18nProvider>,
    );

    await screen.findByText("Code review");
    expect(container.querySelector(".lucide-chevron-right")).toBeNull();
  });

  it("closes on Escape without copying", async () => {
    const bridge = launcherBridge();
    const user = userEvent.setup();

    render(
      <I18nProvider initialLocale="en">
        <Launcher bridge={bridge} />
      </I18nProvider>,
    );
    await screen.findByText("Code review");
    await user.keyboard("{Escape}");

    expect(bridge.closeCurrentWindow).toHaveBeenCalledOnce();
    expect(bridge.copyPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ["en" as const, "Prompt library unavailable", "Manage library"],
    ["zh-CN" as const, "Prompt 文件库不可用", "管理文件库"],
  ])(
    "shows a localized library recovery action when search rejects in %s",
    async (locale, title, manageLabel) => {
      const bridge = launcherBridge();
      vi.mocked(bridge.librarySearch).mockRejectedValue({
        code: "rootNotConfigured",
        message: "Choose a library folder.",
      });
      const user = userEvent.setup();

      render(
        <I18nProvider initialLocale={locale}>
          <Launcher bridge={bridge} />
        </I18nProvider>,
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(title);

      const manageButtons = screen.getAllByRole("button", {
        name: manageLabel,
      });
      await user.click(manageButtons[manageButtons.length - 1]);

      expect(bridge.showWindow).toHaveBeenCalledWith("manager");
      expect(bridge.closeCurrentWindow).toHaveBeenCalledOnce();
    },
  );

  it("does not expose unreadable prompts in launcher results", async () => {
    const bridge = launcherBridge();
    vi.mocked(bridge.librarySearch).mockResolvedValue([
      results[0],
      {
        ...results[1],
        id: "broken-prompt",
        name: "Broken prompt.prompt",
        health: "issue",
      },
    ]);

    render(
      <I18nProvider initialLocale="en">
        <Launcher bridge={bridge} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Code review")).toBeVisible();
    expect(screen.queryByText("Broken prompt")).not.toBeInTheDocument();
  });

  it("keeps the newest query results when an older request resolves last", async () => {
    const bridge = launcherBridge();
    const initial = deferred<PromptSummary[]>();
    const latest = deferred<PromptSummary[]>();
    vi.mocked(bridge.librarySearch)
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => latest.promise);

    render(
      <I18nProvider initialLocale="en">
        <Launcher bridge={bridge} />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Search prompts…" }), {
      target: { value: "latest" },
    });
    await waitFor(() => expect(bridge.librarySearch).toHaveBeenCalledTimes(2));

    await act(async () => {
      latest.resolve([{ ...results[1], id: "latest", name: "Latest.prompt" }]);
    });
    expect(await screen.findByText("Latest")).toBeVisible();

    await act(async () => {
      initial.resolve([{ ...results[0], id: "stale", name: "Stale.prompt" }]);
    });
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(screen.getByText("Latest")).toBeVisible();
  });

  it("does not let an older library-update refresh replace a newer query", async () => {
    const bridge = launcherBridge();
    const updateRefresh = deferred<PromptSummary[]>();
    const latestQuery = deferred<PromptSummary[]>();
    let notifyLibraryUpdate: (() => void) | undefined;
    vi.mocked(bridge.onLibraryUpdate).mockImplementation(async (listener) => {
      notifyLibraryUpdate = listener;
      return () => undefined;
    });
    vi.mocked(bridge.librarySearch)
      .mockResolvedValueOnce(results)
      .mockImplementationOnce(() => updateRefresh.promise)
      .mockImplementationOnce(() => latestQuery.promise);

    render(
      <I18nProvider initialLocale="en">
        <Launcher bridge={bridge} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Code review")).toBeVisible();
    await waitFor(() => expect(notifyLibraryUpdate).toBeTypeOf("function"));
    act(() => notifyLibraryUpdate?.());
    await waitFor(() => expect(bridge.librarySearch).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByRole("textbox", { name: "Search prompts…" }), {
      target: { value: "latest" },
    });
    await waitFor(() => expect(bridge.librarySearch).toHaveBeenCalledTimes(3));

    await act(async () => {
      latestQuery.resolve([
        { ...results[1], id: "latest", name: "Latest.prompt" },
      ]);
    });
    expect(await screen.findByText("Latest")).toBeVisible();

    await act(async () => {
      updateRefresh.resolve([
        { ...results[0], id: "stale-update", name: "Stale update.prompt" },
      ]);
    });
    expect(screen.queryByText("Stale update")).not.toBeInTheDocument();
    expect(screen.getByText("Latest")).toBeVisible();
  });

  it("keeps the launcher open and shows a recoverable error when copy fails", async () => {
    const bridge = launcherBridge();
    vi.mocked(bridge.copyPrompt).mockRejectedValue({
      code: "clipboardWriteFailed",
      message: "Clipboard is unavailable.",
    });
    const user = userEvent.setup();

    render(
      <I18nProvider initialLocale="en">
        <Launcher bridge={bridge} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Code review")).toBeVisible();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't copy the prompt",
    );
    expect(bridge.closeCurrentWindow).not.toHaveBeenCalled();
    expect(screen.getByText("Code review")).toBeVisible();
  });
});
