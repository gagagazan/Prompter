use serde::Serialize;
use serde_json::Value;

/// Stable IPC error shape. Frontend code should branch on `code`, never on
/// platform-specific error messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: impl Into<Value>) -> Self {
        self.details = Some(details.into());
        self
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Self::new("io", error.to_string())
            .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
    }
}

impl From<crate::library::LibraryError> for CommandError {
    fn from(error: crate::library::LibraryError) -> Self {
        let message = error.to_string();
        let code = serde_json::to_value(error.code)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "library".to_owned());

        Self {
            code,
            message,
            // Library diagnostics can contain native absolute paths. The
            // desktop boundary exposes stable codes only; paths remain inside
            // the Rust-owned library module.
            details: None,
        }
    }
}
