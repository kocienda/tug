//! The verdict tier — one model turn, no hands, and the envelope it answers in.
//!
//! A wire with no probe needs no worktree, so its trip never spawns a session:
//! it asks a pooled worker one question and reads the answer. That is the
//! cheap path, and it is what makes a standing wire affordable enough to leave
//! armed.
//!
//! **One pool per model, one worker each.** A pool worker is a persistent
//! `claude -p` process with a model fixed at spawn, so per-turn switching is
//! impossible and per-model pools are the honest shape. Workers spawn lazily,
//! so a machine whose wires never fire pays nothing at all.
//!
//! **The envelope is read the way the Observer reads its own.** The models are
//! the same models and they preface, double-wrap and self-correct the same
//! ways whichever job they are answering, so the span scanner is shared rather
//! than copied. Sharing a pure parse helper is not the Overview acting toward
//! work; it is two readers agreeing about what a model's last word looks like.
//!
//! **A missing or unreadable envelope is a failure, never a silence.** The
//! Observer's failure mode is to post nothing, because an invented post would
//! put words in the channel nobody wrote. A wire's is the opposite: it was
//! asked a question and the trip log has to say it did not answer, or a wire
//! that has been broken for a week looks exactly like a wire with nothing to
//! report.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::feeds::observer_wake::json_object_spans;
use crate::shared_agent::{AgentSpec, AgentWorkerSpawner, JobSpec, SharedAgentPool};

/// The one job a wire pool runs.
pub const WIRE_VERDICT: &str = "wire-verdict";

/// Ceiling on a verdict turn. Past it the trip fails rather than waiting: a
/// wire is background work, and a background question nobody is watching must
/// not hold a concurrency slot indefinitely.
const WIRE_VERDICT_TIMEOUT: Duration = Duration::from_secs(120);

/// Turnaround past which the call is marked slow. Nothing is cancelled — it
/// only makes drift readable in accumulated logs.
const WIRE_VERDICT_SLOW: Duration = Duration::from_secs(45);

/// The model a wire with no `model` column runs on.
pub const DEFAULT_WIRE_MODEL: &str = crate::feeds::overview_agent::DEFAULT_MODEL;

/// The verdict tier's whole contract.
///
/// Generic on purpose: every wire shares this job, and what makes one wire
/// different from another is its brief and its evidence, which arrive as the
/// turn's input. A per-wire job class would be a pool per wire, which is a
/// process per wire, for a question that takes one turn.
///
/// The two fields the wording works hardest on are `interest` and `outcome`.
/// `interest` is the only thing standing between a wire and a channel full of
/// nothing — a model asked to report will report, so it is told in as many
/// words that most firings are routine and that saying so is the answer, not a
/// failure to find something. `outcome` is `verdict` for this tier always,
/// because this tier has no hands; the value exists so one envelope shape
/// serves both tiers and the settle site can catch a model claiming work it
/// could not have done.
const WIRE_VERDICT_INSTRUCTIONS: &str = "\
WIRE VERDICT

A standing tripwire fired. You are given the wire's brief — what its author \
wants to know — and the evidence of the event that fired it. Answer the brief \
against that evidence and nothing else. You have no tools: do not ask for \
files, do not propose running anything, and do not speculate about what you \
would find if you looked.

Answer with bare JSON in exactly this shape and nothing around it:

{\"interest\": \"routine\", \"outcome\": \"verdict\", \"headline\": \"...\", \"refs\": []}

interest — `interesting` when a person would want to be told about this now, \
`routine` otherwise. Most firings are routine. A wire fires on a pattern, and \
the pattern occurring is ordinary; saying `routine` is the answer, not a \
failure to find something. Reserve `interesting` for what you would interrupt \
someone to say.

outcome — always `verdict` here. You have no hands, so you cannot have staged \
anything.

headline — one sentence, under 140 characters, saying what happened and what \
it means. Write it for someone who will read only this line. Name the file, \
the command, or the sha exactly; do not spend the sentence describing the \
wire.

refs — anything the headline names that a reader would want to open, as \
{\"kind\": \"file|commit|session|dash\", \"target\": \"...\"}. An empty list is \
fine and is the common case.";

/// The closing envelope, stated once (Spec S04).
///
/// Both tiers close with the same object and the same field meanings, so both
/// are shown the same words. A second wording drifting from this one would
/// give the work tier a contract the parser does not implement.
pub const ENVELOPE_CONTRACT: &str = "\
{\"interest\": \"routine|interesting\", \"outcome\": \"verdict|staged\", \"headline\": \"...\", \
\"refs\": [{\"kind\": \"file|commit|session|dash\", \"target\": \"...\"}]}";

const WIRE_AGENT_JOBS: &[JobSpec] = &[JobSpec {
    name: WIRE_VERDICT,
    timeout: WIRE_VERDICT_TIMEOUT,
    slow: Some(WIRE_VERDICT_SLOW),
    instructions: WIRE_VERDICT_INSTRUCTIONS,
}];

/// Build a pool pinned to one model. Spawns nothing — the first firing is what
/// spawns the worker, so an armed wire that never trips costs nothing.
///
/// One worker, because a wire's turn is not on anybody's critical path: a
/// second concurrent firing waiting a turn is cheaper than a second `claude`
/// process resident for the life of the instance.
pub fn build_wire_pool(model: &str, spawner: Arc<dyn AgentWorkerSpawner>) -> Arc<SharedAgentPool> {
    let model = model.to_string();
    SharedAgentPool::new(
        AgentSpec {
            name: "wire",
            model: Arc::new(move || model.clone()),
            jobs: WIRE_AGENT_JOBS,
            max_workers: 1,
        },
        spawner,
    )
}

/// The pools this instance has been asked for, one per model.
///
/// Lazy: a model named by no wire never gets a pool, and a pool that exists
/// has still spawned nothing until a wire on that model actually fires. The
/// map only grows, which is correct for a process whose wire set is small and
/// whose models are drawn from a handful of names.
pub struct WirePools {
    spawner: Arc<dyn AgentWorkerSpawner>,
    pools: Mutex<HashMap<String, Arc<SharedAgentPool>>>,
}

impl WirePools {
    pub fn new(spawner: Arc<dyn AgentWorkerSpawner>) -> Self {
        WirePools {
            spawner,
            pools: Mutex::new(HashMap::new()),
        }
    }

    /// The pool for a wire's model, building it on first ask. A wire with no
    /// model column runs on the default rather than on nothing.
    pub fn for_model(&self, model: Option<&str>) -> Arc<SharedAgentPool> {
        let model = model
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or(DEFAULT_WIRE_MODEL);
        let mut pools = self.pools.lock().expect("wire pools mutex");
        Arc::clone(
            pools
                .entry(model.to_string())
                .or_insert_with(|| build_wire_pool(model, Arc::clone(&self.spawner))),
        )
    }

    /// How many distinct models have a pool. Telemetry for the tests that pin
    /// the routing; nothing gates on it.
    #[cfg(test)]
    pub fn pool_count(&self) -> usize {
        self.pools.lock().expect("wire pools mutex").len()
    }
}

// MARK: - The envelope

/// What a trip is worth telling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Interest {
    Routine,
    Interesting,
}

impl Interest {
    pub const fn as_str(self) -> &'static str {
        match self {
            Interest::Routine => "routine",
            Interest::Interesting => "interesting",
        }
    }
}

/// What the trip left behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// An answer and nothing else.
    Verdict,
    /// Work waiting on a dash.
    Staged,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Outcome::Verdict => "verdict",
            Outcome::Staged => "staged",
        }
    }
}

/// One thing the headline names that a reader would want to open.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct WireRef {
    pub kind: String,
    pub target: String,
}

/// The ref kinds a wire may name. A kind outside this set is dropped rather
/// than repaired: a ref this build cannot resolve renders as an inert chip,
/// and an inert chip is worse than no chip.
const REF_KINDS: &[&str] = &["session", "commit", "file", "dash"];

/// What a wire's turn answered.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireEnvelope {
    pub interest: Interest,
    pub outcome: Outcome,
    pub headline: String,
    #[serde(default)]
    pub refs: Vec<WireRef>,
}

impl WireEnvelope {
    /// The refs worth keeping — every one whose kind this build can resolve,
    /// in the order the model wrote them.
    pub fn known_refs(&self) -> Vec<WireRef> {
        self.refs
            .iter()
            .filter(|r| REF_KINDS.contains(&r.kind.as_str()))
            .cloned()
            .collect()
    }
}

/// Read the answer's envelope.
///
/// The same tolerance discipline the Observer reads its own with, and for the
/// same reasons: a model prefaces its JSON with a sentence about four times in
/// ten, occasionally double-wraps it under the key the example showed, and
/// sometimes notices its own malformed envelope and writes a corrected one
/// after it. So every balanced top-level object is a candidate, they are tried
/// **newest first** — a correction supersedes what it corrects — and one level
/// of wrapping is peeled.
///
/// Finding an envelope, never repairing one: what parses is still the model's
/// own JSON, still whole, and still strict about its fields.
pub fn parse_wire_envelope(raw: &str) -> Option<WireEnvelope> {
    for span in json_object_spans(raw.trim()).into_iter().rev() {
        if let Some(envelope) = parse_one(span) {
            return Some(envelope);
        }
    }
    None
}

fn parse_one(span: &str) -> Option<WireEnvelope> {
    if let Ok(envelope) = serde_json::from_str::<WireEnvelope>(span) {
        return Some(envelope);
    }
    let value: serde_json::Value = serde_json::from_str(span).ok()?;
    let inner = value.as_object()?.get("verdict")?;
    serde_json::from_value::<WireEnvelope>(inner.clone()).ok()
}

/// The turn's input: what the wire wants to know, then what happened.
///
/// The brief first, because it is the question, and a model reading evidence
/// before it knows what is being asked answers the wrong thing. The evidence
/// verbatim, because for a failed edit it is the whole marker — the program,
/// the report, the counts — and the wire's entire value is that a diagnosing
/// reader gets all of it.
pub fn compose_input(brief: &str, evidence: &str) -> String {
    format!("BRIEF\n{}\n\nEVENT\n{}", brief.trim(), evidence.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(raw: &str) -> WireEnvelope {
        parse_wire_envelope(raw).expect("an envelope")
    }

    #[test]
    fn a_bare_envelope_parses_whole() {
        let e = envelope(
            r#"{"interest":"interesting","outcome":"verdict","headline":"a.rs went stale","refs":[{"kind":"file","target":"a.rs"}]}"#,
        );
        assert_eq!(e.interest, Interest::Interesting);
        assert_eq!(e.outcome, Outcome::Verdict);
        assert_eq!(e.headline, "a.rs went stale");
        assert_eq!(e.refs.len(), 1);
        assert_eq!(e.refs[0].kind, "file");
    }

    /// A model prefaces its JSON with a sentence of its own about four times
    /// in ten, and discarding those would throw away complete envelopes.
    #[test]
    fn a_preamble_is_a_wrapper_not_a_refusal() {
        let e = envelope(
            "Here is my read on it:\n\n{\"interest\":\"routine\",\"outcome\":\"verdict\",\"headline\":\"ordinary\"}",
        );
        assert_eq!(e.interest, Interest::Routine);
        assert_eq!(e.headline, "ordinary");
    }

    #[test]
    fn one_level_of_wrapping_is_peeled() {
        let e = envelope(
            r#"{"verdict":{"interest":"routine","outcome":"verdict","headline":"wrapped"}}"#,
        );
        assert_eq!(e.headline, "wrapped");
    }

    /// A model that notices its own malformed envelope writes a corrected one
    /// after it, so the last candidate is the model's final answer.
    #[test]
    fn a_correction_written_after_a_slip_is_the_answer() {
        let e = envelope(
            "{\"interest\":\"routine\"}\n\nLet me fix that JSON:\n\n{\"interest\":\"interesting\",\"outcome\":\"verdict\",\"headline\":\"the corrected one\"}",
        );
        assert_eq!(e.headline, "the corrected one");
    }

    /// A brace inside a string must not split the envelope in half — the same
    /// scanner property the Observer's own posts rest on.
    #[test]
    fn a_headline_quoting_a_brace_does_not_split_its_own_envelope() {
        let e = envelope(
            r#"{"interest":"routine","outcome":"verdict","headline":"the program wrote {\"ops\":[]} and stopped"}"#,
        );
        assert!(e.headline.contains("{\"ops\":[]}"));
    }

    #[test]
    fn an_unreadable_answer_is_no_envelope_at_all() {
        assert!(parse_wire_envelope("I could not tell.").is_none());
        assert!(parse_wire_envelope("{\"interest\":\"routine\"").is_none());
        assert!(
            parse_wire_envelope(r#"{"interest":"routine","outcome":"verdict"}"#).is_none(),
            "a missing headline is a missing field, not a blank one"
        );
        assert!(
            parse_wire_envelope(r#"{"interest":"maybe","outcome":"verdict","headline":"h"}"#)
                .is_none(),
            "an interest outside the two spellings is not read as either"
        );
        assert!(
            parse_wire_envelope(
                r#"{"interest":"routine","outcome":"verdict","headline":"h","mood":"blue"}"#
            )
            .is_none(),
            "an unknown field means the model answered a different question"
        );
    }

    /// A ref this build cannot resolve renders as an inert chip, so it is
    /// dropped rather than repaired — and dropping one costs the others
    /// nothing.
    #[test]
    fn an_unknown_ref_kind_is_dropped_and_the_rest_are_kept() {
        let e = envelope(
            r#"{"interest":"routine","outcome":"verdict","headline":"h","refs":[{"kind":"file","target":"a.rs"},{"kind":"portent","target":"raven"},{"kind":"dash","target":"wire-w-abc"}]}"#,
        );
        assert_eq!(e.refs.len(), 3, "the envelope keeps what the model wrote");
        let kept = e.known_refs();
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].target, "a.rs");
        assert_eq!(kept[1].kind, "dash");
    }

    #[test]
    fn the_turn_asks_the_brief_before_it_shows_the_evidence() {
        let input = compose_input("  diagnose it  ", "{\"class\":\"resolve\"}");
        assert_eq!(
            input,
            "BRIEF\ndiagnose it\n\nEVENT\n{\"class\":\"resolve\"}"
        );
        assert!(input.find("BRIEF").unwrap() < input.find("EVENT").unwrap());
    }

    #[test]
    fn a_pool_is_built_once_per_model_and_a_null_model_takes_the_default() {
        let spawner = crate::shared_agent::test_support::FakeSpawner::always(Ok("{}".to_string()));
        let pools = WirePools::new(spawner);

        let a = pools.for_model(Some("opus"));
        let b = pools.for_model(Some("opus"));
        assert!(Arc::ptr_eq(&a, &b), "one pool per model, not one per ask");
        assert_eq!(pools.pool_count(), 1);

        pools.for_model(Some("haiku"));
        assert_eq!(pools.pool_count(), 2);

        let default = pools.for_model(None);
        let blank = pools.for_model(Some("   "));
        assert!(
            Arc::ptr_eq(&default, &blank),
            "an absent model and a blank one are the same default"
        );
        assert_eq!(pools.pool_count(), 3);
    }

    #[tokio::test]
    async fn a_verdict_turn_carries_the_job_instructions_and_the_composed_input() {
        let spawner = crate::shared_agent::test_support::FakeSpawner::always(Ok(
            r#"{"interest":"routine","outcome":"verdict","headline":"nothing to see"}"#.to_string(),
        ));
        let pools = WirePools::new(Arc::clone(&spawner) as Arc<dyn AgentWorkerSpawner>);
        let pool = pools.for_model(Some("test-model"));

        let answer = pool
            .run(WIRE_VERDICT, compose_input("watch the edits", "the marker"))
            .await
            .expect("the pool answers");
        assert_eq!(
            parse_wire_envelope(&answer).unwrap().headline,
            "nothing to see"
        );

        let seen = spawner.turns_seen();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].starts_with("WIRE VERDICT"), "{}", seen[0]);
        assert!(seen[0].contains("BRIEF\nwatch the edits"), "{}", seen[0]);
        assert!(seen[0].contains("EVENT\nthe marker"), "{}", seen[0]);
    }
}
