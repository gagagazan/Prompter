use std::path::PathBuf;

use serde_json::Value;
use tauri::{Runtime, State};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::library::{
    EntryId, EntryKind, LibraryError, LibraryErrorCode, LibraryUpdate, Mutation,
    PromptLibrarySession, validate_library_root,
};

use super::{
    error::CommandError,
    projection::{
        LibrarySnapshotView, MutationResponse, PromptDocumentView, PublicSettings,
        all_prompt_views, is_version_conflict, mutation_response, prompt_document_view,
        public_settings, search_views, snapshot_view,
    },
    settings::SettingsPatch,
    state::{DesktopState, emit_library_update, emit_settings_update},
    tray::update_tray_menu,
    windows::{best_dialog_parent, hide_invoking_window, show_window_impl},
};

#[tauri::command(async)]
pub fn library_snapshot<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
) -> Result<LibrarySnapshotView, CommandError> {
    if let Ok(session) = state.session() {
        return snapshot_view(&session);
    }

    let Some(root) = state.settings.get().root else {
        return Ok(super::projection::unavailable_snapshot(&state));
    };
    let _operation = state.operation_gate.lock();
    // Another audit or command may have recovered the session while this call
    // waited for the operation gate.
    if let Ok(session) = state.session() {
        return snapshot_view(&session);
    }
    if state
        .library_error()
        .is_some_and(|error| error.code == "PermissionDenied")
    {
        return Ok(super::projection::unavailable_snapshot(&state));
    }
    if let Err(error) = validate_library_root(&root) {
        state.set_library_error(CommandError::from(error));
        return Ok(super::projection::unavailable_snapshot(&state));
    }
    let session = match PromptLibrarySession::open(&root) {
        Ok(session) => session,
        Err(error) => {
            state.set_library_error(CommandError::from(error));
            return Ok(super::projection::unavailable_snapshot(&state));
        }
    };
    let snapshot = session.snapshot();
    let mounted = LibraryUpdate {
        revision: snapshot.revision,
        changed: snapshot
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect(),
        invalidated: false,
    };
    state.mount_library(&app, session);
    let session = state.session()?;
    let view = snapshot_view(&session)?;
    emit_library_update(&app, &mounted);
    Ok(view)
}

#[tauri::command(async)]
pub fn library_read(
    state: State<'_, DesktopState>,
    prompt_id: String,
) -> Result<PromptDocumentView, CommandError> {
    let prompt_id = parse_entry_id(&prompt_id)?;
    let session = state.session()?;
    let document = session.read(&prompt_id).map_err(CommandError::from)?;
    prompt_document_view(&session, document)
}

#[tauri::command(async)]
pub fn library_search(
    state: State<'_, DesktopState>,
    query: String,
) -> Result<Vec<super::projection::PromptSummary>, CommandError> {
    let session = state.session()?;
    if query.trim().is_empty() {
        all_prompt_views(&session)
    } else {
        search_views(&session, session.search(&query))
    }
}

#[tauri::command(async)]
pub fn library_mutate<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
    mutation: Value,
) -> Result<MutationResponse, CommandError> {
    let _operation = state.operation_gate.lock();
    let session = state.session()?;
    let mutation = parse_mutation_for_session(mutation, &session)?;
    let conflict_id = save_prompt_id(&mutation).cloned();
    let created = creates_entry(&mutation);
    match session.mutate(mutation) {
        Ok(result) => {
            let update = result.update.clone();
            let response = mutation_response(&session, result, created);
            emit_library_update(&app, &update);
            response
        }
        Err(error) if is_version_conflict(&error) => {
            let prompt_id = conflict_id.ok_or_else(|| CommandError::from(error.clone()))?;
            let current = session.read(&prompt_id).map_err(CommandError::from)?;
            Ok(MutationResponse::Conflict {
                code: "Conflict",
                current: prompt_document_view(&session, current)?,
            })
        }
        Err(error) if is_expected_mutation_error(&error) => Ok(MutationResponse::Error {
            code: mutation_error_code(error.code).to_owned(),
        }),
        Err(error) => Err(CommandError::from(error)),
    }
}

#[tauri::command(async)]
pub fn choose_library_root<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
) -> Result<PublicSettings, CommandError> {
    let current = state.settings.get();
    let mut picker = app
        .dialog()
        .file()
        .set_title("Choose Prompt Library Folder")
        .set_can_create_directories(true);
    if let Some(root) = current.root.as_ref().filter(|path| path.is_dir()) {
        picker = picker.set_directory(root);
    }
    if let Some(parent) = best_dialog_parent(&app, &window) {
        picker = picker.set_parent(&parent);
    }

    let Some(selected) = picker.blocking_pick_folder() else {
        return Ok(public_settings(&state));
    };
    let selected = selected
        .into_path()
        .map_err(|error| CommandError::new("invalidRoot", error.to_string()))?;
    validate_library_root(&selected).map_err(CommandError::from)?;
    let selected = canonical_directory(selected)?;

    let _operation = state.operation_gate.lock();
    if let Ok(session) = state.session() {
        if session.root() == selected {
            if let Some(update) = state.refresh_if_idle_locked()? {
                emit_library_update(&app, &update);
            }
            return Ok(public_settings(&state));
        }
    }

    // Open and validate before persisting the grant. A rejected directory must
    // never displace a working library or become the next startup root.
    let session = PromptLibrarySession::open(&selected).map_err(CommandError::from)?;
    let snapshot = session.snapshot();
    let mounted = LibraryUpdate {
        revision: snapshot.revision,
        changed: snapshot.entries.into_iter().map(|entry| entry.id).collect(),
        invalidated: false,
    };
    let mut next = state.settings.get();
    next.root = Some(selected);
    state.settings.replace(next)?;
    state.mount_library(&app, session);
    emit_library_update(&app, &mounted);
    emit_settings_update(&app, &state);
    update_tray_menu(&app, &state.settings.get().locale)?;
    Ok(public_settings(&state))
}

#[tauri::command(async)]
pub fn copy_prompt<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
    prompt_id: String,
) -> Result<(), CommandError> {
    let prompt_id = parse_entry_id(&prompt_id)?;
    let document = state
        .session()?
        .read(&prompt_id)
        .map_err(CommandError::from)?;
    app.clipboard()
        .write_text(document.content)
        .map_err(|error| CommandError::new("clipboardWriteFailed", error.to_string()))?;
    Ok(())
}

#[tauri::command(async)]
pub fn open_prompt<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
    prompt_id: String,
) -> Result<(), CommandError> {
    let path = checked_prompt_path(&state, &prompt_id)?;
    let path_string = path.to_str().ok_or_else(|| {
        CommandError::new(
            "pathEncodingUnsupported",
            "The selected prompt path cannot be represented for the system opener.",
        )
    })?;

    match app.opener().open_path(path_string, None::<&str>) {
        Ok(()) => Ok(()),
        Err(open_error) => app
            .opener()
            .reveal_item_in_dir(&path)
            .map_err(|reveal_error| {
                CommandError::new(
                    "openPromptFailed",
                    "The prompt could not be opened or revealed in its folder.",
                )
                .with_details(serde_json::json!({
                    "openError": open_error.to_string(),
                    "revealError": reveal_error.to_string(),
                }))
            }),
    }
}

#[tauri::command(async)]
pub fn reveal_prompt<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
    prompt_id: String,
) -> Result<(), CommandError> {
    let path = checked_entry_path(&state, &prompt_id)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| CommandError::new("revealPromptFailed", error.to_string()))
}

#[tauri::command(async)]
pub fn settings_get(state: State<'_, DesktopState>) -> Result<PublicSettings, CommandError> {
    Ok(public_settings(&state))
}

#[tauri::command(async)]
pub fn settings_update<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
    patch: SettingsPatch,
) -> Result<PublicSettings, CommandError> {
    let shortcut_requested = patch.global_shortcut.is_some();
    let locale_requested = patch.language.is_some();
    let autostart_requested = patch.launch_at_login.is_some();
    let _operation = state.operation_gate.lock();

    let previous = state.settings.get();
    let next = patch.apply(&previous)?;

    if shortcut_requested {
        state.rebind_shortcut(&app, &next.shortcut)?;
    }

    let previous_autostart = if autostart_requested {
        match sync_autostart(&app, next.launch_at_login) {
            Ok(previous) => Some(previous),
            Err(error) => {
                if shortcut_requested {
                    let _ = state.rebind_shortcut(&app, &previous.shortcut);
                }
                return Err(error);
            }
        }
    } else {
        None
    };

    if let Err(error) = state.settings.replace(next.clone()) {
        if let Some(previous_autostart) = previous_autostart {
            let _ = set_autostart(&app, previous_autostart);
        }
        if shortcut_requested {
            let _ = state.rebind_shortcut(&app, &previous.shortcut);
        }
        return Err(error);
    }

    if locale_requested {
        if let Err(error) = update_tray_menu(&app, &next.locale) {
            let _ = state.settings.replace(previous.clone());
            if let Some(previous_autostart) = previous_autostart {
                let _ = set_autostart(&app, previous_autostart);
            }
            if shortcut_requested {
                let _ = state.rebind_shortcut(&app, &previous.shortcut);
            }
            return Err(error);
        }
    }
    emit_settings_update(&app, &state);
    Ok(public_settings(&state))
}

#[tauri::command(async)]
pub fn show_window<R: Runtime>(
    app: tauri::AppHandle<R>,
    label: String,
) -> Result<(), CommandError> {
    show_window_impl(&app, &label)
}

#[tauri::command(async)]
pub fn hide_current_window<R: Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<(), CommandError> {
    hide_invoking_window(&window)
}

fn parse_entry_id(raw: &str) -> Result<EntryId, CommandError> {
    serde_json::from_value(Value::String(raw.to_owned())).map_err(|error| {
        CommandError::new("invalidEntryId", error.to_string())
            .with_details(serde_json::json!({ "entryId": raw }))
    })
}

/// `baseRevision` is an opaque content-version string despite its frontend
/// name. The library owns that compatibility spelling and deserializes it
/// directly to `ContentVersion`.
fn parse_mutation(value: Value) -> Result<Mutation, CommandError> {
    serde_json::from_value(value)
        .map_err(|error| CommandError::new("invalidMutation", error.to_string()))
}

fn parse_mutation_for_session(
    mut value: Value,
    session: &PromptLibrarySession,
) -> Result<Mutation, CommandError> {
    let snapshot = session.snapshot();
    let object = value
        .as_object_mut()
        .ok_or_else(|| CommandError::new("invalidMutation", "Mutation must be a JSON object."))?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::new("invalidMutation", "Mutation kind is required."))?;

    match kind {
        "createFolder" => {
            if object.get("parentId").is_none_or(Value::is_null) {
                object.insert(
                    "parentId".to_owned(),
                    serde_json::to_value(&snapshot.root_id)
                        .map_err(|error| CommandError::new("invalidMutation", error.to_string()))?,
                );
            }
        }
        "createPrompt" => strip_prompt_suffix_field(object, "name"),
        "rename" => {
            let renamed_prompt = object
                .get("entryId")
                .and_then(Value::as_str)
                .and_then(|id| {
                    snapshot
                        .entries
                        .iter()
                        .find(|entry| entry.id.as_str() == id)
                })
                .is_some_and(|entry| entry.kind == EntryKind::Prompt);
            if renamed_prompt {
                strip_prompt_suffix_field(object, "name");
            }
        }
        _ => {}
    }
    parse_mutation(value)
}

fn strip_prompt_suffix_field(object: &mut serde_json::Map<String, Value>, field: &str) {
    let Some(name) = object.get(field).and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    if let Some(logical_name) = name.strip_suffix(".prompt") {
        object.insert(field.to_owned(), Value::String(logical_name.to_owned()));
    }
}

fn checked_prompt_path(state: &DesktopState, raw_prompt_id: &str) -> Result<PathBuf, CommandError> {
    let prompt_id = parse_entry_id(raw_prompt_id)?;
    let session = state.session()?;
    // `read` rejects folder IDs and revalidates UTF-8/readability before any
    // path crosses into an OS integration.
    session.read(&prompt_id).map_err(CommandError::from)?;
    session.path_for(&prompt_id).map_err(CommandError::from)
}

fn checked_entry_path(state: &DesktopState, raw_entry_id: &str) -> Result<PathBuf, CommandError> {
    let entry_id = parse_entry_id(raw_entry_id)?;
    state
        .session()?
        .path_for(&entry_id)
        .map_err(CommandError::from)
}

fn save_prompt_id(mutation: &Mutation) -> Option<&EntryId> {
    match mutation {
        Mutation::Save { prompt_id, .. } => Some(prompt_id),
        _ => None,
    }
}

fn creates_entry(mutation: &Mutation) -> bool {
    matches!(
        mutation,
        Mutation::SaveCopy { .. } | Mutation::CreatePrompt { .. } | Mutation::CreateFolder { .. }
    )
}

fn is_expected_mutation_error(error: &LibraryError) -> bool {
    matches!(
        error.code,
        LibraryErrorCode::NotFound
            | LibraryErrorCode::StaleId
            | LibraryErrorCode::NameCollision
            | LibraryErrorCode::InvalidName
            | LibraryErrorCode::InvalidEncoding
            | LibraryErrorCode::TooLarge
            | LibraryErrorCode::PermissionDenied
            | LibraryErrorCode::ReadOnly
            | LibraryErrorCode::FileBusy
            | LibraryErrorCode::CrossDeviceMove
            | LibraryErrorCode::TrashUnavailable
            | LibraryErrorCode::UnsafeEntry
    )
}

fn mutation_error_code(code: LibraryErrorCode) -> &'static str {
    match code {
        LibraryErrorCode::NotFound => "NotFound",
        LibraryErrorCode::StaleId => "StaleId",
        LibraryErrorCode::NameCollision => "NameCollision",
        LibraryErrorCode::InvalidName => "InvalidName",
        LibraryErrorCode::InvalidEncoding => "InvalidEncoding",
        LibraryErrorCode::TooLarge => "TooLarge",
        LibraryErrorCode::PermissionDenied => "PermissionDenied",
        LibraryErrorCode::ReadOnly => "ReadOnly",
        LibraryErrorCode::FileBusy => "FileBusy",
        LibraryErrorCode::CrossDeviceMove => "CrossDeviceMove",
        LibraryErrorCode::TrashUnavailable => "TrashUnavailable",
        LibraryErrorCode::UnsafeEntry => "UnsafeEntry",
        _ => "RecoveryRequired",
    }
}

fn canonical_directory(path: PathBuf) -> Result<PathBuf, CommandError> {
    let metadata = std::fs::metadata(&path).map_err(|error| {
        CommandError::new("invalidRoot", error.to_string())
            .with_details(serde_json::json!({ "path": path }))
    })?;
    if !metadata.is_dir() {
        return Err(CommandError::new(
            "invalidRoot",
            "The selected path is not a directory.",
        ));
    }
    path.canonicalize().map_err(CommandError::from)
}

pub(crate) fn sync_autostart<R: Runtime>(
    app: &tauri::AppHandle<R>,
    desired: bool,
) -> Result<bool, CommandError> {
    let previous = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| CommandError::new("autostartStatusFailed", error.to_string()))?;
    if autostart_needs_update(previous, desired) {
        set_autostart(app, desired)?;
    }
    Ok(previous)
}

fn autostart_needs_update(current: bool, desired: bool) -> bool {
    current != desired
}

pub(crate) fn set_autostart<R: Runtime>(
    app: &tauri::AppHandle<R>,
    enabled: bool,
) -> Result<(), CommandError> {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    result.map_err(|error| {
        CommandError::new("autostartUpdateFailed", error.to_string())
            .with_details(serde_json::json!({ "enabled": enabled }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_accepts_the_frontend_base_revision_name() {
        let parsed = parse_mutation(serde_json::json!({
            "kind": "save",
            "promptId": "prompt-1",
            "baseRevision": "abc",
            "content": "updated"
        }))
        .unwrap();

        match parsed {
            Mutation::Save { base_version, .. } => assert_eq!(base_version.as_str(), "abc"),
            other => panic!("unexpected mutation: {other:?}"),
        }
    }

    #[test]
    fn base_revision_is_not_parsed_as_the_numeric_library_revision() {
        let error = parse_mutation(serde_json::json!({
            "kind": "save",
            "promptId": "prompt-1",
            "baseRevision": 42,
            "content": "updated"
        }))
        .unwrap_err();
        assert_eq!(error.code, "invalidMutation");
    }

    #[test]
    fn mutation_errors_keep_the_public_pascal_case_codes() {
        assert_eq!(
            mutation_error_code(LibraryErrorCode::NameCollision),
            "NameCollision"
        );
        assert_eq!(
            mutation_error_code(LibraryErrorCode::InvalidEncoding),
            "InvalidEncoding"
        );
        assert_eq!(
            mutation_error_code(LibraryErrorCode::TrashUnavailable),
            "TrashUnavailable"
        );
        assert_eq!(
            mutation_error_code(LibraryErrorCode::CrossDeviceMove),
            "CrossDeviceMove"
        );
    }

    #[test]
    fn autostart_is_not_rewritten_when_it_already_matches_settings() {
        assert!(!autostart_needs_update(true, true));
        assert!(!autostart_needs_update(false, false));
        assert!(autostart_needs_update(false, true));
        assert!(autostart_needs_update(true, false));
    }
}
