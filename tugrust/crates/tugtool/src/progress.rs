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

/// `tugtool progress gaps`: the record of long Bash calls that reported no
/// unit, one line per command head, most frequent first. A reader of the
/// machine-global record, which tugcast writes; an absent record is an
/// empty listing rather than an error.
pub fn run_gaps(json: bool) {
    let path = tugcore::run_gaps::RunGaps::default_path();
    let gaps = tugcore::run_gaps::summarize(&path);
    if json {
        #[derive(serde::Serialize)]
        struct Report<'a> {
            path: String,
            gaps: &'a [tugcore::run_gaps::GapSummary],
        }
        crate::output::print_ok(
            "progress gaps",
            Report {
                path: path.display().to_string(),
                gaps: &gaps,
            },
        );
        return;
    }
    if gaps.is_empty() {
        println!("no long unreported runs recorded");
        return;
    }
    println!("{:<6} {:>9}  head", "runs", "total");
    for gap in &gaps {
        println!(
            "{:<6} {:>9}  {}",
            gap.count,
            format_duration_ms(gap.total_ms),
            gap.head
        );
    }
}

/// A duration in whole seconds, minutes, or hours — a ranking is read at a
/// glance, not to the millisecond.
fn format_duration_ms(ms: i64) -> String {
    let secs = ms / 1000;
    if secs < 90 {
        format!("{secs}s")
    } else if secs < 90 * 60 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// `tugtool progress`. Silent, and always `Ok`.
pub fn run(report: RunReport) {
    if !have_calling_session() {
        return;
    }
    let _ = post_run_progress(&report);
}

/// A phased run, as `progress phase` keeps it between a recipe's calls: the
/// phase names, and when each phase so far began. The last start is the
/// running phase's; when there is one start per name plus one, the run is
/// finished and that last start is its end.
///
/// A recipe writes one line per phase (`progress phase <label> <n> <name>`),
/// and this is what turns those lines into the rows the run panel draws —
/// the landed phases with their times, the running one since when, the
/// rest to come — so no recipe builds the JSON itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PhaseRun {
    pub names: Vec<String>,
    pub started_ms: Vec<i64>,
}

impl PhaseRun {
    /// Phase `n` begins now. `of` is the run's whole list of names when the
    /// recipe gives it, and it is kept from the call that gave it, so later
    /// calls need not repeat it; without one, `name` sets or adds the phase
    /// and the names accumulate as phases are reported. `n == 0` starts a
    /// fresh run whatever `prior` says, which is how a recipe run again
    /// under the same label replaces the last run rather than extending it.
    /// An `n` one past the names is the finish — every phase has landed —
    /// when the list was given or no `name` is passed; a `name` with no
    /// list is a phase, so a recipe that never lists its phases finishes
    /// with a bare `n`.
    pub fn advance(
        prior: Option<PhaseRun>,
        n: usize,
        name: Option<&str>,
        of: &[String],
        now_ms: i64,
    ) -> PhaseRun {
        let mut run = match prior {
            Some(prior) if n > 0 => prior,
            _ => PhaseRun::default(),
        };
        // Phases this call did not see started are taken to begin now, and
        // starts past this phase belong to a run that is being re-walked.
        run.started_ms.truncate(n);
        run.started_ms.resize(n, now_ms);
        run.started_ms.push(now_ms);
        if !of.is_empty() {
            run.names = of.to_vec();
        } else if let Some(name) = name {
            if n < run.names.len() {
                run.names[n] = name.to_string();
            } else {
                run.names.resize(n, String::new());
                run.names.push(name.to_string());
            }
        } else if n > run.names.len() {
            run.names.resize(n, String::new());
        }
        run
    }

    /// Which phase is running: the index of the last start.
    fn running(&self) -> usize {
        self.started_ms.len().saturating_sub(1)
    }

    /// The rows the panel draws, one per name, in the shape `build-app`'s
    /// hand-built reporter sent: a landed phase with its seconds, the running
    /// one with when it began, the rest pending.
    pub fn rows(&self) -> serde_json::Value {
        let running = self.running();
        let rows: Vec<serde_json::Value> = self
            .names
            .iter()
            .enumerate()
            .map(|(i, name)| {
                if i < running {
                    let secs = (self.started_ms[i + 1] - self.started_ms[i]) / 1000;
                    serde_json::json!({"name": name, "status": "pass", "index": i, "secs": secs})
                } else if i == running {
                    serde_json::json!({
                        "name": name, "status": "running", "index": i,
                        "started_at_ms": self.started_ms[i],
                    })
                } else {
                    serde_json::json!({"name": name, "status": "pending", "index": i})
                }
            })
            .collect();
        serde_json::Value::Array(rows)
    }

    /// The report this state makes, under `label`, with `text` as its line.
    pub fn report(&self, label: &str, text: &str, needles: Vec<String>) -> RunReport {
        let total = self.names.len() as u64;
        RunReport {
            label: Some(label.to_string()),
            text: text.to_string(),
            done: Some((self.running() as u64).min(total)),
            total: Some(total),
            failures: None,
            unit: Some("phase".into()),
            jobs: None,
            units: Some(self.rows()),
            needles,
        }
    }
}

/// Where a phased run's state lives: a small file under the temp dir, keyed
/// by the calling session and the label, so two recipes in one session, or
/// one recipe in two sessions, never share a run.
fn phase_state_path(label: &str) -> Option<std::path::PathBuf> {
    let token = crate::session_identity::calling_session_token()?;
    Some(
        std::env::temp_dir()
            .join("tug-progress-phase")
            .join(format!("{token}-{}.json", safe_label(label))),
    )
}

/// A label as a file name: letters, digits, `-` and `_` kept, the rest `_`.
pub(crate) fn safe_label(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `tugtool progress phase <label> <n> [<name>] [--of <names…>]`. Silent,
/// and always `Ok`: with no calling session nothing is kept and nothing is
/// sent. The report's line is the name, or the run's finish word.
pub fn run_phase(label: &str, n: usize, name: Option<&str>, of: &[String], needles: Vec<String>) {
    let Some(path) = phase_state_path(label) else {
        return;
    };
    let prior = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PhaseRun>(&bytes).ok());
    let run = PhaseRun::advance(prior, n, name, of, now_ms());
    let text = name.unwrap_or("done");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(&run) {
        let _ = std::fs::write(&path, bytes);
    }
    let _ = post_run_progress(&run.report(label, text, needles));
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

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_phased_run_starts_lands_and_finishes() {
        let of = names(&["build", "sign"]);
        let run = PhaseRun::advance(None, 0, Some("build"), &of, 1_000);
        assert_eq!(
            run.rows(),
            serde_json::json!([
                {"name": "build", "status": "running", "index": 0, "started_at_ms": 1_000},
                {"name": "sign", "status": "pending", "index": 1},
            ])
        );
        let report = run.report("build-app", "build", vec!["just x".into()]);
        assert_eq!(report.unit.as_deref(), Some("phase"));
        assert_eq!((report.done, report.total), (Some(0), Some(2)));
        assert_eq!(report.needles, vec!["just x".to_string()]);

        let run = PhaseRun::advance(Some(run), 1, Some("sign"), &of, 4_500);
        assert_eq!(
            run.rows(),
            serde_json::json!([
                {"name": "build", "status": "pass", "index": 0, "secs": 3},
                {"name": "sign", "status": "running", "index": 1, "started_at_ms": 4_500},
            ])
        );
        assert_eq!(run.report("build-app", "sign", vec![]).done, Some(1));

        // The finish: one start past the names, and every phase has landed.
        let run = PhaseRun::advance(Some(run), 2, Some("built"), &of, 6_000);
        assert_eq!(
            run.rows(),
            serde_json::json!([
                {"name": "build", "status": "pass", "index": 0, "secs": 3},
                {"name": "sign", "status": "pass", "index": 1, "secs": 1},
            ])
        );
        let report = run.report("build-app", "built", vec![]);
        assert_eq!((report.done, report.total), (Some(2), Some(2)));
    }

    #[test]
    fn a_rerun_under_the_same_label_starts_over() {
        let of = names(&["build", "sign"]);
        let run = PhaseRun::advance(None, 0, Some("build"), &of, 1_000);
        let run = PhaseRun::advance(Some(run), 1, Some("sign"), &of, 2_000);
        let run = PhaseRun::advance(Some(run), 2, Some("built"), &of, 3_000);
        let again = PhaseRun::advance(Some(run), 0, Some("build"), &of, 9_000);
        assert_eq!(again.started_ms, vec![9_000]);
        assert_eq!(again.rows()[0]["status"], "running");
        assert_eq!(again.rows()[1]["status"], "pending");
    }

    #[test]
    fn names_accumulate_when_the_list_is_not_given() {
        let run = PhaseRun::advance(None, 0, Some("fetch"), &[], 1_000);
        let run = PhaseRun::advance(Some(run), 1, Some("compile"), &[], 2_000);
        assert_eq!(run.names, names(&["fetch", "compile"]));
        assert_eq!(run.report("x", "compile", vec![]).total, Some(2));
        // A phase the recipe never reported as started is taken to begin now.
        let run = PhaseRun::advance(None, 2, Some("link"), &[], 5_000);
        assert_eq!(run.started_ms, vec![5_000, 5_000, 5_000]);
        assert_eq!(run.names, names(&["", "", "link"]));
        // Finishing with a bare `n`: no name is added, every phase lands.
        let run = PhaseRun::advance(Some(run), 3, None, &[], 6_000);
        assert_eq!(run.names.len(), 3);
        assert_eq!(run.report("x", "done", vec![]).done, Some(3));
    }

    #[test]
    fn the_list_given_once_is_kept_by_the_calls_after_it() {
        let of = names(&["a", "b", "c"]);
        let run = PhaseRun::advance(None, 0, Some("a"), &of, 1_000);
        let run = PhaseRun::advance(Some(run), 1, Some("b"), &[], 2_000);
        assert_eq!(run.names, of, "a name with no list sets, never cuts");
        assert_eq!(run.rows()[2]["status"], "pending");
        let run = PhaseRun::advance(Some(run), 3, None, &[], 4_000);
        assert_eq!(run.names, of);
        assert_eq!(run.report("x", "done", vec![]).done, Some(3));
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
        assert_eq!(
            read_units(dir.path().join("missing").to_str().unwrap()),
            None
        );
    }
}
