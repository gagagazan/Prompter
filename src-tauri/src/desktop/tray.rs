use tauri::{
    App, AppHandle, Manager, Runtime,
    image::Image,
    menu::{Menu, MenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use super::{
    error::CommandError,
    state::DesktopState,
    windows::{LAUNCHER_WINDOW, MANAGER_WINDOW, SETTINGS_WINDOW, show_window_impl},
};

const TRAY_ID: &str = "prompter-tray";
const MENU_MANAGER: &str = "tray-manager";
const MENU_LAUNCHER: &str = "tray-launcher";
const MENU_SETTINGS: &str = "tray-settings";
const MENU_QUIT: &str = "tray-quit";

pub fn install_tray<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let locale = app.state::<DesktopState>().settings.get().locale;
    let menu = tray_menu(app, &locale)?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Prompter")
        .icon(tray_template_icon()?)
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_MANAGER => {
                let _ = show_window_impl(app, MANAGER_WINDOW);
            }
            MENU_LAUNCHER => {
                let _ = show_window_impl(app, LAUNCHER_WINDOW);
            }
            MENU_SETTINGS => {
                let _ = show_window_impl(app, SETTINGS_WINDOW);
            }
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_window_impl(tray.app_handle(), LAUNCHER_WINDOW);
            }
        });

    builder.build(app)?;
    Ok(())
}

fn tray_template_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(include_bytes!("../../icons/tray/32x32.png"))
}

pub fn update_tray_menu<R: Runtime>(app: &AppHandle<R>, locale: &str) -> Result<(), CommandError> {
    let menu = tray_menu(app, locale)
        .map_err(|error| CommandError::new("trayMenuBuildFailed", error.to_string()))?;
    let tray = app.tray_by_id(TRAY_ID).ok_or_else(|| {
        CommandError::new("trayUnavailable", "The Prompter tray icon is unavailable.")
    })?;
    tray.set_menu(Some(menu))
        .map_err(|error| CommandError::new("trayMenuUpdateFailed", error.to_string()))
}

fn tray_menu<R: Runtime, M: tauri::Manager<R>>(
    manager: &M,
    locale: &str,
) -> tauri::Result<Menu<R>> {
    let labels = tray_labels(locale);
    MenuBuilder::new(manager)
        .text(MENU_MANAGER, labels.manager)
        .text(MENU_LAUNCHER, labels.launcher)
        .separator()
        .text(MENU_SETTINGS, labels.settings)
        .separator()
        .text(MENU_QUIT, labels.quit)
        .build()
}

struct TrayLabels {
    manager: &'static str,
    launcher: &'static str,
    settings: &'static str,
    quit: &'static str,
}

fn tray_labels(locale: &str) -> TrayLabels {
    if prefers_chinese(locale) {
        TrayLabels {
            manager: "打开管理器",
            launcher: "打开启动器",
            settings: "设置",
            quit: "退出 Prompter",
        }
    } else {
        TrayLabels {
            manager: "Open Manager",
            launcher: "Open Launcher",
            settings: "Settings",
            quit: "Quit Prompter",
        }
    }
}

pub(crate) fn prefers_chinese(locale: &str) -> bool {
    let system_locale = locale
        .eq_ignore_ascii_case("system")
        .then(sys_locale::get_locale)
        .flatten();
    prefers_chinese_from(locale, system_locale.as_deref())
}

fn prefers_chinese_from(locale: &str, system_locale: Option<&str>) -> bool {
    let resolved = if locale.eq_ignore_ascii_case("system") {
        system_locale.unwrap_or_default()
    } else {
        locale
    };
    resolved
        .trim()
        .split(['-', '_', '.', '@'])
        .next()
        .is_some_and(|language| language.eq_ignore_ascii_case("zh"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_locale_selects_stable_labels() {
        assert_eq!(tray_labels("zh-CN").settings, "设置");
        assert_eq!(tray_labels("en").settings, "Settings");
    }

    #[test]
    fn tray_template_has_transparent_background_and_visible_foreground() {
        let image = tray_template_icon().expect("tray icon should decode");
        assert_eq!((image.width(), image.height()), (32, 32));
        let mut alphas = image.rgba().iter().skip(3).step_by(4);
        assert!(alphas.clone().any(|alpha| *alpha == 0));
        assert!(alphas.any(|alpha| *alpha > 0));
    }

    #[test]
    fn system_locale_uses_native_locale_result() {
        assert!(prefers_chinese_from("system", Some("zh-Hans-CN")));
        assert!(prefers_chinese_from("system", Some("zh_CN.UTF-8")));
        assert!(!prefers_chinese_from("system", Some("en-US")));
        assert!(!prefers_chinese_from("system", None));
    }

    #[test]
    fn explicit_locale_is_not_overridden_by_system_locale() {
        assert!(prefers_chinese_from("zh-CN", Some("en-US")));
        assert!(!prefers_chinese_from("en", Some("zh-CN")));
        assert!(!prefers_chinese_from("zhongwen", None));
    }
}
