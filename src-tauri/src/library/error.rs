use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

pub type LibraryResult<T> = Result<T, LibraryError>;

/// Machine-readable errors returned by the library boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
#[non_exhaustive]
pub enum LibraryErrorCode {
    RootUnavailable,
    NotFound,
    StaleId,
    Conflict,
    NameCollision,
    InvalidName,
    InvalidEncoding,
    TooLarge,
    PermissionDenied,
    ReadOnly,
    FileBusy,
    CrossDeviceMove,
    TrashUnavailable,
    UnsafeEntry,
    WatcherDegraded,
    RecoveryRequired,
}

/// Stable serializable error envelope. OS-specific diagnostics, when useful,
/// are confined to `details`; `code` and `message` are stable API values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryError {
    pub code: LibraryErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, String>,
}

impl LibraryError {
    pub(crate) fn new(code: LibraryErrorCode, message: &'static str) -> Self {
        Self {
            code,
            message: message.to_owned(),
            details: BTreeMap::new(),
        }
    }

    pub(crate) fn detail(mut self, key: &str, value: impl Into<String>) -> Self {
        self.details.insert(key.to_owned(), value.into());
        self
    }

    pub(crate) fn io(operation: &'static str, path: &Path, error: &std::io::Error) -> Self {
        let code = classify_io_error(error);
        let message = match code {
            LibraryErrorCode::PermissionDenied => {
                "The prompt library does not have permission to access this entry."
            }
            LibraryErrorCode::ReadOnly => "The prompt library is on a read-only filesystem.",
            LibraryErrorCode::FileBusy => "The filesystem entry is busy. Try again shortly.",
            LibraryErrorCode::CrossDeviceMove => {
                "The entry cannot be moved atomically across filesystems."
            }
            LibraryErrorCode::StaleId => "The library entry changed or disappeared on disk.",
            _ => "The prompt library could not safely complete the filesystem operation.",
        };
        Self::new(code, message)
            .detail("operation", operation)
            .detail("path", path.to_string_lossy())
            .detail("reason", error.to_string())
    }

    pub(crate) fn invalid_root(path: &Path, reason: &'static str) -> Self {
        Self::new(
            LibraryErrorCode::RootUnavailable,
            "The library root is not a usable directory.",
        )
        .detail("path", path.to_string_lossy())
        .detail("reason", reason)
    }

    pub(crate) fn not_found(id: &str) -> Self {
        Self::new(
            LibraryErrorCode::NotFound,
            "The requested library entry no longer exists.",
        )
        .detail("entryId", id)
    }

    pub(crate) fn invalid_name(name: &str, reason: &'static str) -> Self {
        Self::new(
            LibraryErrorCode::InvalidName,
            "The entry name is not portable across supported systems.",
        )
        .detail("name", name)
        .detail("reason", reason)
    }

    pub(crate) fn collision(name: &str) -> Self {
        Self::new(
            LibraryErrorCode::NameCollision,
            "An entry with an equivalent portable name already exists.",
        )
        .detail("name", name)
    }

    pub(crate) fn invalid_encoding(path: &Path) -> Self {
        Self::new(
            LibraryErrorCode::InvalidEncoding,
            "Prompt content must be valid UTF-8.",
        )
        .detail("path", path.to_string_lossy())
    }

    pub(crate) fn too_large(path: &Path, size: u64) -> Self {
        Self::new(
            LibraryErrorCode::TooLarge,
            "Prompt content exceeds the 16 MiB limit.",
        )
        .detail("path", path.to_string_lossy())
        .detail("sizeBytes", size.to_string())
        .detail("limitBytes", crate::library::MAX_PROMPT_BYTES.to_string())
    }

    pub(crate) fn unsupported(path: &Path, reason: &'static str) -> Self {
        Self::new(
            LibraryErrorCode::UnsafeEntry,
            "The filesystem entry is not managed by the prompt library.",
        )
        .detail("path", path.to_string_lossy())
        .detail("reason", reason)
    }

    pub(crate) fn unsafe_trash(path: &Path, reason: &'static str) -> Self {
        Self::new(
            LibraryErrorCode::UnsafeEntry,
            "The folder cannot be moved to Trash because it contains unsafe content.",
        )
        .detail("path", path.to_string_lossy())
        .detail("reason", reason)
    }
}

impl fmt::Display for LibraryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LibraryError {}

fn classify_io_error(error: &std::io::Error) -> LibraryErrorCode {
    use std::io::ErrorKind;

    match error.kind() {
        ErrorKind::PermissionDenied => return LibraryErrorCode::PermissionDenied,
        ErrorKind::NotFound => return LibraryErrorCode::StaleId,
        ErrorKind::WouldBlock => return LibraryErrorCode::FileBusy,
        _ => {}
    }

    // These OS values are stable platform ABI constants. Keeping them here
    // avoids depending on a platform crate on Unix while still giving callers
    // actionable, portable error codes.
    match error.raw_os_error() {
        #[cfg(unix)]
        Some(30) => LibraryErrorCode::ReadOnly, // EROFS
        #[cfg(unix)]
        Some(16) => LibraryErrorCode::FileBusy, // EBUSY
        #[cfg(unix)]
        Some(18) => LibraryErrorCode::CrossDeviceMove, // EXDEV
        #[cfg(windows)]
        Some(19) => LibraryErrorCode::ReadOnly, // ERROR_WRITE_PROTECT
        #[cfg(windows)]
        Some(32) | Some(33) => LibraryErrorCode::FileBusy, // sharing / lock violation
        #[cfg(windows)]
        Some(17) => LibraryErrorCode::CrossDeviceMove, // ERROR_NOT_SAME_DEVICE
        _ => LibraryErrorCode::RecoveryRequired,
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn windows_sharing_and_lock_violations_are_file_busy() {
        assert_eq!(
            classify_io_error(&std::io::Error::from_raw_os_error(32)),
            LibraryErrorCode::FileBusy
        );
        assert_eq!(
            classify_io_error(&std::io::Error::from_raw_os_error(33)),
            LibraryErrorCode::FileBusy
        );
    }
}
