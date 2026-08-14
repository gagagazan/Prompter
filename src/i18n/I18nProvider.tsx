import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { LanguagePreference } from "../lib/desktopBridge";
import {
  dictionary,
  type EffectiveLocale,
  type TranslationKey,
} from "./dictionary";

interface I18nValue {
  locale: EffectiveLocale;
  preference: LanguagePreference;
  setPreference: (preference: LanguagePreference) => void;
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
  formatDate: (value: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function resolveLocale(
  preference: LanguagePreference,
  systemLocales: readonly string[] =
    typeof navigator === "undefined" ? [] : navigator.languages,
): EffectiveLocale {
  if (preference !== "system") return preference;
  return systemLocales[0]?.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en";
}

interface I18nProviderProps {
  children: ReactNode;
  initialLocale?: LanguagePreference;
}

export function I18nProvider({
  children,
  initialLocale = "system",
}: I18nProviderProps) {
  const [preference, setPreference] =
    useState<LanguagePreference>(initialLocale);
  const locale = resolveLocale(preference);

  const t = useCallback(
    (key: TranslationKey, values: Record<string, string | number> = {}) => {
      let message: string = dictionary[locale][key];
      for (const [name, value] of Object.entries(values)) {
        message = message.split(`{${name}}`).join(String(value));
      }
      return message;
    },
    [locale],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      preference,
      setPreference,
      t,
      formatDate: (date) =>
        new Intl.DateTimeFormat(locale, {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(date)),
    }),
    [locale, preference, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
