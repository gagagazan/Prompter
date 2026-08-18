import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Clock3 from "lucide-react/dist/esm/icons/clock-3";
import EllipsisVertical from "lucide-react/dist/esm/icons/ellipsis-vertical";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import FilePlus2 from "lucide-react/dist/esm/icons/file-plus-2";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Folder from "lucide-react/dist/esm/icons/folder";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Grid2X2 from "lucide-react/dist/esm/icons/grid-2x2";
import MoveRight from "lucide-react/dist/esm/icons/move-right";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Plus from "lucide-react/dist/esm/icons/plus";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Save from "lucide-react/dist/esm/icons/save";
import Search from "lucide-react/dist/esm/icons/search";
import SettingsIcon from "lucide-react/dist/esm/icons/settings";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import { BrandLockup } from "../../components/BrandLockup";
import { useI18n } from "../../i18n/I18nProvider";
import {
  clearDirtyEditor,
  isDirtyEditorBlocked,
  markDirtyEditor,
} from "../../lib/dirtyEditor";
import type {
  DesktopBridge,
  FolderSummary,
  LibraryMutation,
  LibrarySnapshot,
  MutationResult,
  PromptDocument,
  PromptSummary,
  StableLibraryErrorCode,
} from "../../lib/desktopBridge";
import {
  matchesPrimaryShortcut,
  useWindowKeydown,
} from "../../lib/useWindowKeydown";

type FolderSelection = "all" | "recent" | string;
type SaveState = "saved" | "dirty" | "saving";
type DialogState =
  | { kind: "createPrompt" }
  | { kind: "createFolder" }
  | { kind: "rename"; entryId: string }
  | { kind: "move"; entryId: string }
  | null;
type EntryContextMenu = {
  kind: "prompt" | "folder";
  entryId: string;
  x: number;
  y: number;
} | null;

interface ManagerProps {
  bridge: DesktopBridge;
}

interface ManagerData {
  snapshot: LibrarySnapshot;
  document: PromptDocument | null;
}

const sortNewestFirst = (left: PromptSummary, right: PromptSummary) =>
  new Date(right.modifiedAt).getTime() - new Date(left.modifiedAt).getTime();

const SEARCH_DEBOUNCE_MS = 120;
const STARTUP_SNAPSHOT_RETRY_DELAYS_MS = [120, 320] as const;

const isRootNotConfiguredError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "rootNotConfigured";

async function initialLibrarySnapshot(bridge: DesktopBridge) {
  let lastError: unknown;
  let lastSnapshot: LibrarySnapshot | undefined;
  for (
    let attempt = 0;
    attempt <= STARTUP_SNAPSHOT_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(
          resolve,
          STARTUP_SNAPSHOT_RETRY_DELAYS_MS[attempt - 1],
        );
      });
    }
    try {
      const snapshot = await bridge.librarySnapshot();
      const configuredRootTemporarilyUnavailable =
        snapshot.root.status !== "ready" &&
        snapshot.root.status !== "unconfigured" &&
        snapshot.root.displayPath.trim().length > 0 &&
        snapshot.root.errorCode === "unknown";
      if (
        !configuredRootTemporarilyUnavailable ||
        attempt === STARTUP_SNAPSHOT_RETRY_DELAYS_MS.length
      ) {
        return snapshot;
      }
      lastSnapshot = snapshot;
    } catch (error) {
      if (isRootNotConfiguredError(error)) throw error;
      lastError = error;
    }
  }
  if (lastSnapshot) return lastSnapshot;
  throw lastError;
}

const stableLibraryErrorCodes = new Set<StableLibraryErrorCode>([
  "RootUnavailable",
  "NotFound",
  "StaleId",
  "Conflict",
  "NameCollision",
  "InvalidName",
  "InvalidEncoding",
  "TooLarge",
  "PermissionDenied",
  "ReadOnly",
  "FileBusy",
  "CrossDeviceMove",
  "TrashUnavailable",
  "UnsafeEntry",
  "WatcherDegraded",
  "RecoveryRequired",
]);

const stableErrorCode = (error: unknown): StableLibraryErrorCode | null => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return null;
  }
  return stableLibraryErrorCodes.has(error.code as StableLibraryErrorCode)
    ? (error.code as StableLibraryErrorCode)
    : null;
};

const withoutPromptExtension = (name: string) =>
  name.endsWith(".prompt") ? name.slice(0, -".prompt".length) : name;

const portableRenameValue = (name: string, prompt: boolean) =>
  (prompt ? withoutPromptExtension(name) : name).trim().normalize("NFC");

const newestHealthyPrompt = (snapshot: LibrarySnapshot) =>
  [...snapshot.prompts]
    .sort(sortNewestFirst)
    .find((prompt) => prompt.health !== "issue") ?? null;

const documentFromSnapshot = (
  document: PromptDocument | null,
  snapshot: LibrarySnapshot,
) => {
  if (!document) return null;
  const summary = snapshot.prompts.find((prompt) => prompt.id === document.id);
  return summary
    ? {
        ...document,
        name: summary.name,
        folderId: summary.folderId ?? snapshot.root.id,
        folderName: summary.folderName,
        modifiedAt: summary.modifiedAt,
      }
    : document;
};

function folderContains(
  folders: FolderSummary[],
  ancestorId: string,
  descendantId: string | undefined,
) {
  let cursor = descendantId;
  const parents = new Map(
    folders.map((folder) => [folder.id, folder.parentId] as const),
  );
  while (cursor) {
    if (cursor === ancestorId) return true;
    cursor = parents.get(cursor) ?? undefined;
  }
  return false;
}

export function Manager({ bridge }: ManagerProps) {
  const { formatDate, t } = useI18n();
  const [data, setData] = useState<ManagerData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [rootNotConfigured, setRootNotConfigured] = useState(false);
  const [rootChangeBlocked, setRootChangeBlocked] = useState(false);
  const [confirmRootDraftDiscard, setConfirmRootDraftDiscard] = useState(false);
  const [folderSelection, setFolderSelection] =
    useState<FolderSelection>("all");
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PromptSummary[] | null>(
    null,
  );
  const [searchEpoch, setSearchEpoch] = useState(0);
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState<PromptDocument | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [dialogPending, setDialogPending] = useState(false);
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [entryContextMenu, setEntryContextMenu] =
    useState<EntryContextMenu>(null);
  const [operationError, setOperationError] = useState<
    | StableLibraryErrorCode
    | "dirtyCreate"
    | "dirtyEntry"
    | "dirtyTrash"
    | "generic"
    | null
  >(null);
  const selectedRef = useRef<string | null>(null);
  const dataRef = useRef<ManagerData | null>(null);
  const saveStateRef = useRef<SaveState>("saved");
  const searchQueryRef = useRef("");
  const searchRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const selectionRequestRef = useRef(0);
  const dialogRef = useRef<DialogState>(null);
  const dialogPendingRef = useRef(false);
  const deferredRefreshRef = useRef(false);
  const dialogInputRef = useRef<HTMLInputElement>(null);

  const openEntryContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    kind: "prompt" | "folder",
    entryId: string,
  ) => {
    event.preventDefault();
    setMenuOpen(false);
    setFolderMenuId(null);
    setEntryContextMenu({
      kind,
      entryId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 178)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 126)),
    });
  };

  const mutateLibrary = useCallback(
    async (mutation: LibraryMutation): Promise<MutationResult | null> => {
      try {
        return await bridge.libraryMutate(mutation);
      } catch (error) {
        setOperationError(stableErrorCode(error) ?? "generic");
        return null;
      }
    },
    [bridge],
  );

  const runDocumentAction = async (action: () => Promise<void>) => {
    setOperationError(null);
    try {
      await action();
    } catch (error) {
      setOperationError(stableErrorCode(error) ?? "generic");
    }
  };

  const showEmptySnapshot = useCallback((snapshot: LibrarySnapshot) => {
    selectedRef.current = null;
    setSelectedPromptId(null);
    setData({ snapshot, document: null });
    setContent("");
    setConflict(null);
    setSaveState("saved");
  }, []);

  const reconcileSnapshot = useCallback(
    async (snapshot: LibrarySnapshot, requestId: number) => {
      const current = dataRef.current;
      if (!current || requestId !== refreshRequestRef.current) return;
      setFolderSelection((selection) =>
        selection === "all" ||
        selection === "recent" ||
        snapshot.folders.some((folder) => folder.id === selection)
          ? selection
          : "all",
      );
      const selectedId = selectedRef.current;
      const selectedSummary = selectedId
        ? snapshot.prompts.find((prompt) => prompt.id === selectedId)
        : undefined;

      if (!selectedSummary) {
        if (saveStateRef.current === "dirty" && current.document) {
          // The old ID can no longer support SaveCopy. Preserve the draft and
          // enter the recovery UI; its save-copy action creates a fresh prompt.
          setData({ ...current, snapshot });
          setConflict(current.document);
          return;
        }
        const fallback = newestHealthyPrompt(snapshot);
        if (!fallback) {
          showEmptySnapshot(snapshot);
          return;
        }
        try {
          const document = await bridge.libraryRead(fallback.id);
          if (requestId !== refreshRequestRef.current) return;
          selectedRef.current = document.id;
          setSelectedPromptId(document.id);
          setData({ snapshot, document });
          setContent(document.content);
          setConflict(null);
          setSaveState("saved");
        } catch {
          if (requestId === refreshRequestRef.current) showEmptySnapshot(snapshot);
        }
        return;
      }

      if (selectedSummary.health === "issue") {
        if (saveStateRef.current === "dirty" && current.document) {
          setData({ ...current, snapshot });
          setConflict(current.document);
          return;
        }
        selectedRef.current = selectedSummary.id;
        setSelectedPromptId(selectedSummary.id);
        setData({ snapshot, document: null });
        setContent("");
        setConflict(null);
        setSaveState("saved");
        return;
      }

      try {
        const remote = await bridge.libraryRead(selectedSummary.id);
        if (requestId !== refreshRequestRef.current) return;
        if (remote.revision === current.document?.revision) {
          setData({ snapshot, document: remote });
          if (saveStateRef.current !== "dirty") setContent(remote.content);
          setConflict(null);
        } else if (saveStateRef.current === "dirty") {
          setData({ ...current, snapshot });
          setConflict(remote);
        } else {
          setData({ snapshot, document: remote });
          setContent(remote.content);
          setConflict(null);
          setSaveState("saved");
        }
      } catch {
        if (requestId !== refreshRequestRef.current) return;
        if (saveStateRef.current === "dirty" && current.document) {
          setData({ ...current, snapshot });
          setConflict(current.document);
        } else {
          const fallback = newestHealthyPrompt({
            ...snapshot,
            prompts: snapshot.prompts.filter(
              (prompt) => prompt.id !== selectedSummary.id,
            ),
          });
          if (!fallback) showEmptySnapshot(snapshot);
          else {
            try {
              const document = await bridge.libraryRead(fallback.id);
              if (requestId !== refreshRequestRef.current) return;
              selectedRef.current = document.id;
              setSelectedPromptId(document.id);
              setData({ snapshot, document });
              setContent(document.content);
              setConflict(null);
              setSaveState("saved");
            } catch {
              if (requestId === refreshRequestRef.current) {
                showEmptySnapshot(snapshot);
              }
            }
          }
        }
      }
    },
    [bridge, showEmptySnapshot],
  );

  const refreshLibrary = useCallback(async () => {
    ++searchRequestRef.current;
    setSearchResults(searchQueryRef.current.trim() ? [] : null);
    setSearchEpoch((epoch) => epoch + 1);
    const requestId = ++refreshRequestRef.current;
    try {
      const snapshot = await bridge.librarySnapshot();
      setLoadError(false);
      setRootNotConfigured(snapshot.root.status === "unconfigured");
      await reconcileSnapshot(snapshot, requestId);
    } catch {
      if (requestId === refreshRequestRef.current) setLoadError(true);
    }
  }, [bridge, reconcileSnapshot]);

  const requestLibraryRefresh = useCallback(() => {
    if (dialogRef.current || dialogPendingRef.current) {
      deferredRefreshRef.current = true;
      return;
    }
    void refreshLibrary();
  }, [refreshLibrary]);

  const closeDialog = useCallback(
    (refreshDeferred = true) => {
      dialogRef.current = null;
      dialogPendingRef.current = false;
      setDialog(null);
      setDialogValue("");
      setDialogPending(false);
      setOperationError(null);
      if (refreshDeferred && deferredRefreshRef.current) {
        deferredRefreshRef.current = false;
        void refreshLibrary();
      }
    },
    [refreshLibrary],
  );

  const refocusDialogInput = useCallback(() => {
    window.setTimeout(() => dialogInputRef.current?.focus(), 0);
  }, []);

  const loadLibrary = useCallback(async () => {
    setLoadError(false);
    setRootNotConfigured(false);
    try {
      const snapshot = await initialLibrarySnapshot(bridge);
      const unconfigured = snapshot.root.status === "unconfigured";
      setRootNotConfigured(unconfigured);
      setFolderSelection((selection) =>
        selection === "all" ||
        selection === "recent" ||
        snapshot.folders.some((folder) => folder.id === selection)
          ? selection
          : "all",
      );
      const first = newestHealthyPrompt(snapshot);
      let document: PromptDocument | null = null;
      if (snapshot.root.status === "ready" && first) {
        document = await bridge.libraryRead(first.id);
      }
      setData({ snapshot, document });
      setSelectedPromptId(document?.id ?? null);
      selectedRef.current = document?.id ?? null;
      setContent(document?.content ?? "");
      setSaveState("saved");
    } catch (error) {
      if (isRootNotConfiguredError(error)) {
        setRootNotConfigured(true);
      } else {
        setLoadError(true);
      }
    }
  }, [bridge]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    saveStateRef.current = saveState;
    if (saveState === "dirty") markDirtyEditor();
    else clearDirtyEditor();
  }, [saveState]);

  useEffect(() => {
    let unsubscribeLibrary: (() => void) | undefined;
    let unsubscribeSettings: (() => void) | undefined;
    let active = true;
    void bridge.onLibraryUpdate(() => {
      requestLibraryRefresh();
    }).then((next) => {
      if (active) unsubscribeLibrary = next;
      else next();
    }).catch(() => undefined);
    void bridge.onSettingsUpdate(() => {
      requestLibraryRefresh();
    }).then((next) => {
      if (active) unsubscribeSettings = next;
      else next();
    }).catch(() => undefined);
    return () => {
      active = false;
      for (const unsubscribe of [unsubscribeLibrary, unsubscribeSettings]) {
        try {
          unsubscribe?.();
        } catch {
          // Listener cleanup is best-effort during window teardown.
        }
      }
    };
  }, [bridge, requestLibraryRefresh]);

  const selectPrompt = useCallback(
    async (promptId: string) => {
      if (
        promptId === selectedRef.current ||
        saveStateRef.current === "saving"
      ) {
        return;
      }
      const requestId = ++selectionRequestRef.current;
      const summary = dataRef.current?.snapshot.prompts.find(
        (prompt) => prompt.id === promptId,
      );
      if (summary?.health === "issue") {
        if (requestId !== selectionRequestRef.current) return;
        selectedRef.current = promptId;
        setSelectedPromptId(promptId);
        setData((current) =>
          current ? { ...current, document: null } : current,
        );
        setContent("");
        setConflict(null);
        saveStateRef.current = "saved";
        clearDirtyEditor();
        setSaveState("saved");
        return;
      }
      try {
        const document = await bridge.libraryRead(promptId);
        if (requestId !== selectionRequestRef.current) return;
        selectedRef.current = promptId;
        setSelectedPromptId(promptId);
        setData((current) => (current ? { ...current, document } : current));
        setContent(document.content);
        saveStateRef.current = "saved";
        clearDirtyEditor();
        setSaveState("saved");
        setConflict(null);
      } catch {
        if (requestId !== selectionRequestRef.current) return;
        const current = dataRef.current;
        if (current) {
          const requestId = ++refreshRequestRef.current;
          await reconcileSnapshot(current.snapshot, requestId);
        }
      }
    },
    [bridge, reconcileSnapshot],
  );

  useEffect(() => {
    const query = searchQuery.trim();
    const requestId = ++searchRequestRef.current;
    if (!query) {
      setSearchResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void bridge
        .librarySearch(query)
        .then((results) => {
          if (requestId === searchRequestRef.current) setSearchResults(results);
        })
        .catch(() => {
          if (requestId === searchRequestRef.current) setSearchResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [bridge, searchEpoch, searchQuery]);

  const visiblePrompts = useMemo(() => {
    if (!data) return [];
    const filtered = [...(searchResults ?? data.snapshot.prompts)].filter(
      (prompt) => {
        if (folderSelection === "recent") return true;
        return folderSelection === "all" || prompt.folderId === folderSelection;
      },
    );
    return searchQuery.trim() && searchResults !== null
      ? filtered
      : filtered.sort(sortNewestFirst);
  }, [data, folderSelection, searchQuery, searchResults]);

  const saveDocument = useCallback(async () => {
    const document = data?.document;
    if (!document || saveState === "saving") return;
    setSaveState("saving");
    const result = await mutateLibrary({
      kind: "save",
      promptId: document.id,
      baseRevision: document.revision,
      content,
    });
    if (!result) {
      setSaveState("dirty");
      return;
    }
    if (result.status === "conflict") {
      setConflict(result.current);
      setSaveState("dirty");
      return;
    }
    if (result.status === "ok") {
      if (result.document) {
        setData({ snapshot: result.snapshot, document: result.document });
        setSaveState("saved");
      } else {
        setSaveState("dirty");
      }
    } else {
      setOperationError(result.code);
      setSaveState("dirty");
    }
  }, [content, data, mutateLibrary, saveState]);

  const saveWithKeyboard = useCallback(
    (event: KeyboardEvent) => {
      if (!matchesPrimaryShortcut(event, "KeyS")) return;
      event.preventDefault();
      if (saveStateRef.current === "dirty" && conflict === null) {
        void saveDocument();
      }
    },
    [conflict, saveDocument],
  );
  useWindowKeydown(saveWithKeyboard);

  useEffect(() => {
    if (!entryContextMenu) return;
    const dismiss = () => setEntryContextMenu(null);
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [entryContextMenu]);

  const dismissTransientUi = useCallback(
    (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.key !== "Escape" ||
        conflict !== null
      ) {
        return;
      }

      if (dialog) {
        event.preventDefault();
        if (!dialogPending) closeDialog();
        return;
      }
      if (menuOpen || folderMenuId !== null || entryContextMenu !== null) {
        event.preventDefault();
        setMenuOpen(false);
        setFolderMenuId(null);
        setEntryContextMenu(null);
        return;
      }
      if (confirmRootDraftDiscard) {
        event.preventDefault();
        setConfirmRootDraftDiscard(false);
        return;
      }
      if (operationError) {
        event.preventDefault();
        setOperationError(null);
        return;
      }
      if (searchQueryRef.current) {
        event.preventDefault();
        searchQueryRef.current = "";
        setSearchQuery("");
        setSearchResults(null);
      }
    },
    [
      conflict,
      closeDialog,
      confirmRootDraftDiscard,
      dialog,
      dialogPending,
      entryContextMenu,
      folderMenuId,
      menuOpen,
      operationError,
    ],
  );
  useWindowKeydown(dismissTransientUi);

  const reloadConflict = async () => {
    if (!conflict || !data) return;
    if (!data.snapshot.prompts.some((prompt) => prompt.id === conflict.id)) {
      saveStateRef.current = "saved";
      setSaveState("saved");
      setConflict(null);
      const requestId = ++refreshRequestRef.current;
      await reconcileSnapshot(data.snapshot, requestId);
      return;
    }
    setData((current) =>
      current ? { ...current, document: conflict } : current,
    );
    setContent(conflict.content);
    setConflict(null);
    setSaveState("saved");
  };

  const saveConflictCopy = async () => {
    const document = data?.document;
    if (!document) return;
    const promptStillExists = data.snapshot.prompts.some(
      (prompt) => prompt.id === document.id,
    );
    const result = await mutateLibrary(
      promptStillExists
        ? {
            kind: "saveCopy",
            promptId: document.id,
            content,
          }
        : {
            kind: "createPrompt",
            folderId: data.snapshot.folders.some(
              (folder) => folder.id === document.folderId,
            )
              ? document.folderId
              : data.snapshot.root.id,
            name: `${document.name.replace(/\.prompt$/u, "")} copy`,
            content,
          },
    );
    if (!result) return;
    if (result.status === "ok") {
      let nextDocument = result.document ?? null;
      if (!nextDocument && result.createdId) {
        try {
          nextDocument = await bridge.libraryRead(result.createdId);
        } catch {
          setOperationError("generic");
          return;
        }
      }
      if (!nextDocument) {
        setOperationError("generic");
        return;
      }
      selectedRef.current = nextDocument.id;
      setSelectedPromptId(nextDocument.id);
      setData({ snapshot: result.snapshot, document: nextDocument });
      setContent(nextDocument.content);
      setConflict(null);
      setSaveState("saved");
    } else if (result.status === "error") {
      setOperationError(result.code);
    }
  };

  const chooseRoot = async () => {
    setRootChangeBlocked(false);
    try {
      await bridge.chooseLibraryRoot();
      await loadLibrary();
    } catch (error) {
      if (isDirtyEditorBlocked(error)) setRootChangeBlocked(true);
      else setLoadError(true);
    }
  };

  const retryOriginalRoot = async () => {
    setConfirmRootDraftDiscard(false);
    setLoadError(false);
    setRootNotConfigured(false);
    await refreshLibrary();
  };

  const discardDraftAndChooseRoot = async () => {
    const document = dataRef.current?.document;
    if (!document) return;
    setConfirmRootDraftDiscard(false);
    setConflict(null);
    setContent(document.content);
    saveStateRef.current = "saved";
    clearDirtyEditor();
    setSaveState("saved");
    await chooseRoot();
  };

  const isDirtyEntryAffected = (entryId?: string) => {
    const current = dataRef.current;
    const document = current?.document;
    if (saveStateRef.current !== "dirty" || !current || !document) return false;
    const targetId = entryId ?? document.id;
    return (
      targetId === document.id ||
      folderContains(
        current.snapshot.folders,
        targetId,
        document.folderId,
      )
    );
  };

  const openEntryDialog = (
    kind: "rename" | "move",
    entryId?: string,
  ) => {
    setMenuOpen(false);
    setFolderMenuId(null);
    setEntryContextMenu(null);
    if (isDirtyEntryAffected(entryId)) {
      setOperationError("dirtyEntry");
      return;
    }
    setOperationError(null);
    const current = dataRef.current;
    const targetId = entryId ?? current?.document?.id;
    if (!targetId) return;
    const prompt = current?.snapshot.prompts.find(
      (item) => item.id === targetId,
    );
    const originalName = targetId
      ? current?.snapshot.folders.find((folder) => folder.id === targetId)?.name ??
        prompt?.name ??
        (current?.document?.id === targetId ? current.document.name : "")
      : "";
    const nextDialog = { kind, entryId: targetId } as const;
    dialogRef.current = nextDialog;
    dialogPendingRef.current = false;
    setDialogPending(false);
    setDialogValue(
      kind === "rename" && prompt
        ? withoutPromptExtension(originalName)
        : kind === "rename"
          ? originalName
          : "",
    );
    setDialog(nextDialog);
  };

  const openCreatePromptDialog = () => {
    if (saveStateRef.current === "dirty") {
      setOperationError("dirtyCreate");
      return;
    }
    setOperationError(null);
    setDialogValue("");
    const nextDialog = { kind: "createPrompt" } as const;
    dialogRef.current = nextDialog;
    dialogPendingRef.current = false;
    setDialogPending(false);
    setDialog(nextDialog);
  };

  const openCreateFolderDialog = () => {
    setOperationError(null);
    setDialogValue("");
    const nextDialog = { kind: "createFolder" } as const;
    dialogRef.current = nextDialog;
    dialogPendingRef.current = false;
    setDialogPending(false);
    setDialog(nextDialog);
  };

  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !dialog ||
      !dialogValue.trim() ||
      !data ||
      dialogPendingRef.current
    ) {
      return;
    }
    const document = data.document;
    if (
      (dialog.kind === "rename" || dialog.kind === "move") &&
      isDirtyEntryAffected(dialog.entryId)
    ) {
      setOperationError("dirtyEntry");
      return;
    }
    let mutation: LibraryMutation;
    if (dialog.kind === "createPrompt") {
      const folderId =
        typeof folderSelection === "string" &&
        !["all", "recent"].includes(folderSelection)
          ? folderSelection
          : data.snapshot.root.id;
      mutation = { kind: "createPrompt", folderId, name: dialogValue.trim() };
    } else if (dialog.kind === "createFolder") {
      const parentId =
        typeof folderSelection === "string" &&
        !["all", "recent"].includes(folderSelection)
          ? folderSelection
          : data.snapshot.root.id;
      mutation = { kind: "createFolder", parentId, name: dialogValue.trim() };
    } else if (dialog.kind === "rename") {
      const entryId = dialog.entryId;
      const prompt = data.snapshot.prompts.find((item) => item.id === entryId);
      const currentName =
        prompt?.name ??
        data.snapshot.folders.find((folder) => folder.id === entryId)?.name ??
        (document?.id === entryId ? document.name : null);
      const isPrompt = Boolean(prompt || document?.id === entryId);
      if (
        currentName !== null &&
        portableRenameValue(currentName, isPrompt) ===
          portableRenameValue(dialogValue, isPrompt)
      ) {
        closeDialog();
        return;
      }
      mutation = { kind: "rename", entryId, name: dialogValue.trim() };
    } else {
      const entryId = dialog.entryId;
      const destinationId =
        dialogValue === data.snapshot.root.id
          ? data.snapshot.root.id
          : data.snapshot.folders.find((folder) => folder.id === dialogValue)
              ?.id;
      if (!destinationId) return;
      mutation = {
        kind: "move",
        entryId,
        targetFolderId: destinationId,
      };
    }
    const mutatesFolder =
      (mutation.kind === "rename" || mutation.kind === "move") &&
      data.snapshot.folders.some((folder) => folder.id === mutation.entryId);
    dialogPendingRef.current = true;
    setDialogPending(true);
    setOperationError(null);
    const result = await mutateLibrary(mutation);
    dialogPendingRef.current = false;
    setDialogPending(false);
    if (!result) {
      refocusDialogInput();
      return;
    }
    if (result.status === "ok") {
      const refreshAfterSuccess = deferredRefreshRef.current;
      deferredRefreshRef.current = false;
      if (mutatesFolder) {
        const requestId = ++refreshRequestRef.current;
        await reconcileSnapshot(result.snapshot, requestId);
        closeDialog(false);
        if (refreshAfterSuccess) void refreshLibrary();
        return;
      }
      const nextDocument = documentFromSnapshot(
        result.document ?? document,
        result.snapshot,
      );
      setData({
        snapshot: result.snapshot,
        document: nextDocument,
      });
      if (result.createdId && dialog.kind === "createPrompt") {
        await selectPrompt(result.createdId);
      }
      closeDialog(false);
      if (refreshAfterSuccess) void refreshLibrary();
    } else if (result.status === "error") {
      setOperationError(result.code);
      refocusDialogInput();
      return;
    }
  };

  const trashFolder = async (folderId: string) => {
    setEntryContextMenu(null);
    if (
      saveStateRef.current === "dirty" &&
      data?.document &&
      folderContains(
        data.snapshot.folders,
        folderId,
        data.document.folderId,
      )
    ) {
      setOperationError("dirtyTrash");
      setFolderMenuId(null);
      return;
    }
    const result = await mutateLibrary({ kind: "trash", entryId: folderId });
    if (!result) return;
    if (result.status !== "ok") {
      if (result.status === "error") setOperationError(result.code);
      return;
    }
    setFolderSelection("all");
    setFolderMenuId(null);
    const requestId = ++refreshRequestRef.current;
    await reconcileSnapshot(result.snapshot, requestId);
  };

  const trashPrompt = async (promptId: string) => {
    setEntryContextMenu(null);
    if (isDirtyEntryAffected(promptId)) {
      setOperationError("dirtyTrash");
      setMenuOpen(false);
      return;
    }
    const result = await mutateLibrary({
      kind: "trash",
      entryId: promptId,
    });
    if (!result) return;
    if (result.status === "ok") {
      const requestId = ++refreshRequestRef.current;
      await reconcileSnapshot(result.snapshot, requestId);
    } else if (result.status === "error") {
      setOperationError(result.code);
    }
    setMenuOpen(false);
  };

  const trashSelected = async () => {
    const document = data?.document;
    if (document) await trashPrompt(document.id);
  };

  const hasUnavailableDirtyDraft =
    saveState === "dirty" &&
    data?.document !== null &&
    data?.document !== undefined &&
    (loadError ||
      rootNotConfigured ||
      data.snapshot.root.status !== "ready");
  const dialogRenamesPrompt =
    dialog?.kind === "rename" &&
    Boolean(data?.snapshot.prompts.some((prompt) => prompt.id === dialog.entryId));

  if (hasUnavailableDirtyDraft && data?.document) {
    return (
      <main className="manager-shell manager-centered-state manager-draft-recovery">
        <TriangleAlert className="error-icon" aria-hidden="true" />
        <h1>{t("manager.rootError.title")}</h1>
        <p>{t("manager.rootRecovery.body")}</p>
        <textarea
          className="root-recovery-draft"
          aria-label={t("manager.rootRecovery.draftLabel")}
          value={content}
          readOnly
          spellCheck={false}
        />
        <div className="root-recovery-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => void retryOriginalRoot()}
          >
            {t("manager.rootRecovery.retry")}
          </button>
          <button
            type="button"
            onClick={() => setConfirmRootDraftDiscard(true)}
          >
            {t("manager.rootRecovery.discardChoose")}
          </button>
        </div>
        {confirmRootDraftDiscard ? (
          <section className="root-recovery-confirm" role="alert">
            <p>{t("manager.rootRecovery.confirmDiscard")}</p>
            <div className="root-recovery-actions">
              <button
                type="button"
                onClick={() => setConfirmRootDraftDiscard(false)}
              >
                {t("manager.rootRecovery.keepDraft")}
              </button>
              <button
                type="button"
                className="danger-action"
                onClick={() => void discardDraftAndChooseRoot()}
              >
                {t("manager.rootRecovery.discardNow")}
              </button>
            </div>
          </section>
        ) : null}
      </main>
    );
  }

  if (rootNotConfigured) {
    return (
      <main className="manager-shell manager-centered-state">
        <FolderOpen aria-hidden="true" />
        <h1>{t("manager.firstRun.title")}</h1>
        <p>{t("manager.firstRun.body")}</p>
        <button
          type="button"
          className="primary-button"
          onClick={() => void chooseRoot()}
        >
          {t("manager.rootError.choose")}
        </button>
        {rootChangeBlocked ? (
          <p className="inline-error">{t("manager.dirtyRootBlocked")}</p>
        ) : null}
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="manager-shell manager-centered-state">
        <TriangleAlert aria-hidden="true" />
        <h1>{t("manager.rootError.title")}</h1>
        <p>{t("manager.rootError.body")}</p>
        <button
          type="button"
          className="primary-button"
          onClick={() => void loadLibrary()}
        >
          {t("common.retry")}
        </button>
        {rootChangeBlocked ? (
          <p className="inline-error">{t("manager.dirtyRootBlocked")}</p>
        ) : null}
      </main>
    );
  }

  if (!data) {
    return <main className="manager-centered-state">{t("common.loading")}</main>;
  }

  if (data.snapshot.root.status !== "ready") {
    return (
      <main className="manager-shell manager-centered-state">
        <TriangleAlert className="error-icon" aria-hidden="true" />
        <h1>{t("manager.rootError.title")}</h1>
        <p>{t("manager.rootError.body")}</p>
        <button type="button" className="primary-button" onClick={() => void chooseRoot()}>
          {t("manager.rootError.choose")}
        </button>
        {rootChangeBlocked ? <p className="inline-error">{t("manager.dirtyRootBlocked")}</p> : null}
      </main>
    );
  }

  const document = data.document;
  const watcherDegraded = data.snapshot.issues.some(
    (issue) => issue.code === "WatcherDegraded",
  );
  const skippedIssueCount = data.snapshot.issues.filter(
    (issue) => issue.code !== "WatcherDegraded",
  ).length;

  return (
    <main className="manager-shell">
      <ManagerTitlebar
        t={t}
        onOpenSettings={() =>
          void runDocumentAction(() => bridge.showWindow("settings"))
        }
      />
      <section className="manager-workspace">
        <aside className="manager-sidebar">
          <button
            className="primary-button new-prompt-button"
            type="button"
            onClick={openCreatePromptDialog}
          >
            <FilePlus2 aria-hidden="true" />
            {t("manager.newPrompt")}
          </button>
          <label className="manager-search">
            <Search aria-hidden="true" />
            <input
              value={searchQuery}
              onChange={(event) => {
                searchQueryRef.current = event.currentTarget.value;
                setSearchQuery(event.currentTarget.value);
              }}
              placeholder={t("manager.search")}
              aria-label={t("manager.search")}
            />
          </label>
          <SidebarButton
            icon={<Grid2X2 aria-hidden="true" />}
            label={t("manager.all")}
            active={folderSelection === "all"}
            onClick={() => setFolderSelection("all")}
          />
          <SidebarButton
            icon={<Clock3 aria-hidden="true" />}
            label={t("manager.recent")}
            active={folderSelection === "recent"}
            onClick={() => setFolderSelection("recent")}
          />
          <div className="folder-heading">
            <span>{t("manager.folders")}</span>
            <button
              type="button"
              aria-label={t("manager.newFolder")}
              onClick={openCreateFolderDialog}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
          <FolderTree
            folders={data.snapshot.folders}
            selectedId={folderSelection}
            onSelect={setFolderSelection}
            menuId={folderMenuId}
            onMenuToggle={(folderId) => {
              setEntryContextMenu(null);
              setFolderMenuId((current) => current === folderId ? null : folderId);
            }}
            onContextMenu={(event, folderId) => {
              setFolderSelection(folderId);
              openEntryContextMenu(event, "folder", folderId);
            }}
            onRename={(entryId) => {
              openEntryDialog("rename", entryId);
            }}
            onMove={(entryId) => {
              openEntryDialog("move", entryId);
            }}
            onTrash={(entryId) => void trashFolder(entryId)}
          />
        </aside>

        <section className="prompt-browser" data-testid="prompt-list">
          <div className="prompt-columns">
            <span>{t("manager.column.name")}</span>
            <span>{t("manager.column.folder")}</span>
            <span>{t("manager.column.modified")}</span>
          </div>
          <div className="prompt-rows">
            {visiblePrompts.length === 0 ? (
              <p className="prompt-empty">{t("manager.empty")}</p>
            ) : (
              visiblePrompts.map((prompt) => (
                <button
                  type="button"
                  key={prompt.id}
                  className="prompt-row"
                  aria-selected={selectedPromptId === prompt.id}
                  onClick={() => void selectPrompt(prompt.id)}
                  onContextMenu={(event) => {
                    void selectPrompt(prompt.id);
                    openEntryContextMenu(event, "prompt", prompt.id);
                  }}
                >
                  <span className="prompt-name">
                    {prompt.health === "issue" ? (
                      <TriangleAlert className="prompt-issue-icon" aria-hidden="true" />
                    ) : (
                      <FileText aria-hidden="true" />
                    )}
                    {withoutPromptExtension(prompt.name)}
                  </span>
                  <span>{prompt.folderName}</span>
                  <time dateTime={prompt.modifiedAt}>{formatDate(prompt.modifiedAt)}</time>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="prompt-editor">
          {document ? (
            <>
              <div className="editor-path">
                <span>{document.folderName} / {document.name}</span>
                <div className="more-menu-wrap">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Actions"
                    aria-expanded={menuOpen}
                    onClick={() => {
                      setEntryContextMenu(null);
                      setMenuOpen((current) => !current);
                    }}
                  >
                    <EllipsisVertical aria-hidden="true" />
                  </button>
                  {menuOpen ? (
                    <EntryActionsMenu
                      className="more-menu"
                      onRename={() => openEntryDialog("rename")}
                      onMove={() => openEntryDialog("move")}
                      onTrash={() => void trashSelected()}
                    />
                  ) : null}
                </div>
              </div>
              <div className="editor-toolbar">
                <span>{t("manager.plainText")}</span>
                <div>
                  <button
                    type="button"
                    className="primary-button save-button"
                    disabled={
                      saveState === "saved" ||
                      saveState === "saving" ||
                      conflict !== null
                    }
                    onClick={() => void saveDocument()}
                  >
                    <Save aria-hidden="true" />
                    {t("manager.save")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void runDocumentAction(() => bridge.openPrompt(document.id))
                    }
                  >
                    <ExternalLink aria-hidden="true" />{t("manager.open")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void runDocumentAction(() => bridge.revealPrompt(document.id))
                    }
                  >
                    <FolderOpen aria-hidden="true" />{t("manager.reveal")}
                  </button>
                </div>
              </div>
              <textarea
                className="plain-editor"
                aria-label={document.name}
                value={content}
                spellCheck={false}
                onChange={(event) => {
                  setContent(event.currentTarget.value);
                  setSaveState("dirty");
                }}
              />
            </>
          ) : selectedPromptId && data.snapshot.prompts.some(
              (prompt) =>
                prompt.id === selectedPromptId && prompt.health === "issue",
            ) ? (
            <div className="prompt-issue-state" role="status">
              <TriangleAlert aria-hidden="true" />
              <p>{t("manager.promptIssue")}</p>
            </div>
          ) : null}
        </section>
      </section>

      <footer className="manager-statusbar">
        <span className={`save-status save-status-${saveState}`}>
          <i aria-hidden="true" />
          {t(
            saveState === "saved"
              ? "manager.saved"
              : saveState === "saving"
                ? "manager.saving"
                : "manager.unsaved",
          )}
        </span>
        {watcherDegraded ? (
          <span className="library-health-warning" role="status">
            <TriangleAlert aria-hidden="true" />
            {t("manager.watcherDegraded")}
          </span>
        ) : null}
        {skippedIssueCount > 0 ? (
          <span className="library-health-warning" role="status">
            <TriangleAlert aria-hidden="true" />
            {t("manager.libraryIssues", { count: skippedIssueCount })}
          </span>
        ) : null}
        <span>{data.snapshot.root.displayPath}</span>
      </footer>

      {entryContextMenu ? (
        <EntryActionsMenu
          className="context-actions-menu"
          position={{ x: entryContextMenu.x, y: entryContextMenu.y }}
          onRename={() =>
            openEntryDialog("rename", entryContextMenu.entryId)
          }
          onMove={() => openEntryDialog("move", entryContextMenu.entryId)}
          onTrash={() =>
            void (entryContextMenu.kind === "folder"
              ? trashFolder(entryContextMenu.entryId)
              : trashPrompt(entryContextMenu.entryId))
          }
        />
      ) : null}

      {conflict ? (
        <div className="modal-backdrop">
          <section className="dialog" role="alertdialog" aria-modal="true">
            <TriangleAlert className="conflict-icon" aria-hidden="true" />
            <h2>{t("manager.conflict.title")}</h2>
            <p>{t("manager.conflict.body")}</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => void reloadConflict()}>
                <RotateCcw aria-hidden="true" />{t("manager.conflict.reload")}
              </button>
              <button type="button" className="primary-button" onClick={() => void saveConflictCopy()}>
                <Save aria-hidden="true" />{t("manager.conflict.saveCopy")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {dialog ? (
        <div className="modal-backdrop">
          <form
            className="dialog compact-dialog"
            aria-busy={dialogPending}
            onSubmit={(event) => void submitDialog(event)}
          >
            <h2>{t(dialogTitleKey(dialog.kind))}</h2>
            {dialog.kind === "move" ? (
              <select
                autoFocus
                disabled={dialogPending}
                value={dialogValue}
                onChange={(event) => setDialogValue(event.currentTarget.value)}
                aria-label={t("manager.move.select")}
              >
                <option value="">{t("manager.move.select")}</option>
                <option value={data.snapshot.root.id}>
                  {data.snapshot.root.displayPath}
                </option>
                {data.snapshot.folders
                  .filter((folder) => folder.id !== dialog.entryId)
                  .map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folderPath(data.snapshot.folders, folder)}
                    </option>
                  ))}
              </select>
            ) : (
              <label className="dialog-name-field">
                <input
                  ref={dialogInputRef}
                  autoFocus
                  disabled={dialogPending}
                  value={dialogValue}
                  onChange={(event) => setDialogValue(event.currentTarget.value)}
                  aria-label={t(dialogTitleKey(dialog.kind))}
                />
                {dialogRenamesPrompt ? (
                  <span aria-hidden="true">.prompt</span>
                ) : null}
              </label>
            )}
            <p
              className={`inline-error dialog-inline-error${operationError ? "" : " is-placeholder"}`}
              role={operationError ? "alert" : undefined}
              aria-hidden={operationError ? undefined : true}
            >
              {operationError ? mutationErrorMessage(t, operationError) : "\u00a0"}
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={dialogPending}
                onClick={() => closeDialog()}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={dialogPending || !dialogValue.trim()}
              >
                {t(dialogActionKey(dialog.kind))}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {!dialog && operationError ? (
        <p className="inline-error manager-operation-error" role="alert">
          {mutationErrorMessage(t, operationError)}
        </p>
      ) : null}
    </main>
  );
}

function folderPath(folders: FolderSummary[], folder: FolderSummary) {
  const names = [folder.name];
  const byId = new Map(folders.map((item) => [item.id, item] as const));
  let parentId = folder.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" / ");
}

function mutationErrorMessage(
  t: ReturnType<typeof useI18n>["t"],
  code:
    | StableLibraryErrorCode
    | "dirtyCreate"
    | "dirtyEntry"
    | "dirtyTrash"
    | "generic",
) {
  if (code === "dirtyCreate") return t("manager.dirtyCreateBlocked");
  if (code === "dirtyEntry") return t("manager.dirtyEntryBlocked");
  if (code === "dirtyTrash") return t("manager.dirtyTrashBlocked");
  if (code === "generic") return t("manager.error.generic");
  return t(`manager.error.${code}`);
}

function dialogTitleKey(kind: NonNullable<DialogState>["kind"]) {
  if (kind === "createPrompt") return "manager.createPrompt.name" as const;
  if (kind === "createFolder") return "manager.createFolder.name" as const;
  if (kind === "rename") return "manager.rename.name" as const;
  return "manager.move.folder" as const;
}

function dialogActionKey(kind: NonNullable<DialogState>["kind"]) {
  if (kind === "rename") return "manager.rename" as const;
  if (kind === "move") return "manager.move" as const;
  return "common.create" as const;
}

interface ManagerTitlebarProps {
  t: ReturnType<typeof useI18n>["t"];
  onOpenSettings: () => void;
}

function ManagerTitlebar({ t, onOpenSettings }: ManagerTitlebarProps) {
  return (
    <header className="manager-titlebar" data-tauri-drag-region>
      <BrandLockup name={t("app.name")} />
      <button
        type="button"
        className="manager-settings-button"
        aria-label={t("settings.title")}
        onClick={onOpenSettings}
      >
        <SettingsIcon aria-hidden="true" />
      </button>
    </header>
  );
}

interface SidebarButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

function SidebarButton({ icon, label, active, onClick }: SidebarButtonProps) {
  return (
    <button
      type="button"
      className="sidebar-row"
      aria-selected={active}
      onClick={onClick}
    >
      {icon}<span>{label}</span>
    </button>
  );
}

interface FolderTreeProps {
  folders: FolderSummary[];
  selectedId: FolderSelection;
  onSelect: (folderId: string) => void;
  menuId: string | null;
  onMenuToggle: (folderId: string) => void;
  onContextMenu: (
    event: React.MouseEvent<HTMLElement>,
    folderId: string,
  ) => void;
  onRename: (folderId: string) => void;
  onMove: (folderId: string) => void;
  onTrash: (folderId: string) => void;
  parentId?: string | null;
  depth?: number;
}

function FolderTree({
  folders,
  selectedId,
  onSelect,
  menuId,
  onMenuToggle,
  onContextMenu,
  onRename,
  onMove,
  onTrash,
  parentId = null,
  depth = 0,
}: FolderTreeProps) {
  const children = folders.filter((folder) => folder.parentId === parentId);
  if (children.length === 0) return null;
  return (
    <div className="folder-tree" role={depth === 0 ? "tree" : "group"}>
      {children.map((folder) => (
        <div key={folder.id} role="none">
          <FolderTreeRow
            folder={folder}
            active={selectedId === folder.id}
            depth={depth}
            onClick={() => onSelect(folder.id)}
            menuOpen={menuId === folder.id}
            onMenuToggle={() => onMenuToggle(folder.id)}
            onContextMenu={(event) => onContextMenu(event, folder.id)}
            onRename={() => onRename(folder.id)}
            onMove={() => onMove(folder.id)}
            onTrash={() => onTrash(folder.id)}
          />
          <FolderTree
            folders={folders}
            selectedId={selectedId}
            onSelect={onSelect}
            menuId={menuId}
            onMenuToggle={onMenuToggle}
            onContextMenu={onContextMenu}
            onRename={onRename}
            onMove={onMove}
            onTrash={onTrash}
            parentId={folder.id}
            depth={depth + 1}
          />
        </div>
      ))}
    </div>
  );
}

interface FolderTreeRowProps {
  folder: FolderSummary;
  active: boolean;
  depth: number;
  onClick: () => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onRename: () => void;
  onMove: () => void;
  onTrash: () => void;
}

function FolderTreeRow({
  folder,
  active,
  depth,
  onClick,
  menuOpen,
  onMenuToggle,
  onContextMenu,
  onRename,
  onMove,
  onTrash,
}: FolderTreeRowProps) {
  return (
    <div
      className="folder-tree-row"
      role="treeitem"
      aria-selected={active}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className="sidebar-row folder-select-button"
        style={{ paddingInlineStart: `${12 + depth * 20}px` }}
        onClick={onClick}
      >
        <Folder aria-hidden="true" />
        <span>{folder.name}</span>
      </button>
      <button
        type="button"
        className="folder-actions-button"
        aria-label={`${folder.name} Actions`}
        aria-expanded={menuOpen}
        onClick={onMenuToggle}
      >
        <EllipsisVertical aria-hidden="true" />
      </button>
      {menuOpen ? (
        <EntryActionsMenu
          className="folder-actions-menu"
          onRename={onRename}
          onMove={onMove}
          onTrash={onTrash}
        />
      ) : null}
    </div>
  );
}

interface EntryActionsMenuProps {
  className: string;
  position?: { x: number; y: number };
  onRename: () => void;
  onMove: () => void;
  onTrash: () => void;
}

function EntryActionsMenu({
  className,
  position,
  onRename,
  onMove,
  onTrash,
}: EntryActionsMenuProps) {
  const { t } = useI18n();
  return (
    <div
      className={className}
      role="menu"
      style={position ? { left: position.x, top: position.y } : undefined}
      onPointerDown={position ? (event) => event.stopPropagation() : undefined}
    >
      <button type="button" onClick={onRename}>
        <Pencil aria-hidden="true" />{t("manager.rename")}
      </button>
      <button type="button" onClick={onMove}>
        <MoveRight aria-hidden="true" />{t("manager.move")}
      </button>
      <button type="button" className="danger-action" onClick={onTrash}>
        <Trash2 aria-hidden="true" />{t("manager.trash")}
      </button>
    </div>
  );
}
