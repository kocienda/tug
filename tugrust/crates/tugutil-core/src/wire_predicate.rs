//! What a wire watches for, and whether an event is it.
//!
//! A trigger is JSON with exactly one source — a fact kind, or a commit — and
//! this module is its types, its serde shape, and the pure `matches` that
//! decides. Nothing here touches IO, a clock, or a database: the engine reads
//! a wire row, hands the trigger an event, and gets a bool.
//!
//! **Two sources, because two things trip a wire.** Facts are the uniform,
//! searchable record of everything a session does, so a new trigger source is
//! normally a new fact kind rather than new machinery here. Commits are the
//! exception that earns its own arm: `GIT_HEAD` catches the terminal and
//! external commits that never write a `commit` fact at all.
//!
//! **A `where` clause reads the fact's payload and nothing else.** A missing
//! field never matches — the same posture the shell-op grammar takes, because
//! a predicate that treats absence as a match fires a wire on evidence that
//! was not there.
//!
//! The v1 shape is deliberately flat: no regex, no numeric comparison, no
//! AND/OR. Each of those grows an enum here and changes nothing else, which is
//! the property worth keeping.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a wire is armed to watch for. Exactly one source, and the untagged
/// serde shape is what makes `{"fact": …}` and `{"commit": …}` the whole
/// grammar rather than a `type` discriminator nobody would ever type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum Predicate {
    #[serde(rename = "fact")]
    Fact(FactTrigger),
    #[serde(rename = "commit")]
    Commit(CommitTrigger),
}

/// A fact of one kind, optionally narrowed by its payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactTrigger {
    /// A `facts.kind` string, in the `FactKind::as_str` spelling. Unknown
    /// kinds are legal on purpose: a wire laid against a kind a newer build
    /// records must be storable by an older one, and simply never fire.
    pub kind: String,
    /// A flat map over the fact's payload. Absent means "any fact of this
    /// kind".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#where: Option<BTreeMap<String, Matcher>>,
}

/// A commit on a watched workspace, optionally narrowed to one branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitTrigger {
    /// Absent means any branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// How one payload field is compared. A bare JSON string is the exact match,
/// which is what makes the common case read as `{"route": "claude"}` rather
/// than as a wrapper nobody needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Matcher {
    Exact(String),
    Contains { contains: String },
    Prefix { prefix: String },
}

impl Matcher {
    /// Whether a payload value satisfies this matcher.
    ///
    /// The value is compared as a string, and a non-string JSON value is
    /// compared by the text it renders as — so `--where exit=3` matches the
    /// number `3` the marker actually wrote. Anything else would make a
    /// number-valued field unmatchable from a command line, which has only
    /// strings to offer.
    pub fn matches(&self, value: &serde_json::Value) -> bool {
        let text = match value {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Null => return false,
            other => other.to_string(),
        };
        match self {
            Matcher::Exact(want) => text == *want,
            Matcher::Contains { contains } => text.contains(contains.as_str()),
            Matcher::Prefix { prefix } => text.starts_with(prefix.as_str()),
        }
    }
}

/// One thing that happened, as the engine hands it to a predicate.
///
/// The project path rides both arms because scope is checked against it, and
/// scope is the engine's business rather than the predicate's — it is here so
/// one struct describes an event whole rather than two halves the caller has
/// to keep together.
#[derive(Debug, Clone, PartialEq)]
pub enum WireEvent {
    Fact {
        kind: String,
        payload: serde_json::Value,
        project_dir: Option<String>,
        session_card: Option<String>,
        /// The rowid the fact was read at. Unique within an instance, which is
        /// what the claim key needs — two instances never read one fact,
        /// because a session ledger is per-instance. A fact with no stable
        /// identity of its own would have to be keyed by its arrival time, and
        /// two facts of one kind arriving in one millisecond would then be one
        /// firing with the second silently lost.
        seq: i64,
    },
    Commit {
        branch: Option<String>,
        sha: String,
        workspace_path: String,
    },
}

impl WireEvent {
    /// The path a scope is compared against ([P12]): the fact's session's
    /// project directory, or the committing workspace.
    pub fn project_path(&self) -> Option<&str> {
        match self {
            WireEvent::Fact { project_dir, .. } => project_dir.as_deref(),
            WireEvent::Commit { workspace_path, .. } => Some(workspace_path),
        }
    }

    /// The key the `UNIQUE(wire_id, event_key)` claim arbitrates on. A
    /// commit's is its sha, so re-checking out an already-tripped commit
    /// never trips again.
    pub fn key(&self) -> Option<String> {
        match self {
            WireEvent::Commit { sha, .. } => Some(sha.clone()),
            WireEvent::Fact { .. } => None,
        }
    }
}

/// Whether an event is what a wire is watching for.
///
/// Kind and source must agree exactly. A `where` clause then reads the fact's
/// payload: every named field must be present *and* match, because a wire
/// narrowed to `route=claude` that fires on a fact with no route at all is a
/// wire that quietly ignores the narrowing it was given.
pub fn matches(predicate: &Predicate, event: &WireEvent) -> bool {
    match (predicate, event) {
        (Predicate::Fact(trigger), WireEvent::Fact { kind, payload, .. }) => {
            if trigger.kind != *kind {
                return false;
            }
            let Some(clauses) = &trigger.r#where else {
                return true;
            };
            clauses.iter().all(|(field, matcher)| {
                payload
                    .get(field)
                    .is_some_and(|value| matcher.matches(value))
            })
        }
        (Predicate::Commit(trigger), WireEvent::Commit { branch, .. }) => match &trigger.branch {
            // A branch the engine could not resolve is not "any branch": it is
            // an unknown, and a wire narrowed to `main` must not fire on one.
            Some(want) => branch.as_deref() == Some(want.as_str()),
            None => true,
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fact(kind: &str, payload: serde_json::Value) -> WireEvent {
        WireEvent::Fact {
            kind: kind.to_string(),
            payload,
            project_dir: Some("/proj".to_string()),
            session_card: None,
            seq: 1,
        }
    }

    fn commit(branch: Option<&str>) -> WireEvent {
        WireEvent::Commit {
            branch: branch.map(str::to_owned),
            sha: "abc123".to_string(),
            workspace_path: "/proj".to_string(),
        }
    }

    fn parse(json_text: &str) -> Predicate {
        serde_json::from_str(json_text).expect("the predicate parses")
    }

    #[test]
    fn a_fact_trigger_matches_its_kind_and_nothing_else() {
        let p = parse(r#"{"fact":{"kind":"edit_failed"}}"#);
        assert!(matches(&p, &fact("edit_failed", json!({}))));
        assert!(!matches(&p, &fact("shell", json!({}))));
        assert!(!matches(&p, &commit(Some("main"))));
    }

    #[test]
    fn a_where_clause_reads_each_matcher_off_the_payload() {
        let p = parse(
            r#"{"fact":{"kind":"shell","where":{"route":"claude","command":{"contains":"file edit"},"cwd":{"prefix":"/proj"}}}}"#,
        );
        assert!(matches(
            &p,
            &fact(
                "shell",
                json!({"route":"claude","command":"tugutil file edit","cwd":"/proj/src"})
            )
        ));
        assert!(
            !matches(
                &p,
                &fact(
                    "shell",
                    json!({"route":"user","command":"tugutil file edit","cwd":"/proj"})
                )
            ),
            "every clause must hold, not just one"
        );
        assert!(
            !matches(
                &p,
                &fact("shell", json!({"route":"claude","command":"cargo build"}))
            ),
            "a substring that is not there does not match"
        );
    }

    /// A predicate narrowed by a field the payload never carried has been
    /// ignored, not satisfied.
    #[test]
    fn an_absent_payload_field_never_matches() {
        let p = parse(r#"{"fact":{"kind":"shell","where":{"route":"claude"}}}"#);
        assert!(!matches(&p, &fact("shell", json!({}))));
        assert!(!matches(&p, &fact("shell", json!({"route": null}))));
    }

    /// A command line has only strings to offer, so a number-valued field is
    /// compared by the text it renders as.
    #[test]
    fn a_non_string_payload_value_is_compared_as_text() {
        let p = parse(r#"{"fact":{"kind":"edit_failed","where":{"exit":"3"}}}"#);
        assert!(matches(&p, &fact("edit_failed", json!({"exit": 3}))));
        assert!(!matches(&p, &fact("edit_failed", json!({"exit": 4}))));
    }

    #[test]
    fn a_commit_trigger_honors_its_branch_filter() {
        let any = parse(r#"{"commit":{}}"#);
        assert!(matches(&any, &commit(Some("main"))));
        assert!(matches(&any, &commit(Some("tugdash/x"))));
        assert!(matches(&any, &commit(None)));

        let main = parse(r#"{"commit":{"branch":"main"}}"#);
        assert!(matches(&main, &commit(Some("main"))));
        assert!(!matches(&main, &commit(Some("tugdash/x"))));
        assert!(
            !matches(&main, &commit(None)),
            "an unresolved branch is an unknown, not a wildcard"
        );
        assert!(!matches(&main, &fact("commit", json!({}))));
    }

    /// A wire laid against a kind this build has never heard of must store
    /// and load — it is a wire for a newer build's fact, and it simply never
    /// fires here.
    #[test]
    fn an_unknown_fact_kind_is_legal() {
        let p = parse(r#"{"fact":{"kind":"some_future_kind"}}"#);
        assert!(matches(&p, &fact("some_future_kind", json!({}))));
        assert!(!matches(&p, &fact("edit_failed", json!({}))));
    }

    #[test]
    fn every_spec_shape_round_trips_through_serde() {
        for text in [
            r#"{"fact":{"kind":"edit_failed"}}"#,
            r#"{"fact":{"kind":"shell","where":{"route":"claude"}}}"#,
            r#"{"fact":{"kind":"shell","where":{"command":{"contains":"file edit"}}}}"#,
            r#"{"fact":{"kind":"shell","where":{"command":{"prefix":"just "}}}}"#,
            r#"{"commit":{}}"#,
            r#"{"commit":{"branch":"main"}}"#,
        ] {
            let parsed: Predicate = serde_json::from_str(text).expect(text);
            let back = serde_json::to_string(&parsed).expect("serializes");
            assert_eq!(back, text, "the stored form is the written form");
        }
    }

    #[test]
    fn a_predicate_with_neither_source_or_an_unknown_field_refuses() {
        assert!(serde_json::from_str::<Predicate>(r#"{}"#).is_err());
        assert!(serde_json::from_str::<Predicate>(r#"{"tag":{"kind":"x"}}"#).is_err());
        assert!(
            serde_json::from_str::<Predicate>(r#"{"fact":{"knid":"edit_failed"}}"#).is_err(),
            "a misspelled field is a refusal, not a wire that watches nothing"
        );
    }

    #[test]
    fn a_commit_events_key_is_its_sha() {
        assert_eq!(commit(Some("main")).key().as_deref(), Some("abc123"));
        assert!(fact("shell", json!({})).key().is_none());
    }

    #[test]
    fn an_events_project_path_is_what_scope_compares_against() {
        assert_eq!(fact("shell", json!({})).project_path(), Some("/proj"));
        assert_eq!(commit(None).project_path(), Some("/proj"));
    }
}
