//! `tugtool report unit` — a loop over items draws the report panel one line
//! per item.
//!
//! `plan` declares the items, `start` and `done` move one, `amend` adds to a
//! landed one, and `finish` closes the run. Every call posts the whole run as
//! unit rows, so a shell loop never builds JSON: the verb is `report
//! phase`'s sibling for items, with two differences items need. Items run in
//! parallel, so the state is one file per item rather than one per run —
//! `start` and `done` each write their own item's file by rename, and nothing
//! is read-modified-written but the item's own row. And a run of many items
//! posts only the rows worth drawing once it is past what the panel draws
//! one by one.
//!
//! The row is the report panel's `RunUnit`: `name`, `status`, `index`, and
//! optionally `passed`, `total`, `secs`, `median`, `started_at_ms`, `title`,
//! `message`, `history`. Nothing here adds a field the panel does not read.
//!
//! Telemetry, like every `report` verb: silent, exit 0, and with no calling
//! session nothing is kept under the temp dir and nothing is sent.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::report::{RunReport, now_ms, post_report, safe_label};

/// Past this many items the panel draws a band rather than one cell per item
/// (`CELLS_UP_TO` in the deck's report-panel model), so a report past it carries
/// only the rows the band shows: the running ones and the reds.
pub const CELLS_UP_TO: usize = 64;

/// Where a row stands. The wire words are the lowercase names.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnitStatus {
    Pending,
    Running,
    Pass,
    Fail,
    Error,
    Skipped,
    Stalled,
}

impl UnitStatus {
    fn landed(self) -> bool {
        !matches!(self, UnitStatus::Pending | UnitStatus::Running)
    }

    fn red(self) -> bool {
        matches!(
            self,
            UnitStatus::Fail | UnitStatus::Error | UnitStatus::Stalled
        )
    }

    fn word(self) -> &'static str {
        match self {
            UnitStatus::Pending => "PENDING",
            UnitStatus::Running => "RUNNING",
            UnitStatus::Pass => "PASS",
            UnitStatus::Fail => "FAIL",
            UnitStatus::Error => "ERROR",
            UnitStatus::Skipped => "SKIPPED",
            UnitStatus::Stalled => "STALLED",
        }
    }
}

/// How an item landed, as `unit done` takes it. `stalled` is the one word for
/// an item stopped past its time; the older `wedged` is no status.
#[derive(Copy, Clone, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum LandedStatus {
    Pass,
    Fail,
    Error,
    Skipped,
    Stalled,
}

impl From<LandedStatus> for UnitStatus {
    fn from(status: LandedStatus) -> Self {
        match status {
            LandedStatus::Pass => UnitStatus::Pass,
            LandedStatus::Fail => UnitStatus::Fail,
            LandedStatus::Error => UnitStatus::Error,
            LandedStatus::Skipped => UnitStatus::Skipped,
            LandedStatus::Stalled => UnitStatus::Stalled,
        }
    }
}

/// What `plan` declared, kept in the run's `plan.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UnitPlan {
    pub label: String,
    /// The word the run counts in (`file`, `test`).
    pub unit: String,
    pub jobs: Option<u64>,
    pub needles: Vec<String>,
    pub names: Vec<String>,
    /// One per name: the median the pending row carries, if any.
    pub medians: Vec<Option<f64>>,
    pub created_ms: i64,
}

impl UnitPlan {
    /// A plan nobody declared: what a `start` or `done` on a fresh label
    /// begins from, so a loop that never planned still draws.
    fn unplanned(label: &str, now: i64) -> Self {
        UnitPlan {
            label: label.to_string(),
            unit: "test".into(),
            created_ms: now,
            ..UnitPlan::default()
        }
    }

    /// The index of `name`, appending it when the plan does not list it.
    fn index_of(&mut self, name: &str) -> usize {
        if let Some(i) = self.names.iter().position(|n| n == name) {
            return i;
        }
        self.names.push(name.to_string());
        self.medians.push(None);
        self.names.len() - 1
    }

    fn median(&self, index: usize) -> Option<f64> {
        self.medians.get(index).copied().flatten()
    }
}

/// One item's row, as posted and as kept in `units/<index>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnitRow {
    pub name: String,
    pub status: UnitStatus,
    pub index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub median: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<String>,
}

impl UnitRow {
    fn pending(name: &str, index: usize, median: Option<f64>) -> Self {
        UnitRow {
            name: name.to_string(),
            status: UnitStatus::Pending,
            index,
            passed: None,
            total: None,
            secs: None,
            median,
            started_at_ms: None,
            title: None,
            message: None,
            history: None,
        }
    }
}

/// How an item landed, as `done` reports it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Landing {
    pub secs: Option<f64>,
    pub passed: Option<u64>,
    pub total: Option<u64>,
    pub title: Option<String>,
    pub message: Option<String>,
}

/// What `amend` adds to a row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Amendment {
    pub history: Option<String>,
    pub message: Option<String>,
    pub title: Option<String>,
}

/// A run: its plan and the rows its items have written.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UnitRun {
    pub plan: UnitPlan,
    pub rows: BTreeMap<usize, UnitRow>,
}

impl UnitRun {
    /// Item `name` starts now. A plan's median rides the row unless `median`
    /// overrides it.
    pub fn start(&mut self, name: &str, median: Option<f64>, now: i64) -> usize {
        let index = self.plan.index_of(name);
        let mut row = UnitRow::pending(name, index, median.or(self.plan.median(index)));
        row.status = UnitStatus::Running;
        row.started_at_ms = Some(now);
        self.rows.insert(index, row);
        index
    }

    /// Item `name` landed. Its seconds are the ones given, else the time
    /// since it started, and a skipped item that was given none has none.
    /// Its counts ride only as a pair, and only when the item ran any tests.
    pub fn done(&mut self, name: &str, status: UnitStatus, landing: Landing, now: i64) -> usize {
        let index = self.plan.index_of(name);
        let median = self.plan.median(index);
        let row = self
            .rows
            .entry(index)
            .or_insert_with(|| UnitRow::pending(name, index, median));
        row.status = status;
        row.secs = match landing.secs {
            Some(secs) => Some(secs.max(0.0).round() as u64),
            None if status == UnitStatus::Skipped => None,
            None => row
                .started_at_ms
                .map(|started| ((now - started).max(0) / 1000) as u64),
        };
        if let (Some(passed), Some(total)) = (landing.passed, landing.total)
            && total > 0
        {
            row.passed = Some(passed);
            row.total = Some(total);
        }
        if landing.title.is_some() {
            row.title = landing.title;
        }
        if landing.message.is_some() {
            row.message = landing.message;
        }
        index
    }

    /// Add to a running or landed row; a pending or unknown one is left as it
    /// is. Answers the row's index when it was amended.
    pub fn amend(&mut self, name: &str, amendment: Amendment) -> Option<usize> {
        let index = self.plan.names.iter().position(|n| n == name)?;
        let row = self.rows.get_mut(&index)?;
        if row.status == UnitStatus::Pending {
            return None;
        }
        if amendment.history.is_some() {
            row.history = amendment.history;
        }
        if amendment.message.is_some() {
            row.message = amendment.message;
        }
        if amendment.title.is_some() {
            row.title = amendment.title;
        }
        Some(index)
    }

    /// Every row in plan order, a pending row for each name nobody has
    /// started.
    fn all_rows(&self) -> Vec<UnitRow> {
        self.plan
            .names
            .iter()
            .enumerate()
            .map(|(i, name)| {
                self.rows
                    .get(&i)
                    .cloned()
                    .unwrap_or_else(|| UnitRow::pending(name, i, self.plan.median(i)))
            })
            .collect()
    }

    /// The rows a report carries: all of them up to [`CELLS_UP_TO`], and past
    /// it only the ones that are neither pending nor passed.
    pub fn rows(&self) -> Vec<UnitRow> {
        let rows = self.all_rows();
        if self.plan.names.len() <= CELLS_UP_TO {
            return rows;
        }
        rows.into_iter()
            .filter(|r| !matches!(r.status, UnitStatus::Pending | UnitStatus::Pass))
            .collect()
    }

    /// The report this run makes, with `text` as its line.
    pub fn report(&self, text: &str) -> RunReport {
        let all = self.all_rows();
        let done = all.iter().filter(|r| r.status.landed()).count() as u64;
        let failures = all.iter().filter(|r| r.status.red()).count() as u64;
        RunReport {
            label: Some(self.plan.label.clone()),
            text: text.to_string(),
            done: Some(done),
            total: Some(all.len() as u64),
            failures: Some(failures),
            unit: Some(self.plan.unit.clone()),
            jobs: self.plan.jobs,
            units: serde_json::to_value(self.rows()).ok(),
            needles: self.plan.needles.clone(),
        }
    }

    /// The line a `done` posts when it is given none.
    fn done_text(&self, index: usize) -> String {
        let Some(row) = self.rows.get(&index) else {
            return String::new();
        };
        let mut text = format!("{} {}", row.name, row.status.word());
        if let (Some(passed), Some(total)) = (row.passed, row.total) {
            text.push_str(&format!(" ({passed}/{total})"));
        }
        if let Some(secs) = row.secs {
            text.push_str(&format!(" {secs}s"));
        }
        text
    }
}

/// The medians `plan` was given, one per name — a number, or `-` for none. A
/// list of the wrong length is ignored whole, since it cannot be lined up.
pub fn parse_medians(medians: &[String], names: usize) -> Vec<Option<f64>> {
    if medians.len() != names {
        return vec![None; names];
    }
    medians
        .iter()
        .map(|m| m.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0))
        .collect()
}

// ---------------------------------------------------------------------------
// The state directory
// ---------------------------------------------------------------------------

/// Where a run's state lives: a directory under the temp dir, keyed by the
/// calling session and the label, as a phased run's file is.
fn run_dir(label: &str) -> Option<PathBuf> {
    let token = crate::session_identity::calling_session_token()?;
    Some(
        std::env::temp_dir()
            .join("tug-report-unit")
            .join(format!("{token}-{}", safe_label(label))),
    )
}

/// Write `bytes` to `path` whole: a sibling temp file, then a rename, so a
/// reader in a parallel job sees the old file or the new one and never half
/// of either.
fn write_whole(path: &Path, bytes: &[u8]) {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn load(dir: &Path, label: &str, now: i64) -> UnitRun {
    let plan = std::fs::read(dir.join("plan.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<UnitPlan>(&bytes).ok())
        .unwrap_or_else(|| UnitPlan::unplanned(label, now));
    let mut rows = BTreeMap::new();
    if let Ok(entries) = std::fs::read_dir(dir.join("units")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            if let Some(row) = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<UnitRow>(&bytes).ok())
            {
                rows.insert(row.index, row);
            }
        }
    }
    UnitRun { plan, rows }
}

fn save_plan(dir: &Path, plan: &UnitPlan) {
    let _ = std::fs::create_dir_all(dir.join("units"));
    if let Ok(bytes) = serde_json::to_vec(plan) {
        write_whole(&dir.join("plan.json"), &bytes);
    }
}

fn save_row(dir: &Path, row: &UnitRow) {
    let _ = std::fs::create_dir_all(dir.join("units"));
    if let Ok(bytes) = serde_json::to_vec(row) {
        write_whole(
            &dir.join("units").join(format!("{}.json", row.index)),
            &bytes,
        );
    }
}

/// Post `run` under `text`, and remember the text for an `amend` that names
/// none.
fn post(dir: &Path, run: &UnitRun, text: &str) {
    write_whole(&dir.join("text"), text.as_bytes());
    let _ = post_report(&run.report(text));
}

fn last_text(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("text")).unwrap_or_default()
}

/// One `report unit` call, as the CLI hands it over.
pub enum UnitCall {
    Plan {
        label: String,
        text: Option<String>,
        unit: Option<String>,
        jobs: Option<u64>,
        needles: Vec<String>,
        medians: Vec<String>,
        of: Vec<String>,
    },
    Start {
        label: String,
        name: String,
        median: Option<f64>,
        text: Option<String>,
    },
    Done {
        label: String,
        name: String,
        status: LandedStatus,
        landing: Landing,
        text: Option<String>,
    },
    Amend {
        label: String,
        name: String,
        amendment: Amendment,
        text: Option<String>,
    },
    Finish {
        label: String,
        text: Option<String>,
    },
}

/// `tugtool report unit …`. Silent, and always `Ok`.
pub fn run_unit(call: UnitCall) {
    let label = match &call {
        UnitCall::Plan { label, .. }
        | UnitCall::Start { label, .. }
        | UnitCall::Done { label, .. }
        | UnitCall::Amend { label, .. }
        | UnitCall::Finish { label, .. } => label.clone(),
    };
    let Some(dir) = run_dir(&label) else {
        return;
    };
    let now = now_ms();
    match call {
        UnitCall::Plan {
            label,
            text,
            unit,
            jobs,
            needles,
            medians,
            of,
        } => {
            let _ = std::fs::remove_dir_all(&dir);
            let medians = parse_medians(&medians, of.len());
            let run = UnitRun {
                plan: UnitPlan {
                    label,
                    unit: unit.unwrap_or_else(|| "test".into()),
                    jobs,
                    needles,
                    names: of,
                    medians,
                    created_ms: now,
                },
                rows: BTreeMap::new(),
            };
            save_plan(&dir, &run.plan);
            let text =
                text.unwrap_or_else(|| format!("{} {}s", run.plan.names.len(), run.plan.unit));
            post(&dir, &run, &text);
        }
        UnitCall::Start {
            name, median, text, ..
        } => {
            let mut run = load(&dir, &label, now);
            let names = run.plan.names.len();
            let index = run.start(&name, median, now);
            if run.plan.names.len() != names {
                save_plan(&dir, &run.plan);
            }
            save_row(&dir, &run.rows[&index]);
            let text = text.unwrap_or_else(|| format!("{name} started"));
            post(&dir, &run, &text);
        }
        UnitCall::Done {
            name,
            status,
            landing,
            text,
            ..
        } => {
            let mut run = load(&dir, &label, now);
            let names = run.plan.names.len();
            let index = run.done(&name, status.into(), landing, now);
            if run.plan.names.len() != names {
                save_plan(&dir, &run.plan);
            }
            save_row(&dir, &run.rows[&index]);
            let text = text.unwrap_or_else(|| run.done_text(index));
            post(&dir, &run, &text);
        }
        UnitCall::Amend {
            name,
            amendment,
            text,
            ..
        } => {
            let mut run = load(&dir, &label, now);
            if let Some(index) = run.amend(&name, amendment) {
                save_row(&dir, &run.rows[&index]);
            }
            let text = text.unwrap_or_else(|| last_text(&dir));
            post(&dir, &run, &text);
        }
        UnitCall::Finish { text, .. } => {
            let run = load(&dir, &label, now);
            post(&dir, &run, text.as_deref().unwrap_or("done"));
        }
    }
}

/// `arc verify`'s report: one `surface` row per surface the range touched,
/// each landing with how many of its checks passed of how many it carries, so
/// the verify draws on its block while its checks run. Built from the
/// verify's own events, in process, rather than by shelling out to `report
/// unit`.
pub struct SurfaceReport {
    run: UnitRun,
}

impl SurfaceReport {
    pub fn new(needles: Vec<String>) -> Self {
        SurfaceReport {
            run: UnitRun {
                plan: UnitPlan {
                    label: "arc verify".into(),
                    unit: "surface".into(),
                    needles,
                    created_ms: now_ms(),
                    ..UnitPlan::default()
                },
                rows: BTreeMap::new(),
            },
        }
    }

    /// The report a verify event makes. A surface whose check failed is the
    /// red, titled with the check; one that declares no checks is skipped as
    /// claimed and unchecked, which is what the verify's table calls it.
    pub fn event(&mut self, event: tugarc_core::surfaces::VerifyEvent<'_>, now: i64) -> RunReport {
        use tugarc_core::surfaces::VerifyEvent;
        match event {
            VerifyEvent::Planned(surfaces) => {
                self.run.plan.names = surfaces.iter().map(|(name, _)| name.clone()).collect();
                self.run.plan.medians = vec![None; surfaces.len()];
                self.run
                    .report(&format!("{} surface(s) to check", surfaces.len()))
            }
            VerifyEvent::Started(name) => {
                self.run.start(name, None, now);
                self.run.report(&format!("checking {name}"))
            }
            VerifyEvent::Finished(result) => {
                let total = result.commands.len() as u64;
                let passed = result
                    .commands
                    .iter()
                    .filter(|c| c.status == "already-run" || c.exit_code == Some(0))
                    .count() as u64;
                let failed = result
                    .commands
                    .iter()
                    .find(|c| c.exit_code.is_some_and(|code| code != 0));
                let (status, title, message) = match failed {
                    Some(c) => (
                        UnitStatus::Fail,
                        Some(c.command.clone()),
                        Some(format!("exit {}", c.exit_code.unwrap_or(-1))),
                    ),
                    None if total == 0 => (
                        UnitStatus::Skipped,
                        None,
                        Some("claimed, unchecked".to_string()),
                    ),
                    None => (UnitStatus::Pass, None, None),
                };
                let landing = Landing {
                    secs: None,
                    passed: Some(passed),
                    total: Some(total),
                    title,
                    message,
                };
                let index = self.run.done(&result.name, status, landing, now);
                self.run.report(&self.run.done_text(index))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verify_draws_one_surface_row_per_surface_with_its_checks() {
        use tugarc_core::surfaces::{CommandResult, SurfaceResult, VerifyEvent};
        let ran = |command: &str, exit: i32| CommandResult {
            command: command.into(),
            declared_by: "x".into(),
            status: "ran".into(),
            exit_code: Some(exit),
            already_run_for: None,
        };
        let surface = |name: &str, commands: Vec<CommandResult>| SurfaceResult {
            name: name.into(),
            paths: vec![],
            red: commands.iter().any(|c| c.exit_code.is_some_and(|e| e != 0)),
            commands,
            borrowed_from: vec![],
        };
        let mut report = SurfaceReport::new(vec!["arc verify".into()]);
        let planned = [
            ("rust".to_string(), 2),
            ("docs".to_string(), 1),
            ("notes".to_string(), 0),
        ];
        let first = report.event(VerifyEvent::Planned(&planned), 1_000);
        assert_eq!(first.label.as_deref(), Some("arc verify"));
        assert_eq!(first.unit.as_deref(), Some("surface"));
        assert_eq!((first.done, first.total), (Some(0), Some(3)));

        report.event(VerifyEvent::Started("rust"), 1_000);
        let rust = surface(
            "rust",
            vec![ran("cargo nextest run", 0), ran("cargo clippy", 0)],
        );
        let landed = report.event(VerifyEvent::Finished(&rust), 4_000);
        assert_eq!(landed.text, "rust PASS (2/2) 3s");

        report.event(VerifyEvent::Started("docs"), 4_000);
        let docs = surface("docs", vec![ran("just lint-docs", 2)]);
        report.event(VerifyEvent::Finished(&docs), 5_000);
        report.event(VerifyEvent::Started("notes"), 5_000);
        let last = report.event(VerifyEvent::Finished(&surface("notes", vec![])), 5_000);

        assert_eq!(
            (last.done, last.total, last.failures),
            (Some(3), Some(3), Some(1))
        );
        let rows = last.units.unwrap();
        assert_eq!(rows[1]["status"], "fail");
        assert_eq!(rows[1]["title"], "just lint-docs");
        assert_eq!(rows[1]["message"], "exit 2");
        assert_eq!(
            (rows[1]["passed"].clone(), rows[1]["total"].clone()),
            (0.into(), 1.into())
        );
        assert_eq!(rows[2]["status"], "skipped");
        assert_eq!(rows[2]["message"], "claimed, unchecked");
        assert_eq!(last.needles, vec!["arc verify".to_string()]);
    }

    fn planned(names: &[&str], medians: &[&str]) -> UnitRun {
        let names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        let medians: Vec<String> = medians.iter().map(|s| s.to_string()).collect();
        UnitRun {
            plan: UnitPlan {
                label: "app-test".into(),
                unit: "file".into(),
                jobs: Some(4),
                needles: vec!["just app-test".into()],
                medians: parse_medians(&medians, names.len()),
                names,
                created_ms: 0,
            },
            rows: BTreeMap::new(),
        }
    }

    fn statuses(run: &UnitRun) -> Vec<UnitStatus> {
        run.rows().iter().map(|r| r.status).collect()
    }

    #[test]
    fn a_plan_then_a_start_then_a_done_draws_pass_running_pending() {
        let mut run = planned(&["a", "b", "c"], &[]);
        run.start("a", None, 1_000);
        run.done("a", UnitStatus::Pass, Landing::default(), 4_600);
        run.start("b", None, 5_000);
        assert_eq!(
            statuses(&run),
            [UnitStatus::Pass, UnitStatus::Running, UnitStatus::Pending]
        );
        let rows = run.rows();
        assert_eq!(rows[0].secs, Some(3), "seconds from the start");
        assert_eq!(rows[0].started_at_ms, Some(1_000));
        assert_eq!(rows[1].started_at_ms, Some(5_000));
        assert_eq!(rows.iter().map(|r| r.index).collect::<Vec<_>>(), [0, 1, 2]);

        let report = run.report("b started");
        assert_eq!(
            (report.done, report.total, report.failures),
            (Some(1), Some(3), Some(0))
        );
        assert_eq!(report.unit.as_deref(), Some("file"));
        assert_eq!(report.jobs, Some(4));
        assert_eq!(report.needles, ["just app-test"]);
        assert_eq!(
            report.units.unwrap()[2],
            serde_json::json!({"name": "c", "status": "pending", "index": 2})
        );
    }

    #[test]
    fn a_done_carries_what_it_was_given_and_its_default_line() {
        let mut run = planned(&["a"], &[]);
        run.start("a", Some(6.5), 0);
        let index = run.done(
            "a",
            UnitStatus::Fail,
            Landing {
                secs: Some(12.0),
                passed: Some(3),
                total: Some(4),
                title: Some("drag".into()),
                message: Some("expected 1".into()),
            },
            99_000,
        );
        let row = &run.rows[&index];
        assert_eq!(row.secs, Some(12), "the given seconds win");
        assert_eq!((row.passed, row.total), (Some(3), Some(4)));
        assert_eq!(row.median, Some(6.5));
        assert_eq!(row.title.as_deref(), Some("drag"));
        assert_eq!(run.done_text(index), "a FAIL (3/4) 12s");
        assert_eq!(run.report("x").failures, Some(1));
    }

    #[test]
    fn counts_of_nothing_are_left_off_and_a_skip_has_no_seconds() {
        let mut run = planned(&["a", "b"], &[]);
        run.start("a", None, 0);
        let a = run.done(
            "a",
            UnitStatus::Error,
            Landing {
                passed: Some(0),
                total: Some(0),
                ..Landing::default()
            },
            2_000,
        );
        assert_eq!((run.rows[&a].passed, run.rows[&a].total), (None, None));
        let b = run.done("b", UnitStatus::Skipped, Landing::default(), 9_000);
        assert_eq!(run.rows[&b].secs, None);
        assert_eq!(run.done_text(b), "b SKIPPED");
    }

    #[test]
    fn amend_adds_history_and_leaves_the_status() {
        let mut run = planned(&["a", "b"], &[]);
        run.start("a", None, 0);
        run.done("a", UnitStatus::Fail, Landing::default(), 1_000);
        let amended = run.amend(
            "a",
            Amendment {
                history: Some("green 3 runs ago".into()),
                ..Amendment::default()
            },
        );
        assert_eq!(amended, Some(0));
        assert_eq!(run.rows[&0].status, UnitStatus::Fail);
        assert_eq!(run.rows[&0].history.as_deref(), Some("green 3 runs ago"));
        // A pending row, or a name the plan lacks, is not amended.
        assert_eq!(run.amend("b", Amendment::default()), None);
        assert_eq!(run.amend("zz", Amendment::default()), None);
    }

    #[test]
    fn past_sixty_four_only_the_running_and_the_reds_ride() {
        let names: Vec<String> = (0..65).map(|i| format!("f{i}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut run = planned(&refs, &[]);
        run.start("f0", None, 0);
        run.done("f0", UnitStatus::Pass, Landing::default(), 1_000);
        run.start("f1", None, 0);
        run.done("f1", UnitStatus::Fail, Landing::default(), 1_000);
        run.start("f2", None, 0);
        run.start("f3", None, 0);
        run.done("f3", UnitStatus::Stalled, Landing::default(), 1_000);
        let rows = run.rows();
        assert_eq!(
            rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["f1", "f2", "f3"]
        );
        let report = run.report("x");
        assert_eq!(
            (report.done, report.total, report.failures),
            (Some(3), Some(65), Some(2)),
            "the counts are over every row, thinned or not"
        );
        // At sixty-four every row still rides.
        let mut run = planned(&refs[..64], &[]);
        run.start("f0", None, 0);
        assert_eq!(run.rows().len(), 64);
    }

    #[test]
    fn wedged_is_no_landed_status() {
        use clap::ValueEnum;
        assert!(LandedStatus::from_str("wedged", false).is_err());
        let status = LandedStatus::from_str("stalled", false).unwrap();
        assert_eq!(
            serde_json::to_value(UnitStatus::from(status)).unwrap(),
            "stalled"
        );
    }

    #[test]
    fn a_start_of_an_unplanned_name_appends_at_the_next_index() {
        let mut run = planned(&["a", "b"], &[]);
        assert_eq!(run.start("late", None, 0), 2);
        assert_eq!(run.plan.names, ["a", "b", "late"]);
        assert_eq!(run.report("x").total, Some(3));
        // A loop that never planned at all draws from its first start.
        let mut run = UnitRun {
            plan: UnitPlan::unplanned("loop", 0),
            rows: BTreeMap::new(),
        };
        assert_eq!(run.start("only", None, 0), 0);
        assert_eq!(statuses(&run), [UnitStatus::Running]);
    }

    #[test]
    fn plan_medians_sit_on_pending_rows_and_a_misfit_list_is_ignored() {
        let run = planned(&["a", "b", "c"], &["12", "-", "3.5"]);
        let rows = run.rows();
        assert_eq!(rows[0].median, Some(12.0));
        assert_eq!(rows[1].median, None);
        assert_eq!(rows[2].median, Some(3.5));
        assert_eq!(
            serde_json::to_value(&rows[1]).unwrap(),
            serde_json::json!({"name": "b", "status": "pending", "index": 1})
        );
        // A start keeps the plan's median unless it names its own.
        let mut started = run.clone();
        started.start("a", None, 0);
        started.start("c", Some(4.0), 0);
        assert_eq!(started.rows[&0].median, Some(12.0));
        assert_eq!(started.rows[&2].median, Some(4.0));

        let misfit = planned(&["a", "b", "c"], &["12", "3"]);
        assert!(misfit.rows().iter().all(|r| r.median.is_none()));
    }
}
