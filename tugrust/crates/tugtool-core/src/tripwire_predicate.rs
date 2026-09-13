//! What a tripwire watches for, and whether an event is it.
//!
//! A trigger is JSON with one source — a fact kind — and this module is its
//! types, its serde shape, and the pure `matches` that decides. Nothing here
//! touches IO, a clock, or a database: the engine reads a tripwire row, hands
//! the trigger an event, and gets a bool.
//!
//! **One source, because the landing is no longer one of them.** A tripwire fires
//! when a landing gesture commits onto its named base branch ([P01]), and the
//! branch is a column on the tripwire rather than a clause in its trigger. What
//! the predicate decides is the narrower question the landing then asks: does
//! this lineage carry the facts the tripwire is watching for? Facts are the
//! uniform, searchable record of everything a session does, so a new trigger
//! source is a new fact kind rather than new machinery here.
//!
//! **A `where` clause reads the fact's payload and nothing else.** A missing
//! field never matches — the same posture the shell-op grammar takes, because
//! a predicate that treats absence as a match fires a tripwire on evidence that
//! was not there.
//!
//! The v1 shape is deliberately flat: no regex, no numeric comparison, no
//! AND/OR. Each of those grows an enum here and changes nothing else, which is
//! the property worth keeping.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a tripwire is armed to watch for. The serde shape is what makes
/// `{"fact": …}` the whole grammar rather than a `type` discriminator nobody
/// would ever type. A row storing a source this build does not know — a
/// `{"commit": …}` trigger laid by an older one — stays unreadable but
/// listable, the standing posture for a foreign trigger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum Predicate {
    #[serde(rename = "fact")]
    Fact(FactTrigger),
}

/// A fact of one kind, optionally narrowed by its payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactTrigger {
    /// A `facts.kind` string, in the `FactKind::as_str` spelling. Unknown
    /// kinds are legal on purpose: a tripwire laid against a kind a newer build
    /// records must be storable by an older one, and simply never fire.
    pub kind: String,
    /// A flat map over the fact's payload. Absent means "any fact of this
    /// kind".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#where: Option<BTreeMap<String, Matcher>>,
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

/// One fact, as the engine hands it to a predicate.
///
/// Only what the condition reads. Where the fact happened, which session wrote
/// it, and which landing carried it are the engine's business — the scope is
/// compared against the landing's repository and the claim is keyed by the
/// landing's sha ([P01]), so none of it reaches here.
#[derive(Debug, Clone, PartialEq)]
pub struct FactEvent {
    pub kind: String,
    pub payload: serde_json::Value,
}

/// Whether a fact is what a tripwire is watching for.
///
/// Kind and source must agree exactly. A `where` clause then reads the fact's
/// payload: every named field must be present *and* match, because a tripwire
/// narrowed to `route=claude` that fires on a fact with no route at all is a
/// tripwire that quietly ignores the narrowing it was given.
pub fn matches(predicate: &Predicate, fact: &FactEvent) -> bool {
    let Predicate::Fact(trigger) = predicate;
    if trigger.kind != fact.kind {
        return false;
    }
    let Some(clauses) = &trigger.r#where else {
        return true;
    };
    clauses.iter().all(|(field, matcher)| {
        fact.payload
            .get(field)
            .is_some_and(|value| matcher.matches(value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fact(kind: &str, payload: serde_json::Value) -> FactEvent {
        FactEvent {
            kind: kind.to_string(),
            payload,
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
                json!({"route":"claude","command":"tugtool file edit","cwd":"/proj/src"})
            )
        ));
        assert!(
            !matches(
                &p,
                &fact(
                    "shell",
                    json!({"route":"user","command":"tugtool file edit","cwd":"/proj"})
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
    fn a_commit_trigger_is_no_longer_a_grammar_this_build_reads() {
        // The branch a tripwire watches is a column on the tripwire now ([P02]), so a
        // v1 trigger that spelled it here is a foreign trigger: unreadable, and
        // therefore listable and removable but never firing.
        for text in [r#"{"commit":{}}"#, r#"{"commit":{"branch":"main"}}"#] {
            assert!(serde_json::from_str::<Predicate>(text).is_err(), "{text}");
        }
    }

    /// A tripwire laid against a kind this build has never heard of must store
    /// and load — it is a tripwire for a newer build's fact, and it simply never
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
            "a misspelled field is a refusal, not a tripwire that watches nothing"
        );
    }
}
