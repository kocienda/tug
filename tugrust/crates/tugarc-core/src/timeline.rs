//! An arc's time, as its log recorded it.
//!
//! When each stage rotated, when each step opened and closed, and the marks
//! between them — compactions, stops, resumes. The TIME popup places a card's
//! turns inside these windows to say what each stage and each step cost; this
//! module reads the windows and nothing else. Durations of *work* are the
//! deck's to compute from its turns, because only the turns know how much of a
//! window was the machine and how much was waiting on the user.
//!
//! One read of the log answers every arc in it, so a recompute that lists many
//! arcs pays for one file read rather than one per arc. The same walk also
//! measures every finished audit the log remembers, project-wide, which is the
//! only history an unstarted audit can be projected from.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Serialize;
use tugcore::instance::Paths;

use crate::log::{is_terminal, read_step_fields, read_step_title, split_log_line};

/// How many recent audits the typical audit is the median of.
const AUDIT_HISTORY: usize = 5;

/// One stage rotation: which stage, when, under which model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimelineStage {
    pub stage: String,
    pub at_ms: u64,
    /// `None` is the account default, which the log spells `-`.
    pub model: Option<String>,
}

/// One open → close of a step. A reopened step has more than one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepSpan {
    pub start_ms: u64,
    /// `None` while the step is open.
    pub end_ms: Option<u64>,
}

/// How a step's latest span closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepEnd {
    Done,
    Withdrawn,
    /// Parked: closed without finishing, still owed.
    Reset,
}

/// One step of the walk, as far as the log has seen it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimelineStep {
    pub n: u32,
    /// The plan's step count, as the step's latest declaration said it.
    pub total: u32,
    pub title: Option<String>,
    pub spans: Vec<StepSpan>,
    /// How the latest span closed; `None` while it is open.
    pub end: Option<StepEnd>,
    /// The round a `step-done` named.
    pub commit: Option<String>,
}

/// What a mark between steps records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkKind {
    Compact,
    Stop,
    Resume,
}

/// A moment the wheel acted on the arc without opening or closing a step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimelineMark {
    pub kind: MarkKind,
    pub at_ms: u64,
    /// The line's note verbatim: `397050 > 300000` for a compaction,
    /// `<stage> <reason>` for a stop, the stage for a resume.
    pub note: String,
}

/// One arc's current generation, in time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ArcTimeline {
    pub stages: Vec<TimelineStage>,
    /// In step order.
    pub steps: Vec<TimelineStep>,
    pub marks: Vec<TimelineMark>,
    /// The declared run's final step, when one was declared.
    pub run_through: Option<u32>,
    /// When the arc reached `arc-done`.
    pub done_at_ms: Option<u64>,
}

/// Every arc's timeline, and what an audit in this project typically takes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Timelines {
    /// Keyed by arc name; current generation only.
    pub arcs: HashMap<String, ArcTimeline>,
    /// The median of the most recent finished audits, start to `audited` or
    /// `arc-done`. `None` when the log remembers none.
    pub typical_audit_ms: Option<u64>,
}

/// Read every arc's timeline from the project's arc log. A missing or
/// unreadable log is no timelines at all.
pub fn read_timelines(paths: &Paths, repo_root: &Path) -> Timelines {
    let path = tugtool_core::paths::arc_log_path_at(paths, repo_root);
    fs::read_to_string(&path)
        .map(|text| timelines_from_text(&text))
        .unwrap_or_default()
}

fn parse_ms(timestamp: &str) -> Option<u64> {
    let at = chrono::DateTime::parse_from_rfc3339(timestamp).ok()?;
    u64::try_from(at.timestamp_millis()).ok()
}

/// What a walk of the log has seen so far. A terminal line is the walker's to
/// read, since what it means differs between the two walks below.
#[derive(Default)]
struct Fold {
    arcs: HashMap<String, ArcTimeline>,
    // An audit in progress per arc, by its start; spent into `audits` when it
    // finishes and dropped when anything else interrupts it.
    audit_open: HashMap<String, u64>,
    audits: Vec<u64>,
}

impl Fold {
    /// Read one line that is not a terminal one.
    fn apply(&mut self, timestamp: &str, name: &str, marker: &str, note: &str) {
        let Self {
            arcs,
            audit_open,
            audits,
        } = self;
        let Some(at_ms) = parse_ms(timestamp) else {
            return;
        };
        let finish_audit = |audit_open: &mut HashMap<String, u64>, audits: &mut Vec<u64>| {
            if let Some(start) = audit_open.remove(name) {
                audits.push(at_ms.saturating_sub(start));
            }
        };
        match marker {
            "arc-start" => {
                // A new generation: whatever the name carried before is gone.
                arcs.insert(name.to_owned(), ArcTimeline::default());
                audit_open.remove(name);
            }
            "arc-stage" => {
                let mut fields = note.split_whitespace();
                let Some(stage) = fields.next() else { return };
                let _session = fields.next();
                let model = fields.next().filter(|m| *m != "-").map(str::to_owned);
                if stage == "audit" {
                    audit_open.insert(name.to_owned(), at_ms);
                } else {
                    audit_open.remove(name);
                }
                arcs.entry(name.to_owned())
                    .or_default()
                    .stages
                    .push(TimelineStage {
                        stage: stage.to_owned(),
                        at_ms,
                        model,
                    });
            }
            "step-start" | "step-reopen" | "step-done" | "step-withdrawn" | "step-reset" => {
                let Some((n, total)) = read_step_fields(note) else {
                    return;
                };
                let timeline = arcs.entry(name.to_owned()).or_default();
                let index = match timeline.steps.iter().position(|s| s.n == n) {
                    Some(i) => i,
                    None => {
                        timeline.steps.push(TimelineStep {
                            n,
                            total,
                            title: None,
                            spans: Vec::new(),
                            end: None,
                            commit: None,
                        });
                        timeline.steps.len() - 1
                    }
                };
                let step = &mut timeline.steps[index];
                step.total = total;
                let open = step.spans.last_mut().filter(|s| s.end_ms.is_none());
                match marker {
                    "step-start" | "step-reopen" => {
                        if let Some(title) = read_step_title(note, n) {
                            step.title = Some(title);
                        }
                        // A start over an open span restarts it rather than
                        // nesting a second one inside it.
                        match open {
                            Some(span) => span.start_ms = at_ms,
                            None => step.spans.push(StepSpan {
                                start_ms: at_ms,
                                end_ms: None,
                            }),
                        }
                        step.end = None;
                    }
                    closing => {
                        if let Some(span) = open {
                            span.end_ms = Some(at_ms);
                        }
                        step.end = Some(match closing {
                            "step-done" => StepEnd::Done,
                            "step-withdrawn" => StepEnd::Withdrawn,
                            _ => StepEnd::Reset,
                        });
                        if closing == "step-done" {
                            // A done note's tail is the round's sha.
                            step.commit = read_step_title(note, n);
                        }
                    }
                }
            }
            "compact" | "arc-stop" | "arc-resume" | "arc-continue" => {
                let kind = match marker {
                    "compact" => MarkKind::Compact,
                    "arc-stop" => MarkKind::Stop,
                    _ => MarkKind::Resume,
                };
                if kind == MarkKind::Stop {
                    // A stopped audit's span measures the stop, not the audit.
                    audit_open.remove(name);
                }
                arcs.entry(name.to_owned())
                    .or_default()
                    .marks
                    .push(TimelineMark {
                        kind,
                        at_ms,
                        note: note.to_owned(),
                    });
            }
            "run-through" => {
                arcs.entry(name.to_owned()).or_default().run_through = note.trim().parse().ok();
            }
            "audited" => finish_audit(audit_open, audits),
            "arc-done" => {
                finish_audit(audit_open, audits);
                arcs.entry(name.to_owned()).or_default().done_at_ms = Some(at_ms);
            }
            _ => {}
        }
    }
}

/// The pure fold behind [`read_timelines`]: every arc's current generation, so
/// a terminal line drops its arc.
pub fn timelines_from_text(text: &str) -> Timelines {
    let mut fold = Fold::default();
    for line in text.lines() {
        let Some((timestamp, name, marker, note)) = split_log_line(line) else {
            continue;
        };
        if is_terminal(marker, note) {
            fold.arcs.remove(name);
            fold.audit_open.remove(name);
            continue;
        }
        fold.apply(timestamp, name, marker, note);
    }
    let Fold {
        mut arcs, audits, ..
    } = fold;

    for timeline in arcs.values_mut() {
        timeline.steps.sort_by_key(|s| s.n);
    }
    let recent = &audits[audits.len().saturating_sub(AUDIT_HISTORY)..];
    Timelines {
        arcs,
        typical_audit_ms: median(recent),
    }
}

/// One arc's newest generation, whether or not it has ended: a terminal line
/// closes the generation and stamps `done_at_ms` if nothing has, and only a
/// later `arc-start` opens the name again. `None` when the log never saw the
/// arc. What the branch held is gone at a join, so this is what remains.
pub fn timeline_for(text: &str, name: &str) -> Option<ArcTimeline> {
    let mut fold = Fold::default();
    let mut closed = false;
    for line in text.lines() {
        let Some((timestamp, arc, marker, note)) = split_log_line(line) else {
            continue;
        };
        if arc != name {
            continue;
        }
        if is_terminal(marker, note) {
            if let Some(timeline) = fold.arcs.get_mut(name) {
                timeline.done_at_ms = timeline.done_at_ms.or(parse_ms(timestamp));
            }
            closed = true;
            continue;
        }
        if closed && marker != "arc-start" {
            continue;
        }
        closed = false;
        fold.apply(timestamp, name, marker, note);
    }
    let mut timeline = fold.arcs.remove(name)?;
    timeline.steps.sort_by_key(|s| s.n);
    Some(timeline)
}

/// The name on the log's last `arc-start` line.
pub fn newest_arc(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .filter_map(split_log_line)
        .find(|(_, _, marker, _)| *marker == "arc-start")
        .map(|(_, name, _, _)| name.to_owned())
}

fn median(xs: &[u64]) -> Option<u64> {
    if xs.is_empty() {
        return None;
    }
    let mut sorted = xs.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    Some(if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(at: &str, arc: &str, marker: &str, note: &str) -> String {
        format!("{at}  {arc}  {marker}  {note}\n")
    }

    const T0: &str = "2026-10-27T16:00:00.000Z";
    fn ms(at: &str) -> u64 {
        parse_ms(at).unwrap()
    }

    #[test]
    fn stages_and_steps_carry_their_times() {
        let log = [
            line(T0, "a", "arc-start", "brief.md"),
            line(
                "2026-10-27T16:00:01.000Z",
                "a",
                "arc-stage",
                "devise s1 opus",
            ),
            line(
                "2026-10-27T16:10:00.000Z",
                "a",
                "arc-stage",
                "implement s2 -",
            ),
            line("2026-10-27T16:10:05.000Z", "a", "run-through", "2"),
            line(
                "2026-10-27T16:10:06.000Z",
                "a",
                "step-start",
                "1/2 Step 1: First",
            ),
            line(
                "2026-10-27T16:17:00.000Z",
                "a",
                "step-done",
                "1/2 315f6074a",
            ),
            line(
                "2026-10-27T16:17:10.000Z",
                "a",
                "compact",
                "397050 > 300000",
            ),
            line(
                "2026-10-27T16:18:00.000Z",
                "a",
                "step-start",
                "2/2 Step 2: Second",
            ),
        ]
        .concat();
        let t = timelines_from_text(&log);
        let a = &t.arcs["a"];
        assert_eq!(a.stages.len(), 2);
        assert_eq!(a.stages[0].model.as_deref(), Some("opus"));
        assert_eq!(a.stages[1].model, None);
        assert_eq!(a.run_through, Some(2));
        assert_eq!(a.steps.len(), 2);
        let first = &a.steps[0];
        assert_eq!(first.title.as_deref(), Some("First"));
        assert_eq!(first.commit.as_deref(), Some("315f6074a"));
        assert_eq!(first.end, Some(StepEnd::Done));
        assert_eq!(
            first.spans,
            vec![StepSpan {
                start_ms: ms("2026-10-27T16:10:06.000Z"),
                end_ms: Some(ms("2026-10-27T16:17:00.000Z")),
            }]
        );
        let second = &a.steps[1];
        assert_eq!(second.end, None);
        assert_eq!(second.spans[0].end_ms, None);
        assert_eq!(a.marks.len(), 1);
        assert_eq!(a.marks[0].kind, MarkKind::Compact);
        assert_eq!(a.marks[0].note, "397050 > 300000");
    }

    #[test]
    fn a_reopened_step_keeps_both_spans() {
        let log = [
            line(T0, "a", "arc-start", "brief.md"),
            line(
                "2026-10-27T16:01:00.000Z",
                "a",
                "step-start",
                "1/1 Step 1: Only",
            ),
            line("2026-10-27T16:02:00.000Z", "a", "step-done", "1/1 aaa"),
            line(
                "2026-10-27T16:03:00.000Z",
                "a",
                "step-reopen",
                "1/1 Step 1: Only",
            ),
            line("2026-10-27T16:05:00.000Z", "a", "step-done", "1/1 bbb"),
        ]
        .concat();
        let step = &timelines_from_text(&log).arcs["a"].steps[0];
        assert_eq!(step.spans.len(), 2);
        assert_eq!(step.commit.as_deref(), Some("bbb"));
        assert_eq!(step.end, Some(StepEnd::Done));
    }

    #[test]
    fn a_terminal_line_ends_the_generation() {
        let log = [
            line(T0, "a", "arc-start", "brief.md"),
            line(
                "2026-10-27T16:01:00.000Z",
                "a",
                "step-start",
                "1/1 Step 1: Only",
            ),
            line(
                "2026-10-27T16:02:00.000Z",
                "a",
                "7d16f2ac6",
                "joined via card",
            ),
        ]
        .concat();
        assert!(!timelines_from_text(&log).arcs.contains_key("a"));
    }

    #[test]
    fn timeline_for_keeps_a_joined_arc_that_the_current_read_drops() {
        let joined_at = "2026-10-27T16:30:00.000Z";
        let log = [
            line(T0, "a", "arc-start", "brief.md"),
            line(T0, "b", "arc-start", "other.md"),
            line(
                "2026-10-27T16:00:01.000Z",
                "a",
                "arc-stage",
                "implement s1 opus",
            ),
            line(
                "2026-10-27T16:01:00.000Z",
                "a",
                "step-start",
                "1/2 Step 1: First",
            ),
            line("2026-10-27T16:02:00.000Z", "a", "step-done", "1/2 aaa"),
            line(
                "2026-10-27T16:03:00.000Z",
                "a",
                "step-start",
                "2/2 Step 2: Second",
            ),
            line("2026-10-27T16:04:00.000Z", "a", "step-done", "2/2 bbb"),
            line(joined_at, "a", "7d16f2ac6", "joined via card"),
        ]
        .concat();
        let a = timeline_for(&log, "a").expect("a joined arc keeps its timeline");
        assert_eq!(a.done_at_ms, Some(ms(joined_at)));
        assert_eq!(a.stages.len(), 1);
        assert_eq!(a.steps.len(), 2);
        assert!(!timelines_from_text(&log).arcs.contains_key("a"));

        // A line after the terminal one that does not open a new generation.
        let late = line("2026-10-27T16:31:00.000Z", "a", "compact", "1 > 0");
        let a = timeline_for(&(log + &late), "a").unwrap();
        assert!(a.marks.is_empty());
    }

    #[test]
    fn timeline_for_keeps_the_done_time_it_already_has() {
        let done_at = "2026-10-27T16:10:00.000Z";
        let log = [
            line(T0, "a", "arc-start", "brief.md"),
            line(done_at, "a", "arc-done", ""),
            line("2026-10-27T17:00:00.000Z", "a", "abc", "joined"),
        ]
        .concat();
        assert_eq!(
            timeline_for(&log, "a").unwrap().done_at_ms,
            Some(ms(done_at))
        );
    }

    #[test]
    fn timeline_for_starts_over_at_a_later_arc_start() {
        let log = [
            line(T0, "a", "arc-start", "brief.md"),
            line(
                "2026-10-27T16:01:00.000Z",
                "a",
                "step-start",
                "1/1 Step 1: Old",
            ),
            line("2026-10-27T16:02:00.000Z", "a", "discarded", ""),
            line("2026-10-27T16:03:00.000Z", "a", "arc-start", "brief.md"),
            line(
                "2026-10-27T16:04:00.000Z",
                "a",
                "step-start",
                "1/1 Step 1: New",
            ),
        ]
        .concat();
        let a = timeline_for(&log, "a").unwrap();
        assert_eq!(a.done_at_ms, None);
        assert_eq!(a.steps.len(), 1);
        assert_eq!(a.steps[0].title.as_deref(), Some("New"));
        assert_eq!(timeline_for(&log, "nobody"), None);
    }

    #[test]
    fn newest_arc_names_the_last_arc_start() {
        let log = [
            line(T0, "older", "arc-start", "brief.md"),
            line("2026-10-27T16:01:00.000Z", "newer", "arc-start", "brief.md"),
            line("2026-10-27T16:02:00.000Z", "older", "compact", "1 > 0"),
        ]
        .concat();
        assert_eq!(newest_arc(&log).as_deref(), Some("newer"));
        assert_eq!(newest_arc(""), None);
    }

    #[test]
    fn the_typical_audit_is_the_median_of_finished_ones() {
        let log = [
            // 10 minutes, ended by `audited`.
            line("2026-10-27T10:00:00.000Z", "a", "arc-stage", "audit s opus"),
            line("2026-10-27T10:10:00.000Z", "a", "audited", "fine"),
            line("2026-10-27T10:10:30.000Z", "a", "arc-done", ""),
            // 20 minutes, ended by `arc-done`.
            line("2026-10-27T11:00:00.000Z", "b", "arc-stage", "audit s opus"),
            line("2026-10-27T11:20:00.000Z", "b", "arc-done", ""),
            // Stopped: not an audit's length.
            line("2026-10-27T12:00:00.000Z", "c", "arc-stage", "audit s opus"),
            line(
                "2026-10-27T12:01:00.000Z",
                "c",
                "arc-stop",
                "audit you pressed stop",
            ),
            line("2026-10-27T13:00:00.000Z", "c", "arc-done", ""),
            // 30 minutes.
            line("2026-10-27T14:00:00.000Z", "d", "arc-stage", "audit s opus"),
            line("2026-10-27T14:30:00.000Z", "d", "audited", "fine"),
        ]
        .concat();
        assert_eq!(
            timelines_from_text(&log).typical_audit_ms,
            Some(20 * 60 * 1000)
        );
    }

    #[test]
    fn no_audits_is_no_typical_audit() {
        let log = line(T0, "a", "arc-start", "brief.md");
        assert_eq!(timelines_from_text(&log).typical_audit_ms, None);
    }
}
