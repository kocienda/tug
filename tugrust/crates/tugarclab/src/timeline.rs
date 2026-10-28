//! The run's output: a timeline — time, actor, event, and a verdict per
//! expectation — in the bench table's column shape, printed and written
//! under the run directory. A red scenario names its first failed probe.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

/// One line of the timeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub at: Duration,
    pub actor: String,
    pub event: String,
    /// `Some(true)` green, `Some(false)` red, `None` for an act.
    pub verdict: Option<bool>,
}

/// The timeline a run writes as it goes.
pub struct Timeline {
    started: Instant,
    pub scenario: String,
    pub rows: Vec<Row>,
}

impl Timeline {
    pub fn start(scenario: &str) -> Self {
        Self {
            started: Instant::now(),
            scenario: scenario.to_string(),
            rows: Vec::new(),
        }
    }

    /// Record an act.
    pub fn act(&mut self, actor: &str, event: impl Into<String>) {
        self.push(actor, event.into(), None);
    }

    /// Record an expectation's verdict.
    pub fn verdict(&mut self, actor: &str, event: impl Into<String>, ok: bool) {
        self.push(actor, event.into(), Some(ok));
    }

    fn push(&mut self, actor: &str, event: String, verdict: Option<bool>) {
        let row = Row {
            at: self.started.elapsed(),
            actor: actor.to_string(),
            event,
            verdict,
        };
        eprintln!("{}", render_row(&row));
        self.rows.push(row);
    }

    /// The first red's event, if any.
    pub fn first_red(&self) -> Option<&Row> {
        self.rows.iter().find(|r| r.verdict == Some(false))
    }

    pub fn green(&self) -> bool {
        self.first_red().is_none()
    }

    /// The whole table, with its verdict line.
    pub fn render(&self) -> String {
        render(&self.scenario, &self.rows)
    }
}

fn clock(at: Duration) -> String {
    let secs = at.as_secs_f64();
    format!("{:>7.1}s", secs)
}

fn render_row(row: &Row) -> String {
    let verdict = match row.verdict {
        Some(true) => "ok",
        Some(false) => "FAIL",
        None => "",
    };
    format!(
        "{} {:<12} {:<60} {}",
        clock(row.at),
        row.actor,
        row.event,
        verdict
    )
}

/// The table for `rows`, headed and closed with a verdict.
pub fn render(scenario: &str, rows: &[Row]) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "scenario {scenario}");
    let _ = writeln!(out, "{:>8} {:<12} {:<60} verdict", "time", "actor", "event");
    for row in rows {
        let _ = writeln!(out, "{}", render_row(row));
    }
    let expectations = rows.iter().filter(|r| r.verdict.is_some()).count();
    let reds = rows.iter().filter(|r| r.verdict == Some(false)).count();
    match rows.iter().find(|r| r.verdict == Some(false)) {
        None => {
            let _ = writeln!(out, "VERDICT: ok — {expectations} expectation(s) held");
        }
        Some(red) => {
            let _ = writeln!(
                out,
                "VERDICT: FAIL — {reds} of {expectations} expectation(s) missed; first: {}",
                red.event
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<Row> {
        vec![
            Row {
                at: Duration::from_millis(1200),
                actor: "lab".into(),
                event: "arc a".into(),
                verdict: None,
            },
            Row {
                at: Duration::from_millis(5400),
                actor: "probe".into(),
                event: "arc-log b crossing".into(),
                verdict: Some(true),
            },
            Row {
                at: Duration::from_millis(9000),
                actor: "probe".into(),
                event: "config tugcrossing.a b.state ∋ x".into(),
                verdict: Some(false),
            },
        ]
    }

    #[test]
    fn a_green_run_says_how_many_held() {
        let out = render("smoke", &rows()[..2]);
        assert!(out.starts_with("scenario smoke\n"));
        assert!(out.contains("    1.2s lab          arc a"));
        assert!(out.contains("    5.4s probe        arc-log b crossing"));
        assert!(
            out.ends_with("VERDICT: ok — 1 expectation(s) held\n"),
            "{out}"
        );
    }

    #[test]
    fn a_red_run_names_its_first_miss() {
        let out = render("smoke", &rows());
        assert!(out.ends_with(
            "VERDICT: FAIL — 1 of 2 expectation(s) missed; first: config tugcrossing.a b.state ∋ x\n"
        ), "{out}");
    }

    #[test]
    fn the_timeline_keeps_order_and_finds_the_first_red() {
        let mut t = Timeline::start("x");
        t.act("lab", "arc a");
        t.verdict("probe", "one", true);
        t.verdict("probe", "two", false);
        t.verdict("probe", "three", false);
        assert_eq!(t.rows.len(), 4);
        assert!(!t.green());
        assert_eq!(t.first_red().map(|r| r.event.as_str()), Some("two"));
    }
}
