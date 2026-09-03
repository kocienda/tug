//! Capture binary for the golden stream-json catalog.
//!
//! Produces versioned fixtures under `tests/fixtures/stream-json-catalog/`.
//! Run the real-claude capture with the feature flag when refreshing baselines.
//!
//! # What this binary does
//!
//! - Spawns one fresh `TestTugcast` per probe in `PROBES`
//! - Drives each probe's `input_script` through `TestWs`
//! - Collects `CODE_OUTPUT` and `SESSION_SIDEBAND` events until a
//!   terminal event (`turn_complete` or timeout)
//! - Normalizes each event via [`normalize_event`] (leaf-only
//!   placeholder substitution per [D14])
//! - Stability-checks the normalized shape across `TUG_STABILITY=N`
//!   repeated captures
//! - Derives a per-event-type [`Schema`] and per-probe event-sequence
//!   via [`derive_schema`]
//! - Writes JSONL + `manifest.json` + `schema.json` under
//!   `tests/fixtures/stream-json-catalog/v<version>/`
//!
//! # What this binary does *not* do
//!
//! - No prose-derived assumptions surviving to fixtures (per SC10)
//! - No version fallback — if `v<version>/` doesn't exist yet, the
//!   capture writes it; if it exists, the drift test reads it and
//!   the capture refuses to overwrite unless re-run explicitly
//!
//! # How to run
//!
//! Default suite: unit tests (`normalize_event` + `derive_schema`)
//! only. The real-claude capture is `#[ignore]` + env-gated.
//!
//! ```ignore
//! # unit tests
//! cd tugrust && cargo nextest run -p tugcast
//!
//! # real capture (writes new v<version>/ dir)
//! TUG_STABILITY=3 TUG_REAL_CLAUDE=1 \
//!   cargo test --test capture_stream_json_catalog -- --ignored
//! ```

#![allow(dead_code)]

mod common;

use serde_json::{Value, json};

// Shared imports — used by both the `#[cfg(test)] mod tests` unit
// tests at the bottom of the file AND by the real-claude-gated
// `capture_all_probes` entry point. Keep these unconditional so the
// unit tests (normalize_event / derive_schema / stability_outcome /
// schema_to_json / canonical_sequence / stability_runs / extract_version /
// status_tag / build_manifest) keep compiling and running in standard
// `cargo nextest run` invocations.
use common::catalog::{
    CapturedProbe, canonical_sequence, derive_schema, diff_capabilities, extract_capabilities,
    extract_version, normalize_event, schema_to_json, stability_outcome, stability_runs,
    summarize_capabilities,
};
use common::probes::ProbeStatus;

// Real-claude-only imports — only used by `capture_all_probes` and
// `write_fixtures`. Gated so standard runs don't trigger
// unused-import warnings when the feature is off.
#[cfg(feature = "real-claude-tests")]
use common::catalog::{
    self, CAPABILITIES_PROBE_NAME, Schema, capabilities_root, capture_with_stability,
};
#[cfg(feature = "real-claude-tests")]
use common::real_claude_enabled;
#[cfg(feature = "real-claude-tests")]
use std::path::PathBuf;

// -----------------------------------------------------------------------
// Fixture writing helpers (capture-binary only)
// -----------------------------------------------------------------------

/// Convert [`ProbeStatus`] to a lowercase status string for
/// `manifest.json`.
fn status_tag(status: &ProbeStatus) -> &'static str {
    match status {
        ProbeStatus::Passed => "passed",
        ProbeStatus::Skipped(_) => "skipped",
        ProbeStatus::Failed(_) => "failed",
        ProbeStatus::ShapeUnstable(_) => "shape_unstable",
    }
}

fn status_reason(status: &ProbeStatus) -> Option<String> {
    match status {
        ProbeStatus::Passed => None,
        ProbeStatus::Skipped(reason) => Some((*reason).to_string()),
        ProbeStatus::Failed(reason) => Some(reason.clone()),
        ProbeStatus::ShapeUnstable(reason) => Some(reason.clone()),
    }
}

/// Build `manifest.json` for a capture run.
fn build_manifest(version: &str, stability: usize, captures: &[CapturedProbe]) -> Value {
    let probes: Vec<Value> = captures
        .iter()
        .map(|probe| {
            let mut entry = json!({
                "name": probe.name,
                "status": status_tag(&probe.status),
                "event_count": probe.events.len(),
                "runtime_ms": "{{i64}}",
            });
            if let Some(reason) = status_reason(&probe.status) {
                entry
                    .as_object_mut()
                    .unwrap()
                    .insert("skip_reason".to_string(), Value::String(reason));
            }
            entry
        })
        .collect();

    json!({
        "claude_version": version,
        "captured_at": "{{iso}}",
        "stability_runs": stability,
        "probes": probes,
    })
}

/// Write a full capture run to disk. Creates the
/// `v<version>/` directory, writes JSONL for each probe, plus
/// `manifest.json` and `schema.json`.
#[cfg(feature = "real-claude-tests")]
pub fn write_fixtures(
    captures: &[CapturedProbe],
    schema: &Schema,
    manifest: &Value,
) -> std::io::Result<PathBuf> {
    let dir = catalog::fixture_root().join(format!("v{}", schema.claude_version));
    std::fs::create_dir_all(&dir)?;

    for probe in captures {
        let mut jsonl = String::new();
        for event in &probe.events {
            jsonl.push_str(&serde_json::to_string(event).unwrap_or_default());
            jsonl.push('\n');
        }
        std::fs::write(dir.join(format!("{}.jsonl", probe.name)), jsonl)?;
    }

    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(manifest).unwrap(),
    )?;
    std::fs::write(
        dir.join("schema.json"),
        serde_json::to_string_pretty(&schema_to_json(schema)).unwrap(),
    )?;

    Ok(dir)
}

// -----------------------------------------------------------------------
// The one real-claude test — the entry point
//
// Gated on `--features real-claude-tests` so `cargo nextest run
// -p tugcast` does not enumerate it in standard runs. See this file's
// feature documentation in `Cargo.toml`.
// -----------------------------------------------------------------------

#[cfg(feature = "real-claude-tests")]
#[tokio::test]
#[ignore]
async fn capture_all_probes() {
    if !real_claude_enabled() {
        println!("skipping capture_all_probes: TUG_REAL_CLAUDE not set");
        return;
    }
    // Pre-flight refusal — refuse to run if any subscription-overriding
    // auth env var is set in the shell. The spawn-site scrubs defend
    // silently, but we prefer to fail loudly up front so the developer
    // can `unset` and retry rather than discovering a contaminated
    // fixture later. See `catalog::AUTH_ENV_VARS` for the list.
    catalog::refuse_if_auth_env_set();
    let project_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    let project_dir = project_dir
        .canonicalize()
        .expect("canonicalize project dir");

    let tmp = tempdir_path();
    std::fs::create_dir_all(&tmp).expect("create tmp dir");
    let _tmp_guard = TmpDirGuard(tmp.clone());

    let stability = stability_runs();
    let captures = capture_with_stability(stability, &tmp, &project_dir).await;

    // Diagnostic dump — always print the per-probe status summary
    // before doing anything else. If the version-extraction panics
    // below (e.g. claude crashed and no probe produced a
    // system_metadata), this is the only window into what happened.
    println!(
        "--- capture_all_probes status summary ({} probes) ---",
        captures.len()
    );
    for probe in &captures {
        let (tag, reason) = match &probe.status {
            ProbeStatus::Passed => ("PASSED", String::new()),
            ProbeStatus::Skipped(r) => ("SKIPPED", (*r).to_string()),
            ProbeStatus::Failed(r) => ("FAILED ", r.clone()),
            ProbeStatus::ShapeUnstable(r) => ("UNSTBL ", r.clone()),
        };
        println!(
            "  [{tag}] {name:<48} events={count} runtime={rt}ms {reason}",
            name = probe.name,
            count = probe.events.len(),
            rt = probe.runtime_ms,
        );
    }
    println!("-----------------------------------------------------");

    // A filtered run is a de-risking inspection, not a re-baseline: writing
    // fixtures from a subset would corrupt the manifest/schema (missing
    // probes). Print the captured event types per probe and return without
    // touching the committed golden.
    if std::env::var("TUG_PROBE_FILTER")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some()
    {
        println!("--- TUG_PROBE_FILTER active: inspection only, NOT writing fixtures ---");
        for probe in &captures {
            let types: Vec<&str> = probe
                .events
                .iter()
                .filter_map(|e| e.get("type").and_then(|v| v.as_str()))
                .collect();
            println!(
                "  {} [{}]:\n    {}",
                probe.name,
                probe.events.len(),
                types.join(", ")
            );
            // Dump the rewind-relevant payloads so a filtered run confirms
            // semantics (canRewind / newSessionId / fork session id), not just
            // that the event types appeared.
            for e in &probe.events {
                match e.get("type").and_then(|v| v.as_str()) {
                    Some("rewind_result")
                    | Some("rewind_preview_result")
                    | Some("session_init") => {
                        println!("      → {e}");
                    }
                    _ => {}
                }
            }
        }
        return;
    }

    let version =
        extract_version(&captures).expect("no system_metadata version found — aborting per [D11]");

    let schema = derive_schema(&version, &captures);
    let manifest = build_manifest(&version, stability, &captures);
    let path = write_fixtures(&captures, &schema, &manifest).expect("write_fixtures succeeded");
    println!("wrote fixtures to {}", path.display());

    // D6.a — extract the system_metadata snapshot into the repo-root
    // `capabilities/` tree and update `capabilities/LATEST`. Tug.app and
    // tugdeck consume the snapshot at build time via `capabilities/LATEST`;
    // co-locating the extraction here keeps the version-bump runbook a
    // single operation.
    let probe28 = path.join(format!("{CAPABILITIES_PROBE_NAME}.jsonl"));
    let caps_dir = capabilities_root();

    // Read the previous snapshot BEFORE extract_capabilities overwrites
    // LATEST, so we can produce a lost/gained diff after the new one lands.
    let prev_version = std::fs::read_to_string(caps_dir.join("LATEST"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let prev_snapshot_line = prev_version.as_ref().and_then(|v| {
        let p = caps_dir.join(v).join("system-metadata.jsonl");
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| s.lines().next().map(String::from))
    });

    let caps_out = extract_capabilities(&probe28, &caps_dir, &version)
        .expect("extract_capabilities succeeded");
    println!("wrote capabilities snapshot to {}", caps_out.display());

    // Human-readable report of what just landed in capabilities/<ver>/.
    let new_snapshot = std::fs::read_to_string(&caps_out).expect("read capabilities snapshot");
    let new_snapshot_line = new_snapshot.lines().next().unwrap_or("");
    println!("\n---- capabilities snapshot ({version}) ----");
    print!("{}", summarize_capabilities(new_snapshot_line));

    // Diff against the previous baked version if one existed and it differs.
    if let (Some(prev_v), Some(prev_line)) = (prev_version.as_ref(), prev_snapshot_line.as_ref()) {
        if prev_v != &version {
            let diff = diff_capabilities(prev_line, new_snapshot_line);
            if !diff.is_empty() {
                println!("\n---- capabilities diff ({prev_v} → {version}) ----");
                print!("{diff}");
            }
        }
    }
    // `_tmp_guard` drops here and removes the per-probe bank files.
}

/// Per-PID scratch directory for capture runs. Holds the per-probe
/// tugbank paths and is wiped by [`TmpDirGuard`] on scope exit.
#[cfg(feature = "real-claude-tests")]
fn tempdir_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("tugcast-capture-{}", std::process::id()));
    p
}

/// RAII guard that `remove_dir_all`s its path on drop. Robust to
/// panics partway through `capture_all_probes` — the tokio runtime
/// unwinds the test stack and the drop fires, cleaning up the
/// per-probe bank files and any stale tugcast subprocess working
/// state without leaving cruft under `$TMPDIR`.
#[cfg(feature = "real-claude-tests")]
struct TmpDirGuard(PathBuf);

#[cfg(feature = "real-claude-tests")]
impl Drop for TmpDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// -----------------------------------------------------------------------
// Unit tests — normalize_event + derive_schema
// -----------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- normalize_event ----

    #[test]
    fn normalize_leaf_uuid_id_key() {
        let mut v =
            json!({"type": "session_init", "session_id": "05086f97-1234-4abc-9def-abcdef012345"});
        normalize_event(&mut v);
        assert_eq!(v["session_id"], "{{uuid}}");
        assert_eq!(v["type"], "session_init");
    }

    #[test]
    fn normalize_leaf_id_key_even_for_non_uuid_content() {
        // session_id: "pending-cont-xyz" is not a UUID but still a
        // varying identifier that must be erased to stabilize the
        // fixture diff.
        let mut v = json!({"session_id": "pending-cont-xyz-123"});
        normalize_event(&mut v);
        assert_eq!(v["session_id"], "{{uuid}}");
    }

    #[test]
    fn normalize_text_content_key_collapses_to_length() {
        let mut v = json!({"type": "assistant_text", "text": "Hello there, how are you?"});
        normalize_event(&mut v);
        assert_eq!(v["text"], "{{text:len=25}}");
    }

    #[test]
    fn normalize_preserves_object_structure() {
        let mut v = json!({
            "type": "system_metadata",
            "tools": ["Read", "Write", "Bash"],
            "model": "claude-opus-4-6",
        });
        normalize_event(&mut v);
        // Structure preserved, tool list intact.
        assert_eq!(v["tools"], json!(["Read", "Write", "Bash"]));
        assert_eq!(v["model"], "claude-opus-4-6");
        assert_eq!(v["type"], "system_metadata");
    }

    #[test]
    fn normalize_preserves_array_structure() {
        let mut v = json!({
            "slash_commands": ["cost", "compact", "status"],
        });
        normalize_event(&mut v);
        assert_eq!(v["slash_commands"], json!(["cost", "compact", "status"]));
    }

    #[test]
    fn normalize_polymorphic_tool_result() {
        let mut v = json!({
            "type": "tool_result",
            "tool_use_id": "toolu_01ABCDEFGHIJKLMNOPQRSTUV",
            "output": "line 1\nline 2",
            "is_error": false,
        });
        normalize_event(&mut v);
        assert_eq!(v["tool_use_id"], "{{uuid}}");
        assert_eq!(v["output"], "{{text:len=13}}");
        assert_eq!(v["is_error"], false);
    }

    #[test]
    fn normalize_iso_timestamp_leaf() {
        let mut v = json!({"captured_at": "2026-04-13T15:00:00Z"});
        normalize_event(&mut v);
        assert_eq!(v["captured_at"], "{{iso}}");
    }

    #[test]
    fn normalize_numeric_allowlist_cost_and_duration() {
        let mut v = json!({
            "type": "cost_update",
            "total_cost_usd": 0.0642,
            "duration_ms": 1912,
            "seq": 2,
        });
        normalize_event(&mut v);
        assert_eq!(v["total_cost_usd"], "{{f64}}");
        assert_eq!(v["duration_ms"], "{{i64}}");
        // seq is NOT in the allowlist — structural meaning preserved.
        assert_eq!(v["seq"], 2);
    }

    #[test]
    fn normalize_cwd_prefix_replaces_home_path() {
        // SAFETY: this test mutates the process environment. Other
        // normalization tests don't read `$HOME` at the moment they
        // normalize strings that would collide — they use literal
        // values that don't start with the real home. The mutation is
        // bracketed so a concurrent test that reads `$HOME` would see
        // the saved-and-restored value.
        let saved = std::env::var("HOME").ok();
        unsafe { std::env::set_var("HOME", "/Users/kocienda") };
        let mut v = json!({"cwd": "/Users/kocienda/Mounts/u/src/tugtool"});
        normalize_event(&mut v);
        assert_eq!(v["cwd"], "{{cwd}}/Mounts/u/src/tugtool");
        match saved {
            Some(val) => unsafe { std::env::set_var("HOME", val) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }

    // ---- derive_schema ----

    fn mk_capture(name: &str, events: Vec<Value>) -> CapturedProbe {
        CapturedProbe {
            name: name.to_string(),
            events,
            status: ProbeStatus::Passed,
            runtime_ms: 0,
        }
    }

    #[test]
    fn derive_schema_basic_single_probe() {
        let captures = vec![mk_capture(
            "test-01-basic-round-trip",
            vec![
                json!({"type": "session_init", "session_id": "{{uuid}}"}),
                json!({"type": "system_metadata", "model": "claude-opus-4-6", "version": "2.1.104"}),
                json!({"type": "assistant_text", "text": "{{text:len=5}}"}),
                json!({"type": "turn_complete", "result": "success"}),
            ],
        )];
        let schema = derive_schema("2.1.104", &captures);
        assert_eq!(schema.claude_version, "2.1.104");
        assert!(schema.event_types.contains_key("session_init"));
        assert!(schema.event_types.contains_key("system_metadata"));
        assert!(schema.event_types.contains_key("assistant_text"));
        assert!(schema.event_types.contains_key("turn_complete"));
        assert_eq!(
            schema.probe_sequences.get("test-01-basic-round-trip"),
            Some(&vec![
                "session_init".to_string(),
                "system_metadata".to_string(),
                "assistant_text".to_string(),
                "turn_complete".to_string(),
            ])
        );
    }

    #[test]
    fn derive_schema_required_vs_optional_fields() {
        // Two probes both emit `system_metadata`. Probe A has
        // `permissionMode`, probe B does not. So `permissionMode`
        // lands in optional_fields, not required.
        let captures = vec![
            mk_capture(
                "probe-a",
                vec![json!({
                    "type": "system_metadata",
                    "model": "claude-opus-4-6",
                    "version": "2.1.104",
                    "permissionMode": "acceptEdits",
                })],
            ),
            mk_capture(
                "probe-b",
                vec![json!({
                    "type": "system_metadata",
                    "model": "claude-opus-4-6",
                    "version": "2.1.104",
                })],
            ),
        ];
        let schema = derive_schema("2.1.104", &captures);
        let meta = schema.event_types.get("system_metadata").unwrap();
        assert!(meta.required_fields.contains_key("model"));
        assert!(meta.required_fields.contains_key("version"));
        assert!(meta.required_fields.contains_key("type"));
        assert!(meta.optional_fields.contains_key("permissionMode"));
        assert!(!meta.required_fields.contains_key("permissionMode"));
    }

    #[test]
    fn derive_schema_polymorphic_tool_use_structured() {
        // Read-tool tool_use_structured vs Bash-tool tool_use_structured
        // have completely different structured_result shapes. [D09]
        // requires they be keyed under by_tool_name.
        let captures = vec![
            mk_capture(
                "probe-read",
                vec![json!({
                    "type": "tool_use_structured",
                    "tool_name": "Read",
                    "tool_use_id": "{{uuid}}",
                    "structured_result": { "file": { "filePath": "{{cwd}}/x", "content": "{{text:len=10}}" } },
                })],
            ),
            mk_capture(
                "probe-bash",
                vec![json!({
                    "type": "tool_use_structured",
                    "tool_name": "Bash",
                    "tool_use_id": "{{uuid}}",
                    "structured_result": { "stdout": "{{text:len=5}}", "stderr": "{{text:len=0}}" },
                })],
            ),
        ];
        let schema = derive_schema("2.1.104", &captures);
        assert!(schema.tool_use_structured_by_tool.contains_key("Read"));
        assert!(schema.tool_use_structured_by_tool.contains_key("Bash"));
        // The general event_types table should NOT have a
        // tool_use_structured entry because polymorphic dispatch
        // routes it to `by_tool_name`.
        assert!(!schema.event_types.contains_key("tool_use_structured"));
    }

    #[test]
    fn derive_schema_probe_sequences_are_ordered() {
        let captures = vec![mk_capture(
            "probe-seq",
            vec![
                json!({"type": "system_metadata"}),
                json!({"type": "thinking_text"}),
                json!({"type": "assistant_text"}),
                json!({"type": "assistant_text"}),
                json!({"type": "cost_update"}),
                json!({"type": "turn_complete"}),
            ],
        )];
        let schema = derive_schema("2.1.104", &captures);
        let seq = schema.probe_sequences.get("probe-seq").unwrap();
        assert_eq!(
            seq,
            &vec![
                "system_metadata",
                "thinking_text",
                "assistant_text",
                "assistant_text",
                "cost_update",
                "turn_complete",
            ]
        );
    }

    #[test]
    fn derive_schema_type_description_for_arrays_and_objects() {
        let captures = vec![mk_capture(
            "probe-types",
            vec![json!({
                "type": "system_metadata",
                "tools": ["Read", "Write"],
                "plugins": [{"name": "tugtool"}],
                "ipc_version": 2,
            })],
        )];
        let schema = derive_schema("2.1.104", &captures);
        let meta = schema.event_types.get("system_metadata").unwrap();
        assert_eq!(
            meta.required_fields.get("tools"),
            Some(&"array<string>".to_string())
        );
        assert_eq!(
            meta.required_fields.get("plugins"),
            Some(&"array<object>".to_string())
        );
        assert_eq!(
            meta.required_fields.get("ipc_version"),
            Some(&"integer".to_string())
        );
    }

    #[test]
    fn derive_schema_extract_version_from_captures() {
        let captures = vec![
            mk_capture(
                "probe-without-metadata",
                vec![json!({"type": "session_init"})],
            ),
            mk_capture(
                "probe-with-metadata",
                vec![json!({
                    "type": "system_metadata",
                    "version": "2.1.104",
                })],
            ),
        ];
        assert_eq!(extract_version(&captures), Some("2.1.104".to_string()));
    }

    #[test]
    fn schema_to_json_shape_matches_spec_s03() {
        let captures = vec![mk_capture(
            "test-01",
            vec![
                json!({"type": "session_init", "session_id": "{{uuid}}"}),
                json!({"type": "turn_complete"}),
            ],
        )];
        let schema = derive_schema("2.1.104", &captures);
        let out = schema_to_json(&schema);
        assert_eq!(out["claude_version"], "2.1.104");
        assert!(
            out["event_types"]["session_init"]["required_fields"]
                .as_object()
                .unwrap()
                .contains_key("type")
        );
        assert!(out["probe_sequences"]["test-01"]["required_sequence"].is_array());
    }

    // ---- manifest / fixture-root smoke ----

    #[test]
    fn build_manifest_includes_all_probes_and_normalizes_timing() {
        let captures = vec![
            mk_capture("probe-1", vec![json!({"type": "session_init"})]),
            CapturedProbe {
                name: "probe-2".to_string(),
                events: vec![],
                status: ProbeStatus::Skipped("reason"),
                runtime_ms: 500,
            },
        ];
        let manifest = build_manifest("2.1.104", 3, &captures);
        assert_eq!(manifest["claude_version"], "2.1.104");
        assert_eq!(manifest["captured_at"], "{{iso}}");
        assert_eq!(manifest["stability_runs"], 3);
        let probes = manifest["probes"].as_array().unwrap();
        assert_eq!(probes.len(), 2);
        assert_eq!(probes[0]["name"], "probe-1");
        assert_eq!(probes[0]["status"], "passed");
        assert_eq!(probes[0]["runtime_ms"], "{{i64}}");
        assert_eq!(probes[1]["status"], "skipped");
        assert_eq!(probes[1]["skip_reason"], "reason");
    }

    #[test]
    fn status_tag_covers_all_variants() {
        assert_eq!(status_tag(&ProbeStatus::Passed), "passed");
        assert_eq!(status_tag(&ProbeStatus::Skipped("x")), "skipped");
        assert_eq!(status_tag(&ProbeStatus::Failed("x".into())), "failed");
        assert_eq!(
            status_tag(&ProbeStatus::ShapeUnstable("x".into())),
            "shape_unstable"
        );
    }

    // ---- stability_outcome ----

    #[test]
    fn stability_outcome_no_rest_is_stable() {
        let first = mk_capture("probe", vec![json!({"type": "turn_complete"})]);
        assert_eq!(stability_outcome(&first, &[]), None);
    }

    #[test]
    fn stability_outcome_matching_runs_are_stable() {
        let first = mk_capture(
            "probe",
            vec![
                json!({"type": "session_init"}),
                json!({"type": "turn_complete"}),
            ],
        );
        let second = mk_capture(
            "probe",
            vec![
                json!({"type": "session_init"}),
                json!({"type": "turn_complete"}),
            ],
        );
        assert_eq!(stability_outcome(&first, &[second]), None);
    }

    #[test]
    fn stability_outcome_diverging_sequence_is_flagged() {
        let first = mk_capture(
            "probe-flap",
            vec![
                json!({"type": "session_init"}),
                json!({"type": "turn_complete"}),
            ],
        );
        let second = mk_capture(
            "probe-flap",
            vec![
                json!({"type": "session_init"}),
                json!({"type": "thinking_text"}),
                json!({"type": "turn_complete"}),
            ],
        );
        let diag = stability_outcome(&first, &[second]).expect("drift should be flagged");
        assert!(diag.contains("probe-flap"));
        assert!(diag.contains("differs"));
    }

    #[test]
    fn stability_outcome_multi_run_catches_later_divergence() {
        // Three runs: first two match, third diverges. The helper
        // should still flag it rather than reporting stable because
        // the first two agreed.
        let first = mk_capture(
            "probe-multi",
            vec![json!({"type": "a"}), json!({"type": "b"})],
        );
        let second = mk_capture(
            "probe-multi",
            vec![json!({"type": "a"}), json!({"type": "b"})],
        );
        let third = mk_capture(
            "probe-multi",
            vec![json!({"type": "a"}), json!({"type": "c"})],
        );
        let diag = stability_outcome(&first, &[second, third]).expect("third run must flag drift");
        // The diagnostic's "run X/Y" should identify the divergent run.
        assert!(diag.contains("run 3/3"));
    }

    #[test]
    fn stability_outcome_collapses_streaming_partials() {
        // Claude emits a variable number of assistant_text partials
        // depending on tokenizer batching. Runs with the same shape
        // but different partial counts must NOT be flagged.
        let first = mk_capture(
            "probe-stream",
            vec![
                json!({"type": "system_metadata"}),
                json!({"type": "assistant_text"}),
                json!({"type": "assistant_text"}),
                json!({"type": "assistant_text"}),
                json!({"type": "assistant_text"}),
                json!({"type": "turn_complete"}),
            ],
        );
        let second = mk_capture(
            "probe-stream",
            vec![
                json!({"type": "system_metadata"}),
                json!({"type": "assistant_text"}),
                json!({"type": "assistant_text"}),
                json!({"type": "turn_complete"}),
            ],
        );
        // Both canonicalize to [system_metadata, assistant_text, turn_complete].
        assert_eq!(stability_outcome(&first, &[second]), None);
    }

    #[test]
    fn stability_outcome_flags_new_event_type_between_runs() {
        // A run where a new event type appears between previously
        // adjacent ones must still be flagged — the canonicalization
        // erases count variance, not ordering drift.
        let first = mk_capture(
            "probe-order",
            vec![
                json!({"type": "a"}),
                json!({"type": "b"}),
                json!({"type": "c"}),
            ],
        );
        let second = mk_capture(
            "probe-order",
            vec![
                json!({"type": "a"}),
                json!({"type": "x"}), // new event type between a and b
                json!({"type": "b"}),
                json!({"type": "c"}),
            ],
        );
        assert!(stability_outcome(&first, &[second]).is_some());
    }

    #[test]
    fn canonical_sequence_dedupes_adjacent_only() {
        let events = vec![
            json!({"type": "a"}),
            json!({"type": "a"}),
            json!({"type": "b"}),
            json!({"type": "a"}),
            json!({"type": "a"}),
        ];
        // [a, a, b, a, a] → [a, b, a] — non-adjacent 'a' islands are
        // preserved so we detect genuine re-entry into an event type.
        assert_eq!(canonical_sequence(&events), vec!["a", "b", "a"]);
    }

    #[test]
    fn stability_outcome_length_mismatch_is_flagged() {
        // A run with extra trailing events is also a drift signal,
        // not a prefix match.
        let first = mk_capture(
            "probe-len",
            vec![json!({"type": "a"}), json!({"type": "b"})],
        );
        let second = mk_capture(
            "probe-len",
            vec![
                json!({"type": "a"}),
                json!({"type": "b"}),
                json!({"type": "c"}),
            ],
        );
        assert!(stability_outcome(&first, &[second]).is_some());
    }

    // ---- extract_capabilities (D6.a) ----

    #[test]
    fn extract_capabilities_writes_snapshot_and_latest() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let probe28 = tmp.path().join("test-28-system-metadata-deep-dive.jsonl");
        // Build a synthetic probe-28 file: a couple non-metadata lines
        // around the system_metadata payload the capabilities artifact
        // should capture.
        let lines = [
            r#"{"type":"session_init","session_id":"{{uuid}}"}"#,
            r#"{"type":"system_metadata","version":"2.1.105","slash_commands":["commit","plan"],"skills":["tugplug:plan"],"agents":["general-purpose","tugplug:coder-agent"],"plugins":[{"name":"tugplug"}]}"#,
            r#"{"type":"turn_complete"}"#,
        ];
        std::fs::write(&probe28, lines.join("\n") + "\n").unwrap();

        let caps_dir = tmp.path().join("capabilities");
        let written = extract_capabilities(&probe28, &caps_dir, "2.1.105").expect("extract");

        // Snapshot file landed at the versioned path.
        assert_eq!(
            written,
            caps_dir.join("2.1.105").join("system-metadata.jsonl")
        );
        let body = std::fs::read_to_string(&written).unwrap();
        assert!(body.starts_with(r#"{"type":"system_metadata""#));
        assert!(body.ends_with("\n"));
        // The captured line is verbatim from the source (minus trailing newline).
        assert_eq!(body.trim_end_matches('\n'), lines[1]);

        // LATEST points at the version string (with trailing newline).
        let latest = std::fs::read_to_string(caps_dir.join("LATEST")).unwrap();
        assert_eq!(latest, "2.1.105\n");
    }

    #[test]
    fn extract_capabilities_errors_when_no_system_metadata_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let probe28 = tmp.path().join("probe28.jsonl");
        std::fs::write(
            &probe28,
            "{\"type\":\"session_init\"}\n{\"type\":\"turn_complete\"}\n",
        )
        .unwrap();
        let caps_dir = tmp.path().join("capabilities");
        let err = extract_capabilities(&probe28, &caps_dir, "2.1.105").expect_err("should fail");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn extract_capabilities_errors_on_missing_source_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("does-not-exist.jsonl");
        let caps_dir = tmp.path().join("capabilities");
        let err = extract_capabilities(&missing, &caps_dir, "2.1.105").expect_err("should fail");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    // ---- summarize_capabilities + diff_capabilities ----

    #[test]
    fn summarize_capabilities_covers_arrays_and_scalars() {
        let line = r#"{"type":"system_metadata","version":"2.1.105","model":"claude-opus-4-7","permission_mode":"acceptEdits","slash_commands":["commit","plan"],"skills":["tugplug:plan"],"agents":["general-purpose","tugplug:coder-agent"],"plugins":[{"name":"tugplug"}]}"#;
        let out = summarize_capabilities(line);
        assert!(out.contains("version:         2.1.105"));
        assert!(out.contains("model:           claude-opus-4-7"));
        assert!(out.contains("permission_mode: acceptEdits"));
        assert!(out.contains("slash_commands (2)"));
        assert!(out.contains("- commit"));
        assert!(out.contains("- plan"));
        assert!(out.contains("skills (1)"));
        assert!(out.contains("- tugplug:plan"));
        assert!(out.contains("agents (2)"));
        assert!(out.contains("- tugplug:coder-agent"));
        assert!(out.contains("plugins (1)"));
        assert!(out.contains("- tugplug"));
    }

    #[test]
    fn summarize_capabilities_handles_missing_fields() {
        let line = r#"{"type":"system_metadata"}"#;
        let out = summarize_capabilities(line);
        assert!(out.contains("version:         <absent>"));
        assert!(out.contains("slash_commands (0)"));
    }

    #[test]
    fn summarize_capabilities_returns_error_on_bad_json() {
        let out = summarize_capabilities("not json");
        assert!(out.contains("failed to parse"));
    }

    #[test]
    fn diff_capabilities_reports_lost_and_gained() {
        let old = r#"{"type":"system_metadata","version":"2.1.105","slash_commands":["commit","plan","old-only"],"skills":["tugplug:plan"],"agents":["general-purpose"],"plugins":[{"name":"tugplug"}]}"#;
        let new = r#"{"type":"system_metadata","version":"2.1.112","slash_commands":["commit","plan","new-only"],"skills":["tugplug:plan","tugplug:arc"],"agents":["general-purpose"],"plugins":[{"name":"tugplug"}]}"#;
        let out = diff_capabilities(old, new);
        assert!(out.contains("version: 2.1.105 → 2.1.112"));
        // slash_commands: lost old-only, gained new-only
        assert!(out.contains("slash_commands (−1 +1)"));
        assert!(out.contains("- old-only"));
        assert!(out.contains("+ new-only"));
        // skills: gained tugplug:arc only
        assert!(out.contains("skills (−0 +1)"));
        assert!(out.contains("+ tugplug:arc"));
        // agents unchanged → not listed
        assert!(!out.contains("agents ("));
        // plugins unchanged → not listed
        assert!(!out.contains("plugins ("));
    }

    #[test]
    fn diff_capabilities_empty_on_identical() {
        let line = r#"{"type":"system_metadata","version":"2.1.105","slash_commands":["commit"]}"#;
        assert_eq!(diff_capabilities(line, line), "");
    }

    // ---- stability_runs ----

    #[test]
    fn stability_runs_reads_env_default_one() {
        // SAFETY: bracketed save/restore.
        let saved = std::env::var("TUG_STABILITY").ok();
        unsafe { std::env::remove_var("TUG_STABILITY") };
        assert_eq!(stability_runs(), 1);
        unsafe { std::env::set_var("TUG_STABILITY", "5") };
        assert_eq!(stability_runs(), 5);
        unsafe { std::env::set_var("TUG_STABILITY", "0") };
        // zero falls back to default per filter
        assert_eq!(stability_runs(), 1);
        match saved {
            Some(v) => unsafe { std::env::set_var("TUG_STABILITY", v) },
            None => unsafe { std::env::remove_var("TUG_STABILITY") },
        }
    }
}
