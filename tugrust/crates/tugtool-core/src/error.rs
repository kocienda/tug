//! Error types for tug operations

use thiserror::Error;

/// Core error type for tug operations.
///
/// Only the variants the surviving surface actually constructs remain — config,
/// resolution, git/worktree, and arc. The plan-parser/validator and the arc
/// state-machine were retired, and their error variants with them.
#[derive(Error, Debug)]
pub enum TugError {
    /// `.tugtool/` directory not initialized
    #[error(".tugtool directory not initialized")]
    NotInitialized,

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Configuration error
    #[error("configuration error: {0}")]
    Config(String),

    /// Not in a git repository
    #[error("not in a git repository")]
    NotAGitRepository,

    /// Base branch not found
    #[error("base branch not found: {branch}")]
    BaseBranchNotFound { branch: String },

    /// Worktree creation failed
    #[error("worktree creation failed: {reason}")]
    WorktreeCreationFailed { reason: String },

    /// Arc name invalid
    #[error("invalid arc name '{name}': {reason}")]
    ArcNameInvalid { name: String, reason: String },

    /// The repo-universe boundary variable names something that is not a checkout
    #[error("TUG_REPO_UNIVERSE='{value}' {reason}")]
    RepoUniverseInvalid { value: String, reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = TugError::ArcNameInvalid {
            name: "Bad Name".to_string(),
            reason: "name must start with a lowercase letter".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "invalid arc name 'Bad Name': name must start with a lowercase letter"
        );
    }

    #[test]
    fn test_io_conversion() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let err: TugError = io.into();
        assert!(matches!(err, TugError::Io(_)));
    }
}
