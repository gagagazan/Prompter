import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

const modifierKeys = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "Shift",
]);

function normalizeShortcutKey(event: ReactKeyboardEvent<HTMLElement>) {
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  if (letter) return letter;

  const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
  if (digit) return digit;

  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.code)?.[0];
  if (functionKey) return functionKey;

  if (event.code === "Space") return "Space";

  if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase();
  if (/^[0-9]$/.test(event.key)) return event.key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(event.key)) {
    return event.key.toUpperCase();
  }
  if (event.key === " " || event.key === "Space" || event.key === "Spacebar") {
    return "Space";
  }
  return null;
}

function shortcutFromKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (modifierKeys.has(event.key)) return null;
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return null;

  const key = normalizeShortcutKey(event);
  if (!key) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.metaKey) parts.push("Super");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

interface ShortcutCaptureDialogProps {
  cancelLabel: string;
  instruction: string;
  modifierError: string;
  title: string;
  unsupportedKeyError: string;
  waitingLabel: string;
  onCancel: () => void;
  onCapture: (shortcut: string) => void;
}

export function ShortcutCaptureDialog({
  cancelLabel,
  instruction,
  modifierError,
  title,
  unsupportedKeyError,
  waitingLabel,
  onCancel,
  onCapture,
}: ShortcutCaptureDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Tab" || event.target !== event.currentTarget) return;

    event.preventDefault();
    event.stopPropagation();
    if (modifierKeys.has(event.key)) {
      setValidationError(null);
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      setValidationError(modifierError);
      return;
    }
    const shortcut = shortcutFromKeyDown(event);
    if (shortcut) onCapture(shortcut);
    else setValidationError(unsupportedKeyError);
  };

  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="dialog compact-dialog shortcut-capture-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-capture-title"
        aria-describedby="shortcut-capture-instruction"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id="shortcut-capture-title">{title}</h2>
        <p id="shortcut-capture-instruction">{instruction}</p>
        <div
          className={`shortcut-capture-field${validationError ? " is-invalid" : ""}`}
          aria-live="polite"
        >
          <KeyboardGlyph />
          <strong role={validationError ? "alert" : undefined}>
            {validationError ?? waitingLabel}
          </strong>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function KeyboardGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h10" />
    </svg>
  );
}
