//! The fold of one Bash call's progress reports into its runs.
//!
//! A call may carry several runs: a build's phases and then its files, a
//! verify and the test runs each of its surfaces wraps, a loop planned twice
//! under one label. Each is its own run, keyed by the `run_id` its reporter
//! minted, and **a run id owns its rows**: a report folds into its own run
//! and nothing it says can touch another's. A report with no id is keyed by
//! its label (`label:<label>`), which is the one-run-per-label behaviour a
//! reporter that mints no id has always had.
//!
//! A run is numbered by its first report (`ord`), stamped with tugcast's
//! clock at that report (`first_at_ms`), and, when it first reports while
//! another run on the call nests and has a unit running, named under that
//! unit (`under`). The child is a separate process that cannot know which row
//! it runs under; the call's fold sees both, so it is the one place that can
//! say, and it says once: `under` never changes after the run's first report.
//!
//! A run's reports may arrive out of order — a parallel loop's two `done`s
//! race to post, and the later post can carry the earlier snapshot — so the
//! fold **merges** rather than replaces, and a landed row is final. A row is
//! keyed by its `index`; its status only moves forward (pending, running,
//! landed), a landed row keeps its status and takes only an amend's
//! `history`, `title` and `message`, and a row the latest snapshot lacks is
//! kept. The run's counts are read back from the merged rows, so `done`
//! never falls. A run that lists only some rows (a test run's reds) cannot
//! be merged row by row: its rows are the snapshot with the larger count,
//! and its counts never step back.
//!
//! Every fold of a call stamps the run with the call's next `seq`, so the
//! deck can drop a frame older than the one it holds.
//!
//! Pure: no clock, no IO. The supervisor holds one [`CallRuns`] per open call
//! and folds every report attached to that call through it.

use super::agent_supervisor::Report;

/// One run's latest state, as the call's fold holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunState {
    /// The reporter's id, or `label:<label>` for a reporter that sent none.
    pub run_id: String,
    /// The run's 0-based place among the call's runs, by first report.
    pub ord: u64,
    pub label: Option<String>,
    pub text: String,
    pub done: Option<u64>,
    pub total: Option<u64>,
    pub failures: Option<u64>,
    pub unit: Option<String>,
    pub jobs: Option<u64>,
    /// Sticky: once a run has said it nests, it is a parent for good.
    pub nests: bool,
    /// Sticky: once a run has said it finished, it has.
    pub finished: bool,
    /// The parent run and the slot of the unit this run ran under, fixed at
    /// the run's first report.
    pub under: Option<(String, u64)>,
    pub units: Option<serde_json::Value>,
    /// tugcast's clock at the run's first report.
    pub first_at_ms: i64,
    /// tugcast's clock at the run's latest report.
    pub at_ms: i64,
    /// The call's fold count at the run's latest report: rises with every
    /// fold of the call, so a later frame of a run always carries a larger
    /// one. 0 for a run no call folded.
    pub seq: u64,
}

/// The key a report folds under: its run id, else its label.
pub fn run_key(report: &Report) -> String {
    match report.run_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => id.to_string(),
        None => format!("label:{}", report.label.as_deref().unwrap_or("")),
    }
}

impl RunState {
    /// A run that has not been folded into any call: an unattached report,
    /// published as it came, under its key.
    pub fn unfolded(report: &Report, at_ms: i64) -> RunState {
        let mut run = RunState {
            run_id: run_key(report),
            first_at_ms: at_ms,
            ..RunState::default()
        };
        run.take(report, at_ms);
        run
    }

    /// The run's **body**: a `report` frame's object without its `type`,
    /// `tug_session_id` and `tool_use_id`, absent fields omitted. `folded`
    /// says the run went through a call's fold, which is what gives it a
    /// place (`run_ord`), a first report, a `seq` and a parent unit. The
    /// live frame and a call's recorded runs are both built from this, so
    /// the two cannot drift.
    pub fn body(&self, folded: bool) -> serde_json::Map<String, serde_json::Value> {
        let mut body = serde_json::Map::new();
        body.insert("run_id".into(), self.run_id.clone().into());
        if folded {
            body.insert("run_ord".into(), self.ord.into());
            body.insert("first_at_ms".into(), self.first_at_ms.into());
            body.insert("seq".into(), self.seq.into());
            if let Some((parent, slot)) = &self.under {
                body.insert(
                    "under".into(),
                    serde_json::json!({"run_id": parent, "slot": slot}),
                );
            }
        }
        if let Some(label) = &self.label {
            body.insert("label".into(), label.clone().into());
        }
        body.insert("text".into(), self.text.clone().into());
        for (key, value) in [
            ("done", self.done),
            ("total", self.total),
            ("failures", self.failures),
            ("jobs", self.jobs),
        ] {
            if let Some(n) = value {
                body.insert(key.into(), n.into());
            }
        }
        if let Some(unit) = &self.unit {
            body.insert("unit".into(), unit.clone().into());
        }
        if let Some(units) = &self.units {
            body.insert("units".into(), units.clone());
        }
        if self.nests {
            body.insert("nests".into(), true.into());
        }
        if self.finished {
            body.insert("finished".into(), true.into());
        }
        body.insert("at_ms".into(), self.at_ms.into());
        body
    }

    /// Take the report's fields whole, keeping what is sticky: the first
    /// report of a run no call holds.
    fn take(&mut self, report: &Report, at_ms: i64) {
        self.label = report.label.clone();
        self.text = report.text.clone();
        self.done = report.done;
        self.total = report.total;
        self.failures = report.failures;
        self.unit = report.unit.clone();
        self.jobs = report.jobs;
        self.units = report.units.clone();
        self.nests |= report.nests;
        self.finished |= report.finished;
        self.at_ms = at_ms;
    }

    /// Merge a report into the run as held: rows move only forward, a
    /// landed row is final, and the counts never step back.
    fn merge(&mut self, report: &Report, at_ms: i64) {
        self.text = report.text.clone();
        if report.label.is_some() {
            self.label = report.label.clone();
        }
        if report.unit.is_some() {
            self.unit = report.unit.clone();
        }
        if report.jobs.is_some() {
            self.jobs = report.jobs;
        }
        self.nests |= report.nests;
        self.finished |= report.finished;
        self.at_ms = at_ms;
        match listed_rows(report) {
            Some(incoming) => self.merge_listed(incoming, report.total),
            None => self.merge_partial(report),
        }
    }

    /// A listed report: merge row by row, then read the counts back.
    fn merge_listed(&mut self, incoming: &[serde_json::Value], reported_total: Option<u64>) {
        let mut rows: std::collections::BTreeMap<u64, serde_json::Value> = self
            .units
            .as_ref()
            .and_then(|units| units.as_array())
            .map(|held| keyed(held))
            .unwrap_or_default();
        for (key, row) in keyed(incoming) {
            let merged = match rows.remove(&key) {
                Some(held) => merge_row(held, row),
                None => row,
            };
            rows.insert(key, merged);
        }
        let rows: Vec<serde_json::Value> = rows.into_values().collect();
        let landed = rows.iter().filter(|row| rank(row) == LANDED).count() as u64;
        let red = rows
            .iter()
            .filter(|row| matches!(status(row), Some("fail" | "error" | "stalled")))
            .count() as u64;
        let count = rows.len() as u64;
        self.done = Some(landed);
        self.failures = Some(red);
        self.total = Some(reported_total.map_or(count, |t| t.max(count)));
        self.units = Some(serde_json::Value::Array(rows));
    }

    /// A report that lists only some rows: the snapshot with the larger
    /// count wins its rows, and no count steps back.
    fn merge_partial(&mut self, report: &Report) {
        if report.done.unwrap_or(0) >= self.done.unwrap_or(0) {
            self.units = report.units.clone();
        }
        self.done = max_of(self.done, report.done);
        self.failures = max_of(self.failures, report.failures);
        if report.total.is_some() {
            self.total = report.total;
        }
    }

    /// The slot of the unit this run has running, when it has one: the
    /// running row that started last, ties to the higher index.
    fn running_slot(&self) -> Option<u64> {
        let rows = self.units.as_ref()?.as_array()?;
        rows.iter()
            .filter(|row| row.get("status").and_then(|s| s.as_str()) == Some("running"))
            .filter_map(|row| {
                let index = row.get("index")?.as_u64()?;
                let started = row
                    .get("started_at_ms")
                    .and_then(|s| s.as_i64())
                    .unwrap_or(i64::MIN);
                Some((started, index))
            })
            .max()
            .map(|(_, index)| index)
    }
}

/// Every run one call has reported, in first-report order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallRuns {
    pub runs: Vec<RunState>,
    /// How many reports the call has folded: the `seq` the latest carried.
    pub seq: u64,
}

impl CallRuns {
    /// Fold `report` into its run, opening the run at its first report, and
    /// answer the run as it now stands.
    pub fn fold(&mut self, report: &Report, at_ms: i64) -> &RunState {
        let key = run_key(report);
        let at = match self.runs.iter().position(|run| run.run_id == key) {
            Some(at) => at,
            None => {
                // The parent is the latest-opened run that nests and has a
                // unit running now, at the child's first report.
                let under = self
                    .runs
                    .iter()
                    .rev()
                    .filter(|run| run.nests)
                    .find_map(|run| run.running_slot().map(|slot| (run.run_id.clone(), slot)));
                self.runs.push(RunState {
                    run_id: key,
                    ord: self.runs.len() as u64,
                    under,
                    first_at_ms: at_ms,
                    ..RunState::default()
                });
                self.runs.len() - 1
            }
        };
        self.seq += 1;
        let run = &mut self.runs[at];
        run.merge(report, at_ms);
        run.seq = self.seq;
        run
    }

    /// The call's runs as they ended, for the ledger: the bodies of every
    /// run that named a unit, in `ord` order, as one JSON array. `None` when
    /// no run named one — a call that only ever said a line has no panel to
    /// give back. Past [`SETTLED_RUNS_CAP_BYTES`] every row's `message` is
    /// dropped, which keeps the cells, verdicts and titles; a call still past
    /// it is not recorded, and says so.
    pub fn settled_json(&self) -> Option<Vec<u8>> {
        let mut bodies: Vec<serde_json::Value> = self
            .runs
            .iter()
            .filter(|run| run.unit.is_some())
            .map(|run| serde_json::Value::Object(run.body(true)))
            .collect();
        if bodies.is_empty() {
            return None;
        }
        let bytes = serde_json::to_vec(&bodies).expect("plain json serializes");
        if bytes.len() <= SETTLED_RUNS_CAP_BYTES {
            return Some(bytes);
        }
        for body in &mut bodies {
            let rows = body.get_mut("units").and_then(|u| u.as_array_mut());
            for row in rows.into_iter().flatten() {
                if let Some(row) = row.as_object_mut() {
                    row.remove("message");
                }
            }
        }
        let bytes = serde_json::to_vec(&bodies).expect("plain json serializes");
        if bytes.len() <= SETTLED_RUNS_CAP_BYTES {
            return Some(bytes);
        }
        tracing::warn!(
            bytes = bytes.len(),
            cap = SETTLED_RUNS_CAP_BYTES,
            "a call's settled runs are past the cap even without messages; not recorded"
        );
        None
    }
}

/// The most one call's recorded runs may take in the ledger.
pub const SETTLED_RUNS_CAP_BYTES: usize = 256 * 1024;

/// A landed row's rank: past pending (0) and running (1).
const LANDED: u8 = 2;

fn status(row: &serde_json::Value) -> Option<&str> {
    row.get("status").and_then(|s| s.as_str())
}

/// How far a row has got: pending 0, running 1, anything else landed.
fn rank(row: &serde_json::Value) -> u8 {
    match status(row) {
        None | Some("pending") => 0,
        Some("running") => 1,
        Some(_) => LANDED,
    }
}

/// A report's rows when it lists every unit: an array as long as its total.
fn listed_rows(report: &Report) -> Option<&[serde_json::Value]> {
    let rows = report.units.as_ref()?.as_array()?;
    (report.total == Some(rows.len() as u64)).then_some(rows.as_slice())
}

/// Rows by their `index`, or by their place in the array when they carry none.
fn keyed(rows: &[serde_json::Value]) -> std::collections::BTreeMap<u64, serde_json::Value> {
    rows.iter()
        .enumerate()
        .map(|(at, row)| {
            let key = row.get("index").and_then(|i| i.as_u64()).unwrap_or(at as u64);
            (key, row.clone())
        })
        .collect()
}

/// One row, held and incoming: a row never goes back, a running row takes
/// the newer reading, and a landed row is final save an amend's words.
fn merge_row(held: serde_json::Value, incoming: serde_json::Value) -> serde_json::Value {
    let (was, now) = (rank(&held), rank(&incoming));
    if now < was {
        return held;
    }
    if was == LANDED && now == LANDED {
        let mut kept = held;
        if let (Some(kept_obj), Some(new_obj)) = (kept.as_object_mut(), incoming.as_object()) {
            for key in ["history", "title", "message"] {
                if let Some(value) = new_obj.get(key) {
                    kept_obj.insert(key.to_string(), value.clone());
                }
            }
        }
        return kept;
    }
    incoming
}

fn max_of(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(run_id: Option<&str>, label: &str, units: serde_json::Value) -> Report {
        Report {
            run_id: run_id.map(str::to_string),
            label: Some(label.to_string()),
            text: label.to_string(),
            unit: Some("file".into()),
            units: Some(units),
            ..Report::default()
        }
    }

    #[test]
    fn a_run_id_owns_its_rows() {
        let mut call = CallRuns::default();
        let first_rows = serde_json::json!([{"name": "a", "status": "pass", "index": 0}]);
        call.fold(&report(Some("r1"), "app-test", first_rows.clone()), 10);
        let second = call.fold(
            &report(
                Some("r2"),
                "app-test",
                serde_json::json!([{"name": "a", "status": "running", "index": 0}]),
            ),
            20,
        );
        assert_eq!((second.run_id.as_str(), second.ord), ("r2", 1));
        assert_eq!(call.runs.len(), 2);
        assert_eq!(call.runs[0].ord, 0);
        assert_eq!(
            call.runs[0].units,
            Some(first_rows),
            "the second run left the first one's rows alone"
        );
        assert_eq!(call.runs[0].first_at_ms, 10);
        // A later report of the first run folds into it, not into a third.
        let again = call.fold(&report(Some("r1"), "app-test", serde_json::json!([])), 30);
        assert_eq!((again.ord, again.first_at_ms, again.at_ms), (0, 10, 30));
        assert_eq!(call.runs.len(), 2);
    }

    #[test]
    fn a_report_with_no_run_id_is_keyed_by_its_label() {
        let mut call = CallRuns::default();
        call.fold(&report(None, "build", serde_json::json!([])), 1);
        call.fold(&report(None, "build", serde_json::json!([])), 2);
        call.fold(&report(None, "files", serde_json::json!([])), 3);
        let keys: Vec<&str> = call.runs.iter().map(|r| r.run_id.as_str()).collect();
        assert_eq!(keys, ["label:build", "label:files"]);
        let unlabelled = Report {
            text: "x".into(),
            ..Report::default()
        };
        assert_eq!(run_key(&unlabelled), "label:");
    }

    #[test]
    fn a_child_is_named_under_the_running_unit_once() {
        let mut call = CallRuns::default();
        let parent = |rows: serde_json::Value| Report {
            nests: true,
            ..report(Some("verify"), "arc verify", rows)
        };
        call.fold(
            &parent(serde_json::json!([
                {"name": "rust", "status": "pass", "index": 0},
                {"name": "deck", "status": "running", "index": 1, "started_at_ms": 5},
                {"name": "app", "status": "pending", "index": 2},
            ])),
            10,
        );
        let child = call.fold(
            &report(Some("tests"), "bun test", serde_json::json!([])),
            11,
        );
        assert_eq!(child.under, Some(("verify".to_string(), 1)));
        // The parent moves on; the child's place does not.
        call.fold(
            &parent(serde_json::json!([
                {"name": "rust", "status": "pass", "index": 0},
                {"name": "deck", "status": "pass", "index": 1},
                {"name": "app", "status": "running", "index": 2, "started_at_ms": 9},
            ])),
            12,
        );
        let child = call.fold(
            &report(Some("tests"), "bun test", serde_json::json!([])),
            13,
        );
        assert_eq!(child.under, Some(("verify".to_string(), 1)));
        // A run first reporting now is under the new running unit.
        let later = call.fold(&report(Some("app"), "app-test", serde_json::json!([])), 14);
        assert_eq!(later.under, Some(("verify".to_string(), 2)));
    }

    #[test]
    fn of_two_running_units_the_child_is_under_the_one_started_last() {
        let mut call = CallRuns::default();
        call.fold(
            &Report {
                nests: true,
                ..report(
                    Some("loop"),
                    "loop",
                    serde_json::json!([
                        {"name": "a", "status": "running", "index": 0, "started_at_ms": 7},
                        {"name": "b", "status": "running", "index": 1, "started_at_ms": 3},
                    ]),
                )
            },
            10,
        );
        let child = call.fold(&report(Some("c"), "child", serde_json::json!([])), 11);
        assert_eq!(child.under, Some(("loop".to_string(), 0)));
    }

    #[test]
    fn a_run_with_no_parent_running_is_top_level() {
        let mut call = CallRuns::default();
        call.fold(
            &report(
                Some("loop"),
                "loop",
                serde_json::json!([{"name": "a", "status": "running", "index": 0}]),
            ),
            10,
        );
        // The loop never said it nests, so a second run is no child of it.
        let other = call.fold(&report(Some("other"), "other", serde_json::json!([])), 11);
        assert_eq!(other.under, None);
    }

    #[test]
    fn finished_is_sticky() {
        let mut call = CallRuns::default();
        call.fold(
            &Report {
                finished: true,
                nests: true,
                ..report(Some("r"), "x", serde_json::json!([]))
            },
            1,
        );
        let run = call.fold(&report(Some("r"), "x", serde_json::json!([])), 2);
        assert!(run.finished, "a later report does not un-finish the run");
        assert!(run.nests, "nor un-nest it");
    }

    /// A listed snapshot: `rows` as the whole run, its total their count.
    fn listed(rows: serde_json::Value) -> Report {
        let total = rows.as_array().map(|r| r.len() as u64);
        Report {
            total,
            ..report(Some("r"), "loop", rows)
        }
    }

    fn statuses(run: &RunState) -> Vec<String> {
        run.units
            .as_ref()
            .and_then(|u| u.as_array())
            .map(|rows| {
                rows.iter()
                    .map(|row| row["status"].as_str().unwrap_or("").to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn a_landed_row_is_final() {
        let mut call = CallRuns::default();
        call.fold(
            &listed(serde_json::json!([
                {"name": "a", "status": "pass", "index": 0},
                {"name": "b", "status": "running", "index": 1},
            ])),
            1,
        );
        // A stale snapshot from before `a` landed arrives last.
        let run = call.fold(
            &listed(serde_json::json!([
                {"name": "a", "status": "running", "index": 0},
                {"name": "b", "status": "pending", "index": 1},
            ])),
            2,
        );
        assert_eq!(statuses(run), ["pass", "running"]);
        assert_eq!(run.done, Some(1), "done does not fall");
    }

    #[test]
    fn a_running_row_does_not_go_back_to_pending() {
        let mut call = CallRuns::default();
        call.fold(
            &listed(serde_json::json!([{"name": "a", "status": "running", "index": 0, "started_at_ms": 5}])),
            1,
        );
        let run = call.fold(&listed(serde_json::json!([{"name": "a", "status": "pending", "index": 0}])), 2);
        assert_eq!(statuses(run), ["running"]);
        assert_eq!(run.units.as_ref().unwrap()[0]["started_at_ms"], 5);
    }

    #[test]
    fn a_landed_row_gains_a_history_line_and_keeps_its_status() {
        let mut call = CallRuns::default();
        call.fold(
            &listed(serde_json::json!([{"name": "a", "status": "fail", "index": 0, "secs": 4}])),
            1,
        );
        let run = call.fold(
            &listed(serde_json::json!([
                {"name": "a", "status": "pass", "index": 0, "history": "red for 3 runs"},
            ])),
            2,
        );
        let row = &run.units.as_ref().unwrap()[0];
        assert_eq!(row["status"], "fail", "a landed status is final");
        assert_eq!(row["history"], "red for 3 runs", "an amend's history line is taken");
        assert_eq!(row["secs"], 4);
        assert_eq!(run.failures, Some(1));
    }

    #[test]
    fn two_parallel_landings_arriving_in_either_order_end_the_same() {
        // Two jobs land a and b at once; each posts the snapshot it saw.
        let a_landed = listed(serde_json::json!([
            {"name": "a", "status": "pass", "index": 0},
            {"name": "b", "status": "running", "index": 1},
        ]));
        let b_landed = listed(serde_json::json!([
            {"name": "a", "status": "running", "index": 0},
            {"name": "b", "status": "fail", "index": 1},
        ]));
        let mut one = CallRuns::default();
        one.fold(&a_landed, 1);
        let one = one.fold(&b_landed, 2).clone();
        let mut two = CallRuns::default();
        two.fold(&b_landed, 1);
        let two = two.fold(&a_landed, 2).clone();
        assert_eq!(one.units, two.units);
        assert_eq!(statuses(&one), ["pass", "fail"]);
        assert_eq!((one.done, one.failures), (Some(2), Some(1)));
        assert_eq!((two.done, two.failures), (Some(2), Some(1)));
    }

    #[test]
    fn a_partial_run_takes_the_later_count_and_never_steps_back() {
        let partial = |done: u64, failures: u64, reds: serde_json::Value| Report {
            done: Some(done),
            failures: Some(failures),
            total: Some(748),
            unit: Some("test".into()),
            ..report(Some("t"), "bun test", reds)
        };
        let mut call = CallRuns::default();
        call.fold(
            &partial(400, 1, serde_json::json!([{"name": "x", "status": "fail"}])),
            1,
        );
        // An older snapshot arrives after: its rows and counts are not taken.
        let run = call.fold(&partial(120, 0, serde_json::json!([])), 2);
        assert_eq!((run.done, run.failures), (Some(400), Some(1)));
        assert_eq!(statuses(run), ["fail"]);
        // A newer one is.
        let run = call.fold(
            &partial(
                748,
                2,
                serde_json::json!([{"name": "x", "status": "fail"}, {"name": "y", "status": "fail"}]),
            ),
            3,
        );
        assert_eq!((run.done, run.failures, run.total), (Some(748), Some(2), Some(748)));
        assert_eq!(statuses(run).len(), 2);
    }

    #[test]
    fn seq_rises_with_every_fold_of_a_call() {
        let mut call = CallRuns::default();
        let seqs: Vec<u64> = [Some("a"), Some("b"), Some("a")]
            .into_iter()
            .enumerate()
            .map(|(at, id)| call.fold(&report(id, "x", serde_json::json!([])), at as i64).seq)
            .collect();
        assert_eq!(seqs, [1, 2, 3]);
        assert_eq!(call.runs[0].seq, 3, "the run carries the call's count at its latest fold");
        assert_eq!(call.runs[1].seq, 2);
    }

    #[test]
    fn counts_are_read_from_the_merged_rows() {
        let mut call = CallRuns::default();
        let run = call.fold(
            &Report {
                done: Some(0),
                failures: Some(9),
                ..listed(serde_json::json!([
                    {"name": "a", "status": "pass", "index": 0},
                    {"name": "b", "status": "stalled", "index": 1},
                    {"name": "c", "status": "skipped", "index": 2},
                    {"name": "d", "status": "pending", "index": 3},
                ]))
            },
            1,
        );
        assert_eq!((run.done, run.failures, run.total), (Some(3), Some(1), Some(4)));
        // A row the latest snapshot lacks is kept, and still counts.
        let run = call.fold(
            &listed(serde_json::json!([{"name": "a", "status": "pass", "index": 0}])),
            2,
        );
        assert_eq!(statuses(run), ["pass", "stalled", "skipped", "pending"]);
        assert_eq!((run.done, run.total), (Some(3), Some(4)));
    }

    #[test]
    fn settled_json_holds_unit_runs_in_order_and_skips_one_liners() {
        let mut call = CallRuns::default();
        assert_eq!(call.settled_json(), None, "a call with no runs records nothing");
        let line = Report {
            label: Some("rust".into()),
            text: "compiling".into(),
            ..Report::default()
        };
        call.fold(&line, 1);
        assert_eq!(call.settled_json(), None, "a call that only said a line records nothing");
        call.fold(&listed(serde_json::json!([{"name": "a", "status": "pass", "index": 0}])), 2);
        call.fold(&report(Some("r2"), "phases", serde_json::json!([])), 3);
        let bodies: serde_json::Value = serde_json::from_slice(&call.settled_json().unwrap()).unwrap();
        let ids: Vec<&str> = bodies
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["run_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["r", "r2"]);
        let first = &bodies[0];
        assert_eq!((first["run_ord"].as_u64(), first["seq"].as_u64()), (Some(1), Some(2)));
        assert_eq!(first["units"][0]["status"], "pass");
        assert!(first.get("type").is_none() && first.get("tool_use_id").is_none());
    }

    #[test]
    fn a_payload_past_the_cap_drops_messages_before_it_drops_the_call() {
        let rows = |message: &str, name: &str| {
            serde_json::Value::Array(
                (0..4)
                    .map(|i| serde_json::json!({"name": format!("{name}{i}"), "status": "fail", "index": i, "title": "t", "message": message}))
                    .collect(),
            )
        };
        let mut call = CallRuns::default();
        call.fold(&listed(rows(&"m".repeat(SETTLED_RUNS_CAP_BYTES / 2), "a")), 1);
        let kept: serde_json::Value = serde_json::from_slice(&call.settled_json().unwrap()).unwrap();
        let row = &kept[0]["units"][0];
        assert!(row.get("message").is_none(), "the messages went");
        assert_eq!((row["status"].as_str(), row["title"].as_str()), (Some("fail"), Some("t")));

        let mut huge = CallRuns::default();
        huge.fold(&listed(rows("m", &"n".repeat(SETTLED_RUNS_CAP_BYTES / 2))), 1);
        assert_eq!(huge.settled_json(), None, "past the cap with no messages to drop");
    }
}
