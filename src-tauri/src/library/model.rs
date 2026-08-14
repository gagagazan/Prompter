use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// An opaque identifier scoped to one open library session.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntryId(String);

impl EntryId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn random() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl fmt::Display for EntryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

pub type PromptId = EntryId;
pub type FolderId = EntryId;

/// SHA-256 of the exact on-disk bytes, including a UTF-8 BOM and line endings.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ContentVersion(String);

impl ContentVersion {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn from_bytes(bytes: &[u8]) -> Self {
        use sha2::{Digest, Sha256};
        Self(hex::encode(Sha256::digest(bytes)))
    }
}

impl From<String> for ContentVersion {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl fmt::Display for ContentVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Prompt,
    Folder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryHealth {
    Healthy,
    Issue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: EntryId,
    pub name: String,
    pub relative_path: String,
    pub kind: EntryKind,
    pub health: EntryHealth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<ContentVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIssue {
    pub code: super::LibraryErrorCode,
    /// Root-relative path using `/` separators.
    pub path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<EntryId>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub root: String,
    pub root_id: FolderId,
    pub revision: u64,
    pub entries: Vec<LibraryEntry>,
    /// A flat prompt-only projection for command palettes and simple clients.
    pub prompts: Vec<LibraryEntry>,
    pub issues: Vec<LibraryIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDocument {
    pub id: PromptId,
    pub name: String,
    pub relative_path: String,
    /// The editor-facing content. A leading UTF-8 BOM is intentionally omitted.
    pub content: String,
    pub version: ContentVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub prompt: LibraryEntry,
    pub score: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUpdate {
    pub revision: u64,
    pub changed: Vec<EntryId>,
    /// `true` means a watcher observed filesystem activity. It is a hint to call
    /// `refresh`, not a claim that the cached snapshot has already changed.
    pub invalidated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Save {
        prompt_id: PromptId,
        #[serde(rename = "baseRevision", alias = "baseVersion", alias = "base_version")]
        base_version: ContentVersion,
        content: String,
    },
    SaveCopy {
        prompt_id: PromptId,
        content: String,
    },
    CreatePrompt {
        folder_id: FolderId,
        name: String,
        #[serde(default)]
        content: String,
    },
    CreateFolder {
        parent_id: FolderId,
        name: String,
    },
    Rename {
        entry_id: EntryId,
        name: String,
    },
    Move {
        entry_id: EntryId,
        target_folder_id: FolderId,
    },
    Trash {
        entry_id: EntryId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub update: LibraryUpdate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<LibraryEntry>,
}
