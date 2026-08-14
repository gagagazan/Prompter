use super::path_safety::is_link_like;
use super::{ContentVersion, LibraryError, LibraryErrorCode, LibraryResult, MAX_PROMPT_BYTES};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const UTF8_BOM: &[u8; 3] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineEnding {
    Lf,
    CrLf,
}

#[derive(Debug, Clone)]
pub(crate) struct LoadedPrompt {
    pub content: String,
    pub version: ContentVersion,
    pub has_bom: bool,
    pub line_ending: LineEnding,
}

pub(crate) fn is_exact_prompt_name(name: &str) -> bool {
    name.strip_suffix(".prompt")
        .is_some_and(|stem| !stem.is_empty())
}

pub(crate) fn logical_prompt_name(name: &str) -> Option<&str> {
    name.strip_suffix(".prompt").filter(|stem| !stem.is_empty())
}

pub(crate) fn load_prompt(path: &Path) -> LibraryResult<LoadedPrompt> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| LibraryError::io("metadata", path, &error))?;
    if is_link_like(&metadata) || !metadata.file_type().is_file() {
        return Err(LibraryError::unsupported(
            path,
            "managed prompts must be regular files",
        ));
    }
    if metadata.len() > MAX_PROMPT_BYTES as u64 {
        return Err(LibraryError::too_large(path, metadata.len()));
    }

    // Read one byte beyond the limit so a file growing concurrently cannot
    // evade the metadata size check.
    let mut file = File::open(path).map_err(|error| LibraryError::io("open", path, &error))?;
    let mut bytes = Vec::with_capacity((metadata.len() as usize).min(MAX_PROMPT_BYTES));
    Read::by_ref(&mut file)
        .take(MAX_PROMPT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| LibraryError::io("read", path, &error))?;
    if bytes.len() > MAX_PROMPT_BYTES {
        return Err(LibraryError::too_large(path, bytes.len() as u64));
    }

    let version = ContentVersion::from_bytes(&bytes);
    let has_bom = bytes.starts_with(UTF8_BOM);
    let editor_bytes = if has_bom {
        &bytes[UTF8_BOM.len()..]
    } else {
        &bytes
    };
    let content = std::str::from_utf8(editor_bytes)
        .map_err(|_| LibraryError::invalid_encoding(path))?
        .to_owned();

    Ok(LoadedPrompt {
        line_ending: detect_line_ending(&content),
        content,
        version,
        has_bom,
    })
}

fn detect_line_ending(content: &str) -> LineEnding {
    let bytes = content.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            return if index > 0 && bytes[index - 1] == b'\r' {
                LineEnding::CrLf
            } else {
                LineEnding::Lf
            };
        }
    }
    LineEnding::Lf
}

pub(crate) fn encode_content(
    content: &str,
    has_bom: bool,
    line_ending: LineEnding,
    path_for_error: &Path,
) -> LibraryResult<Vec<u8>> {
    let content = if has_bom {
        content.strip_prefix('\u{feff}').unwrap_or(content)
    } else {
        content
    };
    let normalized = match line_ending {
        LineEnding::Lf => content.replace("\r\n", "\n"),
        LineEnding::CrLf => content.replace("\r\n", "\n").replace('\n', "\r\n"),
    };

    let encoded_len = normalized.len() + usize::from(has_bom) * UTF8_BOM.len();
    if encoded_len > MAX_PROMPT_BYTES {
        return Err(LibraryError::too_large(path_for_error, encoded_len as u64));
    }
    let mut bytes = Vec::with_capacity(encoded_len);
    if has_bom {
        bytes.extend_from_slice(UTF8_BOM);
    }
    bytes.extend_from_slice(normalized.as_bytes());
    Ok(bytes)
}

pub(crate) fn atomic_replace(
    path: &Path,
    bytes: &[u8],
    expected_version: &ContentVersion,
) -> LibraryResult<()> {
    atomic_replace_with(path, bytes, expected_version, replace_file)
}

fn atomic_replace_with(
    path: &Path,
    bytes: &[u8],
    expected_version: &ContentVersion,
    replace: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> LibraryResult<()> {
    let parent = path.parent().ok_or_else(|| {
        LibraryError::new(
            LibraryErrorCode::RecoveryRequired,
            "The prompt library could not access the filesystem.",
        )
        .detail("operation", "replace")
        .detail("path", path.to_string_lossy())
        .detail("reason", "entry has no parent directory")
    })?;
    let (temporary_path, mut temporary) = create_same_dir_temp(parent)?;
    let mut guard = TemporaryGuard(Some(temporary_path.clone()));

    if let Ok(metadata) = fs::metadata(path) {
        temporary
            .set_permissions(metadata.permissions())
            .map_err(|error| LibraryError::io("setPermissions", &temporary_path, &error))?;
    }
    temporary
        .write_all(bytes)
        .map_err(|error| LibraryError::io("writeTemporary", &temporary_path, &error))?;
    temporary
        .flush()
        .map_err(|error| LibraryError::io("flushTemporary", &temporary_path, &error))?;
    temporary
        .sync_all()
        .map_err(|error| LibraryError::io("syncTemporary", &temporary_path, &error))?;
    drop(temporary);

    // Recheck after the expensive write+sync phase. This does not make writes
    // linearizable against a non-cooperating writer, but it closes the large
    // window between the session's initial check and atomic replacement.
    let current = load_prompt(path)?;
    if &current.version != expected_version {
        return Err(LibraryError::new(
            LibraryErrorCode::Conflict,
            "The prompt changed while the replacement was being prepared.",
        )
        .detail("expectedVersion", expected_version.as_str())
        .detail("currentVersion", current.version.as_str())
        .detail("path", path.to_string_lossy()));
    }

    replace(&temporary_path, path)
        .map_err(|error| LibraryError::io("atomicReplace", path, &error))?;
    guard.0 = None;
    sync_directory(parent);
    Ok(())
}

pub(crate) fn atomic_create(path: &Path, bytes: &[u8]) -> LibraryResult<()> {
    if bytes.len() > MAX_PROMPT_BYTES {
        return Err(LibraryError::too_large(path, bytes.len() as u64));
    }
    let parent = path.parent().ok_or_else(|| {
        LibraryError::new(
            LibraryErrorCode::RecoveryRequired,
            "The prompt library could not access the filesystem.",
        )
        .detail("operation", "create")
        .detail("path", path.to_string_lossy())
        .detail("reason", "entry has no parent directory")
    })?;
    let (temporary_path, mut temporary) = create_same_dir_temp(parent)?;
    let mut guard = TemporaryGuard(Some(temporary_path.clone()));
    temporary
        .write_all(bytes)
        .map_err(|error| LibraryError::io("writeTemporary", &temporary_path, &error))?;
    temporary
        .flush()
        .map_err(|error| LibraryError::io("flushTemporary", &temporary_path, &error))?;
    temporary
        .sync_all()
        .map_err(|error| LibraryError::io("syncTemporary", &temporary_path, &error))?;
    drop(temporary);

    relocate_no_overwrite(&temporary_path, path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            LibraryError::collision(&path.file_name().unwrap_or_default().to_string_lossy())
        } else {
            LibraryError::io("atomicCreate", path, &error)
        }
    })?;
    guard.0 = None;
    sync_directory(parent);
    Ok(())
}

fn create_same_dir_temp(parent: &Path) -> LibraryResult<(PathBuf, File)> {
    for _ in 0..32 {
        let path = parent.join(format!(".prompter-{}.tmp", uuid::Uuid::new_v4()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(LibraryError::io("createTemporary", &path, &error)),
        }
    }
    Err(LibraryError::new(
        LibraryErrorCode::RecoveryRequired,
        "The prompt library could not access the filesystem.",
    )
    .detail("operation", "createTemporary")
    .detail("path", parent.to_string_lossy())
    .detail("reason", "could not allocate a unique temporary file"))
}

struct TemporaryGuard(Option<PathBuf>);

impl Drop for TemporaryGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) {}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{REPLACEFILE_WRITE_THROUGH, ReplaceFileW};

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let succeeded = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Relocates an entry while asking the operating system to fail if the target
/// already exists. This is stronger than `exists` + `rename` on Unix.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) fn relocate_no_overwrite(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    unsafe extern "C" {
        fn renameat2(
            olddirfd: c_int,
            oldpath: *const c_char,
            newdirfd: c_int,
            newpath: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }
    const AT_FDCWD: c_int = -100;
    const RENAME_NOREPLACE: c_uint = 1;
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe {
        renameat2(
            AT_FDCWD,
            source.as_ptr(),
            AT_FDCWD,
            target.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn relocate_no_overwrite(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    unsafe extern "C" {
        fn renamex_np(old: *const c_char, new: *const c_char, flags: c_uint) -> c_int;
    }
    const RENAME_EXCL: c_uint = 0x0000_0004;
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe { renamex_np(source.as_ptr(), target.as_ptr(), RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn relocate_no_overwrite(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let succeeded = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios",
    windows
)))]
pub(crate) fn relocate_no_overwrite(source: &Path, target: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(target).is_ok() {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    if source.is_file() {
        fs::hard_link(source, target)?;
        fs::remove_file(source)
    } else {
        // Best available standard-library fallback for less common targets.
        fs::rename(source, target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_replace_failure_preserves_the_original_and_removes_the_temporary_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("safe.prompt");
        fs::write(&path, "original").unwrap();
        let expected = ContentVersion::from_bytes(b"original");

        let error = atomic_replace_with(&path, b"replacement", &expected, |_source, _target| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        })
        .unwrap_err();

        assert_eq!(error.code, LibraryErrorCode::PermissionDenied);
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
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
}
