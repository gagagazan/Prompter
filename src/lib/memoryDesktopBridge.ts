import type {
  AppSettings,
  DesktopBridge,
  FolderSummary,
  LibraryMutation,
  LibrarySnapshot,
  MutationResult,
  PromptDocument,
  PromptSummary,
  SettingsPatch,
  WindowLabel,
} from "./desktopBridge";
import { assertLibraryRootCanChange } from "./dirtyEditor";

interface DemoState {
  revision: number;
  root: LibrarySnapshot["root"];
  folders: FolderSummary[];
  documents: PromptDocument[];
  settings: AppSettings;
  nextId: number;
}

const demoFolders: FolderSummary[] = [
  { id: "folder-engineering", parentId: null, name: "编程" },
  { id: "folder-writing", parentId: null, name: "写作" },
  { id: "folder-work", parentId: null, name: "工作" },
];

const demoDocuments: PromptDocument[] = [
  {
    id: "prompt-code-review",
    name: "代码审查.prompt",
    folderId: "folder-engineering",
    folderName: "编程",
    content:
      "你是一位资深的软件工程师，擅长代码审查。\n\n请检查我提供的代码，并从以下方面给出建议：\n1. 正确性和边界条件\n2. 可读性与命名\n3. 性能和安全风险\n4. 可以直接执行的改进建议\n\n请先总结最重要的问题，再按优先级展开。",
    revision: "content-code-review-v1",
    modifiedAt: "2026-08-12T02:24:00.000Z",
  },
  {
    id: "prompt-debug",
    name: "错误排查.prompt",
    folderId: "folder-engineering",
    folderName: "编程",
    content:
      "请先复现并定位问题，区分现象、证据和假设。在确认根因之前不要急于修改代码。",
    revision: "content-debug-v1",
    modifiedAt: "2026-08-11T08:42:00.000Z",
  },
  {
    id: "prompt-requirements",
    name: "需求拆解.prompt",
    folderId: "folder-engineering",
    folderName: "编程",
    content:
      "把需求拆分成清晰、可验证的小步骤，指出依赖、风险和验收条件。",
    revision: "content-requirements-v1",
    modifiedAt: "2026-08-10T01:31:00.000Z",
  },
  {
    id: "prompt-meeting",
    name: "会议纪要.prompt",
    folderId: "folder-work",
    folderName: "工作",
    content:
      "整理会议记录，输出结论、待办、负责人和截止日期。不要补写原文中不存在的信息。",
    revision: "content-meeting-v1",
    modifiedAt: "2026-08-09T06:08:00.000Z",
  },
  {
    id: "prompt-email",
    name: "邮件润色.prompt",
    folderId: "folder-writing",
    folderName: "写作",
    content:
      "请将邮件改写得专业、直接且友善，保留事实和行动项，不添加新的承诺。",
    revision: "content-email-v1",
    modifiedAt: "2026-08-08T05:20:00.000Z",
  },
];

function promptSummary(document: PromptDocument): PromptSummary {
  return {
    id: document.id,
    name: document.name,
    folderId: document.folderId,
    folderName: document.folderName,
    modifiedAt: document.modifiedAt,
    preview: document.content.replace(/\s+/gu, " ").slice(0, 92),
    health: "ready",
  };
}

function snapshotOf(state: DemoState): LibrarySnapshot {
  return {
    revision: state.revision,
    root: { ...state.root },
    folders: state.folders.map((folder) => ({ ...folder })),
    prompts: state.documents.map(promptSummary),
    issues: [],
  };
}

function cloneDocument(document: PromptDocument): PromptDocument {
  return { ...document };
}

function normalizePromptName(name: string): string {
  return name.endsWith(".prompt") ? name : `${name}.prompt`;
}

export function createMemoryDesktopBridge(): DesktopBridge {
  const root = {
    id: "root-demo",
    displayPath: "/Users/demo/Prompts",
    status: "ready" as const,
  };
  const state: DemoState = {
    revision: 1,
    root,
    folders: demoFolders.map((folder) => ({ ...folder })),
    documents: demoDocuments.map(cloneDocument),
    settings: {
      language: "system",
      launchAtLogin: false,
      globalShortcut: "⌘⇧P",
      shortcutStatus: "ready",
      libraryRoot: root,
      fileExtension: ".prompt",
      promptCount: demoDocuments.length,
      folderCount: demoFolders.length,
    },
    nextId: 1,
  };

  const refreshSettingsCounts = () => {
    state.settings = {
      ...state.settings,
      libraryRoot: { ...state.root },
      promptCount: state.documents.length,
      folderCount: state.folders.length,
    };
  };

  const mutate = (mutation: LibraryMutation): MutationResult => {
    state.revision += 1;
    if (mutation.kind === "save") {
      const index = state.documents.findIndex(
        (document) => document.id === mutation.promptId,
      );
      if (index < 0) return { status: "error", code: "NotFound" };
      const current = state.documents[index];
      if (current.revision !== mutation.baseRevision) {
        return { status: "conflict", code: "Conflict", current: cloneDocument(current) };
      }
      const document = {
        ...current,
        content: mutation.content,
        revision: `content-demo-${state.nextId++}`,
        modifiedAt: new Date(1786501440000 + state.revision * 60000).toISOString(),
      };
      state.documents[index] = document;
      return {
        status: "ok",
        snapshot: snapshotOf(state),
        document: cloneDocument(document),
      };
    }
    if (mutation.kind === "saveCopy") {
      const source = state.documents.find(
        (document) => document.id === mutation.promptId,
      );
      if (!source) return { status: "error", code: "NotFound" };
      const document = {
        ...source,
        id: `prompt-demo-${state.nextId++}`,
        name: source.name.replace(/\.prompt$/u, " 副本.prompt"),
        content: mutation.content,
        revision: `content-demo-${state.nextId++}`,
        modifiedAt: new Date(1786501440000 + state.revision * 60000).toISOString(),
      };
      state.documents.push(document);
      refreshSettingsCounts();
      return {
        status: "ok",
        snapshot: snapshotOf(state),
        document: cloneDocument(document),
        createdId: document.id,
      };
    }
    if (mutation.kind === "createPrompt") {
      const folder =
        mutation.folderId === state.root.id
          ? { id: state.root.id, name: "" }
          : state.folders.find((item) => item.id === mutation.folderId);
      if (!folder) return { status: "error", code: "NotFound" };
      const document: PromptDocument = {
        id: `prompt-demo-${state.nextId++}`,
        name: normalizePromptName(mutation.name),
        folderId: folder.id,
        folderName: folder.name,
        content: mutation.content ?? "",
        revision: `content-demo-${state.nextId++}`,
        modifiedAt: new Date(1786501440000 + state.revision * 60000).toISOString(),
      };
      state.documents.push(document);
      refreshSettingsCounts();
      return {
        status: "ok",
        snapshot: snapshotOf(state),
        document: cloneDocument(document),
        createdId: document.id,
      };
    }
    if (mutation.kind === "createFolder") {
      const folder: FolderSummary = {
        id: `folder-demo-${state.nextId++}`,
        parentId:
          mutation.parentId === state.root.id ? null : mutation.parentId,
        name: mutation.name,
      };
      state.folders.push(folder);
      refreshSettingsCounts();
      return {
        status: "ok",
        snapshot: snapshotOf(state),
        createdId: folder.id,
      };
    }
    const documentIndex = state.documents.findIndex(
      (document) => document.id === mutation.entryId,
    );
    const folderIndex = state.folders.findIndex(
      (folder) => folder.id === mutation.entryId,
    );
    if (mutation.kind === "rename") {
      if (documentIndex >= 0) {
        state.documents[documentIndex] = {
          ...state.documents[documentIndex],
          name: normalizePromptName(mutation.name),
        };
      } else if (folderIndex >= 0) {
        const renamed = { ...state.folders[folderIndex], name: mutation.name };
        state.folders[folderIndex] = renamed;
        state.documents = state.documents.map((document) =>
          document.folderId === renamed.id
            ? { ...document, folderName: renamed.name }
            : document,
        );
      } else {
        return { status: "error", code: "NotFound" };
      }
    } else if (mutation.kind === "move") {
      const destination =
        mutation.targetFolderId === state.root.id
          ? { id: state.root.id, name: "" }
          : state.folders.find(
              (item) => item.id === mutation.targetFolderId,
            );
      if (!destination) {
        return { status: "error", code: "NotFound" };
      }
      if (documentIndex >= 0) {
        state.documents[documentIndex] = {
          ...state.documents[documentIndex],
          folderId: destination.id,
          folderName: destination.name,
        };
      } else if (folderIndex >= 0) {
        const movingId = state.folders[folderIndex].id;
        let cursor: string | null =
          destination.id === state.root.id ? null : destination.id;
        while (cursor) {
          if (cursor === movingId) {
            return { status: "error", code: "UnsafeEntry" };
          }
          cursor =
            state.folders.find((folder) => folder.id === cursor)?.parentId ??
            null;
        }
        state.folders[folderIndex] = {
          ...state.folders[folderIndex],
          parentId:
            destination.id === state.root.id ? null : destination.id,
        };
      } else {
        return { status: "error", code: "NotFound" };
      }
    } else if (mutation.kind === "trash") {
      if (documentIndex >= 0) state.documents.splice(documentIndex, 1);
      else if (folderIndex >= 0) {
        const folderId = state.folders[folderIndex].id;
        state.folders.splice(folderIndex, 1);
        state.documents = state.documents.filter(
          (document) => document.folderId !== folderId,
        );
      } else return { status: "error", code: "NotFound" };
    }
    refreshSettingsCounts();
    return { status: "ok", snapshot: snapshotOf(state) };
  };

  const navigate = (label: WindowLabel) => {
    const next = new URL(window.location.href);
    next.searchParams.set("surface", label);
    window.location.assign(next.toString());
  };

  return {
    librarySnapshot: async () => snapshotOf(state),
    libraryRead: async (promptId) => {
      const document = state.documents.find((item) => item.id === promptId);
      if (!document) throw new Error("not_found");
      return cloneDocument(document);
    },
    librarySearch: async (query) => {
      const normalized = query.trim().toLocaleLowerCase();
      return state.documents
        .filter((document) =>
          normalized
            ? `${document.name} ${document.folderName} ${document.content}`
                .toLocaleLowerCase()
                .includes(normalized)
            : true,
        )
        .map(promptSummary)
        .sort(
          (left, right) =>
            new Date(right.modifiedAt).getTime() -
            new Date(left.modifiedAt).getTime(),
        );
    },
    libraryMutate: async (mutation) => mutate(mutation),
    chooseLibraryRoot: async () => {
      assertLibraryRootCanChange();
      return { ...state.settings };
    },
    copyPrompt: async (promptId) => {
      const document = state.documents.find((item) => item.id === promptId);
      if (!document) throw new Error("not_found");
      await navigator.clipboard?.writeText(document.content);
    },
    openPrompt: async () => undefined,
    revealPrompt: async () => undefined,
    settingsGet: async () => ({ ...state.settings }),
    settingsUpdate: async (patch: SettingsPatch) => {
      state.settings = { ...state.settings, ...patch };
      return { ...state.settings };
    },
    showWindow: async (label) => navigate(label),
    closeCurrentWindow: async () => undefined,
    onLibraryUpdate: async () => () => undefined,
    onSettingsUpdate: async () => () => undefined,
  };
}
