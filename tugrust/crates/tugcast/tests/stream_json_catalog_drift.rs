//! Drift regression test + hand-rolled shape differ for the golden
//! stream-json catalog.
//!
//! # What this test does
//!
//! The `stream_json_catalog_drift_regression` test, when run against
//! real claude with `TUG_REAL_CLAUDE=1`, performs a full 35-probe
//! capture (using `common::catalog::execute_probe`), derives a live
//! schema via `derive_schema`, loads the committed golden schema at
//! `tests/fixtures/stream-json-catalog/v<version>/schema.json`, and
//! runs a hand-rolled shape differ ([D03]) against the two.
//!
//! If the differ finds any `Fail`-severity divergences, the test
//! panics with a structured bullet-list report naming the exact
//! event-type / field path / probe that drifted. `Warn`-severity
//! findings (new optional fields, new tool union arms, new probes)
//! are printed but do not fail the test — they exist to nudge the
//! maintainer to rerun the capture and commit the new baseline.
//!
//! # Why we need a differ that isn't a generic JSON diff
//!
//! Per [D03], generic JSON diffs don't know:
//! - required vs optional field semantics ([D08])
//! - polymorphic `tool_use_structured` keyed by tool_name ([D09])
//! - canonical probe event sequences that are order-sensitive but
//!   count-insensitive (streaming partial counts vary run-to-run)
//! - that a new optional field is a warn, not a fail
//!
//! So we roll our own, ~200 lines, fully unit-testable without ever
//! spawning real claude.
//!
//! # How to run the drift regression
//!
//! Default suite (differ unit tests only, no real claude):
//! ```ignore
//! cd tugrust && cargo nextest run -p tugcast
//! ```
//!
//! Real drift check against the committed v<version>/ baseline:
//! ```ignore
//! TUG_REAL_CLAUDE=1 cargo test --test stream_json_catalog_drift -- --ignored
//! ```
//!
//! Per [D13], the test fails hard if
//! `tests/fixtures/stream-json-catalog/v<version>/schema.json` does
//! not exist for the running claude version — there is no version
//! fallback. If you see "no golden schema for claude X.Y.Z", run the
//! capture binary to generate one, then review and commit.

#![allow(dead_code)]

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

// Shared imports — used by both the `#[cfg(test)] mod differ_tests`
// unit tests and the real-claude-gated drift regression test. Keep
// unconditional so the differ's 24 unit tests still run in standard
// `cargo nextest run` invocations.
use common::catalog::{
    EventShape, MODEL_OPTIONAL_EVENT_TYPES, Schema, canonical_type_sequence, shape_sequence,
};

// Real-claude-only imports — only used by
// `stream_json_catalog_drift_regression` and its helper
// `schema_path_for_version`. Gated so standard runs don't trigger
// unused-import warnings when the feature is off. See this file's
// feature documentation in `Cargo.toml`.
#[cfg(feature = "real-claude-tests")]
use common::catalog::{
    self, capture_with_stability, derive_schema, extract_version, stability_runs,
};
#[cfg(feature = "real-claude-tests")]
use common::real_claude_enabled;

// -----------------------------------------------------------------------
// Diff report types — [D03]
// -----------------------------------------------------------------------

/// Severity of a single diff finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// The golden and current schemas differ in a way that breaks the
    /// contract. Any `Fail` finding in the report fails the test.
    Fail,
    /// The current capture introduces something new that does not
    /// break the contract (e.g. a new optional field). Surfaced for
    /// the maintainer but does not fail the test.
    Warn,
}

/// Classification of how two schemas diverge at one specific location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailureKind {
    /// Event type present in golden but absent from current.
    MissingEventType { event_type: String },
    /// Event type present in current but absent from golden.
    NewEventType { event_type: String },
    /// A required field is missing from the current event shape.
    MissingRequiredField { path: Vec<String> },
    /// A field's type descriptor differs between golden and current.
    TypeMismatch {
        path: Vec<String>,
        golden: String,
        current: String,
    },
    /// A field appears in current that was not in golden.
    NewField { path: Vec<String>, ty: String },
    /// A `tool_use_structured` union arm present in golden but absent
    /// from current. [D09]
    RemovedToolUseUnion { tool_name: String },
    /// A `tool_use_structured` union arm present in current but absent
    /// from golden. [D09]
    NewToolUseUnion { tool_name: String },
    /// A probe's canonical sequence lost events (golden had them,
    /// current does not). Per [D08], removing a required slot fails.
    RemovedSequenceSlots {
        probe_name: String,
        slots: Vec<String>,
    },
    /// A probe's canonical sequence gained events (current has them,
    /// golden did not). Per [D08], adding a slot warns.
    NewSequenceSlots {
        probe_name: String,
        slots: Vec<String>,
    },
    /// A probe's *shape sequence* has the same events as golden but in
    /// a genuine transposition — neither sequence is a subsequence of
    /// the other. The shape sequence (`shape_sequence`) drops
    /// position-insensitive interstitials and collapses tool-activity
    /// runs, so a flagged reorder is a transposition of the turn
    /// skeleton itself (e.g. `cost_update` before `assistant_text`),
    /// not agent tool-call-count variance. `golden` / `current` are
    /// the reduced shape sequences that were compared.
    ReorderedSequence {
        probe_name: String,
        golden: Vec<String>,
        current: Vec<String>,
    },
    /// A probe's shape sequence differs from golden only by the
    /// insertion or deletion of an event type that still appears
    /// elsewhere — one sequence is a subsequence of the other. This is
    /// optional interstitial-event variance (e.g. `thinking_text` the
    /// model emits on some runs but not others), not a transposition,
    /// so it warns rather than fails.
    OptionalSequenceVariance {
        probe_name: String,
        golden: Vec<String>,
        current: Vec<String>,
    },
    /// A probe that exists in golden is missing from current.
    MissingProbe { probe_name: String },
    /// A probe that exists in current is missing from golden.
    NewProbe { probe_name: String },
    /// Depth limit exceeded ([D12]). **Scope cut from the tugplan deep
    /// dive.** The deep dive described a recursive object-field walk
    /// up to a depth of 8 that would emit this variant on overflow.
    /// The actual differ uses `describe_value`'s flat "object" shape
    /// descriptor — any nested object compares equal to any other
    /// nested object of the same top-level type — which has been
    /// sufficient for 2.1.104 → 2.1.105 drift detection. Implementing
    /// the recursive walk pre-emptively is YAGNI; land it when
    /// `CodeSessionStore`'s reducer actually reaches into a nested
    /// field and needs the extra depth pinned. This variant is retained
    /// so (a) future recursion has a pre-named failure kind and (b)
    /// the report formatter in `format_kind` doesn't need to change
    /// when the walk lands.
    DepthLimitExceeded { path: Vec<String> },
}

/// A single finding produced by `diff_schemas`.
#[derive(Debug, Clone)]
pub struct Finding {
    pub severity: Severity,
    pub kind: FailureKind,
}

/// The full diff report: every `Fail` and `Warn` finding in the order
/// they were discovered.
#[derive(Debug, Default, Clone)]
pub struct DiffReport {
    pub findings: Vec<Finding>,
}

impl DiffReport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn fail(&mut self, kind: FailureKind) {
        self.findings.push(Finding {
            severity: Severity::Fail,
            kind,
        });
    }

    pub fn warn(&mut self, kind: FailureKind) {
        self.findings.push(Finding {
            severity: Severity::Warn,
            kind,
        });
    }

    pub fn has_failures(&self) -> bool {
        self.findings.iter().any(|f| f.severity == Severity::Fail)
    }

    pub fn failure_count(&self) -> usize {
        self.findings
            .iter()
            .filter(|f| f.severity == Severity::Fail)
            .count()
    }

    pub fn warn_count(&self) -> usize {
        self.findings
            .iter()
            .filter(|f| f.severity == Severity::Warn)
            .count()
    }

    /// Render the report as a structured bullet list suitable for a
    /// panic message.
    pub fn format_report(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "Drift report: {} failure(s), {} warning(s)\n",
            self.failure_count(),
            self.warn_count(),
        ));
        for finding in &self.findings {
            let tag = match finding.severity {
                Severity::Fail => "FAIL",
                Severity::Warn => "WARN",
            };
            out.push_str(&format!("  {tag} {}\n", format_kind(&finding.kind)));
        }
        out
    }
}

fn format_kind(kind: &FailureKind) -> String {
    match kind {
        FailureKind::MissingEventType { event_type } => {
            format!("MissingEventType: {event_type}")
        }
        FailureKind::NewEventType { event_type } => {
            format!("NewEventType: {event_type}")
        }
        FailureKind::MissingRequiredField { path } => {
            format!("MissingRequiredField: {}", path.join("."))
        }
        FailureKind::TypeMismatch {
            path,
            golden,
            current,
        } => {
            format!(
                "TypeMismatch: {} (golden={golden}, current={current})",
                path.join("."),
            )
        }
        FailureKind::NewField { path, ty } => {
            format!("NewField: {} (ty={ty})", path.join("."))
        }
        FailureKind::RemovedToolUseUnion { tool_name } => {
            format!("RemovedToolUseUnion: {tool_name}")
        }
        FailureKind::NewToolUseUnion { tool_name } => {
            format!("NewToolUseUnion: {tool_name}")
        }
        FailureKind::RemovedSequenceSlots { probe_name, slots } => {
            format!("RemovedSequenceSlots: {probe_name} lost={slots:?}")
        }
        FailureKind::NewSequenceSlots { probe_name, slots } => {
            format!("NewSequenceSlots: {probe_name} added={slots:?}")
        }
        FailureKind::ReorderedSequence {
            probe_name,
            golden,
            current,
        } => {
            format!("ReorderedSequence: {probe_name} golden={golden:?} current={current:?}")
        }
        FailureKind::OptionalSequenceVariance {
            probe_name,
            golden,
            current,
        } => {
            format!("OptionalSequenceVariance: {probe_name} golden={golden:?} current={current:?}")
        }
        FailureKind::MissingProbe { probe_name } => {
            format!("MissingProbe: {probe_name}")
        }
        FailureKind::NewProbe { probe_name } => {
            format!("NewProbe: {probe_name}")
        }
        FailureKind::DepthLimitExceeded { path } => {
            format!("DepthLimitExceeded: {}", path.join("."))
        }
    }
}

// -----------------------------------------------------------------------
// load_schema — parse schema.json per
// -----------------------------------------------------------------------

/// Parse a committed `schema.json` into a [`Schema`] struct. Fails
/// hard if the file does not exist (per [D13] — no version fallback)
/// or if the JSON is malformed. The return type is a plain `Result`
/// with stringified errors so the caller can `.expect(...)` with a
/// meaningful message.
pub fn load_schema(path: &Path) -> Result<Schema, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?;

    let claude_version = value
        .get("claude_version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{}: missing claude_version", path.display()))?
        .to_string();

    let mut schema = Schema {
        claude_version,
        ..Default::default()
    };

    if let Some(event_types) = value.get("event_types").and_then(|v| v.as_object()) {
        for (et_name, et_value) in event_types {
            // Polymorphic tool_use_structured: route through by_tool_name
            // per [D09]. Each tool_name gets its own EventShape.
            if et_name == "tool_use_structured" {
                if let Some(by_tool) = et_value.get("by_tool_name").and_then(|v| v.as_object()) {
                    for (tool_name, shape_value) in by_tool {
                        let shape = parse_event_shape(shape_value);
                        schema
                            .tool_use_structured_by_tool
                            .insert(tool_name.clone(), shape);
                    }
                }
                continue;
            }
            let shape = parse_event_shape(et_value);
            schema.event_types.insert(et_name.clone(), shape);
        }
    }

    if let Some(probe_sequences) = value.get("probe_sequences").and_then(|v| v.as_object()) {
        for (probe_name, entry) in probe_sequences {
            let seq: Vec<String> = entry
                .get("required_sequence")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            schema.probe_sequences.insert(probe_name.clone(), seq);
        }
    }

    Ok(schema)
}

fn parse_event_shape(value: &Value) -> EventShape {
    let mut shape = EventShape::default();
    if let Some(req) = value.get("required_fields").and_then(|v| v.as_object()) {
        for (k, v) in req {
            shape
                .required_fields
                .insert(k.clone(), v.as_str().unwrap_or("unknown").to_string());
        }
    }
    if let Some(opt) = value.get("optional_fields").and_then(|v| v.as_object()) {
        for (k, v) in opt {
            shape
                .optional_fields
                .insert(k.clone(), v.as_str().unwrap_or("unknown").to_string());
        }
    }
    shape
}

// -----------------------------------------------------------------------
// diff_schemas — core differ per #deep-shape-differ
// -----------------------------------------------------------------------

/// Hand-rolled shape differ. Compares a golden [`Schema`] against a
/// freshly-derived current [`Schema`] and produces a [`DiffReport`]
/// covering event-type shape drift, polymorphic tool_use_structured
/// union drift, and per-probe canonical sequence drift.
pub fn diff_schemas(golden: &Schema, current: &Schema) -> DiffReport {
    let mut report = DiffReport::new();

    // Event types present in golden but absent from current → fail,
    // UNLESS the type is model-optional (its presence is per-turn model
    // behavior, not a protocol contract — see `MODEL_OPTIONAL_EVENT_TYPES`),
    // in which case its absence is benign variance, not drift.
    // Event types present in both → diff their shapes (the shape IS
    // pinned even for model-optional types, whenever a capture carries
    // one).
    for (et, shape_g) in &golden.event_types {
        match current.event_types.get(et) {
            None => {
                if !MODEL_OPTIONAL_EVENT_TYPES.contains(&et.as_str()) {
                    report.fail(FailureKind::MissingEventType {
                        event_type: et.clone(),
                    });
                }
            }
            Some(shape_c) => {
                diff_event_shape(shape_g, shape_c, std::slice::from_ref(et), &mut report);
            }
        }
    }
    // Event types present in current but absent from golden → warn,
    // UNLESS model-optional (a thinking turn the golden capture happened
    // not to elicit — benign, symmetric with the absence case above).
    for et in current.event_types.keys() {
        if !golden.event_types.contains_key(et)
            && !MODEL_OPTIONAL_EVENT_TYPES.contains(&et.as_str())
        {
            report.warn(FailureKind::NewEventType {
                event_type: et.clone(),
            });
        }
    }

    // Polymorphic tool_use_structured [D09]. Union arm missing from
    // current is a fail; new arm in current is a warn.
    for (tool_name, shape_g) in &golden.tool_use_structured_by_tool {
        match current.tool_use_structured_by_tool.get(tool_name) {
            None => report.fail(FailureKind::RemovedToolUseUnion {
                tool_name: tool_name.clone(),
            }),
            Some(shape_c) => {
                let path = vec![
                    "tool_use_structured".to_string(),
                    format!("tool_name={tool_name}"),
                ];
                diff_event_shape(shape_g, shape_c, &path, &mut report);
            }
        }
    }
    for tool_name in current.tool_use_structured_by_tool.keys() {
        if !golden.tool_use_structured_by_tool.contains_key(tool_name) {
            report.warn(FailureKind::NewToolUseUnion {
                tool_name: tool_name.clone(),
            });
        }
    }

    // Per-probe canonical sequence comparison.
    for (probe_name, seq_g) in &golden.probe_sequences {
        match current.probe_sequences.get(probe_name) {
            None => report.fail(FailureKind::MissingProbe {
                probe_name: probe_name.clone(),
            }),
            Some(seq_c) => diff_probe_sequence(probe_name, seq_g, seq_c, &mut report),
        }
    }
    for probe_name in current.probe_sequences.keys() {
        if !golden.probe_sequences.contains_key(probe_name) {
            report.warn(FailureKind::NewProbe {
                probe_name: probe_name.clone(),
            });
        }
    }

    report
}

fn diff_event_shape(
    golden: &EventShape,
    current: &EventShape,
    path: &[String],
    report: &mut DiffReport,
) {
    // Every golden required field must exist in current with the same
    // type. Accept current-optional as satisfying golden-required with
    // a TypeMismatch fail if the types differ — this way, a required
    // field demoted to optional still has its type pinned.
    for (field, ty_g) in &golden.required_fields {
        let ty_c = current
            .required_fields
            .get(field)
            .or_else(|| current.optional_fields.get(field));
        match ty_c {
            None => {
                let mut fpath = path.to_vec();
                fpath.push(field.clone());
                report.fail(FailureKind::MissingRequiredField { path: fpath });
            }
            Some(ty_c_str) if ty_c_str != ty_g => {
                let mut fpath = path.to_vec();
                fpath.push(field.clone());
                report.fail(FailureKind::TypeMismatch {
                    path: fpath,
                    golden: ty_g.clone(),
                    current: ty_c_str.clone(),
                });
            }
            Some(_) => {}
        }
    }

    // Golden optional fields: if present in current, types must match.
    // If absent, that's fine — it was already optional.
    for (field, ty_g) in &golden.optional_fields {
        let ty_c = current
            .required_fields
            .get(field)
            .or_else(|| current.optional_fields.get(field));
        if let Some(ty_c_str) = ty_c {
            if ty_c_str != ty_g {
                let mut fpath = path.to_vec();
                fpath.push(field.clone());
                report.fail(FailureKind::TypeMismatch {
                    path: fpath,
                    golden: ty_g.clone(),
                    current: ty_c_str.clone(),
                });
            }
        }
    }

    // Fields in current that aren't in golden → warn. We iterate
    // required and optional both; either is a new field from the
    // golden's perspective.
    for (field, ty) in current
        .required_fields
        .iter()
        .chain(current.optional_fields.iter())
    {
        if !golden.required_fields.contains_key(field)
            && !golden.optional_fields.contains_key(field)
        {
            let mut fpath = path.to_vec();
            fpath.push(field.clone());
            report.warn(FailureKind::NewField {
                path: fpath,
                ty: ty.clone(),
            });
        }
    }
}

/// Returns `true` if `needle` is a (not necessarily contiguous)
/// subsequence of `haystack` — every element of `needle` appears in
/// `haystack` in the same relative order.
fn is_subsequence(needle: &[String], haystack: &[String]) -> bool {
    let mut hay = haystack.iter();
    needle.iter().all(|n| hay.any(|h| h == n))
}

fn diff_probe_sequence(
    probe_name: &str,
    golden: &[String],
    current: &[String],
    report: &mut DiffReport,
) {
    // Strip model-optional event types from BOTH sides before any
    // comparison. Their presence is per-turn model behavior, not a
    // protocol contract (see `MODEL_OPTIONAL_EVENT_TYPES` — `thinking_text`
    // is the canonical case), so their appearance OR absence is run-to-run
    // variance that must contribute to no finding: not the set diff, not
    // the order check. Their field shape is pinned separately by
    // `diff_event_shape`. Stripping up front (rather than the prior
    // asymmetric tolerated-absence partition + `g_set_norm` normalization)
    // makes the tolerance symmetric and the rest of the function simple.
    let golden: Vec<String> = golden
        .iter()
        .filter(|t| !MODEL_OPTIONAL_EVENT_TYPES.contains(&t.as_str()))
        .cloned()
        .collect();
    let current: Vec<String> = current
        .iter()
        .filter(|t| !MODEL_OPTIONAL_EVENT_TYPES.contains(&t.as_str()))
        .cloned()
        .collect();

    // ---- Event-type *set* comparison — strict. ----
    // Computed on the consecutive-collapsed canonical, where every
    // event type stays individually visible: a probe that loses
    // `tool_use_structured`, or gains a brand-new event type, is
    // caught here regardless of the order-comparison reduction below.
    let g_canon = canonical_type_sequence(&golden);
    let c_canon = canonical_type_sequence(&current);

    let g_set: BTreeSet<String> = g_canon.iter().cloned().collect();
    let c_set: BTreeSet<String> = c_canon.iter().cloned().collect();

    let removed: Vec<String> = g_set.difference(&c_set).cloned().collect();
    let added: Vec<String> = c_set.difference(&g_set).cloned().collect();

    if !removed.is_empty() {
        report.fail(FailureKind::RemovedSequenceSlots {
            probe_name: probe_name.to_string(),
            slots: removed,
        });
    }
    if !added.is_empty() {
        report.warn(FailureKind::NewSequenceSlots {
            probe_name: probe_name.to_string(),
            slots: added,
        });
    }

    // ---- Event-type *order* comparison — supple. ----
    // Runs on the structural shape reduction (`shape_sequence`):
    // position-insensitive interstitials dropped, contiguous
    // tool-activity runs collapsed. Agent tool-call-count and
    // interleaving variance is therefore benign by construction; only
    // a genuine transposition of the turn skeleton fails. Gated on the
    // event-type sets matching — if they differ, the set drift above
    // already covers it and a reorder finding would be redundant.
    if g_set == c_set {
        let g_shape = shape_sequence(&golden);
        let c_shape = shape_sequence(&current);
        if g_shape != c_shape {
            if is_subsequence(&c_shape, &g_shape) || is_subsequence(&g_shape, &c_shape) {
                // One shape is the other with an in-set event type
                // inserted/deleted at a repeated (non-consecutive)
                // position — optional interstitial-event variance, not
                // a transposition. Genuine reorders, where neither
                // shape is a subsequence of the other, still fail.
                report.warn(FailureKind::OptionalSequenceVariance {
                    probe_name: probe_name.to_string(),
                    golden: g_shape,
                    current: c_shape,
                });
            } else {
                report.fail(FailureKind::ReorderedSequence {
                    probe_name: probe_name.to_string(),
                    golden: g_shape,
                    current: c_shape,
                });
            }
        }
    }
}

// -----------------------------------------------------------------------
// Fixture path resolution — [D13] no-fallback rule
// -----------------------------------------------------------------------

#[cfg(feature = "real-claude-tests")]
fn schema_path_for_version(version: &str) -> PathBuf {
    catalog::fixture_root()
        .join(format!("v{version}"))
        .join("schema.json")
}

// -----------------------------------------------------------------------
// The one real-claude test — drift regression entry point
//
// Gated on `--features real-claude-tests` so `cargo nextest run
// -p tugcast` does not enumerate it in standard runs. See this file's
// feature documentation in `Cargo.toml`.
// -----------------------------------------------------------------------

/// The pin on the sentence Claude Code answers a moved Bash call with. The
/// golden normalizes every result's text to its length, so the fixture holds
/// none of the words the move recognizer (`tugcore::moved_call`) reads; the
/// live capture is the one place the two meet. A probe that did not run — a
/// filter that left it out, a stall the capture already reports as its own
/// failure — pins nothing.
#[cfg(feature = "real-claude-tests")]
fn pin_moved_call_sentence(captures: &[common::catalog::CapturedProbe]) {
    let Some(probe) = captures
        .iter()
        .find(|p| p.name == "test-48-bash-timeout-move")
    else {
        return;
    };
    if !matches!(probe.status, common::probes::ProbeStatus::Passed) {
        return;
    }
    let recognized = probe
        .tool_results
        .iter()
        .any(|text| tugcore::moved_call::parse_moved_call(text).is_some());
    assert!(
        recognized,
        "test-48-bash-timeout-move: the move recognizer read no task id and output \
         path off the call's tool_result — the sentence's shape has changed, and a \
         moved call would go back to the dark card: {:?}",
        probe.tool_results
    );
}

#[cfg(feature = "real-claude-tests")]
#[tokio::test]
#[ignore]
async fn stream_json_catalog_drift_regression() {
    if !real_claude_enabled() {
        eprintln!("skipping stream_json_catalog_drift_regression: TUG_REAL_CLAUDE not set");
        return;
    }

    // Pre-flight refusal — same policy as `capture_all_probes`. Refuse
    // to run if any subscription-overriding auth env var is set. See
    // `catalog::AUTH_ENV_VARS` for the list.
    catalog::refuse_if_auth_env_set();

    let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    let project_dir = project_dir
        .canonicalize()
        .expect("canonicalize project dir");

    let tmp = std::env::temp_dir().join(format!("tugcast-drift-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("create tmp dir");
    let _tmp_guard = TmpDirGuard(tmp.clone());

    // Drift test always runs with a single stability run (n=1). The
    // stability pass happens in the capture binary; the drift test's
    // job is to flag shape drift vs the committed baseline, and a
    // single run is sufficient for that (repeated runs wouldn't find
    // a divergence that the baseline already wouldn't). Honors
    // TUG_STABILITY if explicitly set, otherwise defaults to 1.
    let stability = stability_runs();
    let captures = capture_with_stability(stability, &tmp, &project_dir).await;
    pin_moved_call_sentence(&captures);

    let version =
        extract_version(&captures).expect("no system_metadata version found — aborting per [D11]");

    let golden_path = schema_path_for_version(&version);
    if !golden_path.exists() {
        panic!(
            "no golden schema at {} — per [D13] there is no version \
             fallback. Run the capture binary to generate a baseline \
             for claude {version}, review the fixtures, then commit.",
            golden_path.display()
        );
    }

    let golden = load_schema(&golden_path)
        .unwrap_or_else(|e| panic!("load_schema({}): {e}", golden_path.display()));
    let current = derive_schema(&version, &captures);

    let report = diff_schemas(&golden, &current);

    // Always dump the full report, warnings included. The warnings
    // aren't a test failure but they're the signal that the golden
    // baseline is drifting toward needing a refresh.
    eprintln!("{}", report.format_report());

    if report.has_failures() {
        panic!(
            "stream-json catalog drift regression: {} fail-severity \
             finding(s) against golden schema v{version}. See stderr \
             for the full structured report.",
            report.failure_count(),
        );
    }

    eprintln!(
        "stream_json_catalog_drift_regression: clean ({} warning(s), 0 failures)",
        report.warn_count()
    );
}

/// RAII guard that `remove_dir_all`s its path on drop.
#[cfg(feature = "real-claude-tests")]
struct TmpDirGuard(PathBuf);
#[cfg(feature = "real-claude-tests")]
impl Drop for TmpDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// -----------------------------------------------------------------------
// Differ unit tests — run in default nextest, no real claude
// -----------------------------------------------------------------------

#[cfg(test)]
mod differ_tests {
    use super::*;

    // Helpers

    fn event_shape(required: &[(&str, &str)], optional: &[(&str, &str)]) -> EventShape {
        let mut shape = EventShape::default();
        for (k, v) in required {
            shape.required_fields.insert(k.to_string(), v.to_string());
        }
        for (k, v) in optional {
            shape.optional_fields.insert(k.to_string(), v.to_string());
        }
        shape
    }

    fn schema_with_event(event_type: &str, shape: EventShape) -> Schema {
        let mut schema = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        schema.event_types.insert(event_type.to_string(), shape);
        schema
    }

    fn schema_with_probe_seq(probe_name: &str, seq: &[&str]) -> Schema {
        let mut schema = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        schema.probe_sequences.insert(
            probe_name.to_string(),
            seq.iter().map(|s| s.to_string()).collect(),
        );
        schema
    }

    fn assert_fail_kind(report: &DiffReport, predicate: impl Fn(&FailureKind) -> bool) {
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.severity == Severity::Fail && predicate(&f.kind)),
            "expected a Fail finding matching predicate in report: {}",
            report.format_report(),
        );
    }

    fn assert_warn_kind(report: &DiffReport, predicate: impl Fn(&FailureKind) -> bool) {
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.severity == Severity::Warn && predicate(&f.kind)),
            "expected a Warn finding matching predicate in report: {}",
            report.format_report(),
        );
    }

    // ---- 1. Identical shapes → empty report

    #[test]
    fn identical_schemas_produce_empty_report() {
        let shape = event_shape(&[("type", "string"), ("session_id", "string")], &[]);
        let golden = schema_with_event("session_init", shape.clone());
        let current = schema_with_event("session_init", shape);
        let report = diff_schemas(&golden, &current);
        assert_eq!(report.findings.len(), 0);
        assert!(!report.has_failures());
    }

    // ---- 2. New optional field in current → warn only

    #[test]
    fn new_optional_field_warns() {
        let golden = schema_with_event(
            "system_metadata",
            event_shape(&[("type", "string"), ("model", "string")], &[]),
        );
        let current = schema_with_event(
            "system_metadata",
            event_shape(
                &[("type", "string"), ("model", "string")],
                &[("inference_geo", "string")],
            ),
        );
        let report = diff_schemas(&golden, &current);
        assert!(!report.has_failures());
        assert_warn_kind(
            &report,
            |k| matches!(k, FailureKind::NewField { path, .. } if path.last() == Some(&"inference_geo".to_string())),
        );
    }

    // ---- 3. Removed required field → fail

    #[test]
    fn removed_required_field_fails() {
        let golden = schema_with_event(
            "session_init",
            event_shape(
                &[
                    ("type", "string"),
                    ("session_id", "string"),
                    ("ipc_version", "integer"),
                ],
                &[],
            ),
        );
        let current = schema_with_event(
            "session_init",
            event_shape(&[("type", "string"), ("session_id", "string")], &[]),
        );
        let report = diff_schemas(&golden, &current);
        assert!(report.has_failures());
        assert_fail_kind(
            &report,
            |k| matches!(k, FailureKind::MissingRequiredField { path } if path.last() == Some(&"ipc_version".to_string())),
        );
    }

    // ---- 4. Type change → fail

    #[test]
    fn type_change_string_to_integer_fails() {
        let golden =
            schema_with_event("cost_update", event_shape(&[("num_turns", "integer")], &[]));
        let current =
            schema_with_event("cost_update", event_shape(&[("num_turns", "string")], &[]));
        let report = diff_schemas(&golden, &current);
        assert_fail_kind(&report, |k| {
            matches!(k, FailureKind::TypeMismatch { path, golden, current }
                if path.last() == Some(&"num_turns".to_string())
                && golden == "integer"
                && current == "string")
        });
    }

    // ---- 5. Event type missing in current → fail

    #[test]
    fn missing_event_type_in_current_fails() {
        let mut golden = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        golden.event_types.insert(
            "assistant_text".into(),
            event_shape(&[("type", "string")], &[]),
        );
        golden.event_types.insert(
            "turn_complete".into(),
            event_shape(&[("type", "string")], &[]),
        );

        let mut current = Schema {
            claude_version: "2.1.105".into(),
            ..Default::default()
        };
        current.event_types.insert(
            "turn_complete".into(),
            event_shape(&[("type", "string")], &[]),
        );

        let report = diff_schemas(&golden, &current);
        assert_fail_kind(
            &report,
            |k| matches!(k, FailureKind::MissingEventType { event_type } if event_type == "assistant_text"),
        );
    }

    // ---- 6. Event type new in current → warn

    #[test]
    fn new_event_type_in_current_warns() {
        let golden = schema_with_event("session_init", event_shape(&[("type", "string")], &[]));
        let mut current =
            schema_with_event("session_init", event_shape(&[("type", "string")], &[]));
        current.event_types.insert(
            "new_boundary".into(),
            event_shape(&[("type", "string")], &[]),
        );

        let report = diff_schemas(&golden, &current);
        assert!(!report.has_failures());
        assert_warn_kind(
            &report,
            |k| matches!(k, FailureKind::NewEventType { event_type } if event_type == "new_boundary"),
        );
    }

    // ---- 7. Required field demoted to optional with same type → ok

    #[test]
    fn required_to_optional_same_type_is_ok() {
        // A field that was required in golden but is optional in
        // current (with the same type) is NOT a failure: it means the
        // field is still available, just not always populated.
        let golden = schema_with_event(
            "tool_result",
            event_shape(&[("parent_tool_use_id", "string")], &[]),
        );
        let current = schema_with_event(
            "tool_result",
            event_shape(&[], &[("parent_tool_use_id", "string")]),
        );
        let report = diff_schemas(&golden, &current);
        assert!(!report.has_failures());
    }

    // ---- 8. Required field demoted with type change → fail

    #[test]
    fn required_to_optional_type_change_fails() {
        let golden = schema_with_event("tool_result", event_shape(&[("output", "string")], &[]));
        let current = schema_with_event("tool_result", event_shape(&[], &[("output", "integer")]));
        let report = diff_schemas(&golden, &current);
        assert_fail_kind(&report, |k| matches!(k, FailureKind::TypeMismatch { .. }));
    }

    // ---- 9. Polymorphic tool_use_structured: new tool_name → warn

    #[test]
    fn new_tool_use_union_arm_warns() {
        let mut golden = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        golden.tool_use_structured_by_tool.insert(
            "Read".into(),
            event_shape(&[("tool_use_id", "string")], &[]),
        );

        let mut current = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        current.tool_use_structured_by_tool.insert(
            "Read".into(),
            event_shape(&[("tool_use_id", "string")], &[]),
        );
        current.tool_use_structured_by_tool.insert(
            "Glob".into(),
            event_shape(&[("tool_use_id", "string")], &[]),
        );

        let report = diff_schemas(&golden, &current);
        assert!(!report.has_failures());
        assert_warn_kind(
            &report,
            |k| matches!(k, FailureKind::NewToolUseUnion { tool_name } if tool_name == "Glob"),
        );
    }

    // ---- 10. Polymorphic tool_use_structured: removed tool_name → fail

    #[test]
    fn removed_tool_use_union_arm_fails() {
        let mut golden = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        golden.tool_use_structured_by_tool.insert(
            "Read".into(),
            event_shape(&[("tool_use_id", "string")], &[]),
        );
        golden.tool_use_structured_by_tool.insert(
            "Bash".into(),
            event_shape(&[("tool_use_id", "string")], &[]),
        );

        let mut current = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        current.tool_use_structured_by_tool.insert(
            "Read".into(),
            event_shape(&[("tool_use_id", "string")], &[]),
        );

        let report = diff_schemas(&golden, &current);
        assert_fail_kind(
            &report,
            |k| matches!(k, FailureKind::RemovedToolUseUnion { tool_name } if tool_name == "Bash"),
        );
    }

    // ---- 11. Tool_use_structured union arm shape diff → fail at tool_name path

    #[test]
    fn tool_use_union_arm_shape_diff_fails_at_tool_name_path() {
        let mut golden = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        golden.tool_use_structured_by_tool.insert(
            "Read".into(),
            event_shape(
                &[("tool_use_id", "string"), ("structured_result", "object")],
                &[],
            ),
        );

        let mut current = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        // structured_result demoted to missing — shape drift
        current.tool_use_structured_by_tool.insert(
            "Read".into(),
            event_shape(&[("tool_use_id", "string")], &[]),
        );

        let report = diff_schemas(&golden, &current);
        assert_fail_kind(&report, |k| {
            matches!(k, FailureKind::MissingRequiredField { path }
                if path.contains(&"tool_use_structured".to_string())
                && path.contains(&"structured_result".to_string()))
        });
    }

    // ---- 12. Probe sequence: added optional slot → warn

    #[test]
    fn probe_sequence_added_slot_warns() {
        // Golden sequence:  [system_metadata, assistant_text, turn_complete]
        // Current sequence: [system_metadata, compact_boundary, assistant_text, turn_complete]
        // The new `compact_boundary` is a warn (added slot). A genuine
        // new (non-model-optional) event type must surface — model-optional
        // types like `thinking_text` are stripped and would NOT (that
        // symmetry is covered by `probe_sequence_model_optional_presence_is_silent`).
        let golden = schema_with_probe_seq(
            "test-01",
            &["system_metadata", "assistant_text", "turn_complete"],
        );
        let current = schema_with_probe_seq(
            "test-01",
            &[
                "system_metadata",
                "compact_boundary",
                "assistant_text",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert_warn_kind(&report, |k| {
            matches!(k, FailureKind::NewSequenceSlots { probe_name, slots }
                if probe_name == "test-01"
                && slots.contains(&"compact_boundary".to_string()))
        });
        assert!(!report.has_failures());
    }

    // ---- 13. Probe sequence: removed required slot → fail

    #[test]
    fn probe_sequence_removed_slot_fails() {
        // `cost_update` is one of the four turn-skeleton bookends (per
        // README "Indicators that an event is still REQUIRED"); its
        // disappearance is real drift and must fail. `thinking_text`
        // can't be used as the removed stand-in any more — it's in
        // `TOLERATED_ABSENCE_EVENT_TYPES` and demotes to a warn (see
        // [`probe_sequence_tolerated_absence_warns`]).
        let golden = schema_with_probe_seq(
            "test-01",
            &[
                "system_metadata",
                "assistant_text",
                "cost_update",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-01",
            &["system_metadata", "assistant_text", "turn_complete"],
        );
        let report = diff_schemas(&golden, &current);
        assert_fail_kind(&report, |k| {
            matches!(k, FailureKind::RemovedSequenceSlots { probe_name, slots }
                if probe_name == "test-01"
                && slots.contains(&"cost_update".to_string()))
        });
    }

    // ---- 13b. Probe sequence: model-optional event type → no finding,
    //     either direction
    //
    // `thinking_text` is in `MODEL_OPTIONAL_EVENT_TYPES` (see
    // `common::catalog`): claude chooses whether to think per turn, and
    // the choice flips run-to-run on the same prompt — so neither its
    // appearance nor its absence is drift. The differ strips it from the
    // sequence comparison entirely: a thinking_text-only difference
    // produces NO finding (no fail AND no warn), symmetric in both
    // directions. A WARN that can never be resolved by a refresh would
    // be noise, not signal.

    #[test]
    fn probe_sequence_model_optional_absence_is_silent() {
        let golden = schema_with_probe_seq(
            "test-01",
            &[
                "system_metadata",
                "thinking_text",
                "assistant_text",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-01",
            &["system_metadata", "assistant_text", "turn_complete"],
        );
        let report = diff_schemas(&golden, &current);
        assert_eq!(
            report.findings.len(),
            0,
            "a model-optional (thinking_text) absence must produce no finding, got: {}",
            report.format_report(),
        );
    }

    #[test]
    fn probe_sequence_model_optional_presence_is_silent() {
        // The symmetric case: golden lacked thinking_text (the capture
        // run didn't elicit it), current has it. Still no finding.
        let golden = schema_with_probe_seq(
            "test-01",
            &["system_metadata", "assistant_text", "turn_complete"],
        );
        let current = schema_with_probe_seq(
            "test-01",
            &[
                "system_metadata",
                "thinking_text",
                "assistant_text",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert_eq!(
            report.findings.len(),
            0,
            "a model-optional (thinking_text) presence must produce no finding, got: {}",
            report.format_report(),
        );
    }

    // ---- 14. Probe sequence: reordered same events → fail

    #[test]
    fn probe_sequence_reordered_fails() {
        let golden = schema_with_probe_seq("test-01", &["a", "b", "c"]);
        let current = schema_with_probe_seq("test-01", &["a", "c", "b"]);
        let report = diff_schemas(&golden, &current);
        assert_fail_kind(&report, |k| {
            matches!(k, FailureKind::ReorderedSequence { probe_name, .. }
                if probe_name == "test-01")
        });
    }

    // ---- 14b. Probe sequence: optional interstitial event → warn

    #[test]
    fn probe_sequence_optional_interstitial_variance_warns() {
        // current is golden with one in-set event (`a`) deleted at a
        // repeated, non-consecutive position. `a` still appears, so it
        // is not a removed slot; current is a subsequence of golden, so
        // it is interstitial-event variance, not a transposition.
        let golden = schema_with_probe_seq("test-01", &["x", "a", "y", "a", "z"]);
        let current = schema_with_probe_seq("test-01", &["x", "y", "a", "z"]);
        let report = diff_schemas(&golden, &current);
        assert!(!report.has_failures());
        assert_warn_kind(&report, |k| {
            matches!(k, FailureKind::OptionalSequenceVariance { probe_name, .. }
                if probe_name == "test-01")
        });
    }

    // ---- 15. Probe sequence count variance (canonical match) → ok

    #[test]
    fn probe_sequence_count_variance_is_ok() {
        // Golden has 3 assistant_text partials, current has 5.
        // Canonicalization collapses consecutive duplicates so both
        // become [system_metadata, assistant_text, turn_complete].
        let golden = schema_with_probe_seq(
            "test-02",
            &[
                "system_metadata",
                "assistant_text",
                "assistant_text",
                "assistant_text",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-02",
            &[
                "system_metadata",
                "assistant_text",
                "assistant_text",
                "assistant_text",
                "assistant_text",
                "assistant_text",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert_eq!(report.findings.len(), 0);
    }

    // ---- 15b. Tool-call count variance (golden 3 calls, current 2) → ok

    #[test]
    fn probe_sequence_tool_call_count_variance_is_ok() {
        // The agent made three tool calls on the golden capture and
        // two on the current one — pure agent non-determinism. Both
        // tool-activity runs collapse to a single `tool_activity`
        // token, so the shape sequences are identical.
        let golden = schema_with_probe_seq(
            "test-21-glob-tool",
            &[
                "session_init",
                "system_metadata",
                "assistant_text",
                "tool_use",
                "tool_result",
                "tool_use_structured",
                "tool_use",
                "tool_result",
                "tool_use_structured",
                "tool_use",
                "tool_result",
                "tool_use_structured",
                "assistant_text",
                "cost_update",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-21-glob-tool",
            &[
                "session_init",
                "system_metadata",
                "assistant_text",
                "tool_use",
                "tool_result",
                "tool_use_structured",
                "tool_use",
                "tool_result",
                "tool_use_structured",
                "assistant_text",
                "cost_update",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert_eq!(report.findings.len(), 0, "{}", report.format_report());
    }

    // ---- 15b-bis. subagent narrate-vs-tool ORDER variance → ok
    //
    // Regression for the `test-22-subagent-spawn` drift FAIL: a
    // foreground subagent narrates (`assistant_text`) between its tool
    // calls on one run and only after them on the next — pure model
    // non-determinism. Both reduce to the same tool-using-body skeleton,
    // so `shape_sequence`'s body collapse must yield identical shapes.
    // Sequences are the real golden/current from the v2.1.197 drift run.
    #[test]
    fn probe_sequence_subagent_narration_order_is_ok() {
        let golden = schema_with_probe_seq(
            "test-22-subagent-spawn",
            &[
                "session_init",
                "system_metadata",
                "session_capabilities",
                "content_block_start",
                "assistant_text",
                "content_block_start",
                "tool_use",
                "tool_result",
                "content_block_start",
                "tool_use",
                "tool_result",
                "task_started",
                "tool_use",
                "tool_result",
                "content_block_start",
                "assistant_text",
                "content_block_start",
                "tool_use",
                "tool_result",
                "assistant_text",
                "tool_use",
                "tool_result",
                "cost_update",
                "assistant_text",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-22-subagent-spawn",
            &[
                "session_init",
                "system_metadata",
                "session_capabilities",
                "content_block_start",
                "tool_use",
                "tool_result",
                "content_block_start",
                "tool_use",
                "tool_result",
                "task_started",
                "tool_use",
                "tool_result",
                "content_block_start",
                "tool_use",
                "tool_result",
                "content_block_start",
                "assistant_text",
                "cost_update",
                "assistant_text",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert_eq!(report.findings.len(), 0, "{}", report.format_report());
    }

    // ---- 15b-ter. a pure-text turn is NOT collapsed into tool activity
    //
    // The body collapse only fires for runs that contain a tool call, so
    // a genuine text→tool transposition still surfaces (it must not be
    // masked as benign narration variance).
    #[test]
    fn probe_sequence_text_then_tool_transposition_still_flags() {
        let golden = schema_with_probe_seq(
            "test-x",
            &[
                "session_init",
                "assistant_text",
                "tool_use",
                "tool_result",
                "cost_update",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-x",
            &[
                "session_init",
                "cost_update",
                "assistant_text",
                "tool_use",
                "tool_result",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert!(
            report.has_failures(),
            "a cost_update/assistant_text transposition must still fail: {}",
            report.format_report()
        );
    }

    // ---- 15c. streaming_usage interleaving variance → ok

    #[test]
    fn probe_sequence_streaming_usage_interleaving_is_ok() {
        // `streaming_usage` frames flush at non-deterministic points.
        // Both probes emit them; they just land in different slots.
        // `shape_sequence` drops them, so the shapes match.
        let golden = schema_with_probe_seq(
            "test-02",
            &[
                "session_init",
                "system_metadata",
                "streaming_usage",
                "assistant_text",
                "streaming_usage",
                "cost_update",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-02",
            &[
                "session_init",
                "streaming_usage",
                "system_metadata",
                "assistant_text",
                "cost_update",
                "streaming_usage",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert_eq!(report.findings.len(), 0, "{}", report.format_report());
    }

    // ---- 15d. Genuine turn-skeleton reorder still fails

    #[test]
    fn probe_sequence_genuine_reorder_still_fails() {
        // `cost_update` moves ahead of `assistant_text` — a real
        // transposition of the turn skeleton the reducer relies on.
        // No interstitial / tool-activity events are involved, so the
        // shape reduction does not mask it.
        let golden = schema_with_probe_seq(
            "test-01",
            &[
                "session_init",
                "system_metadata",
                "assistant_text",
                "cost_update",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-01",
            &[
                "session_init",
                "system_metadata",
                "cost_update",
                "assistant_text",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert_fail_kind(&report, |k| {
            matches!(k, FailureKind::ReorderedSequence { probe_name, .. }
                if probe_name == "test-01")
        });
    }

    // ---- 15e. A vanished tool / interstitial event type still fails

    #[test]
    fn probe_sequence_vanished_event_type_still_fails() {
        // The tool-activity collapse must not blind the set check: a
        // probe that stops emitting `tool_use_structured` entirely is
        // real drift, caught by the event-type set comparison.
        let golden = schema_with_probe_seq(
            "test-21-glob-tool",
            &[
                "session_init",
                "system_metadata",
                "tool_use",
                "tool_result",
                "tool_use_structured",
                "streaming_usage",
                "cost_update",
                "turn_complete",
            ],
        );
        let current = schema_with_probe_seq(
            "test-21-glob-tool",
            &[
                "session_init",
                "system_metadata",
                "tool_use",
                "tool_result",
                "cost_update",
                "turn_complete",
            ],
        );
        let report = diff_schemas(&golden, &current);
        assert_fail_kind(&report, |k| {
            matches!(k, FailureKind::RemovedSequenceSlots { probe_name, slots }
                if probe_name == "test-21-glob-tool"
                && slots.contains(&"tool_use_structured".to_string()))
        });
        // `streaming_usage` also vanished — likewise caught by the set
        // check, even though its *position* is otherwise ignored.
        assert_fail_kind(&report, |k| {
            matches!(k, FailureKind::RemovedSequenceSlots { slots, .. }
                if slots.contains(&"streaming_usage".to_string()))
        });
    }

    // ---- 16. Probe missing in current → fail

    #[test]
    fn probe_missing_in_current_fails() {
        let mut golden = schema_with_probe_seq("test-01", &["a", "b"]);
        golden
            .probe_sequences
            .insert("test-02".into(), vec!["c".into(), "d".into()]);

        let current = schema_with_probe_seq("test-01", &["a", "b"]);
        let report = diff_schemas(&golden, &current);
        assert_fail_kind(
            &report,
            |k| matches!(k, FailureKind::MissingProbe { probe_name } if probe_name == "test-02"),
        );
    }

    // ---- 17. New probe in current → warn

    #[test]
    fn new_probe_in_current_warns() {
        let golden = schema_with_probe_seq("test-01", &["a", "b"]);
        let mut current = schema_with_probe_seq("test-01", &["a", "b"]);
        current
            .probe_sequences
            .insert("test-new".into(), vec!["x".into(), "y".into()]);
        let report = diff_schemas(&golden, &current);
        assert!(!report.has_failures());
        assert_warn_kind(
            &report,
            |k| matches!(k, FailureKind::NewProbe { probe_name } if probe_name == "test-new"),
        );
    }

    // ---- 18. Empty golden, non-empty current: everything new → all warns

    #[test]
    fn empty_golden_non_empty_current_all_warns() {
        let golden = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        let current = schema_with_event("session_init", event_shape(&[("type", "string")], &[]));
        let report = diff_schemas(&golden, &current);
        assert!(!report.has_failures());
        assert_warn_kind(&report, |k| matches!(k, FailureKind::NewEventType { .. }));
    }

    // ---- 19. Empty current, non-empty golden: everything missing → all fails

    #[test]
    fn empty_current_non_empty_golden_all_fails() {
        let golden = schema_with_event("session_init", event_shape(&[("type", "string")], &[]));
        let current = Schema {
            claude_version: "2.1.104".into(),
            ..Default::default()
        };
        let report = diff_schemas(&golden, &current);
        assert!(report.has_failures());
        assert_fail_kind(
            &report,
            |k| matches!(k, FailureKind::MissingEventType { event_type } if event_type == "session_init"),
        );
    }

    // ---- 20. Format report is non-empty for non-empty findings

    #[test]
    fn format_report_renders_structured_findings() {
        let mut report = DiffReport::new();
        report.fail(FailureKind::MissingEventType {
            event_type: "foo".into(),
        });
        report.warn(FailureKind::NewField {
            path: vec!["system_metadata".into(), "new_key".into()],
            ty: "string".into(),
        });
        let rendered = report.format_report();
        assert!(rendered.contains("1 failure(s)"));
        assert!(rendered.contains("1 warning(s)"));
        assert!(rendered.contains("FAIL"));
        assert!(rendered.contains("WARN"));
        assert!(rendered.contains("foo"));
        assert!(rendered.contains("new_key"));
    }

    // ---- 21. Required + optional overlap in golden: optional field
    // present in current with matching type is ok

    #[test]
    fn optional_field_type_match_in_current_is_ok() {
        let golden = schema_with_event(
            "tool_result",
            event_shape(&[("type", "string")], &[("parent_tool_use_id", "string")]),
        );
        let current = schema_with_event(
            "tool_result",
            event_shape(&[("type", "string")], &[("parent_tool_use_id", "string")]),
        );
        let report = diff_schemas(&golden, &current);
        assert_eq!(report.findings.len(), 0);
    }

    // ---- 22. Optional field type change → fail

    #[test]
    fn optional_field_type_mismatch_fails() {
        let golden = schema_with_event(
            "tool_result",
            event_shape(&[], &[("parent_tool_use_id", "string")]),
        );
        let current = schema_with_event(
            "tool_result",
            event_shape(&[], &[("parent_tool_use_id", "integer")]),
        );
        let report = diff_schemas(&golden, &current);
        assert_fail_kind(&report, |k| matches!(k, FailureKind::TypeMismatch { .. }));
    }

    // ---- 23. load_schema round-trip

    #[test]
    fn load_schema_parses_expected_structure() {
        use serde_json::json;
        let schema_json = json!({
            "claude_version": "2.1.104",
            "event_types": {
                "session_init": {
                    "required_fields": { "type": "string", "session_id": "string" },
                    "optional_fields": {}
                },
                "tool_use_structured": {
                    "by_tool_name": {
                        "Read": {
                            "required_fields": { "tool_use_id": "string" },
                            "optional_fields": {}
                        }
                    }
                }
            },
            "probe_sequences": {
                "test-01": {
                    "required_sequence": ["session_init", "turn_complete"]
                }
            }
        });
        let tmp =
            std::env::temp_dir().join(format!("drift-differ-test-{}.json", std::process::id()));
        std::fs::write(&tmp, serde_json::to_string_pretty(&schema_json).unwrap())
            .expect("write tmp schema");

        let loaded = load_schema(&tmp).expect("load_schema ok");
        assert_eq!(loaded.claude_version, "2.1.104");
        assert!(loaded.event_types.contains_key("session_init"));
        assert!(loaded.tool_use_structured_by_tool.contains_key("Read"));
        assert_eq!(
            loaded.probe_sequences.get("test-01"),
            Some(&vec![
                "session_init".to_string(),
                "turn_complete".to_string()
            ])
        );

        let _ = std::fs::remove_file(&tmp);
    }

    // ---- 24. load_schema fails hard on missing file

    #[test]
    fn load_schema_fails_on_missing_file() {
        let fake = PathBuf::from("/tmp/definitely-does-not-exist-xyz-drift.json");
        assert!(load_schema(&fake).is_err());
    }
}
