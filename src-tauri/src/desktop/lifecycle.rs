use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, Runtime, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::library::PromptLibrarySession;

use super::{
    commands::set_autostart,
    error::CommandError,
    settings::SettingsStore,
    state::{DesktopState, spawn_audit, spawn_periodic_audit},
    tray::install_tray,
    windows::{
        LAUNCHER_WINDOW, MANAGER_WINDOW, is_managed_window, show_window_impl, sync_dock_visibility,
    },
};

static EXIT_CONFIRMED: AtomicBool = AtomicBool::new(false);
static EXIT_CONFIRMATION_OPEN: AtomicBool = AtomicBool::new(false);

pub fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let settings_store = SettingsStore::load(app.handle())?;
    let settings = settings_store.get();
    app.manage(DesktopState::new(settings_store));

    let state = app.state::<DesktopState>();
    if let Some(root) = settings.root.as_ref() {
        match PromptLibrarySession::open(root) {
            Ok(session) => state.mount_library(app.handle(), session),
            Err(error) => state.set_library_error(CommandError::from(error)),
        }
    }

    if let Err(error) = state.rebind_shortcut(app.handle(), &settings.shortcut) {
        // A conflicting accelerator must not prevent access to the manager.
        // Surface the diagnostic to stderr; settings_update returns the full
        // structured error when the user chooses a replacement.
        eprintln!("global shortcut is unavailable: {error}");
    }

    if let Err(error) = set_autostart(app.handle(), settings.launch_at_login) {
        eprintln!("could not synchronize launch-at-login: {error}");
    }

    install_tray(app)?;
    spawn_periodic_audit(app.handle().clone());
    sync_dock_visibility(app.handle());

    let background = std::env::args().any(|argument| argument == "--background");
    if !background {
        show_window_impl(app.handle(), MANAGER_WINDOW)?;
    }
    Ok(())
}

pub fn handle_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    let label = window.label();
    match event {
        WindowEvent::CloseRequested { api, .. } if is_managed_window(label) => {
            api.prevent_close();
            let _ = window.hide();
            sync_dock_visibility(window.app_handle());
        }
        WindowEvent::Focused(true) => {
            spawn_audit(window.app_handle().clone());
        }
        WindowEvent::Focused(false) if label == LAUNCHER_WINDOW => {
            let _ = window.hide();
            sync_dock_visibility(window.app_handle());
        }
        _ => {}
    }
}

pub fn lifecycle_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("prompter-desktop-lifecycle")
        .on_event(|app, event| match event {
            tauri::RunEvent::Resumed => spawn_audit(app.clone()),
            tauri::RunEvent::ExitRequested { api, .. }
                if !EXIT_CONFIRMED.load(Ordering::Acquire) =>
            {
                api.prevent_exit();
                request_exit_confirmation(app);
            }
            _ => {}
        })
        .build()
}

fn request_exit_confirmation<R: Runtime>(app: &tauri::AppHandle<R>) {
    if EXIT_CONFIRMATION_OPEN.swap(true, Ordering::AcqRel) {
        return;
    }
    let locale = app.state::<DesktopState>().settings.get().locale;
    let chinese = super::tray::prefers_chinese(&locale);
    let (title, message, quit, cancel) = if chinese {
        (
            "退出 Prompter？",
            "尚未保存的 Prompt 编辑将会丢失。确认退出？",
            "退出",
            "取消",
        )
    } else {
        (
            "Quit Prompter?",
            "Any unsaved prompt edits will be lost. Do you want to quit?",
            "Quit",
            "Cancel",
        )
    };
    let app_for_exit = app.clone();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            quit.to_owned(),
            cancel.to_owned(),
        ))
        .show(move |confirmed| {
            EXIT_CONFIRMATION_OPEN.store(false, Ordering::Release);
            if confirmed {
                EXIT_CONFIRMED.store(true, Ordering::Release);
                app_for_exit.exit(0);
            }
        });
}

pub fn handle_second_instance<R: Runtime>(
    app: &tauri::AppHandle<R>,
    _arguments: Vec<String>,
    _working_directory: String,
) {
    let _ = show_window_impl(app, MANAGER_WINDOW);
}
