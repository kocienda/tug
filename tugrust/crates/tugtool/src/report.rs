//! `tugtool report` — a running command tells the block it runs under how far
//! it has got.
//!
//! The report goes to the instance that owns the calling session, as
//! `POST /api/session {op: "report"}`, which attaches it to the Bash
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
    /// one is drawn as a report panel; one that does not is the one line.
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
    /// Whether this run is a parent whose units are themselves runs: a report
    /// under another label arriving while it holds the call is its running
    /// unit's child, drawn beneath it, rather than a report that replaces it.
    pub nests: bool,
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

/// The call this process runs under: `TUG_TOOL_USE_ID` when a probe or a
/// harness exported it, else the id the nearest ancestor shell's command is
/// marked with (`tugcore::call_id`) — read here so attachment is exact with
/// no further change. A variable that is set, even to nothing, is the
/// spawner's word: an empty value says "under no call", which is how a test
/// run from a Bash call of its own keeps that call's mark out of its rows.
pub(crate) fn tool_use_id() -> Option<String> {
    let exported = ["TUG_TOOL_USE_ID", "CLAUDE_CODE_TOOL_USE_ID"]
        .iter()
        .find_map(|key| std::env::var(key).ok());
    match exported {
        Some(id) => Some(id).filter(|v| !v.is_empty()),
        None => tugcore::call_id::ancestor_call_id(),
    }
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
    if report.nests {
        fields.insert("nests".into(), true.into());
    }
    fields.insert("needles".into(), report.needles.clone().into());
    serde_json::Value::Object(fields)
}

/// Post one report. Answers the live session the owning instance attached it
/// under, or `None` when there was no session, no instance, or no `ok`.
pub fn post_report(report: &RunReport) -> Option<String> {
    let answer = tell_calling_session("report", report_fields(report, tool_use_id()))?;
    answer
        .ok()?
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(str::to_string)
}

/// `tugtool report gaps`: the record of long Bash calls that reported no
/// unit, one line per command head, most frequent first. A reader of the
/// machine-global record, which tugcast writes; an absent record is an
/// empty listing rather than an error.
pub fn run_report_gaps(json: bool) {
    let path = tugcore::report_gaps::ReportGaps::default_path();
    let listing = gap_listing(tugcore::report_gaps::summarize(&path), |dir| {
        crate::runners::for_cwd(Some(dir))
    });
    if json {
        #[derive(serde::Serialize)]
        struct Report<'a> {
            path: String,
            #[serde(flatten)]
            listing: &'a GapListing,
        }
        crate::output::print_ok(
            "report gaps",
            Report {
                path: path.display().to_string(),
                listing: &listing,
            },
        );
        return;
    }
    if listing.gaps.is_empty() && listing.stalled.is_empty() {
        println!("no long unreported runs recorded");
        return;
    }
    if !listing.gaps.is_empty() {
        println!("{:<6} {:>9} {:>9}  head", "runs", "total", "median");
        for gap in &listing.gaps {
            println!(
                "{:<6} {:>9} {:>9}  {}{}",
                gap.summary.count,
                format_duration_ms(gap.summary.total_ms),
                format_duration_ms(gap.summary.median_ms),
                gap.summary.head,
                if gap.declared {
                    "  (declared, still silent)"
                } else {
                    ""
                }
            );
        }
    }
    if !listing.stalled.is_empty() {
        if !listing.gaps.is_empty() {
            println!();
        }
        println!("stalled calls — quick commands that hung, not reports due:");
        println!("{:<6} {:>9} {:>9}  head", "runs", "longest", "median");
        for gap in &listing.stalled {
            println!(
                "{:<6} {:>9} {:>9}  {}",
                gap.summary.count,
                format_duration_ms(gap.summary.max_ms),
                format_duration_ms(gap.summary.median_ms),
                gap.summary.head
            );
        }
    }
}

/// One head in the listing: its standing, and whether the runner table its
/// latest call ran under names it — a runner the hook knows that ran dark
/// all the same, behind a heredoc or by a row that does not report.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapLine {
    #[serde(flatten)]
    pub summary: tugcore::report_gaps::GapSummary,
    pub declared: bool,
}

/// The record read two ways: the gaps, where the next report pays, and the
/// stalled calls, where a quick command hung.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct GapListing {
    pub gaps: Vec<GapLine>,
    pub stalled: Vec<GapLine>,
}

/// Split the summaries into gaps and stalled calls, marking each whose latest
/// command a runner in `runners_for(its project)` matches.
pub(crate) fn gap_listing(
    summaries: Vec<tugcore::report_gaps::GapSummary>,
    runners_for: impl Fn(&str) -> Vec<crate::runners::RunnerSpec>,
) -> GapListing {
    let mut tables: std::collections::HashMap<String, Vec<crate::runners::RunnerSpec>> =
        std::collections::HashMap::new();
    let mut listing = GapListing::default();
    for summary in summaries {
        let runners = tables
            .entry(summary.last_project_dir.clone())
            .or_insert_with(|| runners_for(&summary.last_project_dir));
        let words = tugcore::report_gaps::command_words(&summary.last_command);
        let declared = runners.iter().any(|spec| spec.matches(&words));
        let stalled = summary.stalled();
        let line = GapLine { summary, declared };
        if stalled {
            listing.stalled.push(line);
        } else {
            listing.gaps.push(line);
        }
    }
    listing
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

/// The longest probe line a wait's report carries.
const WAIT_LINE_CHARS: usize = 120;

/// The last non-empty line a probe printed — stdout's, else stderr's —
/// trimmed and cut to [`WAIT_LINE_CHARS`].
fn last_probe_line(stdout: &[u8], stderr: &[u8]) -> String {
    let last = |bytes: &[u8]| {
        String::from_utf8_lossy(bytes)
            .lines()
            .rev()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_string)
    };
    let line = last(stdout).or_else(|| last(stderr)).unwrap_or_default();
    match line.char_indices().nth(WAIT_LINE_CHARS) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line,
    }
}

/// A wait's line: how long it has waited or that the condition held, and
/// the probe's last output.
fn wait_text(elapsed: std::time::Duration, held: bool, last: &str) -> String {
    let took = format_duration_ms(elapsed.as_millis() as i64);
    let head = if held {
        format!("held after {took}")
    } else {
        format!("waiting {took}")
    };
    if last.is_empty() {
        head
    } else {
        format!("{head} · {last}")
    }
}

/// `tugtool report wait`: probe until the condition holds or the deadline
/// passes, posting each probe as a report with no total — unit `probe`,
/// `done` the probes run — so the block shows the wait as it goes and the
/// call is not recorded as one that ran silent. The exit code is the
/// wait's, not telemetry's: 0 when the probe exits 0, 1 at the deadline.
/// The reports themselves stay telemetry, made only with a calling session.
pub fn run_wait(label: &str, until: &str, every: f64, limit: f64, needles: Vec<String>) -> u8 {
    use std::time::{Duration, Instant};
    let every = Duration::from_secs_f64(every.max(0.05));
    let limit = Duration::from_secs_f64(limit.max(0.0));
    let reporting = have_calling_session();
    let started = Instant::now();
    let mut probes = 0u64;
    loop {
        let probe = std::process::Command::new("sh")
            .arg("-c")
            .arg(until)
            .stdin(std::process::Stdio::null())
            .output();
        probes += 1;
        let (held, last) = match &probe {
            Ok(out) => (
                out.status.success(),
                last_probe_line(&out.stdout, &out.stderr),
            ),
            Err(err) => (false, format!("cannot run sh: {err}")),
        };
        let elapsed = started.elapsed();
        if reporting {
            let _ = post_report(&RunReport {
                label: Some(label.to_string()),
                text: wait_text(elapsed, held, &last),
                done: Some(probes),
                unit: Some("probe".into()),
                needles: needles.clone(),
                ..RunReport::default()
            });
        }
        if held {
            return 0;
        }
        if elapsed >= limit {
            let limit = format_duration_ms(limit.as_millis() as i64);
            let last = if last.is_empty() {
                "(no output)"
            } else {
                last.as_str()
            };
            eprintln!(
                "report wait: {label} did not hold within {limit} ({probes} probes); last probe: {last}"
            );
            return 1;
        }
        std::thread::sleep(every.min(limit - elapsed));
    }
}

/// `tugtool report count`. Silent, and always `Ok`.
pub fn run(report: RunReport) {
    if !have_calling_session() {
        return;
    }
    let _ = post_report(&report);
}

/// A phased run, as `report phase` keeps it between a recipe's calls: the
/// phase names, and when each phase so far began. The last start is the
/// running phase's; when there is one start per name plus one, the run is
/// finished and that last start is its end.
///
/// A recipe writes one line per phase (`report phase <label> <n> <name>`),
/// and this is what turns those lines into the rows the report panel draws —
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
            nests: false,
        }
    }

    /// The report of a run that stopped in its running phase rather than
    /// finishing: that row lands as `status` (`fail` for a red stop, `pass`
    /// for one that declined), the phases after it are `skipped`, and a red
    /// stop counts its one failure.
    pub fn stopped_report(
        &self,
        label: &str,
        text: &str,
        status: &str,
        needles: Vec<String>,
        now_ms: i64,
    ) -> RunReport {
        let running = self.running();
        let mut report = self.report(label, text, needles);
        if let Some(serde_json::Value::Array(rows)) = report.units.as_mut() {
            for (i, row) in rows.iter_mut().enumerate() {
                if i == running {
                    let started = self.started_ms.get(i).copied().unwrap_or(now_ms);
                    row["status"] = status.into();
                    row["secs"] = ((now_ms - started).max(0) / 1000).into();
                    if let Some(row) = row.as_object_mut() {
                        row.remove("started_at_ms");
                    }
                } else if i > running {
                    row["status"] = "skipped".into();
                }
            }
        }
        report.done = report.total;
        report.failures = (status == "fail").then_some(1);
        report
    }
}

/// Where a phased run's state lives: a small file under the temp dir, keyed
/// by the calling session and the label, so two recipes in one session, or
/// one recipe in two sessions, never share a run.
fn phase_state_path(label: &str) -> Option<std::path::PathBuf> {
    let token = crate::session_identity::calling_session_token()?;
    Some(
        std::env::temp_dir()
            .join("tug-report-phase")
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

/// `tugtool report phase <label> <n> [<name>] [--of <names…>]`. Silent,
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
    let _ = post_report(&run.report(label, text, needles));
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
        assert!(
            fields.get("nests").is_none(),
            "a run that does not nest says nothing"
        );
        let nesting = report_fields(
            &RunReport {
                text: "checking rust".into(),
                unit: Some("surface".into()),
                nests: true,
                ..RunReport::default()
            },
            None,
        );
        assert_eq!(nesting["nests"], true);
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_gap_listing_splits_stalled_calls_and_marks_declared_runners() {
        let summary = |head: &str, command: &str, median_ms: i64, max_ms: i64| {
            tugcore::report_gaps::GapSummary {
                head: head.into(),
                count: 3,
                total_ms: max_ms * 3,
                last_ended_at_ms: 1,
                max_ms,
                median_ms,
                calls: 3,
                last_command: command.into(),
                last_project_dir: "/p".into(),
            }
        };
        let listing = gap_listing(
            vec![
                // A built-in runner, behind a heredoc the hook could not read.
                summary(
                    "cargo nextest",
                    "# tug-call: t\ncd tugrust && cargo nextest run -p x",
                    40_000,
                    60_000,
                ),
                summary(
                    "until grep",
                    "until grep -q ready log; do sleep 1; done",
                    90_000,
                    240_000,
                ),
                summary("grep -rn", "grep -rn needle .", 800, 420_000),
            ],
            |_| crate::runners::built_in(),
        );
        let heads = |lines: &[GapLine]| -> Vec<(String, bool)> {
            lines
                .iter()
                .map(|l| (l.summary.head.clone(), l.declared))
                .collect()
        };
        assert_eq!(
            heads(&listing.gaps),
            vec![("cargo nextest".into(), true), ("until grep".into(), false)]
        );
        assert_eq!(heads(&listing.stalled), vec![("grep -rn".into(), false)]);
        let json = serde_json::to_value(&listing).unwrap();
        assert_eq!(json["gaps"][0]["declared"], true);
        assert_eq!(json["gaps"][0]["medianMs"], 40_000);
        assert_eq!(json["stalled"][0]["head"], "grep -rn");
    }

    #[test]
    fn a_run_stopped_in_a_phase_lands_that_phase_and_skips_the_rest() {
        let of = names(&["check", "replay", "land"]);
        let run = PhaseRun::advance(None, 0, Some("check"), &of, 1_000);
        let run = PhaseRun::advance(Some(run), 1, Some("replay"), &of, 2_000);

        let red = run.stopped_report("arc replay", "conflicts at add g", "fail", vec![], 5_500);
        assert_eq!(
            red.units.unwrap(),
            serde_json::json!([
                {"name": "check", "status": "pass", "index": 0, "secs": 1},
                {"name": "replay", "status": "fail", "index": 1, "secs": 3},
                {"name": "land", "status": "skipped", "index": 2},
            ])
        );
        assert_eq!(
            (red.done, red.total, red.failures),
            (Some(3), Some(3), Some(1))
        );

        let declined = PhaseRun::advance(None, 0, Some("check"), &of, 1_000).stopped_report(
            "arc replay",
            "deferred: dirty",
            "pass",
            vec![],
            1_200,
        );
        assert_eq!(declined.failures, None);
        assert_eq!(declined.units.unwrap()[2]["status"], "skipped");
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
    fn a_wait_says_how_long_and_what_the_probe_last_said() {
        use std::time::Duration;
        assert_eq!(
            wait_text(Duration::from_secs(12), false, "2 of 3 ready"),
            "waiting 12s · 2 of 3 ready"
        );
        assert_eq!(
            wait_text(Duration::from_secs(95), true, ""),
            "held after 1m 35s"
        );
        assert_eq!(last_probe_line(b"a\nb\n\n", b"err"), "b");
        assert_eq!(last_probe_line(b"", b"only on stderr\n"), "only on stderr");
        let long = "x".repeat(200);
        let cut = last_probe_line(long.as_bytes(), b"");
        assert_eq!(cut.chars().count(), WAIT_LINE_CHARS + 1);
        assert!(cut.ends_with('…'));
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
