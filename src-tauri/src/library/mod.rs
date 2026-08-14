//! A filesystem-backed prompt library.
//!
//! IDs deliberately live only for the lifetime of [`PromptLibrarySession`].
//! Callers should refresh a snapshot after an invalidation instead of persisting
//! an ID as a filesystem identity.

mod error;
mod file_io;
mod model;
mod path_safety;
mod session;

pub use error::{LibraryError, LibraryErrorCode, LibraryResult};
pub use model::{
    ContentVersion, EntryHealth, EntryId, EntryKind, FolderId, LibraryEntry, LibraryIssue,
    LibrarySnapshot, LibraryUpdate, Mutation, MutationResult, PromptDocument, PromptId, SearchHit,
};
pub use session::PromptLibrarySession;

/// Rejects symlinks, Windows junctions, mount points, and other reparse-point
/// roots before a native picker grant is canonicalized.
pub fn validate_library_root(path: impl AsRef<std::path::Path>) -> LibraryResult<()> {
    session::validate_library_root_candidate(path.as_ref())
}

/// Maximum encoded size of a managed `.prompt` file.
pub const MAX_PROMPT_BYTES: usize = 16 * 1024 * 1024;

#[cfg(test)]
mod tests;
