//! JSON output formatting for `tugtool` CLI `--json` mode

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: &str = "1";

/// JSON response envelope for `tugtool` CLI `--json` output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonResponse<T> {
    /// Schema version for forward compatibility
    pub schema_version: String,
    /// Command that generated this response
    pub command: String,
    /// Status: "ok" or "error"
    pub status: String,
    /// Command-specific payload
    pub data: T,
    /// Validation issues, warnings, etc.
    pub issues: Vec<JsonIssue>,
}

impl<T> JsonResponse<T> {
    /// Create a successful response
    pub fn ok(command: &str, data: T) -> Self {
        Self {
            schema_version: SCHEMA_VERSION.to_string(),
            command: command.to_string(),
            status: "ok".to_string(),
            data,
            issues: vec![],
        }
    }

    /// Create an error response
    pub fn error(command: &str, data: T, issues: Vec<JsonIssue>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION.to_string(),
            command: command.to_string(),
            status: "error".to_string(),
            data,
            issues,
        }
    }
}

/// Print a successful `--json` envelope to stdout (pretty-printed). The shared
/// path the changes/commits and dash verbs use so every `--json` payload is the
/// same `{schema_version, command, status, data, issues}` shape.
pub fn print_ok<T: Serialize>(command: &str, data: T) {
    let response = JsonResponse::ok(command, data);
    println!("{}", serde_json::to_string_pretty(&response).unwrap());
}

/// Issue object structure for `tugtool` JSON output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonIssue {
    /// Error/warning code (e.g., "E001")
    pub code: String,
    /// Severity level
    pub severity: String,
    /// Human-readable message
    pub message: String,
    /// Project-root-relative file path using forward slashes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// Line number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    /// Anchor reference (always starts with # if present)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
}

/// Data payload for init command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitData {
    /// Path to the created directory
    pub path: String,
    /// Files created
    pub files_created: Vec<String>,
}

/// Data payload for init --check command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitCheckData {
    /// Whether the project is initialized
    pub initialized: bool,
    /// Path to .tug directory
    pub path: String,
}

/// Data payload for tell command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TellData {
    /// Server response status
    pub server_status: String,
}
