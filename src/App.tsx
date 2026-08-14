import { useCallback, useEffect, useMemo } from "react";
import "./App.css";
import { resolveSurface } from "./appSurface";
import { Launcher } from "./features/launcher/Launcher";
import { Manager } from "./features/manager/Manager";
import { Settings } from "./features/settings/Settings";
import { I18nProvider, useI18n } from "./i18n/I18nProvider";
import {
  createTauriDesktopBridge,
  currentWindowLabel,
  isTauriRuntime,
  type DesktopBridge,
  type WindowLabel,
} from "./lib/desktopBridge";
import { createMemoryDesktopBridge } from "./lib/memoryDesktopBridge";
import {
  matchesPrimaryShortcut,
  useWindowKeydown,
} from "./lib/useWindowKeydown";

interface AppProps {
  bridge?: DesktopBridge;
  surface?: WindowLabel;
}

export default function App({ bridge: suppliedBridge, surface }: AppProps) {
  const bridge = useMemo(
    () =>
      suppliedBridge ??
      (isTauriRuntime()
        ? createTauriDesktopBridge()
        : createMemoryDesktopBridge()),
    [suppliedBridge],
  );
  const activeSurface =
    surface ?? resolveSurface(window.location.search, currentWindowLabel());

  return (
    <I18nProvider>
      <AppSurface bridge={bridge} surface={activeSurface} />
    </I18nProvider>
  );
}

interface AppSurfaceProps {
  bridge: DesktopBridge;
  surface: WindowLabel;
}

export function AppSurface({ bridge, surface }: AppSurfaceProps) {
  const { locale, setPreference } = useI18n();

  useEffect(() => {
    let active = true;
    bridge.settingsGet().then(
      (settings) => {
        if (active) setPreference(settings.language);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [bridge, setPreference]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void bridge
      .onSettingsUpdate(() => {
        void bridge.settingsGet().then(
          (settings) => {
            if (active) setPreference(settings.language);
          },
          () => undefined,
        );
      })
      .then((next) => {
        if (active) unsubscribe = next;
        else next();
      })
      .catch(() => {
        // The current language remains usable without the optional event stream.
      });
    return () => {
      active = false;
      try {
        unsubscribe?.();
      } catch {
        // Listener cleanup is best-effort while a native window is closing.
      }
    };
  }, [bridge, setPreference]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const openSettings = useCallback(
    async (event: KeyboardEvent) => {
      if (!matchesPrimaryShortcut(event, "Comma")) return;
      event.preventDefault();
      try {
        await bridge.showWindow("settings");
        if (surface === "launcher") await bridge.closeCurrentWindow();
      } catch {
        // Keep the current surface usable if native presentation fails.
      }
    },
    [bridge, surface],
  );
  useWindowKeydown(openSettings);

  if (surface === "launcher") return <Launcher bridge={bridge} />;
  if (surface === "settings") return <Settings bridge={bridge} />;
  return <Manager bridge={bridge} />;
}
