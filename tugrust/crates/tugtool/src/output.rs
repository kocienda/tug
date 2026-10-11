//! JSON output formatting for `tugtool` CLI `--json` mode

use serde::{Deserialize, Serialize};

use crate::changes::AppError;

const SCHEMA_VERSION: &str = "1";

/// JSON response envelope for `tugtool` CLI `--json` output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonResponse<T> {
    /// Schema version for forward compatibility
    pub schema_version: String,
    /// Command that generated this response
    pub command: String,
    /// Status: "ok", "error", or "held" (a gate someone else holds —
    /// neither a success nor a failure of the verb)
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

    /// Create a held response: the verb found its resource held by someone
    /// else and, asked not to wait, reports who rather than failing.
    pub fn held(command: &str, data: T) -> Self {
        Self {
            schema_version: SCHEMA_VERSION.to_string(),
            command: command.to_string(),
            status: "held".to_string(),
            data,
            issues: vec![],
        }
    }
}

/// Print a successful `--json` envelope to stdout (pretty-printed). The shared
/// path the changes/commits and arc verbs use so every `--json` payload is the
/// same `{schema_version, command, status, data, issues}` shape.
pub fn print_ok<T: Serialize>(command: &str, data: T) {
    let response = JsonResponse::ok(command, data);
    println!("{}", serde_json::to_string_pretty(&response).unwrap());
}

/// Print a held `--json` envelope to stdout — the third status, for a verb
/// whose answer is "someone else has it" ([`JsonResponse::held`]).
pub fn print_held<T: Serialize>(command: &str, data: T) {
    let response = JsonResponse::held(command, data);
    println!("{}", serde_json::to_string_pretty(&response).unwrap());
}

/// Print a failed `--json` envelope to stdout — the error twin of
/// [`print_ok`]. `issues[0]` carries the failure's machine cause as `code` and
/// its sentence as `message`; `data` is `null`. The caller keeps the exit code
/// the failure already had, so `--json` changes what is printed and nothing
/// about how the process ends.
pub fn print_error(command: &str, error: &AppError) {
    print_error_with(command, serde_json::Value::Null, error);
}

/// [`print_error`] for a verb that did part of its work before failing: the
/// envelope carries that part's receipt as `data`, so a caller reads what
/// happened and what did not from one document.
pub fn print_error_with<T: Serialize>(command: &str, data: T, error: &AppError) {
    let issue = JsonIssue {
        code: error.code().unwrap_or("failed").to_string(),
        severity: "error".to_string(),
        message: error.message().to_string(),
        file: None,
        line: None,
        anchor: None,
    };
    let response = JsonResponse::error(command, data, vec![issue]);
    println!("{}", serde_json::to_string_pretty(&response).unwrap());
}

/// Print a verb's `--json` receipt with its verdict, and hand the verdict on.
///
/// For the verb that did its work and then judged it — a join that conflicted,
/// a doctor that found disagreements, a claim the instance refused. On `Ok`
/// the receipt is the success envelope; on `Err` it is the error envelope's
/// `data`, and the failure comes back as already reported so the dispatcher
/// prints nothing more. Either way stdout is one document.
pub fn print_receipt<T: Serialize>(
    command: &str,
    receipt: T,
    verdict: Result<(), AppError>,
) -> Result<(), AppError> {
    match verdict {
        Ok(()) => {
            print_ok(command, receipt);
            Ok(())
        }
        Err(error) => {
            print_error_with(command, receipt, &error);
            Err(AppError::Reported(error.exit_code()))
        }
    }
}

/// Print a verb whose answer *is* a list of diagnostics: every one rides
/// `issues`, and the status is `error` when any of them is, `ok` otherwise —
/// a warning is something to read, not a failure.
pub fn print_diagnosed<T: Serialize>(command: &str, data: T, issues: Vec<JsonIssue>) {
    let response = if issues.iter().any(|i| i.severity == "error") {
        JsonResponse::error(command, data, issues)
    } else {
        let mut ok = JsonResponse::ok(command, data);
        ok.issues = issues;
        ok
    };
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
