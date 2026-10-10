//! The arc engine's one error type.
//!
//! Each variant names a cause a caller can act on — a name the validator
//! refused, an arc that is not there, git failing, the filesystem failing, a
//! join the engine declined — so a front end chooses what to do (an exit code,
//! a dialog) from the variant rather than from the words. The words are kept
//! as well: every variant renders the exact sentence the engine has always
//! returned, so a typed error changes no message anybody reads.

use std::path::{Path, PathBuf};
use tugtool_core::error::TugError;

use crate::ops::JoinBlocker;

/// Why an arc verb failed.
#[derive(Debug, thiserror::Error)]
pub enum ArcError {
    /// The arc name failed [`crate::log::validate_arc_name`]; the validator's
    /// own error, kept whole.
    #[error(transparent)]
    InvalidName(TugError),

    /// No arc by this name exists.
    #[error("Arc not found: {name}")]
    NotFound { name: String },

    /// A git invocation failed, or could not be run.
    ///
    /// `what` is the sentence the failing site leads with (`git add failed`,
    /// `failed to land the join commit`), and the message is `<what>:
    /// <stderr>`. An empty `what` renders `stderr` alone, for a reader whose
    /// git error already arrives as one finished sentence.
    #[error("{}", lead(.what, .stderr))]
    Git {
        what: String,
        args: Vec<String>,
        stderr: String,
    },

    /// A filesystem act failed on `path`. `what` is the site's lead, rendered
    /// `<what>: <source>`, and spells the path however that site always has;
    /// an empty `what` renders the source alone.
    #[error("{}", lead(.what, &.source.to_string()))]
    Io {
        what: String,
        path: PathBuf,
        source: std::io::Error,
    },

    /// A join the preflight refused, with every blocker it found.
    #[error("{}", blocker_details(.0))]
    Blocked(Vec<JoinBlocker>),

    /// A join whose integration conflicted, with the conflicted paths.
    #[error("The join hit conflicts in {}", .0.join(", "))]
    Conflicted(Vec<String>),

    /// The engine declining with a reason: the sentence says why.
    #[error("{0}")]
    Refused(String),
}

fn lead(what: &str, detail: &str) -> String {
    if what.is_empty() {
        detail.to_string()
    } else {
        format!("{what}: {detail}")
    }
}

fn blocker_details(blockers: &[JoinBlocker]) -> String {
    blockers
        .iter()
        .map(|b| b.detail.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

impl ArcError {
    /// A git failure: `what` leads, git's own stderr follows.
    pub(crate) fn git(what: impl Into<String>, args: &[&str], stderr: impl Into<String>) -> Self {
        ArcError::Git {
            what: what.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            stderr: stderr.into(),
        }
    }

    /// A filesystem failure on `path`, led by the site's own words.
    pub(crate) fn io(
        what: impl Into<String>,
        path: impl Into<PathBuf>,
        source: std::io::Error,
    ) -> Self {
        ArcError::Io {
            what: what.into(),
            path: path.into(),
            source,
        }
    }

    /// This error with `lead` in front of its message, as `<lead>: <message>`.
    ///
    /// A git or filesystem failure stays one, with the lead folded into its
    /// `what`; a refusal stays a refusal. The variants whose message is fixed
    /// by their fields cannot carry a lead, so they become the refusal they
    /// read as.
    pub(crate) fn context(self, lead: impl AsRef<str>) -> Self {
        let lead = lead.as_ref();
        let led = |s: &str| {
            if s.is_empty() {
                lead.to_string()
            } else {
                format!("{lead}: {s}")
            }
        };
        match self {
            ArcError::Git { what, args, stderr } => ArcError::Git {
                what: led(&what),
                args,
                stderr,
            },
            ArcError::Io { what, path, source } => ArcError::Io {
                what: led(&what),
                path,
                source,
            },
            fixed => ArcError::Refused(led(&fixed.to_string())),
        }
    }

    /// This error with `tail` after its message — what a failure left behind,
    /// said after the failure itself — keeping the cause as [`Self::context`]
    /// does.
    pub(crate) fn with_tail(self, tail: impl AsRef<str>) -> Self {
        let tail = tail.as_ref();
        match self {
            ArcError::Git { what, args, stderr } => ArcError::Git {
                what,
                args,
                stderr: format!("{stderr}{tail}"),
            },
            ArcError::Io { what, path, source } => ArcError::Io {
                what,
                path,
                source: std::io::Error::new(source.kind(), format!("{source}{tail}")),
            },
            fixed => ArcError::Refused(format!("{fixed}{tail}")),
        }
    }

    /// A failed write to the arc log at `repo_root`.
    ///
    /// The log's append fails only on I/O, which `TugError` renders as `IO
    /// error: <source>`; this keeps that sentence and adds the path it lost.
    pub(crate) fn arc_log(repo_root: &Path, e: TugError) -> Self {
        match e {
            TugError::Io(source) => ArcError::Io {
                what: "IO error".to_string(),
                path: tugtool_core::paths::arc_log_path(repo_root),
                source,
            },
            other => Self::arc_log_said(repo_root, other.to_string()),
        }
    }

    /// A failure of the arc log at `repo_root` whose sentence the site writes
    /// whole — the log's own error set mid-sentence, or a record written and
    /// then not read back.
    pub(crate) fn arc_log_said(repo_root: &Path, sentence: String) -> Self {
        ArcError::Io {
            what: String::new(),
            path: tugtool_core::paths::arc_log_path(repo_root),
            source: std::io::Error::other(sentence),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_git_failure_reads_as_it_always_has() {
        let e = ArcError::git("git add failed", &["add", "-A"], "fatal: index.lock");
        assert_eq!(e.to_string(), "git add failed: fatal: index.lock");
        let bare = ArcError::git("", &["status"], "not a git repository");
        assert_eq!(bare.to_string(), "not a git repository");
    }

    #[test]
    fn an_invalid_name_keeps_the_validators_sentence() {
        let inner = crate::log::validate_arc_name("join").unwrap_err();
        let text = inner.to_string();
        assert_eq!(ArcError::InvalidName(inner).to_string(), text);
    }

    /// A lead or a tail changes the words and never the cause: a git failure
    /// wrapped twice is still a git failure, reading as the old `format!`
    /// chain did.
    #[test]
    fn context_and_tail_keep_the_cause_and_the_words() {
        let e = ArcError::git("git checkout HEAD -- a failed", &["checkout"], "boom")
            .context("failed to drop the base's copy of a")
            .with_tail(" — the base checkout was left as it was.");
        assert!(matches!(e, ArcError::Git { .. }), "{e:?}");
        assert_eq!(
            e.to_string(),
            "failed to drop the base's copy of a: git checkout HEAD -- a failed: boom — the base checkout was left as it was."
        );

        let io = ArcError::io("", "/x", std::io::Error::other("denied")).with_tail(" — left.");
        assert!(matches!(io, ArcError::Io { .. }), "{io:?}");
        assert_eq!(io.to_string(), "denied — left.");

        // A variant whose words its fields fix becomes the refusal it reads as.
        let conflicted = ArcError::Conflicted(vec!["a".into(), "b".into()]);
        assert_eq!(conflicted.to_string(), "The join hit conflicts in a, b");
        let stranded = conflicted.with_tail(" — and more.");
        assert!(matches!(stranded, ArcError::Refused(_)), "{stranded:?}");
        assert_eq!(
            stranded.to_string(),
            "The join hit conflicts in a, b — and more."
        );
    }
}
