import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider";
import type {
  AppSettings,
  DesktopBridge,
  LibrarySnapshot,
  MutationResult,
  PromptDocument,
  PromptSummary,
} from "../../lib/desktopBridge";
import { Manager } from "./Manager";

const snapshot: LibrarySnapshot = {
  revision: 3,
  root: {
    id: "root-demo",
    displayPath: "/Demo/Prompts",
    status: "ready",
  },
  folders: [
    { id: "folder-engineering", parentId: null, name: "Engineering" },
    { id: "folder-writing", parentId: null, name: "Writing" },
  ],
  prompts: [
    {
      id: "prompt-review",
      name: "Code review.prompt",
      folderId: "folder-engineering",
      folderName: "Engineering",
      modifiedAt: "2026-08-12T08:00:00.000Z",
      preview: "Review the code.",
    },
    {
      id: "prompt-email",
      name: "Email rewrite.prompt",
      folderId: "folder-writing",
      folderName: "Writing",
      modifiedAt: "2026-08-11T08:00:00.000Z",
      preview: "Rewrite an email.",
    },
  ],
  issues: [],
};

const documents: Record<string, PromptDocument> = {
  "prompt-review": {
    id: "prompt-review",
    name: "Code review.prompt",
    folderId: "folder-engineering",
    folderName: "Engineering",
    content: "Review the code carefully.",
    revision: "content-review-v7",
    modifiedAt: "2026-08-12T08:00:00.000Z",
  },
  "prompt-email": {
    id: "prompt-email",
    name: "Email rewrite.prompt",
    folderId: "folder-writing",
    folderName: "Writing",
    content: "Rewrite this email with a warm, direct tone.",
    revision: "content-email-v4",
    modifiedAt: "2026-08-11T08:00:00.000Z",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function makeBridge(mutateResult?: MutationResult) {
  const settings: AppSettings = {
    language: "en",
    launchAtLogin: false,
    globalShortcut: "⌘⇧P",
    shortcutStatus: "ready",
    libraryRoot: snapshot.root,
    fileExtension: ".prompt",
    promptCount: 2,
    folderCount: 2,
  };
  return {
    librarySnapshot: vi.fn().mockResolvedValue(snapshot),
    libraryRead: vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(documents[id])),
    librarySearch: vi.fn().mockResolvedValue(snapshot.prompts),
    libraryMutate: vi.fn().mockResolvedValue(
      mutateResult ?? {
        status: "ok",
        snapshot,
        document: documents["prompt-review"],
      },
    ),
    chooseLibraryRoot: vi.fn().mockResolvedValue(settings),
    copyPrompt: vi.fn().mockResolvedValue(undefined),
    openPrompt: vi.fn().mockResolvedValue(undefined),
    revealPrompt: vi.fn().mockResolvedValue(undefined),
    settingsGet: vi.fn().mockResolvedValue(settings),
    settingsUpdate: vi.fn().mockResolvedValue(settings),
    showWindow: vi.fn().mockResolvedValue(undefined),
    closeCurrentWindow: vi.fn().mockResolvedValue(undefined),
    onLibraryUpdate: vi.fn().mockResolvedValue(() => undefined),
    onSettingsUpdate: vi.fn().mockResolvedValue(() => undefined),
  } satisfies DesktopBridge;
}

function makeUpdateBridge() {
  let listener: (() => void) | undefined;
  const bridge = makeBridge();
  bridge.onLibraryUpdate = vi.fn().mockImplementation(async (next) => {
    listener = next;
    return () => undefined;
  });
  return { bridge, emitUpdate: () => listener?.() };
}

function renderManager(bridge: DesktopBridge) {
  return render(
    <I18nProvider initialLocale="en">
      <Manager bridge={bridge} />
    </I18nProvider>,
  );
}

describe("Manager", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("does not render inert application-menu buttons", async () => {
    renderManager(makeBridge());

    await screen.findByDisplayValue("Review the code carefully.");
    expect(
      screen.queryByRole("navigation", { name: "Application menu" }),
    ).not.toBeInTheDocument();
  });

  it("opens prompt actions from the row context menu", async () => {
    const user = userEvent.setup();
    renderManager(makeBridge());
    await screen.findByDisplayValue("Review the code carefully.");

    const promptRow = screen.getByRole("button", {
      name: /Code review Engineering/,
    });
    expect(fireEvent.contextMenu(promptRow, { clientX: 320, clientY: 210 })).toBe(
      false,
    );

    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("button", { name: "Rename" }),
    ).toBeVisible();
    expect(within(menu).getByRole("button", { name: "Move" })).toBeVisible();
    expect(
      within(menu).getByRole("button", { name: "Move to Trash" }),
    ).toBeVisible();
    await user.click(within(menu).getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "New name" })).toHaveValue(
      "Code review",
    );
    expect(screen.getByText(".prompt")).toBeVisible();
  });

  it("opens folder actions from the row context menu", async () => {
    const user = userEvent.setup();
    renderManager(makeBridge());
    await screen.findByDisplayValue("Review the code carefully.");

    const folderRow = screen.getByRole("button", { name: "Engineering" });
    expect(fireEvent.contextMenu(folderRow, { clientX: 180, clientY: 330 })).toBe(
      false,
    );

    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("button", { name: "Rename" }),
    ).toBeVisible();
    expect(within(menu).getByRole("button", { name: "Move" })).toBeVisible();
    expect(
      within(menu).getByRole("button", { name: "Move to Trash" }),
    ).toBeVisible();
    await user.click(within(menu).getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "New name" })).toHaveValue(
      "Engineering",
    );
  });

  it("shows compact modified times without the year", async () => {
    renderManager(makeBridge());
    await screen.findByDisplayValue("Review the code carefully.");

    const modifiedTimes = Array.from(document.querySelectorAll("time")).map(
      (element) => element.textContent ?? "",
    );
    expect(modifiedTimes).toHaveLength(2);
    expect(modifiedTimes.every((value) => !value.includes("2026"))).toBe(true);
    expect(modifiedTimes.some((value) => value.includes("08/12"))).toBe(true);
  });

  it("prefills the current prompt and folder names when renaming", async () => {
    const user = userEvent.setup();
    renderManager(makeBridge());
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    expect(screen.getByRole("textbox", { name: "New name" })).toHaveValue(
      "Code review",
    );
    expect(screen.getByText(".prompt")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(
      screen.getByRole("button", { name: "Engineering Actions" }),
    );
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    expect(screen.getByRole("textbox", { name: "New name" })).toHaveValue(
      "Engineering",
    );
  });

  it("keeps the rename target and editor stable when a library update races the mutation", async () => {
    let updateListener: (() => void) | undefined;
    const mutation = deferred<MutationResult>();
    const nextSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      prompts: [snapshot.prompts[1]],
    };
    const bridge = makeBridge();
    bridge.librarySnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue(nextSnapshot);
    bridge.libraryMutate = vi.fn().mockReturnValue(mutation.promise);
    bridge.onLibraryUpdate = vi.fn().mockImplementation(async (listener) => {
      updateListener = listener;
      return () => undefined;
    });
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    const input = screen.getByRole("textbox", { name: "New name" });
    await user.clear(input);
    await user.type(input, "Code review 2");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    await act(async () => updateListener?.());

    expect(screen.getByDisplayValue("Review the code carefully.")).toBeVisible();
    expect(screen.queryByDisplayValue(documents["prompt-email"].content)).toBeNull();
    expect(input).toHaveValue("Code review 2");
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(bridge.librarySnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      mutation.resolve({ status: "error", code: "NotFound" });
    });
    expect(screen.getByDisplayValue("Review the code carefully.")).toBeVisible();
    expect(
      screen.getByText(
        "That item no longer exists. Cancel and retry from the refreshed library.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "New name" })).toHaveFocus(),
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByDisplayValue(documents["prompt-email"].content),
    ).toBeVisible();
    expect(bridge.librarySnapshot).toHaveBeenCalledTimes(2);
  });

  it("pins the rename target when the selected document changes behind the modal", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    const input = screen.getByRole("textbox", { name: "New name" });
    await user.clear(input);
    await user.type(input, "Pinned review");

    fireEvent.click(screen.getByRole("button", { name: /Email rewrite/ }));
    await screen.findByDisplayValue(documents["prompt-email"].content);
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "rename",
      entryId: "prompt-review",
      name: "Pinned review",
    });
  });

  it("shows a precise native mutation error and keeps the rename editable", async () => {
    const bridge = makeBridge();
    bridge.libraryMutate = vi
      .fn()
      .mockRejectedValue({ code: "FileBusy", message: "busy" });
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    const input = screen.getByRole("textbox", { name: "New name" });
    await user.clear(input);
    await user.type(input, "Busy review");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(
      await screen.findByText(
        "Another app is using that item. Close it there and try again.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "New name" })).toHaveValue(
      "Busy review",
    );
  });

  it("reconciles the current document name when rename returns a stale document payload", async () => {
    const renamedSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      prompts: snapshot.prompts.map((prompt) =>
        prompt.id === "prompt-review"
          ? { ...prompt, name: "Renamed review.prompt" }
          : prompt,
      ),
    };
    const bridge = makeBridge({
      status: "ok",
      snapshot: renamedSnapshot,
      document: documents["prompt-review"],
    });
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    const input = screen.getByRole("textbox", { name: "New name" });
    await user.clear(input);
    await user.type(input, "Renamed review");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(
      await screen.findByText("Engineering / Renamed review.prompt"),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Renamed review.prompt" }),
    ).toHaveValue("Review the code carefully.");
  });

  it("uses a Rename action and treats an unchanged name as a no-op", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(bridge.libraryMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "New name" })).toBeNull();
  });

  it("uses Escape to dismiss transient UI without closing the manager", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    expect(screen.getByRole("textbox", { name: "New name" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "New name" })).toBeNull();

    const search = screen.getByRole("textbox", { name: "Search files…" });
    await user.type(search, "review");
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(bridge.closeCurrentWindow).not.toHaveBeenCalled();
  });

  it("hides the managed extension in the prompt name column", async () => {
    renderManager(makeBridge());
    const list = await screen.findByTestId("prompt-list");

    expect(within(list).getByText("Code review")).toBeVisible();
    expect(within(list).queryByText("Code review.prompt")).toBeNull();
  });

  it("discards an unsaved draft when browsing to another prompt", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    const editor = await screen.findByRole("textbox", {
      name: "Code review.prompt",
    });
    await user.clear(editor);
    await user.type(editor, "Discard this draft");

    await user.click(screen.getByRole("button", { name: /Email rewrite/ }));

    expect(
      await screen.findByDisplayValue(
        "Rewrite this email with a warm, direct tone.",
      ),
    ).toBeVisible();
    expect(screen.queryByDisplayValue("Discard this draft")).toBeNull();
    expect(screen.getByText("Saved")).toBeVisible();
    expect(bridge.libraryMutate).not.toHaveBeenCalled();
  });

  it.each([
    ["macOS", { metaKey: true }],
    ["Windows", { ctrlKey: true }],
  ])("saves a dirty prompt with the %s primary shortcut", async (_platform, modifier) => {
    const bridge = makeBridge();
    renderManager(bridge);
    const editor = await screen.findByDisplayValue("Review the code carefully.");
    fireEvent.change(editor, { target: { value: "Changed by keyboard." } });

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ...modifier });

    await waitFor(() =>
      expect(bridge.libraryMutate).toHaveBeenCalledWith({
        kind: "save",
        promptId: "prompt-review",
        baseRevision: "content-review-v7",
        content: "Changed by keyboard.",
      }),
    );
  });

  it("keeps working when update listener registration fails", async () => {
    const bridge = makeBridge();
    bridge.onLibraryUpdate = vi
      .fn()
      .mockRejectedValue(new Error("library listener unavailable"));
    bridge.onSettingsUpdate = vi
      .fn()
      .mockRejectedValue(new Error("settings listener unavailable"));
    renderManager(bridge);

    expect(
      await screen.findByDisplayValue("Review the code carefully."),
    ).toBeVisible();
    await waitFor(() => {
      expect(bridge.onLibraryUpdate).toHaveBeenCalledOnce();
      expect(bridge.onSettingsUpdate).toHaveBeenCalledOnce();
    });
  });

  it("best-effort cleans up update listeners", async () => {
    const bridge = makeBridge();
    const unsubscribeLibrary = vi.fn(() => {
      throw new Error("library cleanup failed");
    });
    const unsubscribeSettings = vi.fn(() => {
      throw new Error("settings cleanup failed");
    });
    bridge.onLibraryUpdate = vi.fn().mockResolvedValue(unsubscribeLibrary);
    bridge.onSettingsUpdate = vi.fn().mockResolvedValue(unsubscribeSettings);
    const view = renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");
    await waitFor(() => {
      expect(bridge.onLibraryUpdate).toHaveBeenCalledOnce();
      expect(bridge.onSettingsUpdate).toHaveBeenCalledOnce();
    });

    expect(() => view.unmount()).not.toThrow();
    expect(unsubscribeLibrary).toHaveBeenCalledOnce();
    expect(unsubscribeSettings).toHaveBeenCalledOnce();
  });

  it("filters the prompt list by folder and loads the selected document", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);

    await screen.findByText("Code review");
    await user.click(screen.getByRole("button", { name: "Writing" }));

    const list = screen.getByTestId("prompt-list");
    expect(within(list).getByText("Email rewrite")).toBeVisible();
    expect(within(list).queryByText("Code review")).not.toBeInTheDocument();

    await user.click(within(list).getByText("Email rewrite"));
    expect(
      await screen.findByDisplayValue(
        "Rewrite this email with a warm, direct tone.",
      ),
    ).toBeVisible();
    expect(bridge.libraryRead).toHaveBeenCalledWith("prompt-email");
  });

  it("marks edits dirty and offers reload or save-copy after a conflict", async () => {
    const remote: PromptDocument = {
      ...documents["prompt-review"],
      content: "A teammate changed this on disk.",
      revision: "content-review-v8",
    };
    const bridge = makeBridge({ status: "conflict", code: "Conflict", current: remote });
    const user = userEvent.setup();
    renderManager(bridge);

    const editor = await screen.findByRole("textbox", { name: "Code review.prompt" });
    await user.clear(editor);
    await user.type(editor, "My local changes");
    expect(screen.getByText("Unsaved changes")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This prompt changed on disk")).toBeVisible();
    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "save",
      promptId: "prompt-review",
      baseRevision: "content-review-v7",
      content: "My local changes",
    });

    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(screen.getByDisplayValue("A teammate changed this on disk.")).toBeVisible();
    expect(screen.getByText("Saved")).toBeVisible();
  });

  it("lets the user choose another folder when the library root is missing", async () => {
    const bridge = makeBridge();
    bridge.librarySnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      root: {
        ...snapshot.root,
        status: "missing",
        errorCode: "not_found",
      },
    });
    const user = userEvent.setup();
    renderManager(bridge);

    expect(
      await screen.findByText("The prompt library is unavailable"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Choose library folder…" }),
    );
    await waitFor(() => expect(bridge.chooseLibraryRoot).toHaveBeenCalledOnce());
  });

  it("shows first-run guidance instead of an unavailable-library error", async () => {
    const bridge = makeBridge();
    bridge.librarySnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      root: {
        id: "unconfigured-session",
        displayPath: "",
        status: "unconfigured",
      },
      folders: [],
      prompts: [],
    });

    renderManager(bridge);

    expect(await screen.findByText("Choose your Prompt library")).toBeVisible();
    expect(
      screen.queryByText("The prompt library is unavailable"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose library folder…" }),
    ).toBeVisible();
  });

  it("recovers automatically when the initial snapshot races desktop startup", async () => {
    const bridge = makeBridge();
    bridge.librarySnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("desktop state is not ready"))
      .mockResolvedValue(snapshot);

    renderManager(bridge);

    expect(
      await screen.findByDisplayValue("Review the code carefully."),
    ).toBeVisible();
    expect(bridge.librarySnapshot).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("The prompt library is unavailable"),
    ).not.toBeInTheDocument();
  });

  it("rechecks a configured root before showing a startup error", async () => {
    const bridge = makeBridge();
    bridge.librarySnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        ...snapshot,
        root: {
          id: "unavailable-session",
          displayPath: "C:\\Users\\Azan\\Prompts",
          status: "unreadable",
          errorCode: "unknown",
        },
        folders: [],
        prompts: [],
      })
      .mockResolvedValue(snapshot);

    renderManager(bridge);

    expect(
      await screen.findByDisplayValue("Review the code carefully."),
    ).toBeVisible();
    expect(bridge.librarySnapshot).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("The prompt library is unavailable"),
    ).not.toBeInTheDocument();
  });

  it("does not retry a library root after macOS denies folder access", async () => {
    const bridge = makeBridge();
    bridge.librarySnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      root: {
        id: "unavailable-session",
        displayPath: "/Users/Azan/Documents/Prompts",
        status: "unreadable",
        errorCode: "permission_denied",
      },
      folders: [],
      prompts: [],
    });

    renderManager(bridge);

    expect(
      await screen.findByText("The prompt library is unavailable"),
    ).toBeVisible();
    expect(bridge.librarySnapshot).toHaveBeenCalledOnce();
  });

  it("reloads a clean document when its opaque content version changes", async () => {
    const { bridge, emitUpdate } = makeUpdateBridge();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    bridge.libraryRead = vi.fn().mockResolvedValue({
      ...documents["prompt-review"],
      revision: "content-review-v8",
      content: "Updated outside Prompter.",
    });
    await act(async () => emitUpdate());

    expect(
      await screen.findByDisplayValue("Updated outside Prompter."),
    ).toBeVisible();
  });

  it("returns to All Prompts when the selected folder disappears", async () => {
    const { bridge, emitUpdate } = makeUpdateBridge();
    const nextSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      folders: [snapshot.folders[1]],
      prompts: [snapshot.prompts[1]],
    };
    bridge.librarySnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue(nextSnapshot);
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");
    await user.click(screen.getByRole("button", { name: "Engineering" }));

    await act(async () => emitUpdate());

    expect(
      await screen.findByDisplayValue(
        "Rewrite this email with a warm, direct tone.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "All Prompts" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      within(screen.getByTestId("prompt-list")).getByText(
        "Email rewrite",
      ),
    ).toBeVisible();
  });

  it("preserves a dirty draft and opens conflict recovery on an external update", async () => {
    const { bridge, emitUpdate } = makeUpdateBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    const editor = await screen.findByRole("textbox", { name: "Code review.prompt" });
    await user.clear(editor);
    await user.type(editor, "Keep my draft");

    bridge.libraryRead = vi.fn().mockResolvedValue({
      ...documents["prompt-review"],
      revision: "content-review-v8",
      content: "Updated outside Prompter.",
    });
    await act(async () => emitUpdate());

    expect(await screen.findByText("This prompt changed on disk")).toBeVisible();
    expect(screen.getByDisplayValue("Keep my draft")).toBeVisible();
  });

  it.each([
    ["openPrompt", "Open in external editor"],
    ["revealPrompt", "Show in file manager"],
  ] as const)(
    "shows a visible error when %s fails",
    async (method, buttonName) => {
      const bridge = makeBridge();
      bridge[method] = vi.fn().mockRejectedValue({ code: "PermissionDenied" });
      const user = userEvent.setup();
      renderManager(bridge);
      await screen.findByDisplayValue("Review the code carefully.");

      await user.click(screen.getByRole("button", { name: buttonName }));

      expect(
        await screen.findByText(
          "Prompter does not have permission to change that entry.",
        ),
      ).toBeVisible();
      expect(bridge[method]).toHaveBeenCalledWith("prompt-review");
    },
  );

  it("shows a visible error when opening Settings fails", async () => {
    const bridge = makeBridge();
    bridge.showWindow = vi
      .fn()
      .mockRejectedValue(new Error("settings window unavailable"));
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(
      await screen.findByText("The library change could not be completed."),
    ).toBeVisible();
    expect(bridge.showWindow).toHaveBeenCalledWith("settings");
  });

  it("moves a folder to Trash through its row actions", async () => {
    const bridge = makeBridge({
      status: "ok",
      snapshot: {
        ...snapshot,
        folders: snapshot.folders.filter(
          (folder) => folder.id !== "folder-writing",
        ),
        prompts: snapshot.prompts.filter(
          (prompt) => prompt.folderId !== "folder-writing",
        ),
      },
    });
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByText("Code review");

    await user.click(
      screen.getByRole("button", { name: "Writing Actions" }),
    );
    const folderMenu = screen.getByRole("menu");
    await user.click(within(folderMenu).getByRole("button", { name: "Move to Trash" }));

    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "trash",
      entryId: "folder-writing",
    });
    expect(screen.queryByRole("button", { name: "Writing" })).not.toBeInTheDocument();
  });

  it("selects the newest healthy prompt after trashing the current prompt", async () => {
    const issuePrompt: PromptSummary = {
      id: "prompt-broken",
      name: "Broken.prompt",
      folderId: "folder-engineering",
      folderName: "Engineering",
      modifiedAt: "2026-08-13T08:00:00.000Z",
      preview: "",
      health: "issue",
    };
    const bridge = makeBridge({
      status: "ok",
      snapshot: {
        ...snapshot,
        prompts: [issuePrompt, snapshot.prompts[1]],
      },
    });
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", {
        name: "Move to Trash",
      }),
    );

    expect(
      await screen.findByDisplayValue(
        "Rewrite this email with a warm, direct tone.",
      ),
    ).toBeVisible();
    expect(bridge.libraryRead).not.toHaveBeenCalledWith("prompt-broken");
  });

  it("catches a healthy fallback read failure after trashing a folder", async () => {
    const issuePrompt: PromptSummary = {
      id: "prompt-broken",
      name: "Broken.prompt",
      folderId: "folder-writing",
      folderName: "Writing",
      modifiedAt: "2026-08-13T08:00:00.000Z",
      preview: "",
      health: "issue",
    };
    const bridge = makeBridge({
      status: "ok",
      snapshot: {
        ...snapshot,
        folders: [snapshot.folders[1]],
        prompts: [issuePrompt, snapshot.prompts[1]],
      },
    });
    bridge.libraryRead = vi.fn().mockImplementation((id: string) =>
      id === "prompt-review"
        ? Promise.resolve(documents[id])
        : Promise.reject({ code: "StaleId" }),
    );
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(
      screen.getByRole("button", { name: "Engineering Actions" }),
    );
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", {
        name: "Move to Trash",
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Code review.prompt" }),
      ).not.toBeInTheDocument(),
    );
    expect(bridge.libraryRead).toHaveBeenCalledWith("prompt-email");
    expect(bridge.libraryRead).not.toHaveBeenCalledWith("prompt-broken");
  });

  it("keeps a readable prompt editable when an issue file is newer", async () => {
    const issuePrompt = {
      id: "prompt-broken",
      name: "Broken.prompt",
      folderId: "folder-engineering",
      folderName: "Engineering",
      modifiedAt: "2026-08-13T08:00:00.000Z",
      preview: "",
      health: "issue" as const,
    };
    const bridge = makeBridge();
    bridge.librarySnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      prompts: [issuePrompt, ...snapshot.prompts],
    });
    const user = userEvent.setup();
    renderManager(bridge);

    expect(
      await screen.findByDisplayValue("Review the code carefully."),
    ).toBeVisible();
    expect(bridge.libraryRead).toHaveBeenCalledWith("prompt-review");
    expect(bridge.libraryRead).not.toHaveBeenCalledWith("prompt-broken");

    await user.click(
      screen.getByRole("button", { name: /Broken Engineering/ }),
    );
    expect(await screen.findByText(/cannot be read/)).toBeVisible();
    expect(bridge.libraryRead).not.toHaveBeenCalledWith("prompt-broken");
  });

  it("shows watcher degradation while keeping the library usable", async () => {
    const bridge = makeBridge();
    bridge.librarySnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      issues: [{ code: "WatcherDegraded", path: "" }],
    });
    renderManager(bridge);

    expect(
      await screen.findByDisplayValue("Review the code carefully."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "File watching is unavailable; periodic checks remain active.",
      ),
    ).toBeVisible();
  });

  it("summarizes non-watcher library issues that have no prompt row", async () => {
    const bridge = makeBridge();
    bridge.librarySnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      issues: [
        { code: "WatcherDegraded", path: "" },
        { code: "UnsafeEntry", path: "Linked folder" },
        { code: "PermissionDenied", path: "Unreadable folder" },
      ],
    });
    renderManager(bridge);

    expect(
      await screen.findByText(
        "2 library entries were skipped because of safety or read problems.",
      ),
    ).toBeVisible();
  });

  it("blocks moving the current dirty prompt to Trash", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    const editor = await screen.findByRole("textbox", {
      name: "Code review.prompt",
    });
    await user.type(editor, " local draft");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", {
        name: "Move to Trash",
      }),
    );

    expect(bridge.libraryMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Save, reload, or save a copy before moving this prompt or its folder to Trash.",
      ),
    ).toBeVisible();
    expect(screen.getByDisplayValue(/local draft/)).toBeVisible();
  });

  it("blocks moving an ancestor folder of the current dirty prompt to Trash", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    const editor = await screen.findByRole("textbox", {
      name: "Code review.prompt",
    });
    await user.type(editor, " local draft");

    await user.click(
      screen.getByRole("button", { name: "Engineering Actions" }),
    );
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", {
        name: "Move to Trash",
      }),
    );

    expect(bridge.libraryMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Save, reload, or save a copy before moving this prompt or its folder to Trash.",
      ),
    ).toBeVisible();
  });

  it.each([
    ["Rename", "prompt"],
    ["Move", "prompt"],
    ["Rename", "ancestor folder"],
    ["Move", "ancestor folder"],
  ] as const)(
    "blocks %s on the current dirty prompt's %s",
    async (action, target) => {
      const bridge = makeBridge();
      const user = userEvent.setup();
      renderManager(bridge);
      const editor = await screen.findByRole("textbox", {
        name: "Code review.prompt",
      });
      await user.type(editor, " protected draft");

      await user.click(
        screen.getByRole("button", {
          name: target === "prompt" ? "Actions" : "Engineering Actions",
        }),
      );
      await user.click(
        within(screen.getByRole("menu")).getByRole("button", {
          name: action,
        }),
      );

      expect(bridge.libraryMutate).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          "Save, reload, or save a copy before renaming or moving this prompt or its folder.",
        ),
      ).toBeVisible();
      expect(screen.getByDisplayValue(/protected draft/)).toBeVisible();
      expect(
        screen.queryByRole(action === "Move" ? "combobox" : "textbox", {
          name: action === "Move" ? /Destination folder/ : "New name",
        }),
      ).not.toBeInTheDocument();
    },
  );

  it("blocks creating another prompt while the current draft is dirty", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    const editor = await screen.findByRole("textbox", {
      name: "Code review.prompt",
    });
    await user.type(editor, " must survive");

    await user.click(screen.getByRole("button", { name: "New Prompt" }));

    expect(bridge.libraryMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Save, reload, or save a copy before creating another prompt.",
      ),
    ).toBeVisible();
    expect(screen.getByDisplayValue(/must survive/)).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "Prompt name" }),
    ).not.toBeInTheDocument();
  });

  it("selects the newest healthy prompt when a settings update removes the selected ID", async () => {
    let settingsListener: (() => void) | undefined;
    const bridge = makeBridge();
    const nextSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      prompts: [snapshot.prompts[1]],
    };
    bridge.librarySnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue(nextSnapshot);
    let initialReadDone = false;
    bridge.libraryRead = vi.fn().mockImplementation((id: string) => {
      if (id === "prompt-review" && initialReadDone) {
        return Promise.reject({ code: "StaleId" });
      }
      initialReadDone = true;
      return Promise.resolve(documents[id]);
    });
    bridge.onSettingsUpdate = vi.fn().mockImplementation(async (listener) => {
      settingsListener = listener;
      return () => undefined;
    });
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await act(async () => settingsListener?.());

    expect(
      await screen.findByDisplayValue(
        "Rewrite this email with a warm, direct tone.",
      ),
    ).toBeVisible();
    expect(bridge.libraryRead).not.toHaveBeenCalledTimes(3);
  });

  it("preserves a dirty draft when an update removes the selected ID", async () => {
    let updateListener: (() => void) | undefined;
    const bridge = makeBridge();
    const nextSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      prompts: [snapshot.prompts[1]],
    };
    bridge.librarySnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue(nextSnapshot);
    bridge.onLibraryUpdate = vi.fn().mockImplementation(async (listener) => {
      updateListener = listener;
      return () => undefined;
    });
    const user = userEvent.setup();
    renderManager(bridge);
    const editor = await screen.findByRole("textbox", {
      name: "Code review.prompt",
    });
    await user.clear(editor);
    await user.type(editor, "irreplaceable local draft");

    await act(async () => updateListener?.());

    expect(
      await screen.findByDisplayValue("irreplaceable local draft"),
    ).toBeVisible();
    expect(await screen.findByText("This prompt changed on disk")).toBeVisible();
    expect(bridge.libraryRead).not.toHaveBeenCalledWith("prompt-email");

    await user.click(screen.getByRole("button", { name: "Save a copy" }));

    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "createPrompt",
      folderId: "folder-engineering",
      name: "Code review copy",
      content: "irreplaceable local draft",
    });
  });

  it("keeps a dirty draft reachable while the original root is unavailable", async () => {
    let updateListener: (() => void) | undefined;
    const unavailableSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      root: { ...snapshot.root, status: "missing", errorCode: "not_found" },
      prompts: [],
    };
    const bridge = makeBridge();
    bridge.librarySnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(unavailableSnapshot)
      .mockResolvedValue(snapshot);
    bridge.onLibraryUpdate = vi.fn().mockImplementation(async (listener) => {
      updateListener = listener;
      return () => undefined;
    });
    const user = userEvent.setup();
    renderManager(bridge);
    const editor = await screen.findByRole("textbox", {
      name: "Code review.prompt",
    });
    await user.clear(editor);
    await user.type(editor, "recover this draft");

    await act(async () => updateListener?.());

    expect(
      await screen.findByRole("textbox", { name: "Unsaved draft recovery" }),
    ).toHaveValue("recover this draft");
    expect(screen.getByText("The prompt library is unavailable")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Try the original library again" }),
    );
    expect(
      await screen.findByRole("textbox", { name: "Code review.prompt" }),
    ).toHaveValue("recover this draft");
    expect(screen.queryByText("The prompt library is unavailable")).not.toBeInTheDocument();
  });

  it("requires explicit confirmation before discarding an unavailable-root draft", async () => {
    let updateListener: (() => void) | undefined;
    const unavailableSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      root: { ...snapshot.root, status: "missing", errorCode: "not_found" },
      prompts: [],
    };
    const bridge = makeBridge();
    bridge.librarySnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(unavailableSnapshot)
      .mockResolvedValue(snapshot);
    bridge.onLibraryUpdate = vi.fn().mockImplementation(async (listener) => {
      updateListener = listener;
      return () => undefined;
    });
    const user = userEvent.setup();
    renderManager(bridge);
    const editor = await screen.findByRole("textbox", {
      name: "Code review.prompt",
    });
    await user.clear(editor);
    await user.type(editor, "draft before root loss");
    await act(async () => updateListener?.());
    await screen.findByRole("textbox", { name: "Unsaved draft recovery" });

    await user.click(
      screen.getByRole("button", { name: "Discard draft and choose another library…" }),
    );
    expect(bridge.chooseLibraryRoot).not.toHaveBeenCalled();
    expect(
      screen.getByText("This permanently discards the draft shown above."),
    ).toBeVisible();
    expect(screen.getByDisplayValue("draft before root loss")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Discard draft now" }),
    );
    await waitFor(() => expect(bridge.chooseLibraryRoot).toHaveBeenCalledOnce());
  });

  it("uses library search for full-content matches", async () => {
    const bridge = makeBridge();
    bridge.librarySearch = vi.fn().mockResolvedValue([snapshot.prompts[1]]);
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByText("Code review");

    await user.type(
      screen.getByRole("textbox", { name: "Search files…" }),
      "needle only in body",
    );

    await waitFor(() =>
      expect(bridge.librarySearch).toHaveBeenLastCalledWith(
        "needle only in body",
      ),
    );
    const list = screen.getByTestId("prompt-list");
    expect(within(list).getByText("Email rewrite")).toBeVisible();
    expect(within(list).queryByText("Code review")).not.toBeInTheDocument();
  });

  it("preserves the relevance order returned by library search", async () => {
    const bridge = makeBridge();
    bridge.librarySearch = vi
      .fn()
      .mockResolvedValue([snapshot.prompts[1], snapshot.prompts[0]]);
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByText("Code review");

    await user.type(
      screen.getByRole("textbox", { name: "Search files…" }),
      "rewrite",
    );

    const list = screen.getByTestId("prompt-list");
    await waitFor(() =>
      expect(within(list).getAllByRole("button")[0]).toHaveTextContent(
        "Email rewrite",
      ),
    );
  });

  it("does not let an older search response replace newer results", async () => {
    const bridge = makeBridge();
    let resolveFirst!: (value: PromptSummary[]) => void;
    let resolveSecond!: (value: PromptSummary[]) => void;
    bridge.librarySearch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PromptSummary[]>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<PromptSummary[]>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    renderManager(bridge);
    await screen.findByText("Code review");
    const search = screen.getByRole("textbox", { name: "Search files…" });

    fireEvent.change(search, { target: { value: "first" } });
    await waitFor(() => expect(bridge.librarySearch).toHaveBeenCalledWith("first"));
    fireEvent.change(search, { target: { value: "second" } });
    await waitFor(() => expect(bridge.librarySearch).toHaveBeenCalledWith("second"));
    resolveSecond([snapshot.prompts[1]]);
    expect(await screen.findByText("Email rewrite")).toBeVisible();

    resolveFirst([snapshot.prompts[0]]);
    await waitFor(() =>
      expect(screen.getByText("Email rewrite")).toBeVisible(),
    );
    expect(screen.queryByText("Code review")).not.toBeInTheDocument();
  });

  it.each([
    ["library", "onLibraryUpdate"],
    ["settings", "onSettingsUpdate"],
  ] as const)(
    "reruns search after a %s update and ignores its stale response",
    async (_source, subscriptionMethod) => {
      let emitUpdate: (() => void) | undefined;
      let resolveOld!: (value: PromptSummary[]) => void;
      let resolveNew!: (value: PromptSummary[]) => void;
      const bridge = makeBridge();
      const nextSnapshot: LibrarySnapshot = {
        ...snapshot,
        revision: 4,
        prompts: [snapshot.prompts[1]],
      };
      bridge.librarySnapshot = vi
        .fn()
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValue(nextSnapshot);
      bridge.librarySearch = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<PromptSummary[]>((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<PromptSummary[]>((resolve) => {
              resolveNew = resolve;
            }),
        );
      bridge[subscriptionMethod] = vi.fn().mockImplementation(async (listener) => {
        emitUpdate = listener;
        return () => undefined;
      });
      renderManager(bridge);
      await screen.findByDisplayValue("Review the code carefully.");
      fireEvent.change(
        screen.getByRole("textbox", { name: "Search files…" }),
        { target: { value: "shared query" } },
      );
      await waitFor(() => expect(bridge.librarySearch).toHaveBeenCalledOnce());

      await act(async () => emitUpdate?.());

      await waitFor(() => expect(bridge.librarySearch).toHaveBeenCalledTimes(2));
      await act(async () => resolveNew([snapshot.prompts[1]]));
      expect(await screen.findByText("Email rewrite")).toBeVisible();
      await act(async () => resolveOld([snapshot.prompts[0]]));
      await waitFor(() =>
        expect(screen.getByText("Email rewrite")).toBeVisible(),
      );
      expect(screen.queryByText("Code review")).not.toBeInTheDocument();
    },
  );

  it("moves an entry using the selected folder ID even when folder names repeat", async () => {
    const bridge = makeBridge();
    bridge.librarySnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      folders: [
        ...snapshot.folders,
        { id: "archive-engineering", parentId: "folder-engineering", name: "Archive" },
        { id: "archive-writing", parentId: "folder-writing", name: "Archive" },
      ],
    });
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Move" }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Destination folder/ }),
      "archive-writing",
    );
    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "move",
      entryId: "prompt-review",
      targetFolderId: "archive-writing",
    });
  });

  it("moves an entry to the library root selected by its ID", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Move" }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Destination folder/ }),
      "root-demo",
    );
    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "move",
      entryId: "prompt-review",
      targetFolderId: "root-demo",
    });
  });

  it("refreshes the current document metadata after renaming its folder", async () => {
    const renamedDocument = {
      ...documents["prompt-review"],
      folderName: "Development",
    };
    const renamedSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      folders: snapshot.folders.map((folder) =>
        folder.id === "folder-engineering"
          ? { ...folder, name: "Development" }
          : folder,
      ),
      prompts: snapshot.prompts.map((prompt) =>
        prompt.id === "prompt-review"
          ? { ...prompt, folderName: "Development" }
          : prompt,
      ),
    };
    const bridge = makeBridge({ status: "ok", snapshot: renamedSnapshot });
    bridge.libraryRead = vi
      .fn()
      .mockResolvedValueOnce(documents["prompt-review"])
      .mockResolvedValue(renamedDocument);
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(
      screen.getByRole("button", { name: "Engineering Actions" }),
    );
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Rename" }),
    );
    const renameInput = screen.getByRole("textbox", { name: "New name" });
    await user.clear(renameInput);
    await user.type(renameInput, "Development");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    expect(
      await screen.findByText("Development / Code review.prompt"),
    ).toBeVisible();
    expect(bridge.libraryRead).toHaveBeenCalledTimes(2);
  });

  it("safely reconciles the current document after moving its folder", async () => {
    const movedSnapshot: LibrarySnapshot = {
      ...snapshot,
      revision: 4,
      folders: snapshot.folders.map((folder) =>
        folder.id === "folder-engineering"
          ? { ...folder, parentId: "folder-writing" }
          : folder,
      ),
    };
    const bridge = makeBridge({ status: "ok", snapshot: movedSnapshot });
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(
      screen.getByRole("button", { name: "Engineering Actions" }),
    );
    await user.click(
      within(screen.getByRole("menu")).getByRole("button", { name: "Move" }),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Destination folder/ }),
      "folder-writing",
    );
    await user.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() => expect(bridge.libraryRead).toHaveBeenCalledTimes(2));
    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "move",
      entryId: "folder-engineering",
      targetFolderId: "folder-writing",
    });
  });

  it("creates prompts and folders at the root from All or Recent", async () => {
    const bridge = makeBridge();
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(
      screen.getByRole("button", { name: "Recently modified" }),
    );
    await user.click(screen.getByRole("button", { name: "New Prompt" }));
    await user.type(screen.getByRole("textbox", { name: "Prompt name" }), "Root prompt");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "createPrompt",
      folderId: "root-demo",
      name: "Root prompt",
    });

    await user.click(screen.getByRole("button", { name: "All Prompts" }));
    await user.click(screen.getByRole("button", { name: "New folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Root folder");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(bridge.libraryMutate).toHaveBeenCalledWith({
      kind: "createFolder",
      parentId: "root-demo",
      name: "Root folder",
    });
  });

  it("keeps a mutation error visible instead of silently closing the dialog", async () => {
    const bridge = makeBridge({ status: "error", code: "NameCollision" });
    const user = userEvent.setup();
    renderManager(bridge);
    await screen.findByDisplayValue("Review the code carefully.");

    await user.click(screen.getByRole("button", { name: "New Prompt" }));
    await user.type(screen.getByRole("textbox", { name: "Prompt name" }), "Duplicate");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("A file or folder with that name already exists."),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Prompt name" })).toHaveValue(
      "Duplicate",
    );
  });
});
