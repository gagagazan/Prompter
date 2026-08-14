import { describe, expect, it } from "vitest";
import { dictionary } from "./dictionary";
import { resolveLocale } from "./I18nProvider";

describe("i18n", () => {
  it("uses only the preferred system language when preference is system", () => {
    expect(resolveLocale("system", ["zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(resolveLocale("system", ["fr-FR", "en-US"])).toBe("en");
    expect(resolveLocale("system", ["en-US", "zh-CN"])).toBe("en");
  });

  it("keeps complete zh-CN and English dictionaries", () => {
    expect(Object.keys(dictionary.en).sort()).toEqual(
      Object.keys(dictionary["zh-CN"]).sort(),
    );
  });
});
