//! `tugtool deck motion settle` — one settle gesture, driven and read in one
//! command, by the React commits inside its settle window.
//!
//! Every settle gesture's React commit lands inside the settle window by
//! design: the deck's commit is scheduled after the first painted frame of
//! whatever the settle armed. So the question about a gesture is not whether
//! a commit lands under the tween but how large it is and why. This verb
//! drives the gesture through the deck's own gesture door,
//! `window.tugdeck.lab.drive` (`tugdeck/src/lib/gesture-drivers.ts`) — the
//! same door the app-tests drive — and reports every commit between the
//! settle mark going on and off, with a margin either side: its React time,
//! fibers performed and mounted, the components that asked, the store
//! changes that caused it, and why each pane-chrome component rendered.
//!
//! `slide` reads a click's first 260 ms, which is the wrong window for this
//! question; its per-commit reducers are reused here (`commit_timings`,
//! `cause_label` through it, `origins_label`), and its aggregate rows are not,
//! because this verb reports each commit by itself.
//!
//! The page half is `deck_motion_settle.js`, embedded here; it returns raw
//! times relative to the drive, and this module finds the window and reduces
//! it, so the reduction is what the unit tests pin. Every run begins with the
//! deck's census and an at-rest check: a deck that is not at rest is reported
//! and not read.

use crate::commands::deck_motion::{EVAL_GATED_REMEDY, EXIT_GATED};
use crate::commands::deck_motion_slide::{
    RawCommit, RawTell, census, commit_timings, ensure_recorder, origins_label, print_census,
    script_page,
};
use serde::Serialize;
use serde_json::{Value, json};

/// The page half: one function expression, applied to a JSON argument object.
const PAGE: &str = include_str!("deck_motion_settle.js");

/// The gestures the verb drives, as `--gesture` takes them.
pub const GESTURE_NAMES: [&str; 7] = [
    "flip", "fold", "unfold", "close", "rails", "split", "switch",
];

/// How far either side of the settle mark a commit still counts as in the
/// window: a commit a few ms before the mark goes on is the gesture's own.
pub const MARGIN_MS: f64 = 60.0;

/// How long after the settle mark goes off the page keeps recording.
const TAIL_MS: u32 = 300;

/// How long a gesture is recorded for when its settle mark never goes off.
const CAP_MS: u32 = 4000;

/// The window a workspace switch is read over. A switch arms no settle, so
/// it sets no settle mark: its frames are sampled for this long from the swap
/// (`SPACE_SWITCH_FRAME_WINDOW_MS`, `tugdeck/src/lib/space-switch-frames.ts`),
/// and its commits are read over the same span from the drive.
pub const SWITCH_WINDOW_MS: u32 = 600;

/// The window a gesture's commits are read over: the switch's fixed span from
/// the drive, or the settle mark's on and off.
pub fn gesture_window(gesture: &str, marks: &[(f64, bool)]) -> Option<(f64, f64)> {
    if gesture == "switch" {
        Some((0.0, f64::from(SWITCH_WINDOW_MS)))
    } else {
        window_of(marks)
    }
}

/// Quiet time between one drive and the next.
const REST_BETWEEN_MS: u64 = 400;

/// How many `why` entries a commit reports.
const WHY_SHOWN: usize = 12;

/// The arguments a gesture can take, as the flags gave them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GestureArgs {
    pub card: Option<String>,
    pub pane: Option<String>,
    pub slot: Option<u32>,
    pub mode: Option<String>,
    pub space: Option<String>,
}

/// Where the deck stands before the first drive: what a repeated `switch` or
/// `flip` goes back to.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Home {
    pub space_id: Option<String>,
    pub card_id: Option<String>,
}

/// One call to `lab.drive`, and whether its window is reported. A `rails`
/// hide is driven so the next show has a hidden rail to show, and not read.
#[derive(Debug, Clone, PartialEq)]
pub struct Drive {
    pub gesture: &'static str,
    pub args: Value,
    pub read: bool,
}

/// Refuse a gesture that lacks what it needs, naming the flag.
pub fn check_args(gesture: &str, args: &GestureArgs) -> Result<(), String> {
    let missing = |flag: &str| Err(format!("--gesture {gesture} needs {flag}"));
    match gesture {
        "flip" | "fold" | "unfold" if args.card.is_none() => missing("--card"),
        "close" if args.pane.is_none() => missing("--pane"),
        "split" if args.slot.is_none() => missing("--slot"),
        "switch" if args.space.is_none() => missing("--space"),
        g if !GESTURE_NAMES.contains(&g) => Err(format!(
            "unknown gesture '{g}' (expected one of {})",
            GESTURE_NAMES.join(", ")
        )),
        _ => Ok(()),
    }
}

/// The drives `--count` repetitions of a gesture make.
///
/// A repetition has to undo the last one, or it drives a no-op: `fold` and
/// `unfold` alternate on the card, `split` alternates the mode with the other
/// one, `switch` and `flip` alternate with the workspace or card the deck
/// stood on before the first drive, and `rails` drives an unread hide before
/// each show it reads — so the deck is expected to start with its rails
/// showing. A pane closes once, whatever the count.
pub fn drives(
    gesture: &str,
    args: &GestureArgs,
    count: u32,
    home: &Home,
) -> Result<Vec<Drive>, String> {
    check_args(gesture, args)?;
    let count = count.max(1) as usize;
    let alternate = |a: Drive, b: Drive| -> Vec<Drive> {
        (0..count)
            .map(|i| if i % 2 == 0 { a.clone() } else { b.clone() })
            .collect()
    };
    let read = |gesture: &'static str, args: Value| Drive {
        gesture,
        args,
        read: true,
    };
    Ok(match gesture {
        "fold" | "unfold" => {
            let card = json!({"card": args.card});
            let (first, second) = if gesture == "fold" {
                ("fold", "unfold")
            } else {
                ("unfold", "fold")
            };
            alternate(read(first, card.clone()), read(second, card))
        }
        "split" => {
            let mode = args.mode.as_deref().unwrap_or("split");
            let other = if mode == "split" { "stack" } else { "split" };
            alternate(
                read("split", json!({"slot": args.slot, "mode": mode})),
                read("split", json!({"slot": args.slot, "mode": other})),
            )
        }
        "switch" => {
            let to = args.space.clone().unwrap_or_default();
            let back = match &home.space_id {
                Some(home) if *home != to => Some(home.clone()),
                _ if count > 1 => {
                    return Err(format!(
                        "--gesture switch --count {count} goes back to the active workspace between drives, and '{to}' is already the active one"
                    ));
                }
                _ => None,
            };
            alternate(
                read("switch", json!({"space": to})),
                read("switch", json!({"space": back})),
            )
        }
        "flip" => {
            let to = args.card.clone().unwrap_or_default();
            let back = match &home.card_id {
                Some(home) if *home != to => Some(home.clone()),
                _ if count > 1 => {
                    return Err(format!(
                        "--gesture flip --count {count} goes back to the focused card between drives, and '{to}' is already the focused one"
                    ));
                }
                _ => None,
            };
            alternate(
                read("flip", json!({"card": to})),
                read("flip", json!({"card": back})),
            )
        }
        "rails" => (0..count)
            .flat_map(|_| {
                [
                    Drive {
                        gesture: "rails",
                        args: json!({}),
                        read: false,
                    },
                    read("rails", json!({})),
                ]
            })
            .collect(),
        "close" => vec![read("close", json!({"pane": args.pane}))],
        _ => unreachable!("check_args admits only gesture names"),
    })
}

/// The settle window in a run's mark flips: the first time the mark went on,
/// and the first time after that it went off. `None` when it never went on,
/// or never went off again.
pub fn window_of(marks: &[(f64, bool)]) -> Option<(f64, f64)> {
    let on = marks.iter().find(|(_, on)| *on)?.0;
    let off = marks.iter().find(|(t, set)| !*set && *t >= on)?.0;
    Some((on, off))
}

/// The indices of the commits inside the window, `margin_ms` either side.
pub fn in_window(commits: &[RawCommit], window: (f64, f64), margin_ms: f64) -> Vec<usize> {
    commits
        .iter()
        .enumerate()
        .filter(|(_, c)| c.t >= window.0 - margin_ms && c.t <= window.1 + margin_ms)
        .map(|(i, _)| i)
        .collect()
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// One commit in the window, as the verb reports it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct WindowCommit {
    /// When the commit hook ran, relative to the drive.
    pub t: f64,
    /// From the render's first store read to the commit hook; present only
    /// with the lead recorder installed.
    pub react_ms: Option<f64>,
    /// The React time, or the span from the previous React boundary when the
    /// render read no store.
    pub react_or_span_ms: f64,
    pub performed: u64,
    pub mounted: u64,
    pub fibers: u64,
    pub origins: Vec<(String, u64)>,
    pub top: Vec<(String, u64)>,
    /// The store changes or flushSyncs that caused it, condensed.
    pub causes: String,
    /// The first `WHY_SHOWN` of the census's `why` entries.
    pub why: Vec<String>,
}

/// The window's commits, reported, in commit order. Timings are computed over
/// every commit the run saw, since a commit's causes partition on the one
/// before it, and only then filtered to the window.
pub fn window_commits(
    commits: &[RawCommit],
    tells: &[RawTell],
    window: (f64, f64),
) -> Vec<WindowCommit> {
    let timings = commit_timings(commits, tells);
    in_window(commits, window, MARGIN_MS)
        .into_iter()
        .map(|i| {
            let c = &commits[i];
            let timing = &timings[i];
            WindowCommit {
                t: c.t,
                react_ms: timing.react_ms,
                react_or_span_ms: round1(timing.react_or_span()),
                performed: c.performed,
                mounted: c.mounted,
                fibers: c.fibers,
                origins: c.origins.clone(),
                top: c.top.clone(),
                causes: timing.causes.clone(),
                why: c.why.iter().take(WHY_SHOWN).cloned().collect(),
            }
        })
        .collect()
}

/// The largest commit by fibers performed; a tie goes to the earliest.
pub fn largest(commits: &[WindowCommit]) -> Option<&WindowCommit> {
    commits
        .iter()
        .fold(None, |best: Option<&WindowCommit>, c| match best {
            Some(b) if b.performed >= c.performed => Some(b),
            _ => Some(c),
        })
}

/// The rest check's line, and whether the deck is at rest: its updates per
/// second at or under the probe's calibrated budget. A deck that reports no
/// budget is read, with the line saying the budget is unknown — a missing
/// reference is not a zero one.
pub fn rest_verdict(updates: f64, budget: Option<f64>) -> (String, bool) {
    match budget {
        Some(budget) => (
            format!(
                "at rest: {} update(s)/s against a budget of {}",
                updates as i64, budget as i64
            ),
            updates <= budget,
        ),
        None => (
            format!(
                "at rest: {} update(s)/s; this deck reports no rest budget, so it is read unchecked",
                updates as i64
            ),
            true,
        ),
    }
}

/// One drive's reading.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Reading {
    pub gesture: &'static str,
    pub args: Value,
    /// The settle mark's on and off, relative to the drive; `None` when it
    /// never closed within the cap.
    pub window: Option<(f64, f64)>,
    pub commits: Vec<WindowCommit>,
    pub largest: Option<WindowCommit>,
    /// Commits the run saw at all, in or out of the window; `None` when the
    /// page had no census to give (a release deck without `--tasks`).
    pub commits_seen: Option<usize>,
}

/// Reduce one `record` op's raw result to a reading.
pub fn reduce(drive: &Drive, raw: &Value) -> Reading {
    fn list<T: serde::de::DeserializeOwned>(raw: &Value, key: &str) -> Option<Vec<T>> {
        raw.get(key)
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }
    let marks: Vec<(f64, bool)> = list(raw, "settle").unwrap_or_default();
    let raw_commits: Option<Vec<RawCommit>> = list(raw, "commits");
    let tells: Vec<RawTell> = list(raw, "tells").unwrap_or_default();
    let window = gesture_window(drive.gesture, &marks);
    let commits = match (&raw_commits, window) {
        (Some(commits), Some(window)) => window_commits(commits, &tells, window),
        _ => Vec::new(),
    };
    Reading {
        gesture: drive.gesture,
        args: drive.args.clone(),
        window,
        largest: largest(&commits).cloned(),
        commits,
        commits_seen: raw_commits.map(|c| c.len()),
    }
}

/// Post one page op. `None` when the eval door is shut.
fn page(port: u16, args: Value) -> Result<Option<Value>, String> {
    script_page(port, PAGE, args)
}

fn str_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

pub fn run_settle(
    port: u16,
    gesture: &str,
    args: GestureArgs,
    count: u32,
    tasks: bool,
    json_output: bool,
) -> Result<i32, String> {
    let gated = || {
        eprintln!("{EVAL_GATED_REMEDY}");
        Ok(EXIT_GATED)
    };
    check_args(gesture, &args)?;
    if gesture == "close" && count > 1 && !json_output {
        eprintln!("note: a pane closes once; --count {count} reads one close");
    }

    if tasks && !ensure_recorder(port, json_output)? {
        return gated();
    }
    let Some(census) = census(port)? else {
        return gated();
    };
    let Some(rest) = page(port, json!({"op": "rest"}))? else {
        return gated();
    };
    let Some(home) = page(port, json!({"op": "where"}))? else {
        return gated();
    };
    let home = Home {
        space_id: str_of(&home, "spaceId"),
        card_id: str_of(&home, "cardId"),
    };
    let plan = drives(gesture, &args, count, &home)?;

    let updates = rest
        .pointer("/rest/updatesPerSecond")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let budget = rest.get("budgetPerSecond").and_then(|v| v.as_f64());
    let (rest_line, at_rest) = rest_verdict(updates, budget);
    if !json_output {
        print_census(&census);
        println!("{rest_line}");
    }
    if !at_rest {
        return Err(format!(
            "the deck is not at rest ({rest_line}); a settle read over a busy deck is not the gesture's — find what is running with `deck motion list`"
        ));
    }
    if census.get("visibility").and_then(|v| v.as_str()) != Some("visible") {
        eprintln!(
            "warning: the deck reports itself hidden — a covered window stalls requestAnimationFrame, so these frames are not the user's"
        );
    }
    if !json_output {
        if tasks {
            println!(
                "note: the lead recorder takes a stack at every queueing and walks every React commit, so react_ms is perturbed upward"
            );
        }
        println!(
            "settle --gesture {gesture}, {} drive(s), commits within {MARGIN_MS:.0} ms of the settle mark",
            plan.iter().filter(|d| d.read).count()
        );
    }

    let mut readings = Vec::new();
    for drive in &plan {
        let raw = page(
            port,
            json!({
                "op": "record",
                "gesture": drive.gesture,
                "args": drive.args,
                "tasks": tasks && drive.read,
                "tailMs": TAIL_MS,
                "capMs": CAP_MS,
                "fixedMs": (drive.gesture == "switch").then_some(SWITCH_WINDOW_MS),
            }),
        )?;
        let Some(raw) = raw else {
            return gated();
        };
        if drive.read {
            let reading = reduce(drive, &raw);
            if !json_output {
                print_reading(readings.len() + 1, &reading);
            }
            readings.push(reading);
        }
        std::thread::sleep(std::time::Duration::from_millis(REST_BETWEEN_MS));
    }

    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "census": census,
                "rest": rest,
                "gesture": gesture,
                "marginMs": MARGIN_MS,
                "framesPerturbedByTasks": tasks,
                "readings": readings,
            }))
            .unwrap()
        );
    }
    Ok(0)
}

fn print_reading(index: usize, r: &Reading) {
    println!();
    let what = match r.args.as_object() {
        Some(o) if !o.is_empty() => format!("{} {}", r.gesture, r.args),
        _ => r.gesture.to_string(),
    };
    let Some((on, off)) = r.window else {
        println!("#{index} {what}: the settle mark never went on and off within {CAP_MS} ms");
        return;
    };
    let Some(seen) = r.commits_seen else {
        println!(
            "#{index} {what}: settle {on:.1}→{off:.1} ms; no commit census in this page (a release deck needs --tasks)"
        );
        return;
    };
    println!(
        "#{index} {what}: settle {on:.1}→{off:.1} ms, {} of {seen} commit(s) in the window",
        r.commits.len()
    );
    for c in &r.commits {
        let marker = if r.largest.as_ref() == Some(c) {
            "*"
        } else {
            " "
        };
        let react = match c.react_ms {
            Some(ms) => format!("react {ms:.1} ms"),
            None => format!("span {:.1} ms", c.react_or_span_ms),
        };
        println!(
            "  {marker} t {:>7.1}  {react}  performed {} (mounted {}) of {} fibers; asked by {}; caused by {}",
            c.t,
            c.performed,
            c.mounted,
            c.fibers,
            origins_label(&c.origins),
            c.causes
        );
        if r.largest.as_ref() == Some(c) {
            for why in &c.why {
                println!("        why {why}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(t: f64, performed: u64) -> RawCommit {
        serde_json::from_value(json!({"t": t, "performed": performed})).unwrap()
    }

    fn args(
        card: Option<&str>,
        pane: Option<&str>,
        slot: Option<u32>,
        space: Option<&str>,
    ) -> GestureArgs {
        GestureArgs {
            card: card.map(str::to_string),
            pane: pane.map(str::to_string),
            slot,
            mode: None,
            space: space.map(str::to_string),
        }
    }

    #[test]
    fn the_rest_check_reads_the_budget_and_never_assumes_zero() {
        assert!(rest_verdict(10.0, Some(10.0)).1);
        assert!(!rest_verdict(24.0, Some(10.0)).1);
        let (line, at_rest) = rest_verdict(24.0, None);
        assert!(at_rest);
        assert!(line.contains("no rest budget"));
    }

    #[test]
    fn a_switch_is_read_over_its_fixed_window() {
        assert_eq!(gesture_window("switch", &[]), Some((0.0, 600.0)));
        assert_eq!(gesture_window("fold", &[]), None);
    }

    #[test]
    fn window_opens_on_the_first_on_and_closes_on_the_next_off() {
        assert_eq!(window_of(&[]), None);
        // An off before any on is not a window's end.
        assert_eq!(
            window_of(&[(5.0, false), (10.0, true), (420.0, false)]),
            Some((10.0, 420.0))
        );
        // A window that never closes reports none.
        assert_eq!(window_of(&[(10.0, true)]), None);
        assert_eq!(
            window_of(&[(10.0, true), (12.0, true), (400.0, false), (500.0, true)]),
            Some((10.0, 400.0))
        );
    }

    #[test]
    fn in_window_keeps_the_margins_and_drops_the_rest() {
        let commits = vec![
            commit(-60.0, 1),
            commit(-50.0, 1),
            commit(100.0, 1),
            commit(460.0, 1),
            commit(460.5, 1),
            commit(-50.5, 1),
        ];
        assert_eq!(in_window(&commits, (10.0, 400.0), MARGIN_MS), vec![1, 2, 3]);
    }

    #[test]
    fn largest_by_performed_ties_to_the_earliest() {
        let raw = vec![
            commit(20.0, 5),
            commit(30.0, 9),
            commit(40.0, 9),
            commit(50.0, 2),
        ];
        let commits = window_commits(&raw, &[], (0.0, 100.0));
        let big = largest(&commits).unwrap();
        assert_eq!((big.t, big.performed), (30.0, 9));
        assert!(largest(&[]).is_none());
    }

    #[test]
    fn a_reading_reports_the_window_and_its_commits() {
        let drive = Drive {
            gesture: "close",
            args: json!({"pane": "p1"}),
            read: true,
        };
        let raw = json!({
            "settle": [[8.0, true], [410.0, false]],
            "commits": [
                {"t": 2.0, "performed": 3},
                {"t": 30.0, "performed": 2965, "mounted": 4, "fibers": 9000,
                 "why": ["TugPaneImpl@p2{columnMember}", "CardTitleBar@c2{placeArrangement}"]},
                {"t": 800.0, "performed": 7},
            ],
        });
        let r = reduce(&drive, &raw);
        assert_eq!(r.window, Some((8.0, 410.0)));
        assert_eq!(r.commits_seen, Some(3));
        assert_eq!(r.commits.len(), 2);
        let big = r.largest.unwrap();
        assert_eq!((big.performed, big.mounted, big.fibers), (2965, 4, 9000));
        assert_eq!(big.why.len(), 2);
    }

    #[test]
    fn a_page_with_no_census_reads_no_commits() {
        let drive = Drive {
            gesture: "rails",
            args: json!({}),
            read: true,
        };
        let r = reduce(
            &drive,
            &json!({"settle": [[8.0, true], [410.0, false]], "commits": null}),
        );
        assert_eq!(r.commits_seen, None);
        assert!(r.commits.is_empty());
        assert!(r.largest.is_none());
    }

    #[test]
    fn each_gesture_refuses_its_missing_argument_by_flag() {
        let none = GestureArgs::default();
        for (gesture, flag) in [
            ("flip", "--card"),
            ("fold", "--card"),
            ("unfold", "--card"),
            ("close", "--pane"),
            ("split", "--slot"),
            ("switch", "--space"),
        ] {
            let error = check_args(gesture, &none).unwrap_err();
            assert_eq!(error, format!("--gesture {gesture} needs {flag}"));
        }
        assert!(check_args("rails", &none).is_ok());
        assert!(
            check_args("wiggle", &none)
                .unwrap_err()
                .contains("unknown gesture")
        );
    }

    #[test]
    fn repetitions_undo_the_drive_before_them() {
        let home = Home {
            space_id: Some("s1".into()),
            card_id: Some("c0".into()),
        };
        let fold = drives("fold", &args(Some("c1"), None, None, None), 3, &home).unwrap();
        let names: Vec<_> = fold.iter().map(|d| d.gesture).collect();
        assert_eq!(names, vec!["fold", "unfold", "fold"]);

        let split = drives("split", &args(None, None, Some(0), None), 2, &home).unwrap();
        assert_eq!(split[0].args, json!({"slot": 0, "mode": "split"}));
        assert_eq!(split[1].args, json!({"slot": 0, "mode": "stack"}));

        let switch = drives("switch", &args(None, None, None, Some("s2")), 2, &home).unwrap();
        assert_eq!(switch[1].args, json!({"space": "s1"}));
        // Back to the active workspace is a no-op, so a repeat is refused.
        assert!(drives("switch", &args(None, None, None, Some("s1")), 2, &home).is_err());
        assert!(drives("switch", &args(None, None, None, Some("s1")), 1, &home).is_ok());

        let flip = drives("flip", &args(Some("c1"), None, None, None), 2, &home).unwrap();
        assert_eq!(flip[1].args, json!({"card": "c0"}));

        // Each show is read, and the hide before it is not.
        let rails = drives("rails", &GestureArgs::default(), 2, &home).unwrap();
        let read: Vec<_> = rails.iter().map(|d| d.read).collect();
        assert_eq!(read, vec![false, true, false, true]);

        let close = drives("close", &args(None, Some("p1"), None, None), 5, &home).unwrap();
        assert_eq!(close.len(), 1);
    }
}
