use super::file_io::{
    LineEnding, LoadedPrompt, atomic_create, atomic_replace, encode_content, is_exact_prompt_name,
    load_prompt, logical_prompt_name, relocate_no_overwrite,
};
use super::path_safety::is_link_like;
use super::{
    ContentVersion, EntryHealth, EntryId, EntryKind, FolderId, LibraryEntry, LibraryError,
    LibraryErrorCode, LibraryIssue, LibraryResult, LibrarySnapshot, LibraryUpdate, Mutation,
    MutationResult, PromptDocument, PromptId, SearchHit,
};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Weak, mpsc};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

#[derive(Debug, Clone)]
struct InternalEntry {
    public: LibraryEntry,
    relative: PathBuf,
    content: Option<String>,
    has_bom: bool,
    line_ending: LineEnding,
}

#[derive(Debug)]
struct ScannedEntry {
    relative: PathBuf,
    name: String,
    kind: EntryKind,
    loaded: Option<LoadedPrompt>,
    health: EntryHealth,
}

#[derive(Debug)]
struct ScanResult {
    entries: Vec<ScannedEntry>,
    issues: Vec<LibraryIssue>,
}

#[derive(Debug)]
struct SessionState {
    root_id: FolderId,
    revision: u64,
    entries: HashMap<EntryId, InternalEntry>,
    path_to_id: HashMap<PathBuf, EntryId>,
    issues: Vec<LibraryIssue>,
    watcher_issue: Option<LibraryIssue>,
    subscribers: Vec<mpsc::Sender<LibraryUpdate>>,
    invalidated: bool,
    invalidation_epoch: u64,
}

#[derive(Debug)]
struct SessionCore {
    state: Mutex<SessionState>,
}

pub(crate) type WatchEventHandler = Box<dyn FnMut(notify::Result<Event>) + Send>;

/// Owns the platform watcher for as long as the library session is alive.
pub(crate) struct WatchSubscription {
    _watcher: Option<RecommendedWatcher>,
}

impl WatchSubscription {
    #[cfg(test)]
    pub(crate) fn inert() -> Self {
        Self { _watcher: None }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct WatchStartError {
    operation: &'static str,
    reason: String,
}

impl WatchStartError {
    pub(crate) fn new(operation: &'static str, reason: impl Into<String>) -> Self {
        Self {
            operation,
            reason: reason.into(),
        }
    }
}

type WatchStarter = fn(&Path, WatchEventHandler) -> Result<WatchSubscription, WatchStartError>;

pub(crate) fn validate_library_root_candidate(requested_root: &Path) -> LibraryResult<()> {
    let metadata = fs::symlink_metadata(requested_root).map_err(|error| {
        LibraryError::invalid_root(requested_root, "root cannot be accessed")
            .detail("operation", "metadataRoot")
            .detail("reason", error.to_string())
    })?;
    if is_link_like(&metadata) {
        return Err(LibraryError::invalid_root(
            requested_root,
            "root is a link-like filesystem entry",
        ));
    }
    if !metadata.is_dir() {
        return Err(LibraryError::invalid_root(
            requested_root,
            "root is not a directory",
        ));
    }
    fs::read_dir(requested_root).map_err(|error| {
        LibraryError::invalid_root(requested_root, "root cannot be enumerated")
            .detail("operation", "readRoot")
            .detail("reason", error.to_string())
    })?;
    Ok(())
}

/// One open, watched view of a prompt-library directory.
pub struct PromptLibrarySession {
    root: PathBuf,
    core: Arc<SessionCore>,
    // Keeping the watcher alive is the subscription. Events only invalidate the
    // snapshot; reconciliation is explicit through `refresh`.
    _watcher: Option<WatchSubscription>,
    trash: Arc<dyn TrashAdapter>,
}

pub(crate) trait TrashAdapter: Send + Sync {
    fn delete(&self, path: &Path) -> Result<(), String>;
}

struct SystemTrash;

impl TrashAdapter for SystemTrash {
    fn delete(&self, path: &Path) -> Result<(), String> {
        trash::delete(path).map_err(|error| error.to_string())
    }
}

fn start_system_watcher(
    root: &Path,
    handler: WatchEventHandler,
) -> Result<WatchSubscription, WatchStartError> {
    let mut watcher = RecommendedWatcher::new(handler, Config::default())
        .map_err(|error| WatchStartError::new("createWatcher", error.to_string()))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|error| WatchStartError::new("watchRoot", error.to_string()))?;
    Ok(WatchSubscription {
        _watcher: Some(watcher),
    })
}

fn handle_watch_event(weak_core: &Weak<SessionCore>, root: &Path, event: notify::Result<Event>) {
    let Some(core) = weak_core.upgrade() else {
        return;
    };
    let mut state = core.state.lock();
    state.invalidation_epoch = state.invalidation_epoch.saturating_add(1);
    if let Err(error) = event {
        state.watcher_issue = Some(watcher_degraded_issue(
            root,
            "watchEvent",
            error.to_string(),
        ));
    }
    if state.invalidated {
        return;
    }
    state.invalidated = true;
    let update = LibraryUpdate {
        revision: state.revision,
        changed: Vec::new(),
        invalidated: true,
    };
    publish(&mut state, &update);
}

fn watcher_degraded_issue(root: &Path, operation: &'static str, reason: String) -> LibraryIssue {
    let error = LibraryError::new(
        LibraryErrorCode::WatcherDegraded,
        "The prompt library could not watch the selected directory.",
    )
    .detail("operation", operation)
    .detail("path", root.to_string_lossy())
    .detail("reason", reason);
    LibraryIssue {
        code: error.code,
        path: String::new(),
        message: error.message,
        entry_id: None,
        details: error.details,
    }
}

impl PromptLibrarySession {
    pub fn open(root: impl AsRef<Path>) -> LibraryResult<Self> {
        Self::open_with_trash(root, Arc::new(SystemTrash))
    }

    pub(crate) fn open_with_trash(
        root: impl AsRef<Path>,
        trash: Arc<dyn TrashAdapter>,
    ) -> LibraryResult<Self> {
        Self::open_with_adapters(root, trash, start_system_watcher)
    }

    pub(crate) fn open_with_adapters(
        root: impl AsRef<Path>,
        trash: Arc<dyn TrashAdapter>,
        start_watcher: WatchStarter,
    ) -> LibraryResult<Self> {
        let requested_root = root.as_ref();
        validate_library_root_candidate(requested_root)?;
        let root = fs::canonicalize(requested_root).map_err(|error| {
            LibraryError::invalid_root(requested_root, "root cannot be resolved safely")
                .detail("operation", "canonicalizeRoot")
                .detail("reason", error.to_string())
        })?;
        let state = SessionState {
            root_id: EntryId::random(),
            revision: 1,
            entries: HashMap::new(),
            path_to_id: HashMap::new(),
            issues: Vec::new(),
            watcher_issue: None,
            subscribers: Vec::new(),
            invalidated: false,
            invalidation_epoch: 0,
        };
        let core = Arc::new(SessionCore {
            state: Mutex::new(state),
        });

        let weak_core: Weak<SessionCore> = Arc::downgrade(&core);
        let watched_root = root.clone();
        let handler: WatchEventHandler = Box::new(move |event| {
            handle_watch_event(&weak_core, &watched_root, event);
        });

        // Register before the first scan so an edit cannot land in the gap
        // between reading the directory and subscribing to OS notifications.
        // A watcher is only a hint source: failure is diagnostic, not fatal.
        let watcher = match start_watcher(&root, handler) {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                core.state.lock().watcher_issue =
                    Some(watcher_degraded_issue(&root, error.operation, error.reason));
                None
            }
        };

        let scanned = scan_library(&root)?;
        install_initial_scan(&mut core.state.lock(), scanned);

        Ok(Self {
            root,
            core,
            _watcher: watcher,
            trash,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn snapshot(&self) -> LibrarySnapshot {
        let state = self.core.state.lock();
        snapshot_from_state(&self.root, &state)
    }

    pub fn read(&self, id: &PromptId) -> LibraryResult<PromptDocument> {
        let mut state = self.core.state.lock();
        let entry = state
            .entries
            .get(id)
            .cloned()
            .ok_or_else(|| LibraryError::not_found(id.as_str()))?;
        if entry.public.kind != EntryKind::Prompt {
            return Err(LibraryError::unsupported(
                &self.root.join(&entry.relative),
                "entry is a folder",
            ));
        }
        let path = ensure_safe_entry(&self.root, &entry.relative, EntryKind::Prompt)?;
        let loaded = load_prompt(&path)?;
        if entry.public.version.as_ref() != Some(&loaded.version) {
            if let Some(cached) = state.entries.get_mut(id) {
                apply_loaded_prompt(cached, &loaded);
            }
            let update = advance(&mut state, vec![id.clone()]);
            publish(&mut state, &update);
        }
        Ok(PromptDocument {
            id: id.clone(),
            name: entry.public.name,
            relative_path: relative_string(&entry.relative),
            content: loaded.content,
            version: loaded.version,
        })
    }

    /// Searches the in-memory index. Call `refresh` after an invalidation to
    /// reconcile external filesystem edits before searching.
    pub fn search(&self, query: &str) -> Vec<SearchHit> {
        let folded_query = fold_text(query.trim());
        if folded_query.is_empty() {
            return Vec::new();
        }
        let tokens: Vec<&str> = folded_query.split_whitespace().collect();
        let state = self.core.state.lock();
        let mut hits = Vec::new();
        for entry in state.entries.values() {
            if entry.public.kind != EntryKind::Prompt {
                continue;
            }
            let name = fold_text(&entry.public.name);
            let path = fold_text(&entry.public.relative_path);
            let content = fold_text(entry.content.as_deref().unwrap_or_default());
            let mut score = 0_u32;
            let mut all_tokens_match = true;
            for token in &tokens {
                let token_score = if name == *token {
                    1_000
                } else if name.starts_with(token) {
                    700
                } else if name.contains(token) {
                    500
                } else if path.contains(token) {
                    300
                } else if content.contains(token) {
                    100 + content.matches(token).take(10).count() as u32
                } else {
                    all_tokens_match = false;
                    0
                };
                score = score.saturating_add(token_score);
            }
            if all_tokens_match {
                hits.push(SearchHit {
                    prompt: entry.public.clone(),
                    score,
                });
            }
        }
        hits.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| {
                    portable_key(&left.prompt.name).cmp(&portable_key(&right.prompt.name))
                })
                .then_with(|| left.prompt.relative_path.cmp(&right.prompt.relative_path))
        });
        hits
    }

    pub fn mutate(&self, mutation: Mutation) -> LibraryResult<MutationResult> {
        let mut state = self.core.state.lock();
        match mutation {
            Mutation::Save {
                prompt_id,
                base_version,
                content,
            } => self.save(&mut state, &prompt_id, &base_version, &content),
            Mutation::SaveCopy { prompt_id, content } => {
                self.save_copy(&mut state, &prompt_id, &content)
            }
            Mutation::CreatePrompt {
                folder_id,
                name,
                content,
            } => self.create_prompt(&mut state, &folder_id, &name, &content),
            Mutation::CreateFolder { parent_id, name } => {
                self.create_folder(&mut state, &parent_id, &name)
            }
            Mutation::Rename { entry_id, name } => self.rename(&mut state, &entry_id, &name),
            Mutation::Move {
                entry_id,
                target_folder_id,
            } => self.move_entry(&mut state, &entry_id, &target_folder_id),
            Mutation::Trash { entry_id } => self.trash_entry(&mut state, &entry_id),
        }
    }

    /// Reconciles the cache with disk. IDs for entries at unchanged relative
    /// paths remain stable; newly discovered entries receive new session IDs.
    pub fn refresh(&self) -> LibraryResult<LibraryUpdate> {
        let scan_epoch = self.core.state.lock().invalidation_epoch;
        let scanned = scan_library(&self.root)?;
        let mut state = self.core.state.lock();
        let invalidated_during_scan = state.invalidation_epoch != scan_epoch;
        state.invalidated = invalidated_during_scan;
        let (changed, issues_changed) = reconcile_scan(&mut state, scanned);
        let mut update = if changed.is_empty() && !issues_changed {
            LibraryUpdate {
                revision: state.revision,
                changed,
                invalidated: false,
            }
        } else {
            advance(&mut state, changed)
        };
        update.invalidated = invalidated_during_scan;
        if !update.changed.is_empty() || issues_changed || update.invalidated {
            publish(&mut state, &update);
        }
        Ok(update)
    }

    /// Subscribes to both committed updates and watcher invalidation hints.
    pub fn subscribe(&self) -> mpsc::Receiver<LibraryUpdate> {
        let (sender, receiver) = mpsc::channel();
        let mut state = self.core.state.lock();
        if state.invalidated {
            let _ = sender.send(LibraryUpdate {
                revision: state.revision,
                changed: Vec::new(),
                invalidated: true,
            });
        }
        state.subscribers.push(sender);
        receiver
    }

    pub fn path_for(&self, id: &EntryId) -> LibraryResult<PathBuf> {
        let state = self.core.state.lock();
        if id == &state.root_id {
            ensure_safe_root(&self.root)?;
            return Ok(self.root.clone());
        }
        let entry = state
            .entries
            .get(id)
            .ok_or_else(|| LibraryError::not_found(id.as_str()))?;
        ensure_safe_entry(&self.root, &entry.relative, entry.public.kind)
    }

    fn save(
        &self,
        state: &mut SessionState,
        id: &PromptId,
        base_version: &ContentVersion,
        content: &str,
    ) -> LibraryResult<MutationResult> {
        let entry = prompt_entry(state, id)?.clone();
        let path = ensure_safe_entry(&self.root, &entry.relative, EntryKind::Prompt)?;
        let current = load_prompt(&path)?;
        if &current.version != base_version {
            return Err(LibraryError::new(
                LibraryErrorCode::Conflict,
                "The prompt changed since it was opened.",
            )
            .detail("entryId", id.as_str())
            .detail("expectedVersion", base_version.as_str())
            .detail("currentVersion", current.version.as_str()));
        }
        let bytes = encode_content(content, current.has_bom, current.line_ending, &path)?;
        ensure_safe_entry(&self.root, &entry.relative, EntryKind::Prompt)?;
        atomic_replace(&path, &bytes, base_version)?;
        let loaded = load_prompt(&path)?;
        if let Some(cached) = state.entries.get_mut(id) {
            apply_loaded_prompt(cached, &loaded);
        }
        finish_mutation(state, vec![id.clone()], Some(id))
    }

    fn save_copy(
        &self,
        state: &mut SessionState,
        id: &PromptId,
        content: &str,
    ) -> LibraryResult<MutationResult> {
        let source = prompt_entry(state, id)?.clone();
        let source_path = ensure_safe_entry(&self.root, &source.relative, EntryKind::Prompt)?;
        let source_loaded = load_prompt(&source_path)?;
        let parent = source
            .relative
            .parent()
            .unwrap_or(Path::new(""))
            .to_path_buf();
        let name = unique_copy_name(&self.root, state, &parent, &source.public.name)?;
        let filename = format!("{name}.prompt");
        let relative = parent.join(filename);
        let path = safe_destination(&self.root, &relative)?;
        ensure_destination_available(&path, &name)?;
        let bytes = encode_content(
            content,
            source_loaded.has_bom,
            source_loaded.line_ending,
            &path,
        )?;
        atomic_create(&path, &bytes)?;
        let loaded = load_prompt(&path)?;
        let new_id = insert_prompt(state, relative, name, loaded);
        finish_mutation(state, vec![new_id.clone()], Some(&new_id))
    }

    fn create_prompt(
        &self,
        state: &mut SessionState,
        folder_id: &FolderId,
        requested_name: &str,
        content: &str,
    ) -> LibraryResult<MutationResult> {
        let (parent_relative, _) = folder_location(state, &self.root, folder_id)?;
        let name = normalize_and_validate_name(requested_name, EntryKind::Prompt)?;
        ensure_portable_name_available(
            &self.root,
            state,
            &parent_relative,
            &name,
            EntryKind::Prompt,
            None,
        )?;
        let relative = parent_relative.join(format!("{name}.prompt"));
        let path = safe_destination(&self.root, &relative)?;
        ensure_destination_available(&path, &name)?;
        let bytes = encode_content(content, false, LineEnding::Lf, &path)?;
        atomic_create(&path, &bytes)?;
        let loaded = load_prompt(&path)?;
        let id = insert_prompt(state, relative, name, loaded);
        finish_mutation(state, vec![id.clone()], Some(&id))
    }

    fn create_folder(
        &self,
        state: &mut SessionState,
        parent_id: &FolderId,
        requested_name: &str,
    ) -> LibraryResult<MutationResult> {
        let (parent_relative, _) = folder_location(state, &self.root, parent_id)?;
        let name = normalize_and_validate_name(requested_name, EntryKind::Folder)?;
        ensure_portable_name_available(
            &self.root,
            state,
            &parent_relative,
            &name,
            EntryKind::Folder,
            None,
        )?;
        let relative = parent_relative.join(&name);
        let path = safe_destination(&self.root, &relative)?;
        ensure_destination_available(&path, &name)?;
        fs::create_dir(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                LibraryError::collision(&name)
            } else {
                LibraryError::io("createFolder", &path, &error)
            }
        })?;
        let id = EntryId::random();
        let public = LibraryEntry {
            id: id.clone(),
            name,
            relative_path: relative_string(&relative),
            kind: EntryKind::Folder,
            health: EntryHealth::Healthy,
            version: None,
        };
        state.path_to_id.insert(relative.clone(), id.clone());
        state.entries.insert(
            id.clone(),
            InternalEntry {
                public,
                relative,
                content: None,
                has_bom: false,
                line_ending: LineEnding::Lf,
            },
        );
        finish_mutation(state, vec![id.clone()], Some(&id))
    }

    fn rename(
        &self,
        state: &mut SessionState,
        id: &EntryId,
        requested_name: &str,
    ) -> LibraryResult<MutationResult> {
        let entry = state
            .entries
            .get(id)
            .cloned()
            .ok_or_else(|| LibraryError::not_found(id.as_str()))?;
        let name = normalize_and_validate_name(requested_name, entry.public.kind)?;
        let parent = entry
            .relative
            .parent()
            .unwrap_or(Path::new(""))
            .to_path_buf();
        ensure_portable_name_available(
            &self.root,
            state,
            &parent,
            &name,
            entry.public.kind,
            Some(id),
        )?;
        let filename = match entry.public.kind {
            EntryKind::Prompt => format!("{name}.prompt"),
            EntryKind::Folder => name.clone(),
        };
        let destination_relative = parent.join(filename);
        if destination_relative == entry.relative {
            return finish_mutation(state, Vec::new(), Some(id));
        }
        let source = ensure_safe_entry(&self.root, &entry.relative, entry.public.kind)?;
        let destination = safe_destination(&self.root, &destination_relative)?;
        relocate_checked(&source, &destination, &name)?;
        let changed = update_relative_tree(
            state,
            id,
            &entry.relative,
            &destination_relative,
            Some(name),
        );
        finish_mutation(state, changed, Some(id))
    }

    fn move_entry(
        &self,
        state: &mut SessionState,
        id: &EntryId,
        target_folder_id: &FolderId,
    ) -> LibraryResult<MutationResult> {
        let entry = state
            .entries
            .get(id)
            .cloned()
            .ok_or_else(|| LibraryError::not_found(id.as_str()))?;
        let (target_relative, _) = folder_location(state, &self.root, target_folder_id)?;
        if entry.public.kind == EntryKind::Folder
            && (target_relative == entry.relative || target_relative.starts_with(&entry.relative))
        {
            return Err(LibraryError::unsupported(
                &self.root.join(&entry.relative),
                "a folder cannot be moved into itself",
            ));
        }
        let current_parent = entry.relative.parent().unwrap_or(Path::new(""));
        if current_parent == target_relative {
            return finish_mutation(state, Vec::new(), Some(id));
        }
        ensure_portable_name_available(
            &self.root,
            state,
            &target_relative,
            &entry.public.name,
            entry.public.kind,
            Some(id),
        )?;
        let filename = entry
            .relative
            .file_name()
            .expect("scanned entries have names");
        let destination_relative = target_relative.join(filename);
        let source = ensure_safe_entry(&self.root, &entry.relative, entry.public.kind)?;
        let destination = safe_destination(&self.root, &destination_relative)?;
        relocate_checked(&source, &destination, &entry.public.name)?;
        let changed = update_relative_tree(state, id, &entry.relative, &destination_relative, None);
        finish_mutation(state, changed, Some(id))
    }

    fn trash_entry(&self, state: &mut SessionState, id: &EntryId) -> LibraryResult<MutationResult> {
        let entry = state
            .entries
            .get(id)
            .cloned()
            .ok_or_else(|| LibraryError::not_found(id.as_str()))?;
        let path = ensure_safe_entry(&self.root, &entry.relative, entry.public.kind)?;
        match entry.public.kind {
            EntryKind::Prompt => {
                load_prompt(&path)?;
            }
            EntryKind::Folder => validate_trash_tree(&path)?,
        }
        self.trash.delete(&path).map_err(|error| {
            LibraryError::new(
                LibraryErrorCode::TrashUnavailable,
                "The entry could not be moved to the system Trash.",
            )
            .detail("operation", "trash")
            .detail("path", path.to_string_lossy())
            .detail("reason", error)
        })?;

        let removed: Vec<EntryId> = state
            .entries
            .iter()
            .filter(|(_, candidate)| {
                candidate.relative == entry.relative
                    || candidate.relative.starts_with(&entry.relative)
            })
            .map(|(candidate_id, _)| candidate_id.clone())
            .collect();
        for removed_id in &removed {
            state.entries.remove(removed_id);
        }
        rebuild_path_index(state);
        finish_mutation(state, removed, None)
    }
}

fn prompt_entry<'a>(state: &'a SessionState, id: &PromptId) -> LibraryResult<&'a InternalEntry> {
    let entry = state
        .entries
        .get(id)
        .ok_or_else(|| LibraryError::not_found(id.as_str()))?;
    if entry.public.kind != EntryKind::Prompt {
        return Err(LibraryError::unsupported(
            &entry.relative,
            "entry is a folder",
        ));
    }
    Ok(entry)
}

fn folder_location(
    state: &SessionState,
    root: &Path,
    id: &FolderId,
) -> LibraryResult<(PathBuf, PathBuf)> {
    if id == &state.root_id {
        ensure_safe_root(root)?;
        return Ok((PathBuf::new(), root.to_path_buf()));
    }
    let entry = state
        .entries
        .get(id)
        .ok_or_else(|| LibraryError::not_found(id.as_str()))?;
    if entry.public.kind != EntryKind::Folder {
        return Err(LibraryError::unsupported(
            &root.join(&entry.relative),
            "target is not a folder",
        ));
    }
    let path = ensure_safe_entry(root, &entry.relative, EntryKind::Folder)?;
    Ok((entry.relative.clone(), path))
}

fn ensure_safe_root(root: &Path) -> LibraryResult<()> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| LibraryError::io("metadataRoot", root, &error))?;
    if is_link_like(&metadata) || !metadata.is_dir() {
        return Err(LibraryError::unsupported(
            root,
            "the library root was replaced by an unsafe entry",
        ));
    }
    let current = fs::canonicalize(root)
        .map_err(|error| LibraryError::io("canonicalizeRoot", root, &error))?;
    if current != root {
        return Err(LibraryError::unsupported(
            root,
            "the library root now resolves to a different location",
        ));
    }
    Ok(())
}

/// Resolves a cached root-relative path without following any ancestor links.
/// This path-based check narrows the escape/TOCTOU surface; callers still use
/// atomic no-overwrite primitives for the final mutation step.
fn safe_destination(root: &Path, relative: &Path) -> LibraryResult<PathBuf> {
    ensure_safe_root(root)?;
    let components: Vec<_> = relative.components().collect();
    if components.is_empty()
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(LibraryError::unsupported(
            &root.join(relative),
            "entry path contains an unsafe component",
        ));
    }

    let mut parent = root.to_path_buf();
    for component in &components[..components.len() - 1] {
        let Component::Normal(component) = component else {
            unreachable!("components validated above")
        };
        parent.push(component);
        let metadata = fs::symlink_metadata(&parent)
            .map_err(|error| LibraryError::io("metadataAncestor", &parent, &error))?;
        if is_link_like(&metadata) || !metadata.is_dir() {
            return Err(LibraryError::unsupported(
                &parent,
                "an entry ancestor is a link or is not a directory",
            ));
        }
    }
    let canonical_parent = fs::canonicalize(&parent)
        .map_err(|error| LibraryError::io("canonicalizeAncestor", &parent, &error))?;
    if !canonical_parent.starts_with(root) {
        return Err(LibraryError::unsupported(
            &parent,
            "entry parent resolves outside the library root",
        ));
    }
    Ok(root.join(relative))
}

fn ensure_safe_entry(root: &Path, relative: &Path, expected: EntryKind) -> LibraryResult<PathBuf> {
    let path = safe_destination(root, relative)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| LibraryError::io("metadataEntry", &path, &error))?;
    let matches_expected = match expected {
        EntryKind::Prompt => metadata.is_file(),
        EntryKind::Folder => metadata.is_dir(),
    };
    if is_link_like(&metadata) || !matches_expected {
        return Err(LibraryError::unsupported(
            &path,
            "entry was replaced by a link or unexpected filesystem type",
        ));
    }
    Ok(path)
}

fn finish_mutation(
    state: &mut SessionState,
    changed: Vec<EntryId>,
    result_id: Option<&EntryId>,
) -> LibraryResult<MutationResult> {
    let update = if changed.is_empty() {
        LibraryUpdate {
            revision: state.revision,
            changed,
            invalidated: false,
        }
    } else {
        advance(state, changed)
    };
    if !update.changed.is_empty() {
        publish(state, &update);
    }
    let entry = result_id.and_then(|id| state.entries.get(id).map(|entry| entry.public.clone()));
    Ok(MutationResult { update, entry })
}

fn advance(state: &mut SessionState, changed: Vec<EntryId>) -> LibraryUpdate {
    state.revision = state.revision.saturating_add(1);
    LibraryUpdate {
        revision: state.revision,
        changed,
        invalidated: false,
    }
}

fn publish(state: &mut SessionState, update: &LibraryUpdate) {
    state
        .subscribers
        .retain(|subscriber| subscriber.send(update.clone()).is_ok());
}

fn install_initial_scan(state: &mut SessionState, scanned: ScanResult) {
    for scanned_entry in scanned.entries {
        let id = EntryId::random();
        let internal = internal_from_scan(id.clone(), scanned_entry);
        state
            .path_to_id
            .insert(internal.relative.clone(), id.clone());
        state.entries.insert(id, internal);
    }
    state.issues = scanned.issues;
    attach_issue_ids_and_health(state);
}

fn reconcile_scan(state: &mut SessionState, scanned: ScanResult) -> (Vec<EntryId>, bool) {
    let old_entries = std::mem::take(&mut state.entries);
    let old_path_to_id = std::mem::take(&mut state.path_to_id);
    let old_issues = std::mem::take(&mut state.issues);
    let mut next_entries = HashMap::new();
    let mut next_paths = HashMap::new();
    let mut changed = Vec::new();
    let mut retained_ids = HashSet::new();

    for scanned_entry in scanned.entries {
        let old_id = old_path_to_id.get(&scanned_entry.relative).and_then(|id| {
            old_entries
                .get(id)
                .filter(|old| old.public.kind == scanned_entry.kind)
                .map(|_| id.clone())
        });
        let id = old_id.unwrap_or_else(EntryId::random);
        let internal = internal_from_scan(id.clone(), scanned_entry);
        let is_changed = old_entries
            .get(&id)
            .is_none_or(|old| old.public != internal.public || old.content != internal.content);
        if is_changed {
            changed.push(id.clone());
        }
        retained_ids.insert(id.clone());
        next_paths.insert(internal.relative.clone(), id.clone());
        next_entries.insert(id, internal);
    }
    for old_id in old_entries.keys() {
        if !retained_ids.contains(old_id) {
            changed.push(old_id.clone());
        }
    }
    changed.sort();
    changed.dedup();
    state.entries = next_entries;
    state.path_to_id = next_paths;
    state.issues = scanned.issues;
    attach_issue_ids_and_health(state);
    let issues_changed = old_issues != state.issues;
    (changed, issues_changed)
}

fn internal_from_scan(id: EntryId, scanned: ScannedEntry) -> InternalEntry {
    let (version, content, has_bom, line_ending) = match scanned.loaded {
        Some(loaded) => (
            Some(loaded.version),
            Some(loaded.content),
            loaded.has_bom,
            loaded.line_ending,
        ),
        None => (None, None, false, LineEnding::Lf),
    };
    InternalEntry {
        public: LibraryEntry {
            id,
            name: scanned.name,
            relative_path: relative_string(&scanned.relative),
            kind: scanned.kind,
            health: scanned.health,
            version,
        },
        relative: scanned.relative,
        content,
        has_bom,
        line_ending,
    }
}

fn apply_loaded_prompt(entry: &mut InternalEntry, loaded: &LoadedPrompt) {
    entry.public.version = Some(loaded.version.clone());
    entry.content = Some(loaded.content.clone());
    entry.has_bom = loaded.has_bom;
    entry.line_ending = loaded.line_ending;
}

fn insert_prompt(
    state: &mut SessionState,
    relative: PathBuf,
    name: String,
    loaded: LoadedPrompt,
) -> PromptId {
    let id = EntryId::random();
    let public = LibraryEntry {
        id: id.clone(),
        name,
        relative_path: relative_string(&relative),
        kind: EntryKind::Prompt,
        health: EntryHealth::Healthy,
        version: Some(loaded.version.clone()),
    };
    state.path_to_id.insert(relative.clone(), id.clone());
    state.entries.insert(
        id.clone(),
        InternalEntry {
            public,
            relative,
            content: Some(loaded.content),
            has_bom: loaded.has_bom,
            line_ending: loaded.line_ending,
        },
    );
    id
}

fn snapshot_from_state(root: &Path, state: &SessionState) -> LibrarySnapshot {
    let mut entries: Vec<LibraryEntry> = state
        .entries
        .values()
        .map(|entry| entry.public.clone())
        .collect();
    entries.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.kind_sort_key().cmp(&right.kind_sort_key()))
    });
    let prompts = entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::Prompt)
        .cloned()
        .collect();
    let mut issues = state.issues.clone();
    if let Some(issue) = &state.watcher_issue {
        issues.push(issue.clone());
    }
    issues.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| format!("{:?}", left.code).cmp(&format!("{:?}", right.code)))
    });
    LibrarySnapshot {
        root: root.to_string_lossy().into_owned(),
        root_id: state.root_id.clone(),
        revision: state.revision,
        entries,
        prompts,
        issues,
    }
}

fn attach_issue_ids_and_health(state: &mut SessionState) {
    for entry in state.entries.values_mut() {
        entry.public.health = EntryHealth::Healthy;
    }
    let ids_by_path: HashMap<String, EntryId> = state
        .entries
        .iter()
        .map(|(id, entry)| (entry.public.relative_path.clone(), id.clone()))
        .collect();
    for issue in &mut state.issues {
        issue.entry_id = ids_by_path.get(&issue.path).cloned();
        if let Some(id) = &issue.entry_id {
            if let Some(entry) = state.entries.get_mut(id) {
                entry.public.health = EntryHealth::Issue;
            }
        }
    }
    state.issues.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| format!("{:?}", left.code).cmp(&format!("{:?}", right.code)))
    });
}

trait EntrySortKey {
    fn kind_sort_key(&self) -> u8;
}

impl EntrySortKey for LibraryEntry {
    fn kind_sort_key(&self) -> u8 {
        match self.kind {
            EntryKind::Folder => 0,
            EntryKind::Prompt => 1,
        }
    }
}

fn scan_library(root: &Path) -> LibraryResult<ScanResult> {
    ensure_safe_root(root)?;
    let mut scanned = Vec::new();
    let mut issues = Vec::new();
    let mut names: HashMap<(PathBuf, String), Vec<PathBuf>> = HashMap::new();
    let mut walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            !(entry.file_type().is_dir() && entry.file_name() == OsStr::new(".git"))
        });

    while let Some(result) = walker.next() {
        let entry = match result {
            Ok(entry) => entry,
            Err(error) => {
                let path = error.path().unwrap_or(root);
                let relative = path.strip_prefix(root).unwrap_or(path);
                issues.push(issue_from_error(
                    relative,
                    LibraryError::new(
                        LibraryErrorCode::PermissionDenied,
                        "A library path could not be read during scanning.",
                    )
                    .detail("operation", "scan")
                    .detail("reason", error.to_string()),
                ));
                continue;
            }
        };
        if entry.depth() == 0 {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .expect("walkdir entries are under their root")
            .to_path_buf();
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) => {
                walker.skip_current_dir();
                issues.push(issue_from_error(
                    &relative,
                    LibraryError::io("metadataScanEntry", entry.path(), &error),
                ));
                continue;
            }
        };
        if is_link_like(&metadata) {
            // WalkDir cannot reliably distinguish Windows junctions and other
            // reparse-point directories through FileType alone. Explicitly
            // stop descent before asking for the next entry.
            walker.skip_current_dir();
            issues.push(issue_from_error(
                &relative,
                LibraryError::unsupported(entry.path(), "link-like entries are not managed"),
            ));
            continue;
        }
        let file_type = metadata.file_type();
        let Some(file_name) = entry.file_name().to_str() else {
            issues.push(issue_from_error(
                &relative,
                LibraryError::invalid_name(
                    &entry.file_name().to_string_lossy(),
                    "name is not UTF-8",
                ),
            ));
            if file_type.is_dir() {
                walker.skip_current_dir();
            }
            continue;
        };

        let (kind, name, loaded, health) = if file_type.is_dir() {
            let name = file_name.to_owned();
            if let Err(error) = normalize_and_validate_name(file_name, EntryKind::Folder) {
                issues.push(issue_from_error(&relative, error));
            }
            let health = if issues
                .last()
                .is_some_and(|issue| issue.path == relative_string(&relative))
            {
                EntryHealth::Issue
            } else {
                EntryHealth::Healthy
            };
            (EntryKind::Folder, name, None, health)
        } else if file_type.is_file() && is_exact_prompt_name(file_name) {
            let logical_name = logical_prompt_name(file_name).expect("checked prompt suffix");
            let name = logical_name.to_owned();
            if let Err(error) = normalize_and_validate_name(logical_name, EntryKind::Prompt) {
                issues.push(issue_from_error(&relative, error));
            }
            let loaded = match load_prompt(entry.path()) {
                Ok(loaded) => Some(loaded),
                Err(error) => {
                    issues.push(issue_from_error(&relative, error));
                    None
                }
            };
            let health = if issues
                .last()
                .is_some_and(|issue| issue.path == relative_string(&relative))
            {
                EntryHealth::Issue
            } else {
                EntryHealth::Healthy
            };
            (EntryKind::Prompt, name, loaded, health)
        } else {
            continue;
        };

        let parent = relative.parent().unwrap_or(Path::new("")).to_path_buf();
        // Collision rules apply to the physical filename. A folder named
        // `foo` and a prompt named `foo.prompt` can coexist, while differently
        // cased/canonically equivalent `.prompt` filenames cannot portably do so.
        let key = (parent, portable_key(file_name));
        names.entry(key).or_default().push(relative.clone());
        scanned.push(ScannedEntry {
            relative,
            name,
            kind,
            loaded,
            health,
        });
    }
    for collision_paths in names.values().filter(|paths| paths.len() > 1) {
        let paths: Vec<String> = collision_paths
            .iter()
            .map(|path| relative_string(path))
            .collect();
        for collision_path in collision_paths {
            let entry = scanned
                .iter_mut()
                .find(|entry| &entry.relative == collision_path)
                .expect("collision path was scanned");
            entry.health = EntryHealth::Issue;
            let mut error = LibraryError::collision(&entry.name);
            error
                .details
                .insert("collidesWith".to_owned(), paths.join(","));
            issues.push(issue_from_error(&entry.relative, error));
        }
    }
    scanned.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(ScanResult {
        entries: scanned,
        issues,
    })
}

fn issue_from_error(relative: &Path, error: LibraryError) -> LibraryIssue {
    LibraryIssue {
        code: error.code,
        path: relative_string(relative),
        message: error.message,
        entry_id: None,
        details: error.details,
    }
}

fn normalize_and_validate_name(name: &str, kind: EntryKind) -> LibraryResult<String> {
    let normalized: String = name.nfc().collect();
    if normalized.is_empty() {
        return Err(LibraryError::invalid_name(name, "name is empty"));
    }
    if normalized == "." || normalized == ".." {
        return Err(LibraryError::invalid_name(
            name,
            "dot path components are not allowed",
        ));
    }
    if normalized.ends_with(' ') || normalized.ends_with('.') {
        return Err(LibraryError::invalid_name(
            name,
            "trailing spaces and periods are not allowed",
        ));
    }
    if normalized.chars().any(|character| {
        character <= '\u{1f}'
            || character == '\u{7f}'
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
    }) {
        return Err(LibraryError::invalid_name(
            name,
            "name contains a Windows-reserved character",
        ));
    }
    if kind == EntryKind::Folder && portable_key(&normalized) == ".git" {
        return Err(LibraryError::invalid_name(
            name,
            "the .git folder name is reserved",
        ));
    }
    let first_component = normalized
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(first_component.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (first_component.len() == 4
            && (first_component.starts_with("COM") || first_component.starts_with("LPT"))
            && matches!(first_component.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        return Err(LibraryError::invalid_name(
            name,
            "name is reserved by Windows",
        ));
    }
    let extension_units = if kind == EntryKind::Prompt {
        ".prompt".encode_utf16().count()
    } else {
        0
    };
    if normalized.encode_utf16().count() + extension_units > 255 {
        return Err(LibraryError::invalid_name(
            name,
            "name exceeds the portable component-length limit",
        ));
    }
    Ok(normalized)
}

fn portable_key(value: &str) -> String {
    value
        .nfd()
        .collect::<String>()
        .case_fold()
        .collect::<String>()
        .nfc()
        .collect()
}

fn fold_text(value: &str) -> String {
    portable_key(value)
}

fn ensure_portable_name_available(
    root: &Path,
    state: &SessionState,
    parent: &Path,
    name: &str,
    kind: EntryKind,
    excluding: Option<&EntryId>,
) -> LibraryResult<()> {
    let candidate_filename = physical_name(name, kind);
    let key = portable_key(&candidate_filename);
    let excluded_relative =
        excluding.and_then(|id| state.entries.get(id).map(|entry| &entry.relative));
    let probe = parent.join(&candidate_filename);
    let _ = safe_destination(root, &probe)?;
    let parent_path = root.join(parent);
    let children = fs::read_dir(&parent_path)
        .map_err(|error| LibraryError::io("readSiblingNames", &parent_path, &error))?;
    for child in children {
        let child =
            child.map_err(|error| LibraryError::io("readSiblingName", &parent_path, &error))?;
        let child_relative = parent.join(child.file_name());
        if excluded_relative.is_some_and(|excluded| excluded == &child_relative) {
            continue;
        }
        if child
            .file_name()
            .to_str()
            .is_some_and(|filename| portable_key(filename) == key)
        {
            return Err(LibraryError::collision(name));
        }
    }
    Ok(())
}

fn physical_name(name: &str, kind: EntryKind) -> String {
    match kind {
        EntryKind::Prompt => format!("{name}.prompt"),
        EntryKind::Folder => name.to_owned(),
    }
}

fn ensure_destination_available(path: &Path, name: &str) -> LibraryResult<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(LibraryError::collision(name)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(LibraryError::io("checkDestination", path, &error)),
    }
}

fn relocate_checked(source: &Path, destination: &Path, name: &str) -> LibraryResult<()> {
    match fs::symlink_metadata(destination) {
        Ok(_) => {
            // A case-only or normalization-only rename on a case-insensitive
            // filesystem resolves both spellings to the same entry.
            let same_entry = fs::canonicalize(source)
                .and_then(|left| fs::canonicalize(destination).map(|right| left == right))
                .unwrap_or(false);
            if !same_entry {
                return Err(LibraryError::collision(name));
            }
            let parent = source.parent().expect("library entry has a parent");
            let temporary = parent.join(format!(".prompter-{}.relocate", uuid::Uuid::new_v4()));
            relocate_no_overwrite(source, &temporary)
                .map_err(|error| LibraryError::io("stageRelocate", source, &error))?;
            if let Err(error) = relocate_no_overwrite(&temporary, destination) {
                let _ = relocate_no_overwrite(&temporary, source);
                return Err(LibraryError::io("relocate", destination, &error));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            relocate_no_overwrite(source, destination).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    LibraryError::collision(name)
                } else {
                    LibraryError::io("relocate", destination, &error)
                }
            })
        }
        Err(error) => Err(LibraryError::io("checkDestination", destination, &error)),
    }
}

fn update_relative_tree(
    state: &mut SessionState,
    root_id: &EntryId,
    old_root: &Path,
    new_root: &Path,
    new_name: Option<String>,
) -> Vec<EntryId> {
    let replacements: Vec<(EntryId, PathBuf)> = state
        .entries
        .iter()
        .filter_map(|(id, entry)| {
            if entry.relative == old_root || entry.relative.starts_with(old_root) {
                let suffix = entry.relative.strip_prefix(old_root).ok()?;
                let relative = if suffix.as_os_str().is_empty() {
                    new_root.to_path_buf()
                } else {
                    new_root.join(suffix)
                };
                Some((id.clone(), relative))
            } else {
                None
            }
        })
        .collect();
    let mut changed = Vec::with_capacity(replacements.len());
    for (id, relative) in replacements {
        if let Some(entry) = state.entries.get_mut(&id) {
            entry.relative = relative;
            entry.public.relative_path = relative_string(&entry.relative);
            if &id == root_id {
                if let Some(name) = &new_name {
                    entry.public.name = name.clone();
                }
            }
            changed.push(id);
        }
    }
    rebuild_path_index(state);
    changed.sort();
    changed
}

fn rebuild_path_index(state: &mut SessionState) {
    state.path_to_id.clear();
    for (id, entry) in &state.entries {
        state.path_to_id.insert(entry.relative.clone(), id.clone());
    }
}

fn unique_copy_name(
    root: &Path,
    state: &SessionState,
    parent: &Path,
    base: &str,
) -> LibraryResult<String> {
    for number in 1..=10_000_u32 {
        let candidate = if number == 1 {
            format!("{base} copy")
        } else {
            format!("{base} copy {number}")
        };
        let candidate = normalize_and_validate_name(&candidate, EntryKind::Prompt)?;
        if ensure_portable_name_available(root, state, parent, &candidate, EntryKind::Prompt, None)
            .is_ok()
        {
            return Ok(candidate);
        }
    }
    Err(LibraryError::collision(base))
}

fn validate_trash_tree(folder: &Path) -> LibraryResult<()> {
    let metadata = fs::symlink_metadata(folder)
        .map_err(|_| LibraryError::unsafe_trash(folder, "folder is unreadable"))?;
    if is_link_like(&metadata) {
        return Err(LibraryError::unsafe_trash(
            folder,
            "folder is a link-like entry",
        ));
    }
    if !metadata.is_dir() {
        return Err(LibraryError::unsafe_trash(folder, "entry is not a folder"));
    }
    let children = fs::read_dir(folder)
        .map_err(|_| LibraryError::unsafe_trash(folder, "folder is unreadable"))?;
    for child in children {
        let child =
            child.map_err(|_| LibraryError::unsafe_trash(folder, "folder is unreadable"))?;
        let path = child.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| LibraryError::unsafe_trash(&path, "entry is unreadable"))?;
        if is_link_like(&metadata) {
            return Err(LibraryError::unsafe_trash(&path, "folder contains a link"));
        }
        if metadata.is_dir() {
            if child.file_name() == OsStr::new(".git") {
                return Err(LibraryError::unsafe_trash(
                    &path,
                    "folder contains unmanaged content",
                ));
            }
            validate_trash_tree(&path)?;
        } else if metadata.is_file() && child.file_name().to_str().is_some_and(is_exact_prompt_name)
        {
            load_prompt(&path).map_err(|error| {
                LibraryError::unsafe_trash(
                    &path,
                    match error.code {
                        LibraryErrorCode::InvalidEncoding => "folder contains a non-UTF-8 prompt",
                        LibraryErrorCode::TooLarge => "folder contains an oversized prompt",
                        _ => "folder contains unreadable content",
                    },
                )
            })?;
        } else {
            return Err(LibraryError::unsafe_trash(
                &path,
                "folder contains unmanaged content",
            ));
        }
    }
    Ok(())
}

fn relative_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}
