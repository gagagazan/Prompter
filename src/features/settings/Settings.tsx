import { useCallback, useEffect, useRef, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Folder from "lucide-react/dist/esm/icons/folder";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Globe2 from "lucide-react/dist/esm/icons/globe-2";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import SettingsIcon from "lucide-react/dist/esm/icons/settings";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import type { TranslationKey } from "../../i18n/dictionary";
import { useI18n } from "../../i18n/I18nProvider";
import { isDirtyEditorBlocked } from "../../lib/dirtyEditor";
import type {
  AppSettings,
  DesktopBridge,
  LanguagePreference,
  SettingsPatch,
} from "../../lib/desktopBridge";
import { useWindowKeydown } from "../../lib/useWindowKeydown";
import { ShortcutCaptureDialog } from "./ShortcutCaptureDialog";

type SettingsSection = "general" | "shortcut" | "library" | "language";

interface SettingsProps {
  bridge: DesktopBridge;
}

export function Settings({ bridge }: SettingsProps) {
  const { preference, setPreference, t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("library");
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [rootChangeBlocked, setRootChangeBlocked] = useState(false);
  const [shortcutCaptureOpen, setShortcutCaptureOpen] = useState(false);
  const confirmedSettingsRef = useRef<AppSettings | null>(null);

  const applyConfirmedSettings = useCallback(
    (next: AppSettings) => {
      confirmedSettingsRef.current = next;
      setSettings(next);
      setPreference(next.language);
    },
    [setPreference],
  );

  useEffect(() => {
    let active = true;
    bridge.settingsGet().then(
      (next) => {
        if (!active) return;
        applyConfirmedSettings(next);
      },
      () => active && setErrorKey("common.retry"),
    );
    return () => {
      active = false;
    };
  }, [applyConfirmedSettings, bridge]);

  useEffect(() => {
    let active = true;
    let unsubscribeSettings: (() => void) | undefined;
    let unsubscribeLibrary: (() => void) | undefined;

    const refreshConfirmedSettings = async () => {
      try {
        const next = await bridge.settingsGet();
        if (active) applyConfirmedSettings(next);
      } catch {
        if (active) setErrorKey("common.retry");
      }
    };

    void bridge
      .onSettingsUpdate(() => void refreshConfirmedSettings())
      .then((next) => {
        if (active) unsubscribeSettings = next;
        else next();
      })
      .catch(() => {
        // Settings remain editable without the optional update stream.
      });
    void bridge
      .onLibraryUpdate(() => void refreshConfirmedSettings())
      .then((next) => {
        if (active) unsubscribeLibrary = next;
        else next();
      })
      .catch(() => {
        // Counts will refresh the next time the Settings window is opened.
      });

    return () => {
      active = false;
      try {
        unsubscribeSettings?.();
      } catch {
        // Listener cleanup is best-effort while a native window is closing.
      }
      try {
        unsubscribeLibrary?.();
      } catch {
        // Listener cleanup is best-effort while a native window is closing.
      }
    };
  }, [applyConfirmedSettings, bridge]);

  const update = useCallback(
    async (patch: SettingsPatch) => {
      setErrorKey(null);
      setSettings((current) => (current ? { ...current, ...patch } : current));
      try {
        const next = await bridge.settingsUpdate(patch);
        applyConfirmedSettings(next);
      } catch {
        const confirmed = confirmedSettingsRef.current;
        if (confirmed) applyConfirmedSettings(confirmed);
        setErrorKey(
          "globalShortcut" in patch
            ? "settings.error.shortcut"
            : "settings.error.update",
        );
      }
    },
    [applyConfirmedSettings, bridge],
  );

  const chooseRoot = async () => {
    setRootChangeBlocked(false);
    setErrorKey(null);
    try {
      applyConfirmedSettings(await bridge.chooseLibraryRoot());
    } catch (error) {
      if (isDirtyEditorBlocked(error)) setRootChangeBlocked(true);
      else setErrorKey("common.retry");
    }
  };

  const revealRoot = async (rootId: string) => {
    setErrorKey(null);
    try {
      await bridge.revealPrompt(rootId);
    } catch {
      setErrorKey("settings.error.reveal");
    }
  };

  const closeSettings = useCallback(async () => {
    setErrorKey(null);
    try {
      await bridge.closeCurrentWindow();
    } catch {
      setErrorKey("settings.error.close");
    }
  }, [bridge]);

  const closeSettingsWithEscape = useCallback(
    (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.key !== "Escape"
      ) {
        return;
      }
      event.preventDefault();
      void closeSettings();
    },
    [closeSettings],
  );
  useWindowKeydown(closeSettingsWithEscape);

  const changeLanguage = (language: LanguagePreference) => {
    setPreference(language);
    void update({ language });
  };

  if (!settings) {
    return (
      <main className="settings-shell settings-loading">
        {errorKey ? t(errorKey) : t("common.loading")}
      </main>
    );
  }

  return (
    <main className="settings-shell">
      <div className="settings-workspace">
        <aside className="settings-sidebar" aria-label={t("settings.title")}>
          <SettingsNavButton
            icon={<SettingsIcon aria-hidden="true" />}
            label={t("settings.general")}
            active={activeSection === "general"}
            onClick={() => setActiveSection("general")}
          />
          <SettingsNavButton
            icon={<Folder aria-hidden="true" />}
            label={t("settings.library")}
            active={activeSection === "library"}
            onClick={() => setActiveSection("library")}
          />
          <SettingsNavButton
            icon={<Keyboard aria-hidden="true" />}
            label={t("settings.shortcut")}
            active={activeSection === "shortcut"}
            onClick={() => setActiveSection("shortcut")}
          />
          <SettingsNavButton
            icon={<Globe2 aria-hidden="true" />}
            label={t("settings.language")}
            active={activeSection === "language"}
            onClick={() => setActiveSection("language")}
          />
        </aside>

        <section className="settings-content">
          {activeSection === "general" ? (
            <SettingsGroup title={t("settings.general.title")}>
              <SettingsRow
                title={t("settings.launchAtLogin")}
                help={t("settings.launchAtLogin.help")}
              >
                <label className="switch-control">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={t("settings.launchAtLogin")}
                    checked={settings.launchAtLogin}
                    onChange={(event) =>
                      void update({ launchAtLogin: event.currentTarget.checked })
                    }
                  />
                  <span aria-hidden="true" />
                </label>
              </SettingsRow>
            </SettingsGroup>
          ) : null}

          {activeSection === "shortcut" ? (
            <SettingsGroup title={t("settings.shortcut.pageTitle")}>
              <SettingsRow
                title={t("settings.shortcut.title")}
                help={t("settings.shortcut.help")}
              >
                <ShortcutControls
                  shortcut={settings.globalShortcut}
                  changeLabel={t("settings.shortcut.change")}
                  onRequestChange={() => setShortcutCaptureOpen(true)}
                />
              </SettingsRow>
            </SettingsGroup>
          ) : null}

          {activeSection === "library" ? (
            <SettingsGroup
              title={t("settings.library.title")}
              description={t("settings.library.help")}
            >
              <label className="field-label" htmlFor="library-root">
                {t("settings.library.directory")}
              </label>
              <div className="library-root-row">
                <input
                  id="library-root"
                  readOnly
                  value={settings.libraryRoot.displayPath}
                  aria-invalid={settings.libraryRoot.status !== "ready"}
                />
                <button type="button" onClick={() => void chooseRoot()}>
                  {t("settings.library.change")}
                </button>
                <button
                  type="button"
                  disabled={settings.libraryRoot.status !== "ready"}
                  onClick={() => void revealRoot(settings.libraryRoot.id)}
                >
                  {t("settings.library.reveal")}
                </button>
              </div>
              {settings.libraryRoot.status === "ready" ? (
                <>
                  <label className="field-label" htmlFor="library-extension">
                    {t("settings.library.extension")}
                  </label>
                  <input
                    id="library-extension"
                    className="extension-field"
                    value={settings.fileExtension}
                    readOnly
                  />
                  <p className="library-summary">
                    <FolderOpen aria-hidden="true" />
                    {t("settings.library.found", {
                      prompts: settings.promptCount,
                      folders: settings.folderCount,
                    })}
                  </p>
                </>
              ) : (
                <p className="settings-error" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  {t("settings.library.unavailable")}
                </p>
              )}
              {rootChangeBlocked ? (
                <p className="settings-error" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  {t("settings.library.dirtyBlocked")}
                </p>
              ) : null}
            </SettingsGroup>
          ) : null}

          {activeSection === "language" ? (
            <SettingsGroup title={t("settings.language.title")}>
              <SettingsRow
                title={t("settings.language.title")}
                help={t("settings.language.help")}
              >
                <LanguageSelect
                  preference={preference}
                  onChange={changeLanguage}
                  label={t("settings.language.title")}
                  systemLabel={t("settings.language.system")}
                  zhLabel={t("settings.language.zhCN")}
                  enLabel={t("settings.language.en")}
                />
              </SettingsRow>
            </SettingsGroup>
          ) : null}

          {errorKey || settings.shortcutStatus === "unavailable" ? (
            <p className="settings-inline-error" role="alert">
              {t(
                errorKey ?? "settings.error.shortcutUnavailable",
              )}
            </p>
          ) : null}
          <footer className="settings-footer">
            <button
              type="button"
              className="primary-button"
              onClick={() => void closeSettings()}
            >
              {t("common.done")}
            </button>
          </footer>
        </section>
      </div>
      {shortcutCaptureOpen ? (
        <ShortcutCaptureDialog
          title={t("settings.shortcut.capture.title")}
          instruction={t("settings.shortcut.capture.instruction")}
          waitingLabel={t("settings.shortcut.capture.waiting")}
          modifierError={t("settings.shortcut.capture.modifierError")}
          unsupportedKeyError={t("settings.shortcut.capture.keyError")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setShortcutCaptureOpen(false)}
          onCapture={(globalShortcut) => {
            setShortcutCaptureOpen(false);
            void update({ globalShortcut });
          }}
        />
      ) : null}
    </main>
  );
}

interface SettingsNavButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

function SettingsNavButton({
  icon,
  label,
  active,
  onClick,
}: SettingsNavButtonProps) {
  return (
    <button
      type="button"
      className="settings-nav-button"
      aria-selected={active}
      onClick={onClick}
    >
      {icon}<span>{label}</span>
    </button>
  );
}

interface SettingsGroupProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

function SettingsGroup({ title, description, children }: SettingsGroupProps) {
  return (
    <section className="settings-group">
      <h1>{title}</h1>
      {description ? <p className="group-description">{description}</p> : null}
      {children}
    </section>
  );
}

interface SettingsRowProps {
  title: string;
  help: string;
  children: React.ReactNode;
}

function SettingsRow({ title, help, children }: SettingsRowProps) {
  return (
    <div className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{help}</small>
      </span>
      {children}
    </div>
  );
}

interface ShortcutControlsProps {
  shortcut: string;
  changeLabel: string;
  onRequestChange: () => void;
}

function ShortcutControls({
  shortcut,
  changeLabel,
  onRequestChange,
}: ShortcutControlsProps) {
  return (
    <div className="shortcut-controls">
      <kbd>{shortcut}</kbd>
      <button
        type="button"
        onClick={onRequestChange}
      >
        {changeLabel}
      </button>
    </div>
  );
}

interface LanguageSelectProps {
  preference: LanguagePreference;
  onChange: (language: LanguagePreference) => void;
  label: string;
  systemLabel: string;
  zhLabel: string;
  enLabel: string;
}

function LanguageSelect({
  preference,
  onChange,
  label,
  systemLabel,
  zhLabel,
  enLabel,
}: LanguageSelectProps) {
  return (
    <div className="language-select-control">
      <select
        aria-label={label}
        value={preference}
        onChange={(event) =>
          onChange(event.currentTarget.value as LanguagePreference)
        }
      >
        <option value="system">{systemLabel}</option>
        <option value="zh-CN">{zhLabel}</option>
        <option value="en">{enLabel}</option>
      </select>
      <ChevronDown aria-hidden="true" />
    </div>
  );
}
