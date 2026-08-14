import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import FileText from "lucide-react/dist/esm/icons/file-text";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Search from "lucide-react/dist/esm/icons/search";
import X from "lucide-react/dist/esm/icons/x";
import { BrandLockup } from "../../components/BrandLockup";
import { useI18n } from "../../i18n/I18nProvider";
import type { DesktopBridge, PromptSummary } from "../../lib/desktopBridge";
import { useWindowKeydown } from "../../lib/useWindowKeydown";

interface LauncherProps {
  bridge: DesktopBridge;
}

const recoveryContentStyle: CSSProperties = {
  display: "grid",
  justifyItems: "center",
  gap: 12,
  maxWidth: 430,
  padding: "24px 28px",
  textAlign: "center",
};

const recoveryTitleStyle: CSSProperties = {
  color: "var(--text)",
  fontSize: 18,
};

const recoveryBodyStyle: CSSProperties = {
  lineHeight: 1.5,
};

const copyErrorStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  marginTop: 12,
  border: "1px solid #efb5b5",
  borderRadius: 8,
  padding: "10px 12px 10px 15px",
  color: "#8f2020",
  background: "#fff5f5",
};

const copyErrorTextStyle: CSSProperties = {
  display: "grid",
  gap: 3,
  fontSize: 13,
  lineHeight: 1.35,
};

const copyErrorCloseStyle: CSSProperties = {
  display: "grid",
  width: 30,
  height: 30,
  flex: "0 0 auto",
  placeItems: "center",
  borderRadius: "50%",
};

function launcherResults(matches: PromptSummary[]): PromptSummary[] {
  return matches.filter((prompt) => prompt.health !== "issue");
}

export function Launcher({ bridge }: LauncherProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PromptSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [libraryUnavailable, setLibraryUnavailable] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const latestQueryRef = useRef(query);
  const searchRequestRef = useRef(0);
  const copyInFlightRef = useRef(false);

  latestQueryRef.current = query;

  const refreshResults = useCallback(
    async (requestedQuery: string) => {
      const request = ++searchRequestRef.current;
      try {
        const matches = await bridge.librarySearch(requestedQuery);
        if (request !== searchRequestRef.current) return;
        setResults(launcherResults(matches));
        setSelectedIndex(0);
        setLibraryUnavailable(false);
      } catch {
        if (request !== searchRequestRef.current) return;
        setResults([]);
        setSelectedIndex(0);
        setLibraryUnavailable(true);
      }
    },
    [bridge],
  );

  useEffect(() => {
    void refreshResults(query);
  }, [query, refreshResults]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void bridge
      .onLibraryUpdate(() => {
        if (active) void refreshResults(latestQueryRef.current);
      })
      .then((next) => {
        if (active) unsubscribe = next;
        else next();
      })
      .catch(() => {
        // Search remains usable even if the optional update stream is unavailable.
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge, refreshResults]);

  useEffect(
    () => () => {
      searchRequestRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const closeLauncher = useCallback(async () => {
    copyInFlightRef.current = false;
    try {
      await bridge.closeCurrentWindow();
    } catch {
      // A transient presenter failure must not become an unhandled rejection.
    }
  }, [bridge]);

  const copyAndClose = useCallback(
    async (prompt: PromptSummary) => {
      if (copyInFlightRef.current) return;
      copyInFlightRef.current = true;
      setCopyFailed(false);
      try {
        await bridge.copyPrompt(prompt.id);
      } catch {
        setCopyFailed(true);
        copyInFlightRef.current = false;
        return;
      }
      await closeLauncher();
    },
    [bridge, closeLauncher],
  );

  const showManager = useCallback(async () => {
    try {
      await bridge.showWindow("manager");
      await bridge.closeCurrentWindow();
    } catch {
      // Keep the launcher visible if the manager could not be presented.
    }
  }, [bridge]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void closeLauncher();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % results.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex(
          (current) => (current - 1 + results.length) % results.length,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        const selected = results[selectedIndex];
        if (selected) void copyAndClose(selected);
      }
    },
    [closeLauncher, copyAndClose, results, selectedIndex],
  );
  useWindowKeydown(onKeyDown);

  return (
    <main className="launcher-shell">
      <header className="launcher-titlebar" data-tauri-drag-region>
        <BrandLockup name={t("app.name")} />
        <button
          className="titlebar-action"
          type="button"
          onClick={() => void showManager()}
        >
          <FolderOpen aria-hidden="true" />
          {t("launcher.manage")}
        </button>
      </header>

      <section className="launcher-content">
        <label className="launcher-search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("launcher.search")}
            aria-label={t("launcher.search")}
          />
          {query ? (
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={() => setQuery("")}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </label>

        {copyFailed && !libraryUnavailable ? (
          <div role="alert" style={copyErrorStyle}>
            <span style={copyErrorTextStyle}>
              <strong>{t("launcher.copyError.title")}</strong>
              <span>{t("launcher.copyError.body")}</span>
            </span>
            <button
              type="button"
              aria-label={t("common.close")}
              style={copyErrorCloseStyle}
              onClick={() => setCopyFailed(false)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div
          className="launcher-results"
          role={libraryUnavailable ? undefined : "listbox"}
        >
          {libraryUnavailable ? (
            <div className="launcher-empty" role="alert">
              <div style={recoveryContentStyle}>
                <strong style={recoveryTitleStyle}>
                  {t("launcher.libraryError.title")}
                </strong>
                <span style={recoveryBodyStyle}>
                  {t("launcher.libraryError.body")}
                </span>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void showManager()}
                >
                  <FolderOpen aria-hidden="true" />
                  {t("launcher.manage")}
                </button>
              </div>
            </div>
          ) : results.length === 0 ? (
            <p className="launcher-empty">{t("launcher.noResults")}</p>
          ) : (
            results.map((prompt, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className="launcher-result"
                key={prompt.id}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => void copyAndClose(prompt)}
              >
                <FileText className="result-icon" aria-hidden="true" />
                <span className="result-copy">
                  <strong>{prompt.name.replace(/\.prompt$/u, "")}</strong>
                  {index === selectedIndex ? (
                    <>
                      <span className="result-meta">{prompt.folderName}</span>
                      <span className="result-preview">{prompt.preview}</span>
                    </>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <footer className="launcher-hints">
        <span><kbd>↑↓</kbd>{t("launcher.select")}</span>
        <span><kbd>Enter</kbd>{t("launcher.copy")}</span>
        <span><kbd>Esc</kbd>{t("launcher.close")}</span>
      </footer>
    </main>
  );
}
