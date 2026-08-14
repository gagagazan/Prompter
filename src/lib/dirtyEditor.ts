export const DIRTY_EDITOR_MARKER = "prompter:dirty-editor";

export class DirtyEditorBlockedError extends Error {
  readonly code = "dirty_editor";

  constructor() {
    super("dirty_editor");
    this.name = "DirtyEditorBlockedError";
  }
}

export function markDirtyEditor(): void {
  localStorage.setItem(DIRTY_EDITOR_MARKER, "1");
}

export function clearDirtyEditor(): void {
  localStorage.removeItem(DIRTY_EDITOR_MARKER);
}

export function assertLibraryRootCanChange(): void {
  if (localStorage.getItem(DIRTY_EDITOR_MARKER) === "1") {
    throw new DirtyEditorBlockedError();
  }
}

export function isDirtyEditorBlocked(error: unknown): boolean {
  return (
    error instanceof DirtyEditorBlockedError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "dirty_editor")
  );
}
