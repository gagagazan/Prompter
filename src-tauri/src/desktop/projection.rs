use std::{
    collections::HashMap,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::library::{
    EntryHealth, EntryId, EntryKind, LibraryEntry, LibraryErrorCode, LibraryIssue, LibrarySnapshot,
    MutationResult, PromptDocument, PromptLibrarySession, SearchHit,
};

use super::{error::CommandError, settings::AppSettings, state::DesktopState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRootView {
    pub id: String,
    pub display_path: String,
    pub status: RootStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<RootErrorCode>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootStatus {
    Ready,
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RootErrorCode {
    NotFound,
    PermissionDenied,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSummary {
    pub id: EntryId,
    pub parent_id: Option<EntryId>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSummary {
    pub id: EntryId,
    pub name: String,
    pub health: PromptHealth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<EntryId>,
    pub folder_name: String,
    pub modified_at: String,
    pub preview: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptHealth {
    Ready,
    Issue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutStatus {
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshotView {
    pub revision: u64,
    pub root: LibraryRootView,
    pub folders: Vec<FolderSummary>,
    pub prompts: Vec<PromptSummary>,
    pub issues: Vec<LibraryIssueView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIssueView {
    pub code: LibraryErrorCode,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<EntryId>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDocumentView {
    pub id: EntryId,
    pub name: String,
    pub folder_id: EntryId,
    pub folder_name: String,
    pub content: String,
    /// Opaque exact-content version, not the numeric snapshot revision.
    pub revision: crate::library::ContentVersion,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MutationResponse {
    Ok {
        snapshot: LibrarySnapshotView,
        #[serde(skip_serializing_if = "Option::is_none")]
        document: Option<PromptDocumentView>,
        #[serde(skip_serializing_if = "Option::is_none")]
        created_id: Option<EntryId>,
    },
    Conflict {
        code: &'static str,
        current: PromptDocumentView,
    },
    Error {
        code: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub language: String,
    pub launch_at_login: bool,
    pub global_shortcut: String,
    pub shortcut_status: ShortcutStatus,
    pub library_root: LibraryRootView,
    pub file_extension: &'static str,
    pub prompt_count: usize,
    pub folder_count: usize,
}

pub fn snapshot_view(session: &PromptLibrarySession) -> Result<LibrarySnapshotView, CommandError> {
    snapshot_view_from(session, session.snapshot())
}

pub fn snapshot_view_from(
    session: &PromptLibrarySession,
    snapshot: LibrarySnapshot,
) -> Result<LibrarySnapshotView, CommandError> {
    let folder_index = folder_index(&snapshot);
    let root = LibraryRootView {
        id: snapshot.root_id.to_string(),
        display_path: snapshot.root,
        status: RootStatus::Ready,
        error_code: None,
    };

    let folders = snapshot
        .entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::Folder)
        .map(|entry| FolderSummary {
            id: entry.id.clone(),
            parent_id: parent_folder_id(&entry.relative_path, &folder_index),
            name: entry.name.clone(),
        })
        .collect();

    let prompts = snapshot
        .prompts
        .iter()
        .map(|entry| prompt_summary(session, entry, &snapshot.root_id, &folder_index))
        .collect::<Result<Vec<_>, _>>()?;
    let issues = snapshot
        .issues
        .into_iter()
        .map(library_issue_view)
        .collect();

    Ok(LibrarySnapshotView {
        revision: snapshot.revision,
        root,
        folders,
        prompts,
        issues,
    })
}

pub fn prompt_document_view(
    session: &PromptLibrarySession,
    document: PromptDocument,
) -> Result<PromptDocumentView, CommandError> {
    let snapshot = session.snapshot();
    let folders = folder_index(&snapshot);
    let parent_path = parent_relative(&document.relative_path);
    let folder_id = folders
        .get(parent_path)
        .cloned()
        .unwrap_or_else(|| snapshot.root_id.clone());
    let folder_name = folder_display_name(parent_path);
    let modified_at = modified_at(session.path_for(&document.id).ok().as_deref());

    Ok(PromptDocumentView {
        id: document.id,
        name: with_prompt_extension(&document.name),
        folder_id,
        folder_name,
        content: document.content,
        revision: document.version,
        modified_at,
    })
}

pub fn search_views(
    session: &PromptLibrarySession,
    hits: Vec<SearchHit>,
) -> Result<Vec<PromptSummary>, CommandError> {
    let snapshot = session.snapshot();
    let folders = folder_index(&snapshot);
    hits.into_iter()
        .map(|hit| prompt_summary(session, &hit.prompt, &snapshot.root_id, &folders))
        .collect()
}

pub fn all_prompt_views(
    session: &PromptLibrarySession,
) -> Result<Vec<PromptSummary>, CommandError> {
    let snapshot = session.snapshot();
    let folders = folder_index(&snapshot);
    let mut prompts = snapshot
        .prompts
        .iter()
        .map(|prompt| {
            let modified = modified_time(session.path_for(&prompt.id).ok().as_deref());
            let summary = prompt_summary(session, prompt, &snapshot.root_id, &folders)?;
            Ok((modified, prompt.relative_path.clone(), summary))
        })
        .collect::<Result<Vec<_>, CommandError>>()?;
    prompts.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    Ok(prompts.into_iter().map(|(_, _, summary)| summary).collect())
}

pub fn mutation_response(
    session: &PromptLibrarySession,
    result: MutationResult,
    created: bool,
) -> Result<MutationResponse, CommandError> {
    let snapshot = snapshot_view(session)?;
    let created_id = created
        .then(|| result.entry.as_ref().map(|entry| entry.id.clone()))
        .flatten();
    let document = match result.entry.filter(|entry| entry.kind == EntryKind::Prompt) {
        Some(entry) => Some(prompt_document_view(session, session.read(&entry.id)?)?),
        None => None,
    };
    Ok(MutationResponse::Ok {
        snapshot,
        document,
        created_id,
    })
}

pub fn public_settings(state: &DesktopState) -> PublicSettings {
    let settings = state.settings.get();
    let shortcut_status = if state.shortcut_is_ready(&settings.shortcut) {
        ShortcutStatus::Ready
    } else {
        ShortcutStatus::Unavailable
    };
    match state.session() {
        Ok(session) => {
            let snapshot = session.snapshot();
            let prompt_count = snapshot.prompts.len();
            let folder_count = snapshot
                .entries
                .iter()
                .filter(|entry| entry.kind == EntryKind::Folder)
                .count();
            PublicSettings {
                language: settings.locale,
                launch_at_login: settings.launch_at_login,
                global_shortcut: settings.shortcut,
                shortcut_status,
                library_root: LibraryRootView {
                    id: snapshot.root_id.to_string(),
                    display_path: snapshot.root,
                    status: RootStatus::Ready,
                    error_code: None,
                },
                file_extension: ".prompt",
                prompt_count,
                folder_count,
            }
        }
        Err(error) => unavailable_settings(settings, shortcut_status, error),
    }
}

pub fn unavailable_snapshot(state: &DesktopState) -> LibrarySnapshotView {
    let settings = state.settings.get();
    let error = state.library_error().unwrap_or_else(|| {
        CommandError::new(
            "rootNotConfigured",
            "Choose a library folder before using the prompt library.",
        )
    });
    LibrarySnapshotView {
        revision: 0,
        root: unavailable_root(&settings, &error),
        folders: Vec::new(),
        prompts: Vec::new(),
        issues: Vec::new(),
    }
}

fn library_issue_view(issue: LibraryIssue) -> LibraryIssueView {
    LibraryIssueView {
        code: issue.code,
        path: issue.path,
        entry_id: issue.entry_id,
    }
}

fn unavailable_settings(
    settings: AppSettings,
    shortcut_status: ShortcutStatus,
    error: CommandError,
) -> PublicSettings {
    let library_root = unavailable_root(&settings, &error);
    PublicSettings {
        language: settings.locale,
        launch_at_login: settings.launch_at_login,
        global_shortcut: settings.shortcut,
        shortcut_status,
        library_root,
        file_extension: ".prompt",
        prompt_count: 0,
        folder_count: 0,
    }
}

fn unavailable_root(settings: &AppSettings, error: &CommandError) -> LibraryRootView {
    let display_path = settings
        .root
        .as_deref()
        .map(Path::to_string_lossy)
        .map(|path| path.into_owned())
        .unwrap_or_default();
    let (status, error_code) = classify_unavailable_root(settings, error);
    LibraryRootView {
        // This sentinel is deliberately not derived from the absolute path.
        // It can never authorize an operation in `path_for`.
        id: if settings.root.is_none() {
            "unconfigured-session".to_owned()
        } else {
            "unavailable-session".to_owned()
        },
        display_path,
        status,
        error_code: Some(error_code),
    }
}

fn classify_unavailable_root(
    settings: &AppSettings,
    error: &CommandError,
) -> (RootStatus, RootErrorCode) {
    let Some(root) = settings.root.as_deref() else {
        return (RootStatus::Missing, RootErrorCode::NotFound);
    };
    match std::fs::symlink_metadata(root) {
        Err(io) if io.kind() == std::io::ErrorKind::NotFound => {
            return (RootStatus::Missing, RootErrorCode::NotFound);
        }
        Err(io) if io.kind() == std::io::ErrorKind::PermissionDenied => {
            return (RootStatus::Unreadable, RootErrorCode::PermissionDenied);
        }
        _ => {}
    }
    if error.code.to_ascii_lowercase().contains("permission") {
        (RootStatus::Unreadable, RootErrorCode::PermissionDenied)
    } else {
        (RootStatus::Unreadable, RootErrorCode::Unknown)
    }
}

fn prompt_summary(
    session: &PromptLibrarySession,
    entry: &LibraryEntry,
    root_id: &EntryId,
    folders: &HashMap<String, EntryId>,
) -> Result<PromptSummary, CommandError> {
    let parent = parent_relative(&entry.relative_path);
    let folder_id = folders
        .get(parent)
        .cloned()
        .or_else(|| Some(root_id.clone()));
    let content = session
        .read(&entry.id)
        .map(|document| document.content)
        .unwrap_or_default();
    let path = session.path_for(&entry.id).ok();
    Ok(PromptSummary {
        id: entry.id.clone(),
        name: with_prompt_extension(&entry.name),
        health: match entry.health {
            EntryHealth::Healthy => PromptHealth::Ready,
            EntryHealth::Issue => PromptHealth::Issue,
        },
        folder_id,
        folder_name: folder_display_name(parent),
        modified_at: modified_at(path.as_deref()),
        preview: preview(&content),
    })
}

fn folder_index(snapshot: &LibrarySnapshot) -> HashMap<String, EntryId> {
    snapshot
        .entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::Folder)
        .map(|entry| (entry.relative_path.clone(), entry.id.clone()))
        .collect()
}

fn parent_folder_id(relative_path: &str, folders: &HashMap<String, EntryId>) -> Option<EntryId> {
    folders.get(parent_relative(relative_path)).cloned()
}

fn parent_relative(relative_path: &str) -> &str {
    relative_path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("")
}

fn folder_display_name(parent: &str) -> String {
    parent
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("Library")
        .to_owned()
}

fn with_prompt_extension(name: &str) -> String {
    if name.ends_with(".prompt") {
        name.to_owned()
    } else {
        format!("{name}.prompt")
    }
}

fn preview(content: &str) -> String {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(160).collect()
}

fn modified_at(path: Option<&Path>) -> String {
    OffsetDateTime::from(modified_time(path))
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn modified_time(path: Option<&Path>) -> SystemTime {
    path.and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .unwrap_or(UNIX_EPOCH)
}

pub fn is_version_conflict(error: &crate::library::LibraryError) -> bool {
    error.code == LibraryErrorCode::Conflict
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, FileTimes, OpenOptions},
        time::{Duration, UNIX_EPOCH},
    };

    use super::*;

    #[test]
    fn empty_query_projection_orders_prompts_by_most_recent_modification() {
        let root = tempfile::tempdir().unwrap();
        let older = root.path().join("a-older.prompt");
        let newer = root.path().join("z-newer.prompt");
        fs::write(&older, "older").unwrap();
        fs::write(&newer, "newer").unwrap();
        OpenOptions::new()
            .write(true)
            .open(&older)
            .unwrap()
            .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(10)))
            .unwrap();
        OpenOptions::new()
            .write(true)
            .open(&newer)
            .unwrap()
            .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(20)))
            .unwrap();

        let session = PromptLibrarySession::open(root.path()).unwrap();
        let names = all_prompt_views(&session)
            .unwrap()
            .into_iter()
            .map(|prompt| prompt.name)
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["z-newer.prompt", "a-older.prompt"]);
    }

    #[test]
    fn snapshot_projection_exposes_safe_issue_metadata() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("broken.prompt"), [0xff, 0xfe]).unwrap();

        let session = PromptLibrarySession::open(root.path()).unwrap();
        let view = snapshot_view(&session).unwrap();

        assert_eq!(view.issues.len(), 1);
        assert_eq!(view.issues[0].code, LibraryErrorCode::InvalidEncoding);
        assert_eq!(view.issues[0].path, "broken.prompt");
        assert!(view.issues[0].entry_id.is_some());
    }

    #[test]
    fn settings_projection_reports_shortcut_operational_status() {
        let directory = tempfile::tempdir().unwrap();
        let store = super::super::settings::SettingsStore::load_from(
            directory.path().join("settings.json"),
        )
        .unwrap();
        let state = DesktopState::new(store);

        let settings = public_settings(&state);

        assert_eq!(settings.shortcut_status, ShortcutStatus::Unavailable);
    }
}
