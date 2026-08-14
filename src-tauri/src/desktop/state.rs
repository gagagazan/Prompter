use std::{
    fs,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::RecvTimeoutError,
    },
    thread,
    time::Duration,
};

use parking_lot::{Mutex, RwLock};
use tauri::{Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::library::{LibraryUpdate, PromptLibrarySession, validate_library_root};

use super::{error::CommandError, settings::SettingsStore, windows::show_window_impl};

pub const LIBRARY_UPDATED_EVENT: &str = "library-updated";
pub const SETTINGS_UPDATED_EVENT: &str = "settings-updated";

pub struct DesktopState {
    pub(crate) settings: SettingsStore,
    pub(crate) operation_gate: Mutex<()>,
    library: RwLock<Option<Arc<PromptLibrarySession>>>,
    library_error: RwLock<Option<CommandError>>,
    library_generation: AtomicU64,
    refresh_in_flight: AtomicBool,
    registered_shortcut: Mutex<Option<String>>,
}

impl DesktopState {
    pub fn new(settings: SettingsStore) -> Self {
        Self {
            settings,
            operation_gate: Mutex::new(()),
            library: RwLock::new(None),
            library_error: RwLock::new(None),
            library_generation: AtomicU64::new(0),
            refresh_in_flight: AtomicBool::new(false),
            registered_shortcut: Mutex::new(None),
        }
    }

    pub fn session(&self) -> Result<Arc<PromptLibrarySession>, CommandError> {
        if let Some(error) = self.library_error.read().as_ref() {
            return Err(error.clone());
        }
        if let Some(session) = self.current_session() {
            if let Err(error) = validate_live_root(session.root()) {
                self.set_library_error(error.clone());
                return Err(error);
            }
            return Ok(session);
        }
        Err(CommandError::new(
            "rootNotConfigured",
            "Choose a library folder before using the prompt library.",
        ))
    }

    pub fn set_library_error(&self, error: CommandError) {
        *self.library_error.write() = Some(error);
    }

    pub fn library_error(&self) -> Option<CommandError> {
        self.library_error.read().clone()
    }

    pub fn shortcut_is_ready(&self, configured: &str) -> bool {
        self.registered_shortcut.lock().as_deref() == Some(configured)
    }

    fn current_session(&self) -> Option<Arc<PromptLibrarySession>> {
        self.library.read().as_ref().map(Arc::clone)
    }

    pub fn mount_library<R: Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        session: PromptLibrarySession,
    ) {
        let updates = session.subscribe();
        let session = Arc::new(session);
        let generation = self.library_generation.fetch_add(1, Ordering::SeqCst) + 1;

        *self.library.write() = Some(session);
        *self.library_error.write() = None;

        let app = app.clone();
        let _ = thread::Builder::new()
            .name(format!("library-events-{generation}"))
            .spawn(move || {
                while let Ok(update) = updates.recv() {
                    let Some(state) = app.try_state::<DesktopState>() else {
                        break;
                    };
                    if state.library_generation.load(Ordering::Acquire) != generation {
                        break;
                    }
                    if !update.invalidated {
                        // Committed mutations and explicit refreshes are emitted
                        // by their call sites after projections are consistent.
                        continue;
                    }

                    // Filesystem notifications are invalidation hints. Wait for
                    // a quiet period, coalescing Git checkouts and editor safe-save
                    // bursts, then reconcile from disk exactly once.
                    loop {
                        match updates.recv_timeout(Duration::from_millis(200)) {
                            Ok(_) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    if state.library_generation.load(Ordering::Acquire) != generation {
                        break;
                    }
                    match state.refresh_if_idle() {
                        Ok(Some(refreshed)) => emit_library_update(&app, &refreshed),
                        // Even if the scan found no file delta, the original
                        // hint can carry a newly recorded watcher diagnostic.
                        // Let clients fetch the authoritative snapshot once.
                        Ok(None) => emit_library_update(&app, &update),
                        Err(error) => emit_library_degraded(&app, &error),
                    }
                }
            });
    }

    /// Refreshes on a worker thread call site. Concurrent focus, timer and
    /// watcher recovery requests are coalesced into at most one scan. The
    /// operation gate prevents a watcher scan from observing a mutation's
    /// intermediate filesystem state.
    pub fn refresh_if_idle(&self) -> Result<Option<LibraryUpdate>, CommandError> {
        let _operation = self.operation_gate.lock();
        self.refresh_if_idle_locked()
    }

    /// Refreshes while the caller already owns `operation_gate`.
    pub(crate) fn refresh_if_idle_locked(&self) -> Result<Option<LibraryUpdate>, CommandError> {
        if self
            .refresh_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(None);
        }
        let _guard = RefreshGuard(&self.refresh_in_flight);
        let session = match self.current_session() {
            Some(session) => session,
            None => return Ok(None),
        };
        let previous_revision = session.snapshot().revision;
        match session.refresh() {
            Ok(update) => {
                *self.library_error.write() = None;
                if update.revision != previous_revision || update.invalidated {
                    Ok(Some(update))
                } else {
                    Ok(None)
                }
            }
            Err(error) => {
                let error = CommandError::from(error);
                self.set_library_error(error.clone());
                Err(error)
            }
        }
    }

    fn audit_runtime<R: Runtime>(&self, app: &tauri::AppHandle<R>) {
        let _operation = self.operation_gate.lock();
        let shortcut = self.settings.get().shortcut;
        let shortcut_was_ready = self.shortcut_is_ready(&shortcut);
        if let Err(error) = self.rebind_shortcut(app, &shortcut) {
            eprintln!("global shortcut audit failed: {error}");
        }
        if shortcut_was_ready != self.shortcut_is_ready(&shortcut) {
            emit_settings_update(app, self);
        }

        let Some(root) = self.settings.get().root else {
            return;
        };
        let should_reopen = self.library_error().is_some()
            || self
                .current_session()
                .is_none_or(|session| session.root() != root);

        if should_reopen {
            match PromptLibrarySession::open(&root) {
                Ok(session) => {
                    self.mount_library(app, session);
                    if let Some(session) = self.current_session() {
                        let snapshot = session.snapshot();
                        emit_library_update(
                            app,
                            &LibraryUpdate {
                                revision: snapshot.revision,
                                changed: snapshot
                                    .entries
                                    .into_iter()
                                    .map(|entry| entry.id)
                                    .collect(),
                                invalidated: false,
                            },
                        );
                    }
                }
                Err(error) => {
                    let error = CommandError::from(error);
                    self.set_library_error(error.clone());
                    emit_library_degraded(app, &error);
                }
            }
            return;
        }

        match self.refresh_if_idle_locked() {
            Ok(Some(update)) => emit_library_update(app, &update),
            Ok(None) => {}
            Err(error) => emit_library_degraded(app, &error),
        }
    }

    /// Registers exactly one app-owned global shortcut. Rebinding is
    /// idempotent and restores the previous registration if the new shortcut
    /// is unavailable.
    pub fn rebind_shortcut<R: Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        desired: &str,
    ) -> Result<(), CommandError> {
        desired
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .map_err(|error| CommandError::new("invalidShortcut", error.to_string()))?;

        let manager = app.global_shortcut();
        let mut registered = self.registered_shortcut.lock();
        if registered.as_deref() == Some(desired) && manager.is_registered(desired) {
            return Ok(());
        }

        let previous = registered.clone();
        if let Some(previous) = previous.as_deref() {
            if manager.is_registered(previous) {
                manager.unregister(previous).map_err(|error| {
                    CommandError::new("shortcutUnregisterFailed", error.to_string())
                        .with_details(serde_json::json!({ "shortcut": previous }))
                })?;
            }
        }

        match manager.register(desired) {
            Ok(()) => {
                *registered = Some(desired.to_owned());
                Ok(())
            }
            Err(error) => {
                *registered = None;
                let rollback_error = previous.as_deref().and_then(|previous| {
                    manager
                        .register(previous)
                        .err()
                        .map(|rollback| (previous.to_owned(), rollback.to_string()))
                });
                if rollback_error.is_none() {
                    *registered = previous;
                }

                Err(CommandError::new(
                    "shortcutUnavailable",
                    format!("Could not register {desired}: {error}"),
                )
                .with_details(serde_json::json!({
                    "shortcut": desired,
                    "rollbackError": rollback_error,
                })))
            }
        }
    }
}

struct RefreshGuard<'a>(&'a AtomicBool);

impl Drop for RefreshGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(crate) fn emit_library_update<R: Runtime>(app: &tauri::AppHandle<R>, update: &LibraryUpdate) {
    if let Ok(payload) = serde_json::to_value(update) {
        let _ = app.emit(LIBRARY_UPDATED_EVENT, payload);
    }
}

fn emit_library_degraded<R: Runtime>(app: &tauri::AppHandle<R>, error: &CommandError) {
    let revision = app
        .try_state::<DesktopState>()
        .and_then(|state| state.current_session())
        .map(|session| session.snapshot().revision)
        .unwrap_or_default();
    let _ = app.emit(
        LIBRARY_UPDATED_EVENT,
        serde_json::json!({
            "revision": revision,
            "changed": [],
            "invalidated": false,
            "degraded": true,
            "error": error,
        }),
    );
}

pub fn emit_settings_update<R: Runtime>(app: &tauri::AppHandle<R>, state: &DesktopState) {
    let _ = app.emit(
        SETTINGS_UPDATED_EVENT,
        super::projection::public_settings(state),
    );
}

pub fn spawn_audit<R: Runtime>(app: tauri::AppHandle<R>) {
    let _ = thread::Builder::new()
        .name("desktop-runtime-audit".to_owned())
        .spawn(move || {
            if let Some(state) = app.try_state::<DesktopState>() {
                state.audit_runtime(&app);
            }
        });
}

pub fn spawn_periodic_audit<R: Runtime>(app: tauri::AppHandle<R>) {
    let _ = thread::Builder::new()
        .name("desktop-periodic-audit".to_owned())
        .spawn(move || {
            loop {
                thread::park_timeout(std::time::Duration::from_secs(60));
                let Some(state) = app.try_state::<DesktopState>() else {
                    break;
                };
                state.audit_runtime(&app);
            }
        });
}

pub fn shortcut_handler<R: Runtime>(
    app: &tauri::AppHandle<R>,
    _shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
        let _ = show_window_impl(app, super::windows::LAUNCHER_WINDOW);
    }
}

fn validate_live_root(root: &Path) -> Result<(), CommandError> {
    validate_library_root(root).map_err(CommandError::from)?;
    let canonical = root.canonicalize().map_err(CommandError::from)?;
    if canonical != root {
        return Err(CommandError::new(
            "rootChanged",
            "The configured library root now resolves to a different directory.",
        ));
    }
    fs::read_dir(root).map_err(|error| {
        CommandError::new("rootUnreadable", error.to_string()).with_details(serde_json::json!({
            "path": root,
            "kind": format!("{:?}", error.kind()),
        }))
    })?;
    Ok(())
}
