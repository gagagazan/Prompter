use super::*;
use std::fs;
use std::time::Duration;

fn prompt_id(session: &PromptLibrarySession, name: &str) -> PromptId {
    session
        .snapshot()
        .prompts
        .into_iter()
        .find(|prompt| prompt.name == name)
        .unwrap()
        .id
}

#[cfg(unix)]
#[test]
fn snapshot_only_contains_exact_lowercase_prompt_files_and_skips_links() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("kept.prompt"), "hello").unwrap();
    fs::write(root.path().join("ignored.PROMPT"), "no").unwrap();
    fs::create_dir(root.path().join(".git")).unwrap();
    fs::write(root.path().join(".git/hidden.prompt"), "no").unwrap();
    symlink(
        root.path().join("kept.prompt"),
        root.path().join("linked.prompt"),
    )
    .unwrap();

    let session = PromptLibrarySession::open(root.path()).unwrap();
    let snapshot = session.snapshot();

    assert_eq!(snapshot.prompts.len(), 1);
    assert_eq!(snapshot.prompts[0].name, "kept");
    assert_eq!(snapshot.prompts[0].relative_path, "kept.prompt");
    assert!(snapshot.issues.iter().any(|issue| {
        issue.path == "linked.prompt" && issue.code == LibraryErrorCode::UnsafeEntry
    }));
}

#[cfg(unix)]
#[test]
fn a_link_like_library_root_is_rejected_before_canonicalization() {
    use std::os::unix::fs::symlink;

    let target = tempfile::tempdir().unwrap();
    let container = tempfile::tempdir().unwrap();
    let linked_root = container.path().join("linked-root");
    symlink(target.path(), &linked_root).unwrap();

    assert_eq!(
        validate_library_root(&linked_root).unwrap_err().code,
        LibraryErrorCode::RootUnavailable
    );
    assert_eq!(
        PromptLibrarySession::open(&linked_root).err().unwrap().code,
        LibraryErrorCode::RootUnavailable
    );
}

#[cfg(windows)]
fn create_windows_junction(link: &std::path::Path, target: &std::path::Path) {
    let parent = link.parent().expect("junction must have a parent");
    let name = link.file_name().expect("junction must have a file name");
    let output = std::process::Command::new("cmd")
        .current_dir(parent)
        .arg("/D")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(name)
        .arg(target)
        .output()
        .expect("cmd should be available on supported Windows versions");
    assert!(
        output.status.success(),
        "failed to create junction {} -> {}: stdout: {}; stderr: {}",
        link.display(),
        target.display(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(windows)]
#[test]
fn windows_junction_is_reported_without_scanning_its_target() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("escaped.prompt"), "outside").unwrap();
    create_windows_junction(&root.path().join("junction"), outside.path());

    let session = PromptLibrarySession::open(root.path()).unwrap();
    let snapshot = session.snapshot();

    assert!(snapshot.prompts.is_empty());
    assert!(
        snapshot.issues.iter().any(|issue| {
            issue.path == "junction" && issue.code == LibraryErrorCode::UnsafeEntry
        })
    );
}

#[cfg(windows)]
#[test]
fn a_windows_junction_cannot_be_selected_as_the_library_root() {
    let target = tempfile::tempdir().unwrap();
    let container = tempfile::tempdir().unwrap();
    let linked_root = container.path().join("junction-root");
    create_windows_junction(&linked_root, target.path());

    assert_eq!(
        validate_library_root(&linked_root).unwrap_err().code,
        LibraryErrorCode::RootUnavailable
    );
    assert_eq!(
        PromptLibrarySession::open(&linked_root).err().unwrap().code,
        LibraryErrorCode::RootUnavailable
    );
}

#[test]
fn opening_a_library_reports_non_utf8_and_oversized_prompts_without_hiding_other_files() {
    let invalid = tempfile::tempdir().unwrap();
    fs::write(invalid.path().join("bad.prompt"), [0xff, 0xfe]).unwrap();
    let file = fs::File::create(invalid.path().join("huge.prompt")).unwrap();
    file.set_len(MAX_PROMPT_BYTES as u64 + 1).unwrap();
    fs::write(invalid.path().join("good.prompt"), "okay").unwrap();

    let session = PromptLibrarySession::open(invalid.path()).unwrap();
    let snapshot = session.snapshot();
    assert_eq!(snapshot.prompts.len(), 3);
    assert_eq!(snapshot.issues.len(), 2);
    assert!(snapshot.issues.iter().any(|issue| {
        issue.path == "bad.prompt" && issue.code == LibraryErrorCode::InvalidEncoding
    }));
    assert!(
        snapshot.issues.iter().any(|issue| {
            issue.path == "huge.prompt" && issue.code == LibraryErrorCode::TooLarge
        })
    );
    assert_eq!(
        session.read(&prompt_id(&session, "bad")).unwrap_err().code,
        LibraryErrorCode::InvalidEncoding
    );
    assert_eq!(
        session.read(&prompt_id(&session, "huge")).unwrap_err().code,
        LibraryErrorCode::TooLarge
    );
    assert_eq!(
        session.read(&prompt_id(&session, "good")).unwrap().content,
        "okay"
    );
}

#[test]
fn save_preserves_a_bom_and_the_existing_crlf_style() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("windows.prompt"),
        b"\xEF\xBB\xBFfirst\r\nsecond\r\n",
    )
    .unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let id = prompt_id(&session, "windows");
    let document = session.read(&id).unwrap();
    assert_eq!(document.content, "first\r\nsecond\r\n");

    session
        .mutate(Mutation::Save {
            prompt_id: id,
            base_version: document.version,
            content: "changed\nline\n".to_owned(),
        })
        .unwrap();

    assert_eq!(
        fs::read(root.path().join("windows.prompt")).unwrap(),
        b"\xEF\xBB\xBFchanged\r\nline\r\n"
    );
}

#[test]
fn save_detects_an_external_edit_using_the_exact_byte_version() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("race.prompt");
    fs::write(&path, "original").unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let id = prompt_id(&session, "race");
    let original = session.read(&id).unwrap();
    fs::write(&path, "external").unwrap();

    let error = session
        .mutate(Mutation::Save {
            prompt_id: id,
            base_version: original.version,
            content: "mine".to_owned(),
        })
        .unwrap_err();

    assert_eq!(error.code, LibraryErrorCode::Conflict);
    assert_eq!(fs::read_to_string(path).unwrap(), "external");
    assert!(error.details.contains_key("currentVersion"));
}

#[test]
fn mutations_normalize_names_and_reject_portable_casefold_collisions() {
    let root = tempfile::tempdir().unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let root_id = session.snapshot().root_id;

    let created = session
        .mutate(Mutation::CreatePrompt {
            folder_id: root_id.clone(),
            name: "Cafe\u{301}".to_owned(),
            content: String::new(),
        })
        .unwrap();
    assert_eq!(created.entry.unwrap().name, "Caf\u{e9}");

    session
        .mutate(Mutation::CreatePrompt {
            folder_id: root_id.clone(),
            name: "STRASSE".to_owned(),
            content: String::new(),
        })
        .unwrap();
    let error = session
        .mutate(Mutation::CreatePrompt {
            folder_id: root_id,
            name: "Stra\u{df}e".to_owned(),
            content: String::new(),
        })
        .unwrap_err();
    assert_eq!(error.code, LibraryErrorCode::NameCollision);

    let error = session
        .mutate(Mutation::CreatePrompt {
            folder_id: session.snapshot().root_id,
            name: "Caf\u{e9}".to_owned(),
            content: String::new(),
        })
        .unwrap_err();
    assert_eq!(error.code, LibraryErrorCode::NameCollision);
}

#[test]
fn renamed_prompt_remains_readable_by_the_same_session_id() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("original.prompt"), "body").unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let id = prompt_id(&session, "original");

    let result = session
        .mutate(Mutation::Rename {
            entry_id: id.clone(),
            name: "renamed".to_owned(),
        })
        .unwrap();

    assert_eq!(result.entry.unwrap().relative_path, "renamed.prompt");
    let document = session.read(&id).unwrap();
    assert_eq!(document.name, "renamed");
    assert_eq!(document.content, "body");
}

#[test]
fn existing_portable_collisions_are_all_visible_and_diagnosed() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("STRASSE.prompt"), "one").unwrap();
    fs::write(root.path().join("Stra\u{df}e.prompt"), "two").unwrap();

    // A case-insensitive filesystem may collapse the pair before the library
    // can observe it. Case-sensitive volumes exercise the diagnostic behavior.
    if fs::read_dir(root.path()).unwrap().count() < 2 {
        return;
    }

    let session = PromptLibrarySession::open(root.path()).unwrap();
    let snapshot = session.snapshot();
    assert_eq!(snapshot.prompts.len(), 2);
    assert!(
        snapshot
            .prompts
            .iter()
            .all(|entry| entry.health == EntryHealth::Issue)
    );
    assert_eq!(
        snapshot
            .issues
            .iter()
            .filter(|issue| issue.code == LibraryErrorCode::NameCollision)
            .count(),
        2
    );
}

#[test]
fn scanning_preserves_an_existing_names_unicode_spelling() {
    let root = tempfile::tempdir().unwrap();
    let decomposed = "Cafe\u{301}";
    fs::write(root.path().join(format!("{decomposed}.prompt")), "body").unwrap();

    let session = PromptLibrarySession::open(root.path()).unwrap();

    assert_eq!(session.snapshot().prompts[0].name, decomposed);
}

#[test]
fn mutations_reject_windows_unsafe_names() {
    let root = tempfile::tempdir().unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let root_id = session.snapshot().root_id;
    for name in ["CON", "report. ", "a:b", ".."] {
        let error = session
            .mutate(Mutation::CreateFolder {
                parent_id: root_id.clone(),
                name: name.to_owned(),
            })
            .unwrap_err();
        assert_eq!(error.code, LibraryErrorCode::InvalidName, "{name}");
    }
}

#[test]
fn moving_never_overwrites_an_existing_destination() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("target")).unwrap();
    fs::write(root.path().join("same.prompt"), "source").unwrap();
    fs::write(root.path().join("target/same.prompt"), "destination").unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let snapshot = session.snapshot();
    let source = snapshot
        .prompts
        .iter()
        .find(|entry| entry.relative_path == "same.prompt")
        .unwrap()
        .id
        .clone();
    let target = snapshot
        .entries
        .iter()
        .find(|entry| entry.relative_path == "target")
        .unwrap()
        .id
        .clone();

    let error = session
        .mutate(Mutation::Move {
            entry_id: source,
            target_folder_id: target,
        })
        .unwrap_err();

    assert_eq!(error.code, LibraryErrorCode::NameCollision);
    assert_eq!(
        fs::read_to_string(root.path().join("same.prompt")).unwrap(),
        "source"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("target/same.prompt")).unwrap(),
        "destination"
    );
}

#[test]
fn an_unmanaged_uppercase_prompt_extension_reserves_its_portable_filename() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("Foo.PROMPT"), "unmanaged").unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    assert!(session.snapshot().prompts.is_empty());

    let error = session
        .mutate(Mutation::CreatePrompt {
            folder_id: session.snapshot().root_id,
            name: "foo".to_owned(),
            content: String::new(),
        })
        .unwrap_err();

    assert_eq!(error.code, LibraryErrorCode::NameCollision);
    assert_eq!(
        fs::read_to_string(root.path().join("Foo.PROMPT")).unwrap(),
        "unmanaged"
    );
}

#[cfg(unix)]
#[test]
fn replacing_an_ancestor_with_a_symlink_cannot_escape_the_library() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("folder")).unwrap();
    fs::write(root.path().join("folder/safe.prompt"), "inside").unwrap();
    fs::write(outside.path().join("safe.prompt"), "outside").unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let id = prompt_id(&session, "safe");
    let document = session.read(&id).unwrap();
    fs::rename(
        root.path().join("folder"),
        root.path().join("folder-original"),
    )
    .unwrap();
    symlink(outside.path(), root.path().join("folder")).unwrap();

    assert_eq!(
        session.read(&id).unwrap_err().code,
        LibraryErrorCode::UnsafeEntry
    );
    let error = session
        .mutate(Mutation::Save {
            prompt_id: id,
            base_version: document.version,
            content: "attacker overwrite".to_owned(),
        })
        .unwrap_err();
    assert_eq!(error.code, LibraryErrorCode::UnsafeEntry);
    assert_eq!(
        fs::read_to_string(outside.path().join("safe.prompt")).unwrap(),
        "outside"
    );
}

#[cfg(windows)]
#[test]
fn replacing_an_ancestor_with_a_junction_cannot_escape_the_library() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("folder")).unwrap();
    fs::write(root.path().join("folder/safe.prompt"), "inside").unwrap();
    fs::write(outside.path().join("safe.prompt"), "outside").unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let id = prompt_id(&session, "safe");
    fs::rename(
        root.path().join("folder"),
        root.path().join("folder-original"),
    )
    .unwrap();
    create_windows_junction(&root.path().join("folder"), outside.path());

    assert_eq!(
        session.path_for(&id).unwrap_err().code,
        LibraryErrorCode::UnsafeEntry
    );
    assert_eq!(
        session.read(&id).unwrap_err().code,
        LibraryErrorCode::UnsafeEntry
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("safe.prompt")).unwrap(),
        "outside"
    );
}

#[test]
fn search_handles_unicode_casefold_and_cjk_and_ranks_names_first() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("Stra\u{df}e.prompt"), "ordinary").unwrap();
    fs::write(root.path().join("notes.prompt"), "路线包含中文关键词").unwrap();
    fs::write(
        root.path().join("other.prompt"),
        "strasse occurs in content",
    )
    .unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();

    let hits = session.search("STRASSE");
    assert_eq!(hits[0].prompt.name, "Stra\u{df}e");
    assert!(hits[0].score > hits[1].score);
    assert_eq!(session.search("中文")[0].prompt.name, "notes");
}

#[test]
fn refresh_preserves_ids_for_unchanged_paths_and_subscriptions_receive_commits() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("one.prompt"), "one").unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let id = prompt_id(&session, "one");
    let receiver = session.subscribe();
    let document = session.read(&id).unwrap();
    let result = session
        .mutate(Mutation::Save {
            prompt_id: id.clone(),
            base_version: document.version,
            content: "two".to_owned(),
        })
        .unwrap();
    assert_eq!(result.update.changed, vec![id.clone()]);
    let committed = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(!committed.invalidated);
    assert_eq!(committed.changed, vec![id.clone()]);

    session.refresh().unwrap();
    assert_eq!(prompt_id(&session, "one"), id);
}

#[test]
fn ids_are_scoped_to_the_open_session() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("one.prompt"), "one").unwrap();
    let first = PromptLibrarySession::open(root.path()).unwrap();
    let second = PromptLibrarySession::open(root.path()).unwrap();
    assert_ne!(prompt_id(&first, "one"), prompt_id(&second, "one"));
}

#[test]
fn trash_rejects_a_folder_containing_unmanaged_content_before_calling_system_trash() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("mixed")).unwrap();
    fs::write(root.path().join("mixed/managed.prompt"), "okay").unwrap();
    fs::write(root.path().join("mixed/attachment.txt"), "keep me").unwrap();
    let session = PromptLibrarySession::open(root.path()).unwrap();
    let folder = session
        .snapshot()
        .entries
        .into_iter()
        .find(|entry| entry.name == "mixed")
        .unwrap()
        .id;

    let error = session
        .mutate(Mutation::Trash { entry_id: folder })
        .unwrap_err();

    assert_eq!(error.code, LibraryErrorCode::UnsafeEntry);
    assert!(root.path().join("mixed/attachment.txt").exists());
}

#[cfg(windows)]
#[test]
fn trash_rejects_a_folder_containing_a_junction_before_calling_system_trash() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("container")).unwrap();
    create_windows_junction(&root.path().join("container/junction"), outside.path());
    let session =
        PromptLibrarySession::open_with_trash(root.path(), std::sync::Arc::new(FailingTrash))
            .unwrap();
    let folder = session
        .snapshot()
        .entries
        .into_iter()
        .find(|entry| entry.name == "container")
        .unwrap()
        .id;

    let error = session
        .mutate(Mutation::Trash { entry_id: folder })
        .unwrap_err();

    assert_eq!(error.code, LibraryErrorCode::UnsafeEntry);
    assert!(root.path().join("container/junction").exists());
}

#[test]
fn serialized_mutations_use_camel_case_and_a_kind_tag() {
    let value = serde_json::to_value(Mutation::Save {
        prompt_id: EntryId::random(),
        base_version: ContentVersion::new("revision"),
        content: "body".to_owned(),
    })
    .unwrap();
    assert_eq!(value["kind"], "save");
    assert!(value.get("promptId").is_some());
    assert_eq!(value["baseRevision"], "revision");
}

#[test]
fn error_codes_serialize_as_the_stable_pascal_case_contract() {
    assert_eq!(
        serde_json::to_value(LibraryErrorCode::InvalidEncoding).unwrap(),
        "InvalidEncoding"
    );
    assert_eq!(
        serde_json::to_value(LibraryErrorCode::WatcherDegraded).unwrap(),
        "WatcherDegraded"
    );
}

#[test]
fn atomic_replace_rechecks_the_expected_version_after_the_temp_file_is_synced() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("race.prompt");
    fs::write(&path, "external writer won").unwrap();
    let stale = ContentVersion::from_bytes(b"old bytes");

    let error = super::file_io::atomic_replace(&path, b"my edit", &stale).unwrap_err();

    assert_eq!(error.code, LibraryErrorCode::Conflict);
    assert_eq!(fs::read_to_string(&path).unwrap(), "external writer won");
    assert_eq!(
        fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".prompter-"))
            .count(),
        0
    );
}

#[derive(Debug)]
struct FailingTrash;

impl super::session::TrashAdapter for FailingTrash {
    fn delete(&self, _path: &std::path::Path) -> Result<(), String> {
        Err("system trash service unavailable".to_owned())
    }
}

#[test]
fn trash_failure_is_reported_without_permanently_deleting_the_entry() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("keep.prompt"), "important").unwrap();
    let session =
        PromptLibrarySession::open_with_trash(root.path(), std::sync::Arc::new(FailingTrash))
            .unwrap();
    let id = prompt_id(&session, "keep");

    let error = session
        .mutate(Mutation::Trash { entry_id: id })
        .unwrap_err();

    assert_eq!(error.code, LibraryErrorCode::TrashUnavailable);
    assert_eq!(
        fs::read_to_string(root.path().join("keep.prompt")).unwrap(),
        "important"
    );
}

fn watcher_that_creates_a_prompt_before_returning(
    root: &std::path::Path,
    _handler: super::session::WatchEventHandler,
) -> Result<super::session::WatchSubscription, super::session::WatchStartError> {
    fs::write(root.join("arrived-during-watch.prompt"), "visible").unwrap();
    Ok(super::session::WatchSubscription::inert())
}

#[test]
fn watching_starts_before_the_initial_scan() {
    let root = tempfile::tempdir().unwrap();

    let session = PromptLibrarySession::open_with_adapters(
        root.path(),
        std::sync::Arc::new(FailingTrash),
        watcher_that_creates_a_prompt_before_returning,
    )
    .unwrap();

    assert_eq!(session.snapshot().prompts[0].name, "arrived-during-watch");
}

fn watcher_that_cannot_start(
    _root: &std::path::Path,
    _handler: super::session::WatchEventHandler,
) -> Result<super::session::WatchSubscription, super::session::WatchStartError> {
    Err(super::session::WatchStartError::new(
        "watchRoot",
        "watch service unavailable",
    ))
}

#[test]
fn watcher_start_failure_degrades_but_does_not_disable_the_library() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("still-usable.prompt"), "body").unwrap();

    let session = PromptLibrarySession::open_with_adapters(
        root.path(),
        std::sync::Arc::new(FailingTrash),
        watcher_that_cannot_start,
    )
    .unwrap();
    let snapshot = session.snapshot();

    assert_eq!(snapshot.prompts[0].name, "still-usable");
    let issue = snapshot
        .issues
        .iter()
        .find(|issue| issue.code == LibraryErrorCode::WatcherDegraded)
        .expect("watcher degradation should be visible in the snapshot");
    assert_eq!(issue.path, "");
    assert_eq!(issue.details["operation"], "watchRoot");

    session.refresh().unwrap();
    assert!(
        session
            .snapshot()
            .issues
            .iter()
            .any(|issue| issue.code == LibraryErrorCode::WatcherDegraded)
    );
}

fn watcher_that_reports_overflow(
    _root: &std::path::Path,
    mut handler: super::session::WatchEventHandler,
) -> Result<super::session::WatchSubscription, super::session::WatchStartError> {
    handler(Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch)));
    Ok(super::session::WatchSubscription::inert())
}

#[test]
fn watcher_overflow_is_an_invalidation_hint_for_a_full_refresh() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("one.prompt"), "one").unwrap();
    let session = PromptLibrarySession::open_with_adapters(
        root.path(),
        std::sync::Arc::new(FailingTrash),
        watcher_that_reports_overflow,
    )
    .unwrap();

    let receiver = session.subscribe();
    let update = receiver.recv_timeout(Duration::from_secs(1)).unwrap();

    assert!(update.invalidated);
    assert!(update.changed.is_empty());
    assert!(
        session
            .snapshot()
            .issues
            .iter()
            .any(|issue| issue.code == LibraryErrorCode::WatcherDegraded)
    );
}
