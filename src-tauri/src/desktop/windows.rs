use tauri::{Manager, PhysicalPosition, Runtime};

use super::error::CommandError;

pub const MANAGER_WINDOW: &str = "manager";
pub const LAUNCHER_WINDOW: &str = "launcher";
pub const SETTINGS_WINDOW: &str = "settings";

pub fn show_window_impl<R: Runtime>(
    app: &tauri::AppHandle<R>,
    requested_label: &str,
) -> Result<(), CommandError> {
    let label = normalized_label(requested_label)?;
    let window = find_window(app, label).ok_or_else(|| {
        CommandError::new(
            "windowUnavailable",
            format!("The {label} window is not configured."),
        )
        .with_details(serde_json::json!({ "label": label }))
    })?;

    if label == LAUNCHER_WINDOW {
        center_on_active_screen(app, &window)?;
    }
    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| window_error(label, "restore", error))?;
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    window
        .show()
        .map_err(|error| window_error(label, "show", error))?;
    window
        .set_focus()
        .map_err(|error| window_error(label, "focus", error))?;
    Ok(())
}

/// Hides the webview that issued the IPC call. The caller cannot supply a
/// target label, so a compromised webview cannot hide another application
/// window. Only the three windows declared in `tauri.conf.json` cross this
/// boundary.
pub fn hide_invoking_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), CommandError> {
    let label = managed_label(window.label())?;
    window
        .hide()
        .map_err(|error| window_error(label, "hide", error))?;
    sync_dock_visibility(window.app_handle());
    Ok(())
}

pub fn sync_dock_visibility<R: Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        // Tao intentionally debounces `set_dock_visibility(false)` for one
        // second after showing the Dock. Switching activation policy has no
        // such delay, so a quickly closed last window disappears immediately.
        // The macOS dev runner supplies the bundle identity and icon; this
        // function only decides whether that Dock tile should be present.
        let visible = should_show_dock([MANAGER_WINDOW, LAUNCHER_WINDOW, SETTINGS_WINDOW].map(
            |label| {
                find_window(app, label).is_some_and(|window| window.is_visible().unwrap_or(false))
            },
        ));
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(any(target_os = "macos", test))]
fn should_show_dock(visibility: impl IntoIterator<Item = bool>) -> bool {
    visibility.into_iter().any(|visible| visible)
}

/// Chooses only an app-owned, visible window as the native dialog parent.
/// The invoking settings window therefore cannot accidentally put a picker
/// behind a hidden manager window.
pub fn best_dialog_parent<R: Runtime>(
    app: &tauri::AppHandle<R>,
    caller: &tauri::WebviewWindow<R>,
) -> Option<tauri::WebviewWindow<R>> {
    if is_managed_window(caller.label()) && caller.is_visible().unwrap_or(false) {
        return Some(caller.clone());
    }

    [SETTINGS_WINDOW, MANAGER_WINDOW, LAUNCHER_WINDOW]
        .into_iter()
        .filter_map(|label| find_window(app, label))
        .find(|window| window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false))
}

pub fn is_managed_window(label: &str) -> bool {
    managed_label(label).is_ok()
}

fn normalized_label(label: &str) -> Result<&'static str, CommandError> {
    managed_label(label)
}

fn managed_label(label: &str) -> Result<&'static str, CommandError> {
    match label {
        MANAGER_WINDOW => Ok(MANAGER_WINDOW),
        LAUNCHER_WINDOW => Ok(LAUNCHER_WINDOW),
        SETTINGS_WINDOW => Ok(SETTINGS_WINDOW),
        _ => Err(CommandError::new(
            "invalidWindow",
            "Window label must be manager, launcher, or settings.",
        )
        .with_details(serde_json::json!({ "label": label }))),
    }
}

fn find_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
) -> Option<tauri::WebviewWindow<R>> {
    app.get_webview_window(label)
}

fn center_on_active_screen<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), CommandError> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return window
            .center()
            .map_err(|error| window_error(LAUNCHER_WINDOW, "center", error));
    };

    let window_size = window
        .outer_size()
        .map_err(|error| window_error(LAUNCHER_WINDOW, "measure", error))?;
    let work_area = monitor.work_area();
    let x = i64::from(work_area.position.x)
        + (i64::from(work_area.size.width) - i64::from(window_size.width)) / 2;
    let y = i64::from(work_area.position.y)
        + (i64::from(work_area.size.height) - i64::from(window_size.height)) / 2;
    let x = x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let y = y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| window_error(LAUNCHER_WINDOW, "position", error))
}

fn window_error(label: &str, operation: &str, error: tauri::Error) -> CommandError {
    CommandError::new("windowOperationFailed", error.to_string()).with_details(serde_json::json!({
        "label": label,
        "operation": operation,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_windows_cross_the_ipc_seam() {
        assert_eq!(normalized_label("manager").unwrap(), MANAGER_WINDOW);
        assert_eq!(normalized_label("launcher").unwrap(), LAUNCHER_WINDOW);
        assert_eq!(normalized_label("settings").unwrap(), SETTINGS_WINDOW);
        assert_eq!(normalized_label("main").unwrap_err().code, "invalidWindow");
        assert_eq!(
            normalized_label("../../arbitrary").unwrap_err().code,
            "invalidWindow"
        );
    }

    #[test]
    fn dock_visibility_follows_managed_window_visibility() {
        assert!(!should_show_dock([false, false, false]));
        assert!(should_show_dock([true, false, false]));
        assert!(should_show_dock([false, true, false]));
        assert!(should_show_dock([false, false, true]));
    }
}
