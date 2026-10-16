//! `tugtool progress` — a running command tells the block it runs under how
//! far it has got.
//!
//! The report goes to the instance that owns the calling session, as
//! `POST /api/session {op: "run_progress"}`, which attaches it to the Bash
//! call the command is running under and shows it on that block. Reporting is
//! telemetry: it never prints, it always exits 0, it makes no network call at
//! all when there is no calling session, and every POST is bounded, so a
//! recipe that reports can never be slowed or failed by reporting.

use crate::session_identity::{have_calling_session, tell_calling_session};

/// One progress report, as a recipe or the `test run` wrapper composes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunReport {
    pub label: Option<String>,
    pub text: String,
    pub done: Option<u64>,
    pub total: Option<u64>,
    pub failures: Option<u64>,
    /// What the run counts (`file`, `test`, `phase`). A report that names
    /// one is drawn as a run panel; one that does not is the one line.
    pub unit: Option<String>,
    /// How many units run at once.
    pub jobs: Option<u64>,
    /// The run's units, a JSON array of rows the deck narrows. Opaque here:
    /// the reporter writes it and the block reads it, and nothing between
    /// the two has a reason to know its fields.
    pub units: Option<serde_json::Value>,
    /// Substrings of the command this report expects to be running under,
    /// for when the session has several calls open.
    pub needles: Vec<String>,
}

/// The units a reporter handed over, from a path or `-` for stdin: a JSON
/// array, or `None` for anything else. Telemetry, so a bad source is a
/// report without units rather than an error.
pub fn read_units(source: &str) -> Option<serde_json::Value> {
    let text = if source == "-" {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf).ok()?;
        buf
    } else {
        std::fs::read_to_string(source).ok()?
    };
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.is_array().then_some(value)
}

/// The call this process runs under, when the harness says so — read here so
/// the day one is exported, attachment is exact with no further change.
fn tool_use_id() -> Option<String> {
    ["TUG_TOOL_USE_ID", "CLAUDE_CODE_TOOL_USE_ID"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
}

/// The report's fields, without the session — `session_identity` adds that.
fn report_fields(report: &RunReport, tool_use_id: Option<String>) -> serde_json::Value {
    let mut fields = serde_json::Map::new();
    if let Some(id) = tool_use_id {
        fields.insert("tool_use_id".into(), id.into());
    }
    if let Some(label) = &report.label {
        fields.insert("label".into(), label.clone().into());
    }
    fields.insert("text".into(), report.text.clone().into());
    for (key, value) in [
        ("done", report.done),
        ("total", report.total),
        ("failures", report.failures),
        ("jobs", report.jobs),
    ] {
        if let Some(n) = value {
            fields.insert(key.into(), n.into());
        }
    }
    if let Some(unit) = &report.unit {
        fields.insert("unit".into(), unit.clone().into());
    }
    if let Some(units) = &report.units {
        fields.insert("units".into(), units.clone());
    }
    fields.insert("needles".into(), report.needles.clone().into());
    serde_json::Value::Object(fields)
}

/// Post one report. Answers the live session the owning instance attached it
/// under, or `None` when there was no session, no instance, or no `ok`.
pub fn post_run_progress(report: &RunReport) -> Option<String> {
    let answer = tell_calling_session("run_progress", report_fields(report, tool_use_id()))?;
    answer
        .ok()?
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(str::to_string)
}

/// `tugtool progress`. Silent, and always `Ok`.
pub fn run(report: RunReport) {
    if !have_calling_session() {
        return;
    }
    let _ = post_run_progress(&report);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_numbers_and_ids_are_omitted_and_needles_always_ride() {
        let fields = report_fields(
            &RunReport {
                text: "compiling tugcast".into(),
                done: Some(3),
                ..RunReport::default()
            },
            None,
        );
        assert_eq!(
            fields,
            serde_json::json!({"text": "compiling tugcast", "done": 3, "needles": []})
        );
    }

    #[test]
    fn a_unit_report_carries_its_unit_jobs_and_rows() {
        let rows = serde_json::json!([{"name": "at0310", "status": "pass", "index": 0}]);
        let fields = report_fields(
            &RunReport {
                text: "at0310 PASS".into(),
                unit: Some("file".into()),
                jobs: Some(4),
                units: Some(rows.clone()),
                ..RunReport::default()
            },
            None,
        );
        assert_eq!(fields["unit"], "file");
        assert_eq!(fields["jobs"], 4);
        assert_eq!(fields["units"], rows);
    }

    #[test]
    fn units_that_are_not_an_array_are_left_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("units.json");
        std::fs::write(&path, r#"[{"name": "a", "status": "pass"}]"#).unwrap();
        assert!(read_units(path.to_str().unwrap()).is_some());
        std::fs::write(&path, r#"{"name": "a"}"#).unwrap();
        assert_eq!(read_units(path.to_str().unwrap()), None);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_units(path.to_str().unwrap()), None);
        assert_eq!(read_units(dir.path().join("missing").to_str().unwrap()), None);
    }
}
