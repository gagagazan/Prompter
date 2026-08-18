import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { assertLibraryRootCanChange } from "./dirtyEditor";

export type OpaqueId = string;
export type ContentVersion = string;
export type LanguagePreference = "system" | "zh-CN" | "en";
export type RootStatus = "ready" | "unconfigured" | "missing" | "unreadable";

export interface FolderSummary {
  id: OpaqueId;
  parentId: OpaqueId | null;
  name: string;
}

export interface PromptSummary {
  id: OpaqueId;
  name: string;
  folderId?: OpaqueId;
  folderName: string;
  modifiedAt: string;
  preview: string;
  health?: "ready" | "issue";
}

export interface LibraryRoot {
  id: OpaqueId;
  displayPath: string;
  status: RootStatus;
  errorCode?: "not_found" | "permission_denied" | "unknown";
}

export interface LibrarySnapshot {
  revision: number;
  root: LibraryRoot;
  folders: FolderSummary[];
  prompts: PromptSummary[];
  issues: LibraryIssue[];
}

export interface LibraryIssue {
  code: StableLibraryErrorCode;
  path: string;
  entryId?: OpaqueId;
}

export interface PromptDocument {
  id: OpaqueId;
  name: string;
  folderId: OpaqueId;
  folderName: string;
  content: string;
  revision: ContentVersion;
  modifiedAt: string;
}

export type LibraryMutation =
  | {
      kind: "save";
      promptId: OpaqueId;
      baseRevision: ContentVersion;
      content: string;
    }
  | { kind: "saveCopy"; promptId: OpaqueId; content: string }
  | {
      kind: "createPrompt";
      folderId: OpaqueId;
      name: string;
      content?: string;
    }
  | { kind: "createFolder"; parentId: OpaqueId | null; name: string }
  | { kind: "rename"; entryId: OpaqueId; name: string }
  | {
      kind: "move";
      entryId: OpaqueId;
      targetFolderId: OpaqueId;
    }
  | { kind: "trash"; entryId: OpaqueId };

export type MutationResult =
  | {
      status: "ok";
      snapshot: LibrarySnapshot;
      document?: PromptDocument;
      createdId?: OpaqueId;
    }
  | { status: "conflict"; code: "Conflict"; current: PromptDocument }
  | { status: "error"; code: StableLibraryErrorCode };

export type StableLibraryErrorCode =
  | "RootUnavailable"
  | "NotFound"
  | "StaleId"
  | "Conflict"
  | "NameCollision"
  | "InvalidName"
  | "InvalidEncoding"
  | "TooLarge"
  | "PermissionDenied"
  | "ReadOnly"
  | "FileBusy"
  | "CrossDeviceMove"
  | "TrashUnavailable"
  | "UnsafeEntry"
  | "WatcherDegraded"
  | "RecoveryRequired";

export interface AppSettings {
  language: LanguagePreference;
  launchAtLogin: boolean;
  globalShortcut: string;
  shortcutStatus: "ready" | "unavailable";
  libraryRoot: LibraryRoot;
  fileExtension: string;
  promptCount: number;
  folderCount: number;
}

export type SettingsPatch = Partial<
  Pick<AppSettings, "language" | "launchAtLogin" | "globalShortcut">
>;

export type WindowLabel = "launcher" | "manager" | "settings";

export interface DesktopBridge {
  librarySnapshot(): Promise<LibrarySnapshot>;
  libraryRead(promptId: OpaqueId): Promise<PromptDocument>;
  librarySearch(query: string): Promise<PromptSummary[]>;
  libraryMutate(mutation: LibraryMutation): Promise<MutationResult>;
  chooseLibraryRoot(): Promise<AppSettings>;
  copyPrompt(promptId: OpaqueId): Promise<void>;
  openPrompt(promptId: OpaqueId): Promise<void>;
  revealPrompt(promptId: OpaqueId): Promise<void>;
  settingsGet(): Promise<AppSettings>;
  settingsUpdate(patch: SettingsPatch): Promise<AppSettings>;
  showWindow(label: WindowLabel): Promise<void>;
  closeCurrentWindow(): Promise<void>;
  onLibraryUpdate(listener: () => void): Promise<() => void>;
  onSettingsUpdate(listener: () => void): Promise<() => void>;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function currentWindowLabel(): string | undefined {
  return isTauriRuntime() ? getCurrentWindow().label : undefined;
}

export function createTauriDesktopBridge(): DesktopBridge {
  return {
    librarySnapshot: () => invoke<LibrarySnapshot>("library_snapshot"),
    libraryRead: (promptId) =>
      invoke<PromptDocument>("library_read", { promptId }),
    librarySearch: (query) =>
      invoke<PromptSummary[]>("library_search", { query }),
    libraryMutate: (mutation) =>
      invoke<MutationResult>("library_mutate", { mutation }),
    chooseLibraryRoot: () => {
      assertLibraryRootCanChange();
      return invoke<AppSettings>("choose_library_root");
    },
    copyPrompt: (promptId) => invoke<void>("copy_prompt", { promptId }),
    openPrompt: (promptId) => invoke<void>("open_prompt", { promptId }),
    revealPrompt: (promptId) => invoke<void>("reveal_prompt", { promptId }),
    settingsGet: () => invoke<AppSettings>("settings_get"),
    settingsUpdate: (patch) =>
      invoke<AppSettings>("settings_update", { patch }),
    showWindow: (label) => invoke<void>("show_window", { label }),
    closeCurrentWindow: () => invoke<void>("hide_current_window"),
    onLibraryUpdate: async (listener) =>
      listen("library-updated", () => listener()),
    onSettingsUpdate: async (listener) =>
      listen("settings-updated", () => listener()),
  };
}
