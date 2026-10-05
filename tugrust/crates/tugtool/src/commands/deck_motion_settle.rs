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
//!
//! Beside the commits each reading carries what a user sees: the frame lead
//! (the drive to the first frame after it), the longest gap the outside
//! recorder saw up to the settle mark's off, the lead included, and every
//! `settle-beat` row the deck trace wrote in the window, whose `startDelayMs`
//! is planning to the beat's first running frame. With `--chains` it also
//! carries the forced-layout chain probe's reading over the drive.
//!
//! And each reading carries the **land**: the frame the settle's hand-back
//! paid for, read off the same outside frames. The settle mark goes off inside
//! the land's own task, so the land opens at the last frame before the off and
//! closes at the second after it — the first runs ahead of the layout and
//! observer deliveries the hand-back dirtied. What ran in that span is named
//! by site: commits from the census, chains with `--chains`, and
//! `ResizeObserver` deliveries from the lead recorder with `--tasks`.
//!
//! The commits are the window's census, and the census carries its sum: the
//! **main thread** — React's time in every commit in the window, plus the
//! longest chain (with `--chains`) whose paying read fell outside every
//! commit's span. That is the set-up's cost a gesture's frames wait behind,
//! read on the deck the user runs rather than barred in an app-test.

use crate::commands::deck_motion::{EVAL_GATED_REMEDY, EXIT_GATED};
use crate::commands::deck_motion_slide::{
    RawCommit, RawTask, RawTell, census, commit_timings, ensure_recorder, origins_label,
    print_census, script_page,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The page half: one function expression, applied to a JSON argument object.
const PAGE: &str = include_str!("deck_motion_settle.js");

/// The gestures the verb drives, as `--gesture` takes them.
pub const GESTURE_NAMES: [&str; 14] = [
    "flip", "fold", "unfold", "close", "rails", "split", "switch", "slot", "go", "bullseye",
    "sidebar", "fit", "appear", "slide",
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
    pub component: Option<String>,
}

/// Where the deck stands before the first drive: what a repeated `switch`,
/// `flip`, `slide` or `slot` goes back to.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Home {
    pub space_id: Option<String>,
    pub card_id: Option<String>,
    /// The slot of the pane holding `--card`, when one does.
    pub card_slot: Option<u32>,
}

/// One call to `lab.drive`, and whether its window is reported. A `rails`
/// hide is driven so the next show has a hidden rail to show, and not read;
/// so is the close of the card an `appear` brought in. That close names no
/// pane here (`"pane": null`): the pane is the one the `appear` before it
/// returned, which the run substitutes ([`close_target`]).
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
        "flip" | "fold" | "unfold" | "slot" | "slide" if args.card.is_none() => missing("--card"),
        "close" | "bullseye" if args.pane.is_none() => missing("--pane"),
        "split" | "slot" | "go" if args.slot.is_none() => missing("--slot"),
        "switch" if args.space.is_none() => missing("--space"),
        "sidebar" if args.component.is_none() => missing("--component"),
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
///
/// `slot` alternates `--slot` with the slot the card stood in, and `go` with
/// slot 0; `bullseye` repeats its toggle, which undoes itself; `sidebar` hides
/// and then shows, both read; `slide` alternates like `flip`; `fit` drives
/// once, since a second fit has nothing left to fit; and `appear` is followed
/// by an unread close of the pane it brought in.
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
        "flip" | "slide" => {
            let name: &'static str = if gesture == "flip" { "flip" } else { "slide" };
            let to = args.card.clone().unwrap_or_default();
            let back = match &home.card_id {
                Some(home) if *home != to => Some(home.clone()),
                _ if count > 1 => {
                    return Err(format!(
                        "--gesture {name} --count {count} goes back to the focused card between drives, and '{to}' is already the focused one"
                    ));
                }
                _ => None,
            };
            alternate(
                read(name, json!({"card": to})),
                read(name, json!({"card": back})),
            )
        }
        "slot" => {
            let to = args.slot.unwrap_or_default();
            let back = match home.card_slot {
                Some(home) if home != to => Some(home),
                _ if count > 1 => {
                    return Err(format!(
                        "--gesture slot --count {count} sends the card back to its own slot between drives, and the deck holds it in no other slot than {to}"
                    ));
                }
                _ => None,
            };
            alternate(
                read("slot", json!({"card": args.card, "slot": to})),
                read("slot", json!({"card": args.card, "slot": back})),
            )
        }
        "go" => {
            let to = args.slot.unwrap_or_default();
            if to == 0 && count > 1 {
                return Err(format!(
                    "--gesture go --count {count} goes back to slot 0 between drives, and --slot 0 is slot 0"
                ));
            }
            alternate(
                read("go", json!({"slot": to})),
                read("go", json!({"slot": 0})),
            )
        }
        "bullseye" => (0..count)
            .map(|_| read("bullseye", json!({"pane": args.pane})))
            .collect(),
        "sidebar" => alternate(
            read(
                "sidebar",
                json!({"component": args.component, "open": false}),
            ),
            read(
                "sidebar",
                json!({"component": args.component, "open": true}),
            ),
        ),
        "fit" => vec![read("fit", json!({}))],
        "appear" => (0..count)
            .flat_map(|_| {
                [
                    read("appear", json!({})),
                    Drive {
                        gesture: "close",
                        args: json!({"pane": null}),
                        read: false,
                    },
                ]
            })
            .collect(),
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

/// Whether a gesture drives once whatever `--count` says.
fn drives_once(gesture: &str) -> bool {
    matches!(gesture, "close" | "fit")
}

/// The drives a run makes, and which one carries the chain probe's stacks.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub drives: Vec<Drive>,
    /// The drive armed with stacks, for the census by call site.
    pub census: Option<usize>,
    /// Whether the census drive is also reported as a reading: only when the
    /// gesture drives once, so there is no other drive to read.
    pub census_read: bool,
}

/// The run's drives. Without `--chains`, [`drives`] as it stands. With it,
/// one repetition more, whose first read drive is the census: armed with
/// stacks, printed by call site, and not a reading, since a stack per read is
/// the probe's own price. Every other read drive is armed without stacks. A
/// gesture that drives once has no second drive to spare, so its one drive is
/// the census and the reading both.
pub fn plan(
    gesture: &str,
    args: &GestureArgs,
    count: u32,
    home: &Home,
    chains: bool,
) -> Result<Plan, String> {
    if !chains {
        return Ok(Plan {
            drives: drives(gesture, args, count, home)?,
            census: None,
            census_read: false,
        });
    }
    let once = drives_once(gesture);
    let drives = drives(
        gesture,
        args,
        if once { count } else { count.max(1) + 1 },
        home,
    )?;
    let census = drives.iter().position(|d| d.read);
    Ok(Plan {
        drives,
        census,
        census_read: once,
    })
}

/// The pane a drive closes: its own, or, for the close after an `appear`, the
/// pane that `appear` returned. `Err` when there is none to close.
pub fn close_target(drive: &Drive, last_pane: Option<&str>) -> Result<Value, String> {
    if drive.gesture != "close" || !drive.args["pane"].is_null() {
        return Ok(drive.args.clone());
    }
    match last_pane {
        Some(pane) => Ok(json!({"pane": pane})),
        None => Err("--gesture appear: the drive returned no pane to close".to_string()),
    }
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

/// The frame lead and the longest gap, from the outside recorder's frames.
///
/// The lead is the first frame after the drive, relative to it. The longest
/// gap is the largest of the lead and every gap between consecutive frames, up
/// to and including the first frame at or after `end` (the settle mark's off),
/// so a gap that spans the off is counted. `None` for both with no frames.
pub fn frame_gaps(frames: &[f64], end: Option<f64>) -> (Option<f64>, Option<f64>) {
    let Some(&lead) = frames.first() else {
        return (None, None);
    };
    let mut longest = lead;
    let mut prev = lead;
    for &t in &frames[1..] {
        if end.is_some_and(|end| prev >= end) {
            break;
        }
        longest = longest.max(t - prev);
        prev = t;
    }
    (Some(round1(lead)), Some(round1(longest)))
}

/// One thing that ran in the land's frame: a chain's paying read or an
/// observer delivery, with its own time and who asked.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct LandSite {
    /// Relative to the drive.
    pub t: f64,
    pub ms: f64,
    pub site: String,
}

/// One commit in the land's frame.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LandCommit {
    pub t: f64,
    pub performed: u64,
    /// The component that asked first, or the one that performed most.
    pub site: String,
}

/// The land: the frame the settle's hand-back paid for, and what ran in it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Land {
    /// The settle mark's off, relative to the drive — inside the land's task.
    pub at_ms: f64,
    /// The last frame before the off to the first after, and that to the next.
    pub gaps_ms: Vec<f64>,
    /// The longer of the two; `None` when no frame followed the off.
    pub frame_ms: Option<f64>,
    /// `None` when the page had no commit census.
    pub commits: Option<Vec<LandCommit>>,
    /// `None` without `--chains`.
    pub chains: Option<Vec<LandSite>>,
    /// `None` without `--tasks`.
    pub deliveries: Option<Vec<LandSite>>,
}

/// The land's span: the last frame before `off`, or `off` when none came
/// before it, and up to two frames at or after it.
pub fn land_span(frames: &[f64], off: f64) -> (f64, Vec<f64>) {
    let mut before = off;
    let mut after = Vec::new();
    for &t in frames {
        if t < off {
            before = t;
        } else if after.len() < 2 {
            after.push(t);
        }
    }
    (before, after)
}

/// Read the land around the settle mark's off. An event belongs to it when it
/// began after the span's opening frame and at or before its closing one.
pub fn land(
    frames: &[f64],
    off: f64,
    commits: Option<&[RawCommit]>,
    chains: Option<&[LandSite]>,
    tasks: Option<&[RawTask]>,
) -> Land {
    let (before, after) = land_span(frames, off);
    let mut gaps_ms = Vec::new();
    let mut previous = before;
    for &t in &after {
        gaps_ms.push(round1(t - previous));
        previous = t;
    }
    let end = after.last().copied().unwrap_or(off);
    let inside = |t: f64| t > before && t <= end;
    let (commits, chains, deliveries) = events_in(commits, chains, tasks, inside);
    Land {
        at_ms: off,
        frame_ms: gaps_ms.iter().copied().reduce(f64::max),
        gaps_ms,
        commits,
        chains,
        deliveries,
    }
}

/// The commits, chains and observer deliveries that began where `inside`
/// says — the land's span, or the motion's.
#[allow(clippy::type_complexity)]
fn events_in(
    commits: Option<&[RawCommit]>,
    chains: Option<&[LandSite]>,
    tasks: Option<&[RawTask]>,
    inside: impl Fn(f64) -> bool,
) -> (
    Option<Vec<LandCommit>>,
    Option<Vec<LandSite>>,
    Option<Vec<LandSite>>,
) {
    (
        commits.map(|commits| {
            commits
                .iter()
                .filter(|c| inside(c.t))
                .map(|c| LandCommit {
                    t: c.t,
                    performed: c.performed,
                    site: c
                        .origins
                        .first()
                        .or(c.top.first())
                        .map_or_else(|| "-".to_string(), |(name, _)| name.clone()),
                })
                .collect()
        }),
        chains.map(|chains| chains.iter().filter(|c| inside(c.t)).cloned().collect()),
        tasks.map(|tasks| {
            tasks
                .iter()
                .filter(|task| task.kind == "resize-observer" && inside(task.start))
                .map(|task| LandSite {
                    t: task.start,
                    ms: round1(task.end - task.start),
                    site: if task.name.is_empty() {
                        "anonymous".to_string()
                    } else {
                        task.name.clone()
                    },
                })
                .collect()
        }),
    )
}

/// The motion: from the motion gate's last close before the land — the
/// beats' launch — to the land, and what ran in it. Under set-up-and-go
/// ([B05]) the three lists are empty and no gap is over one period.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Motion {
    /// The gate's close, relative to the drive.
    pub at_ms: f64,
    /// The longest frame-to-frame gap whose opening frame came at or after
    /// the close and whose closing frame came at or before the land's off;
    /// `None` when no two frames fell inside.
    pub longest_gap_ms: Option<f64>,
    /// `None` when the page had no commit census.
    pub commits: Option<Vec<LandCommit>>,
    /// `None` without `--chains`.
    pub chains: Option<Vec<LandSite>>,
    /// `None` without `--tasks`.
    pub deliveries: Option<Vec<LandSite>>,
}

/// Read the motion between the gate's last close before `off` and `off`.
/// `None` when no close came before the land — a deck that predates the
/// gate, or a settle that launched no beats.
pub fn motion(
    frames: &[f64],
    gates: &[(f64, String)],
    off: f64,
    commits: Option<&[RawCommit]>,
    chains: Option<&[LandSite]>,
    tasks: Option<&[RawTask]>,
) -> Option<Motion> {
    let at = gates
        .iter()
        .filter(|(t, phase)| phase == "close" && *t <= off)
        .map(|(t, _)| *t)
        .reduce(f64::max)?;
    let longest_gap_ms = frames
        .windows(2)
        .filter(|pair| pair[0] >= at && pair[1] <= off)
        .map(|pair| round1(pair[1] - pair[0]))
        .reduce(f64::max);
    let (commits, chains, deliveries) = events_in(commits, chains, tasks, |t| t > at && t <= off);
    Some(Motion {
        at_ms: at,
        longest_gap_ms,
        commits,
        chains,
        deliveries,
    })
}

/// One `settle-beat` row the deck trace recorded in the window.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BeatRow {
    pub recipe: String,
    #[serde(default)]
    pub targets: u64,
    #[serde(default)]
    pub duration_ms: f64,
    /// Planning to the beat's first running frame; `-1` when its clock never
    /// started.
    #[serde(default)]
    pub start_delay_ms: f64,
    /// The `height`/`width` breaches the beat declared.
    #[serde(default)]
    pub declares: Vec<String>,
    #[serde(default)]
    pub landing: String,
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

/// The window's main-thread time, summed off the commit census: React's time
/// in every commit in the window, plus the longest forced-layout chain in the
/// window whose paying read falls outside every commit's span from render
/// start to commit. A chain paid in a layout effect is inside its commit's
/// React time already, so only a chain after the commit — a `ResizeObserver`
/// delivery, a CodeMirror measure — is added to it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct MainThread {
    /// `react_ms` summed over the window's timed commits.
    pub react_ms: f64,
    /// The window's commits that carry no React time — no lead recorder, or a
    /// render that read no store. Counted, and not in the sum.
    pub untimed: usize,
    /// The longest chain outside every commit's span; `None` without
    /// `--chains`, and when every chain in the window fell inside a commit.
    pub outside_chain: Option<LandSite>,
    /// The chain time the commits' spans already contain; `None` without
    /// `--chains`.
    pub inside_chain_ms: Option<f64>,
    /// `react_ms` plus the outside chain's time.
    pub total_ms: f64,
}

/// Sum the window's main-thread time from the raw commits and, with
/// `--chains`, each chain's paying read on the drive's clock.
pub fn main_thread(
    commits: &[RawCommit],
    chains: Option<&[LandSite]>,
    window: (f64, f64),
) -> MainThread {
    let in_win: Vec<&RawCommit> = in_window(commits, window, MARGIN_MS)
        .into_iter()
        .map(|i| &commits[i])
        .collect();
    let spans: Vec<(f64, f64)> = in_win
        .iter()
        .filter_map(|c| c.render_start.map(|s| (s, c.t)))
        .collect();
    let react_ms = round1(spans.iter().map(|(s, t)| t - s).sum());
    let untimed = in_win.len() - spans.len();
    let (outside_chain, inside_chain_ms) = match chains {
        None => (None, None),
        Some(chains) => {
            let near = chains
                .iter()
                .filter(|c| c.t >= window.0 - MARGIN_MS && c.t <= window.1 + MARGIN_MS);
            let (inside, outside): (Vec<&LandSite>, Vec<&LandSite>) =
                near.partition(|c| spans.iter().any(|(s, t)| c.t >= *s && c.t <= *t));
            let longest = outside
                .into_iter()
                .fold(None, |best: Option<&LandSite>, c| match best {
                    Some(b) if b.ms >= c.ms => Some(b),
                    _ => Some(c),
                });
            (
                longest.cloned(),
                Some(round1(inside.iter().map(|c| c.ms).sum())),
            )
        }
    };
    let total_ms = round1(react_ms + outside_chain.as_ref().map_or(0.0, |c| c.ms));
    MainThread {
        react_ms,
        untimed,
        outside_chain,
        inside_chain_ms,
        total_ms,
    }
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
    /// The window's main-thread time over `commits`; `None` when the page had
    /// no census or the window never closed.
    pub main_thread: Option<MainThread>,
    /// The `settle-beat` rows recorded over the drive (page key `settleBeats`).
    pub settle_beats: Vec<BeatRow>,
    /// The drive to the first frame after it.
    pub lead_ms: Option<f64>,
    /// The largest of the lead and every frame gap up to the settle mark's off.
    pub longest_gap_ms: Option<f64>,
    /// The chain probe's reading over the drive, with `--chains`.
    pub chains: Option<Value>,
    /// The frame the settle's hand-back paid for; `None` when the settle mark
    /// never went off, and for a switch, which sets none.
    pub land: Option<Land>,
    /// The motion between the gate's close and the land; `None` when the
    /// settle mark never went off, for a switch, and on a deck with no gate.
    pub motion: Option<Motion>,
    /// The pane the drive returned — an `appear`'s arriving pane.
    pub pane_id: Option<String>,
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
    let frames: Vec<f64> = list(raw, "frames").unwrap_or_default();
    let window = gesture_window(drive.gesture, &marks);
    let (lead_ms, longest_gap_ms) = frame_gaps(&frames, window.map(|w| w.1));
    let land_chains: Option<Vec<LandSite>> = list(raw, "landChains");
    let tasks: Option<Vec<RawTask>> = list(raw, "tasks");
    let gates: Vec<(f64, String)> = list(raw, "gates").unwrap_or_default();
    let motion_reading = (drive.gesture != "switch")
        .then(|| window_of(&marks))
        .flatten()
        .and_then(|(_, off)| {
            motion(
                &frames,
                &gates,
                off,
                raw_commits.as_deref(),
                land_chains.as_deref(),
                tasks.as_deref(),
            )
        });
    let land = (drive.gesture != "switch")
        .then(|| window_of(&marks))
        .flatten()
        .map(|(_, off)| {
            land(
                &frames,
                off,
                raw_commits.as_deref(),
                land_chains.as_deref(),
                tasks.as_deref(),
            )
        });
    let commits = match (&raw_commits, window) {
        (Some(commits), Some(window)) => window_commits(commits, &tells, window),
        _ => Vec::new(),
    };
    let main_thread_reading = match (&raw_commits, window) {
        (Some(commits), Some(window)) => Some(main_thread(commits, land_chains.as_deref(), window)),
        _ => None,
    };
    Reading {
        gesture: drive.gesture,
        args: drive.args.clone(),
        window,
        largest: largest(&commits).cloned(),
        commits,
        commits_seen: raw_commits.map(|c| c.len()),
        main_thread: main_thread_reading,
        settle_beats: list(raw, "settleBeats").unwrap_or_default(),
        lead_ms,
        longest_gap_ms,
        chains: raw.get("chains").filter(|v| !v.is_null()).cloned(),
        land,
        motion: motion_reading,
        pane_id: str_of(raw, "paneId"),
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
    chains: bool,
    json_output: bool,
) -> Result<i32, String> {
    let gated = || {
        eprintln!("{EVAL_GATED_REMEDY}");
        Ok(EXIT_GATED)
    };
    check_args(gesture, &args)?;
    if drives_once(gesture) && count > 1 && !json_output {
        let what = if gesture == "close" {
            "a pane closes once"
        } else {
            "a fit has nothing left to fit after the first"
        };
        eprintln!("note: {what}; --count {count} reads one {gesture}");
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
    let Some(home) = page(port, json!({"op": "where", "card": args.card}))? else {
        return gated();
    };
    let home = Home {
        space_id: str_of(&home, "spaceId"),
        card_id: str_of(&home, "cardId"),
        card_slot: home
            .get("cardSlot")
            .and_then(|v| v.as_u64())
            .map(|s| s as u32),
    };
    let Plan {
        drives: plan,
        census: census_index,
        census_read,
    } = plan(gesture, &args, count, &home, chains)?;

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
                - usize::from(census_index.is_some() && !census_read)
        );
    }

    let mut readings = Vec::new();
    let mut chains_census: Option<Value> = None;
    let mut last_pane: Option<String> = None;
    for (index, drive) in plan.iter().enumerate() {
        let is_census = census_index == Some(index);
        let drive_args = close_target(drive, last_pane.as_deref())?;
        let raw = page(
            port,
            json!({
                "op": "record",
                "gesture": drive.gesture,
                "args": drive_args,
                "tasks": tasks && drive.read,
                "chains": chains && drive.read,
                "chainStacks": is_census,
                "tailMs": TAIL_MS,
                "capMs": CAP_MS,
                "fixedMs": (drive.gesture == "switch").then_some(SWITCH_WINDOW_MS),
            }),
        )?;
        let Some(raw) = raw else {
            return gated();
        };
        if let Some(error) = raw.get("error").and_then(|e| e.as_str()) {
            return Err(error.to_string());
        }
        last_pane = str_of(&raw, "paneId");
        if is_census {
            chains_census = raw.get("chains").filter(|v| !v.is_null()).cloned();
            if !json_output {
                print_chains_census(chains_census.as_ref());
            }
        }
        if drive.read && (!is_census || census_read) {
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
                "chainsCensus": chains_census,
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
        print!("{}", reading_extras(r));
        return;
    };
    let Some(seen) = r.commits_seen else {
        println!(
            "#{index} {what}: settle {on:.1}→{off:.1} ms; no commit census in this page (a release deck needs --tasks)"
        );
        print!("{}", reading_extras(r));
        return;
    };
    println!(
        "#{index} {what}: settle {on:.1}→{off:.1} ms, {} of {seen} commit(s) in the window",
        r.commits.len()
    );
    print!("{}", reading_extras(r));
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

/// What a reading says beyond its commits, as the human output prints it
/// beneath the reading's header: the lead and longest gap, the land and what
/// ran in it, each beat's start delay and declared breaches, and the chain
/// probe's count, ms and top five sites.
pub fn reading_extras(r: &Reading) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let ms = |v: Option<f64>| v.map_or_else(|| "—".to_string(), |v| format!("{v:.1}"));
    let _ = writeln!(
        out,
        "   lead {} ms, longest gap {} ms",
        ms(r.lead_ms),
        ms(r.longest_gap_ms)
    );
    if let Some(m) = &r.main_thread {
        let untimed = if m.untimed == 0 {
            String::new()
        } else {
            format!(", {} untimed", m.untimed)
        };
        let outside = match (&m.outside_chain, m.inside_chain_ms) {
            (_, None) => "chains unread (--chains)".to_string(),
            (None, Some(inside)) => {
                format!("no chain outside a commit (in-commit chains {inside:.1} ms)")
            }
            (Some(c), Some(inside)) => format!(
                "longest outside chain {:.1} ms at {} (in-commit chains {inside:.1} ms)",
                c.ms, c.site
            ),
        };
        let _ = writeln!(
            out,
            "   main thread {:.1} ms: react {:.1} ms{untimed} + {outside}",
            m.total_ms, m.react_ms
        );
    }
    if let Some(land) = &r.land {
        let gaps = land
            .gaps_ms
            .iter()
            .map(|g| format!("{g:.1}"))
            .collect::<Vec<_>>()
            .join(", ");
        let count = |n: Option<usize>| n.map_or_else(|| "—".to_string(), |n| n.to_string());
        let _ = writeln!(
            out,
            "   land {} ms at {:.1} (gaps {gaps}); commits {}, chains {}, deliveries {}",
            ms(land.frame_ms),
            land.at_ms,
            count(land.commits.as_ref().map(Vec::len)),
            count(land.chains.as_ref().map(Vec::len)),
            count(land.deliveries.as_ref().map(Vec::len)),
        );
        for c in land.commits.iter().flatten() {
            let _ = writeln!(
                out,
                "     commit t {:>7.1}  performed {:>5}  {}",
                c.t, c.performed, c.site
            );
        }
        for c in land.chains.iter().flatten() {
            let _ = writeln!(
                out,
                "     chain  t {:>7.1}  {:>6.1} ms  {}",
                c.t, c.ms, c.site
            );
        }
        for d in land.deliveries.iter().flatten() {
            let _ = writeln!(
                out,
                "     resize t {:>7.1}  {:>6.1} ms  {}",
                d.t, d.ms, d.site
            );
        }
    }
    if let Some(motion) = &r.motion {
        let count = |n: Option<usize>| n.map_or_else(|| "—".to_string(), |n| n.to_string());
        let _ = writeln!(
            out,
            "   motion from {:.1} ms: longest gap {} ms; commits {}, chains {}, deliveries {}",
            motion.at_ms,
            ms(motion.longest_gap_ms),
            count(motion.commits.as_ref().map(Vec::len)),
            count(motion.chains.as_ref().map(Vec::len)),
            count(motion.deliveries.as_ref().map(Vec::len)),
        );
        for c in motion.commits.iter().flatten() {
            let _ = writeln!(
                out,
                "     commit t {:>7.1}  performed {:>5}  {}",
                c.t, c.performed, c.site
            );
        }
        for c in motion.chains.iter().flatten() {
            let _ = writeln!(
                out,
                "     chain  t {:>7.1}  {:>6.1} ms  {}",
                c.t, c.ms, c.site
            );
        }
        for d in motion.deliveries.iter().flatten() {
            let _ = writeln!(
                out,
                "     resize t {:>7.1}  {:>6.1} ms  {}",
                d.t, d.ms, d.site
            );
        }
    }
    for beat in &r.settle_beats {
        let declares = if beat.declares.is_empty() {
            "nothing".to_string()
        } else {
            beat.declares.join(",")
        };
        let _ = writeln!(
            out,
            "   beat {} start {:.1} ms declares {declares}",
            beat.recipe, beat.start_delay_ms
        );
    }
    if let Some(chains) = &r.chains {
        let num = |v: &Value, key: &str| v.get(key).and_then(|n| n.as_f64()).unwrap_or(0.0);
        let _ = writeln!(
            out,
            "   chains {} (longest {:.1} ms, total {:.1} ms)",
            num(chains, "chains") as i64,
            num(chains, "longestChainMs"),
            num(chains, "totalChainMs")
        );
        if let Some(ranked) = chains.get("ranked").and_then(|r| r.as_array()) {
            for site in ranked.iter().take(5) {
                let first = site
                    .get("site")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim();
                let _ = writeln!(
                    out,
                    "     {:>5} chains {:>7.1} ms  {first}",
                    num(site, "chains") as i64,
                    num(site, "ms")
                );
            }
        }
    }
    out
}

/// The census drive's chains, by call site.
fn print_chains_census(chains: Option<&Value>) {
    println!();
    println!("chain census (one extra drive, with stacks — its ms carry the probe's price):");
    match chains.and_then(|c| crate::commands::deck_motion::chains_text("read", c)) {
        Some(text) => print!("{text}"),
        None => println!("  the page returned no chain reading"),
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
            component: None,
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
            card_slot: None,
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

    #[test]
    fn each_new_gesture_refuses_its_missing_argument_by_flag() {
        let none = GestureArgs::default();
        for (gesture, given, flag) in [
            ("slot", GestureArgs::default(), "--card"),
            ("slot", args(Some("c1"), None, None, None), "--slot"),
            ("go", GestureArgs::default(), "--slot"),
            ("bullseye", GestureArgs::default(), "--pane"),
            ("sidebar", GestureArgs::default(), "--component"),
            ("slide", GestureArgs::default(), "--card"),
        ] {
            let error = check_args(gesture, &given).unwrap_err();
            assert_eq!(error, format!("--gesture {gesture} needs {flag}"));
        }
        assert!(check_args("fit", &none).is_ok());
        assert!(check_args("appear", &none).is_ok());
    }

    fn home_at(card_slot: Option<u32>) -> Home {
        Home {
            space_id: Some("s1".into()),
            card_id: Some("c0".into()),
            card_slot,
        }
    }

    #[test]
    fn slot_alternates_with_the_card_s_own_slot() {
        let slot = drives(
            "slot",
            &args(Some("c1"), None, Some(2), None),
            3,
            &home_at(Some(0)),
        )
        .unwrap();
        let slots: Vec<_> = slot.iter().map(|d| d.args["slot"].clone()).collect();
        assert_eq!(slots, vec![json!(2), json!(0), json!(2)]);
        assert!(
            slot.iter()
                .all(|d| d.gesture == "slot" && d.args["card"] == "c1")
        );
        // A card already in the slot it is sent to has nowhere to go back to.
        assert!(
            drives(
                "slot",
                &args(Some("c1"), None, Some(2), None),
                2,
                &home_at(Some(2))
            )
            .is_err()
        );
        assert!(
            drives(
                "slot",
                &args(Some("c1"), None, Some(2), None),
                2,
                &home_at(None)
            )
            .is_err()
        );
        assert!(
            drives(
                "slot",
                &args(Some("c1"), None, Some(2), None),
                1,
                &home_at(None)
            )
            .is_ok()
        );
    }

    #[test]
    fn go_alternates_with_slot_zero_and_refuses_a_repeated_zero() {
        let go = drives("go", &args(None, None, Some(3), None), 2, &home_at(None)).unwrap();
        assert_eq!(go[0].args, json!({"slot": 3}));
        assert_eq!(go[1].args, json!({"slot": 0}));
        assert!(drives("go", &args(None, None, Some(0), None), 2, &home_at(None)).is_err());
        assert!(drives("go", &args(None, None, Some(0), None), 1, &home_at(None)).is_ok());
    }

    #[test]
    fn sidebar_hides_first_and_reads_both() {
        let given = GestureArgs {
            component: Some("jots".into()),
            ..GestureArgs::default()
        };
        let sidebar = drives("sidebar", &given, 3, &home_at(None)).unwrap();
        let opens: Vec<_> = sidebar.iter().map(|d| d.args["open"].clone()).collect();
        assert_eq!(opens, vec![json!(false), json!(true), json!(false)]);
        assert!(
            sidebar
                .iter()
                .all(|d| d.read && d.args["component"] == "jots")
        );
    }

    #[test]
    fn fit_drives_once_and_bullseye_repeats_its_toggle() {
        let fit = drives("fit", &GestureArgs::default(), 3, &home_at(None)).unwrap();
        assert_eq!(fit.len(), 1);
        let bullseye = drives(
            "bullseye",
            &args(None, Some("p1"), None, None),
            2,
            &home_at(None),
        )
        .unwrap();
        assert_eq!(bullseye.len(), 2);
        assert!(bullseye.iter().all(|d| d.args == json!({"pane": "p1"})));
    }

    #[test]
    fn slide_alternates_like_flip() {
        let slide = drives(
            "slide",
            &args(Some("c1"), None, None, None),
            2,
            &home_at(None),
        )
        .unwrap();
        assert_eq!(slide[0].gesture, "slide");
        assert_eq!(slide[1].args, json!({"card": "c0"}));
        assert!(
            drives(
                "slide",
                &args(Some("c0"), None, None, None),
                2,
                &home_at(None)
            )
            .is_err()
        );
    }

    #[test]
    fn appear_reads_each_arrival_and_closes_it_unread() {
        let appear = drives("appear", &GestureArgs::default(), 2, &home_at(None)).unwrap();
        let shape: Vec<_> = appear.iter().map(|d| (d.gesture, d.read)).collect();
        assert_eq!(
            shape,
            vec![
                ("appear", true),
                ("close", false),
                ("appear", true),
                ("close", false)
            ]
        );
        // The close takes the pane the appear before it returned.
        assert_eq!(
            close_target(&appear[1], Some("p-new")).unwrap(),
            json!({"pane": "p-new"})
        );
        assert!(close_target(&appear[1], None).is_err());
        // A close that named its pane keeps it, and any other drive is untouched.
        let named = drives(
            "close",
            &args(None, Some("p1"), None, None),
            1,
            &home_at(None),
        )
        .unwrap();
        assert_eq!(
            close_target(&named[0], Some("p-new")).unwrap(),
            json!({"pane": "p1"})
        );
        assert_eq!(close_target(&appear[0], Some("p-new")).unwrap(), json!({}));
    }

    #[test]
    fn chains_add_one_census_drive_ahead_of_the_readings() {
        let fold = args(Some("c1"), None, None, None);
        let plain = plan("fold", &fold, 3, &home_at(None), false).unwrap();
        assert_eq!((plain.drives.len(), plain.census), (3, None));

        let census = plan("fold", &fold, 3, &home_at(None), true).unwrap();
        let names: Vec<_> = census.drives.iter().map(|d| d.gesture).collect();
        // One repetition more, so the readings still alternate after it.
        assert_eq!(names, vec!["fold", "unfold", "fold", "unfold"]);
        assert_eq!((census.census, census.census_read), (Some(0), false));

        // A rails hide is unread, so the census is the first show.
        let rails = plan("rails", &GestureArgs::default(), 1, &home_at(None), true).unwrap();
        assert_eq!(rails.census, Some(1));

        // A gesture that drives once reads its one drive as the census too.
        let fit = plan("fit", &GestureArgs::default(), 3, &home_at(None), true).unwrap();
        assert_eq!(
            (fit.drives.len(), fit.census, fit.census_read),
            (1, Some(0), true)
        );
    }

    #[test]
    fn the_lead_is_a_gap_and_gaps_stop_at_the_settle_off() {
        assert_eq!(frame_gaps(&[], Some(100.0)), (None, None));
        // A 130 ms lead is the longest gap even when every frame after is even.
        assert_eq!(
            frame_gaps(&[130.0, 146.7, 163.4, 180.1], Some(170.0)),
            (Some(130.0), Some(130.0))
        );
        // A gap spanning the off is counted; one after the first frame past
        // the off is not.
        assert_eq!(
            frame_gaps(&[8.0, 24.7, 41.4, 90.0, 400.0], Some(60.0)),
            (Some(8.0), Some(48.6))
        );
        // With no window the whole recording counts.
        assert_eq!(
            frame_gaps(&[8.0, 24.7, 41.4, 90.0, 400.0], None),
            (Some(8.0), Some(310.0))
        );
    }

    #[test]
    fn the_motion_runs_from_the_last_gate_close_to_the_off() {
        let frames = [10.0, 26.7, 90.0, 106.7, 150.0, 166.7, 183.4];
        let gates = vec![
            (5.0, "close".to_string()),
            (60.0, "open".to_string()),
            // The retarget's close is the motion that landed.
            (95.0, "close".to_string()),
            (300.0, "close".to_string()),
        ];
        let commits: Vec<RawCommit> = serde_json::from_value(json!([
            {"t": 80.0, "performed": 900, "origins": [["SetUp", 1]], "top": []},
            {"t": 120.0, "performed": 4, "origins": [["SessionCard", 1]], "top": []},
        ]))
        .unwrap();
        let m = motion(&frames, &gates, 170.0, Some(&commits), None, None).unwrap();
        assert_eq!(m.at_ms, 95.0);
        // 106.7 → 150 is inside; 90 → 106.7 opened before the close, and
        // 166.7 → 183.4 closes after the off.
        assert_eq!(m.longest_gap_ms, Some(43.3));
        assert_eq!(
            m.commits
                .unwrap()
                .iter()
                .map(|c| c.site.as_str())
                .collect::<Vec<_>>(),
            vec!["SessionCard"]
        );
        assert_eq!((m.chains, m.deliveries), (None, None));
        // No close before the land: a deck with no gate has no motion to read.
        assert_eq!(motion(&frames, &[], 170.0, None, None, None), None);
    }

    #[test]
    fn the_land_opens_before_the_off_and_closes_two_frames_after() {
        // The off is inside the land's task; the first frame after it runs
        // ahead of the layout, and the second pays for it.
        let (before, after) = land_span(&[100.0, 116.7, 133.3, 136.0, 181.0, 197.7], 134.0);
        assert_eq!((before, after), (133.3, vec![136.0, 181.0]));
        // No frame before the off opens the span at the off itself.
        assert_eq!(land_span(&[140.0], 134.0), (134.0, vec![140.0]));

        let commits: Vec<RawCommit> = serde_json::from_value(json!([
            {"t": 120.0, "performed": 9, "origins": [["Early", 1]], "top": []},
            {"t": 150.0, "performed": 742, "origins": [["TugPaneImpl", 4]], "top": [["Presence", 40]]},
            {"t": 160.0, "performed": 3, "origins": [], "top": [["TugButton2", 3]]},
            {"t": 190.0, "performed": 2, "origins": [["Late", 1]], "top": []},
        ]))
        .unwrap();
        let chains = vec![
            LandSite {
                t: 135.0,
                ms: 31.0,
                site: "_placeRunHeight".into(),
            },
            LandSite {
                t: 90.0,
                ms: 12.0,
                site: "before".into(),
            },
        ];
        let tasks: Vec<RawTask> = serde_json::from_value(json!([
            {"kind": "resize-observer", "name": "", "start": 170.0, "end": 174.5},
            {"kind": "timeout", "name": "tick", "start": 171.0, "end": 172.0},
        ]))
        .unwrap();
        let l = land(
            &[100.0, 116.7, 133.3, 136.0, 181.0, 197.7],
            134.0,
            Some(&commits),
            Some(&chains),
            Some(&tasks),
        );
        assert_eq!(l.gaps_ms, vec![2.7, 45.0]);
        assert_eq!(l.frame_ms, Some(45.0));
        let sites: Vec<&str> = l
            .commits
            .as_ref()
            .unwrap()
            .iter()
            .map(|c| c.site.as_str())
            .collect();
        assert_eq!(sites, vec!["TugPaneImpl", "TugButton2"]);
        assert_eq!(l.chains.as_ref().unwrap().len(), 1);
        let delivery = &l.deliveries.as_ref().unwrap()[0];
        assert_eq!((delivery.ms, delivery.site.as_str()), (4.5, "anonymous"));
        assert_eq!(l.deliveries.as_ref().unwrap().len(), 1);

        // Without a census, chains or tasks the land still reads its frame.
        let bare = land(&[100.0, 116.7, 133.3], 110.0, None, None, None);
        assert_eq!(bare.frame_ms, Some(16.7));
        assert_eq!(
            (bare.commits, bare.chains, bare.deliveries),
            (None, None, None)
        );
    }

    #[test]
    fn a_reading_carries_its_land() {
        let drive = Drive {
            gesture: "fold",
            args: json!({"card": "c1"}),
            read: true,
        };
        let raw = json!({
            "settle": [[2.0, true], [300.0, false]],
            "frames": [131.0, 147.0, 284.0, 301.0, 347.0, 364.0],
            "commits": null,
        });
        let r = reduce(&drive, &raw);
        let land = r.land.as_ref().unwrap();
        assert_eq!(land.frame_ms, Some(46.0));
        let text = reading_extras(&r);
        assert!(
            text.contains(
                "land 46.0 ms at 300.0 (gaps 17.0, 46.0); commits —, chains —, deliveries —"
            ),
            "{text}"
        );

        // A switch sets no settle mark and has no land.
        let switch = Drive {
            gesture: "switch",
            args: json!({}),
            read: true,
        };
        assert_eq!(reduce(&switch, &raw).land, None);
    }

    #[test]
    fn a_reading_carries_beats_gaps_chains_and_the_returned_pane() {
        let drive = Drive {
            gesture: "slot",
            args: json!({"card": "c1", "slot": 1}),
            read: true,
        };
        let raw = json!({
            "settle": [[2.0, true], [300.0, false]],
            "frames": [131.0, 147.0, 196.0, 212.0, 310.0],
            // The zero-timer heartbeat: never a settle beat.
            "beats": [0.0, 4.1, 8.3],
            "settleBeats": [
                {"recipe": "column-divide", "targets": 2, "durationMs": 280.0,
                 "startDelayMs": 129.4, "declares": ["height"], "landing": "finished"},
            ],
            "chains": {"chains": 9, "longestChainMs": 14.0, "totalChainMs": 61.0, "ranked": []},
            "paneId": "p7",
            "commits": null,
        });
        let r = reduce(&drive, &raw);
        assert_eq!(r.lead_ms, Some(131.0));
        assert_eq!(r.longest_gap_ms, Some(131.0));
        assert_eq!(r.settle_beats.len(), 1);
        let beat = &r.settle_beats[0];
        assert_eq!(beat.recipe, "column-divide");
        assert_eq!(beat.start_delay_ms, 129.4);
        assert_eq!(beat.declares, vec!["height".to_string()]);
        assert_eq!(r.chains.as_ref().unwrap()["chains"], 9);
        assert_eq!(r.pane_id.as_deref(), Some("p7"));

        let text = reading_extras(&r);
        assert!(
            text.contains("lead 131.0 ms, longest gap 131.0 ms"),
            "{text}"
        );
        assert!(
            text.contains("beat column-divide start 129.4 ms declares height"),
            "{text}"
        );
        assert!(
            text.contains("chains 9 (longest 14.0 ms, total 61.0 ms)"),
            "{text}"
        );

        // Serialized under its own name, so the heartbeat key cannot shadow it.
        let out = serde_json::to_value(&r).unwrap();
        assert_eq!(out["settle_beats"][0]["startDelayMs"], 129.4);
        assert!(out.get("beats").is_none());
    }

    #[test]
    fn the_main_thread_is_react_time_plus_the_longest_chain_outside_every_commit() {
        let timed = |t: f64, start: f64| -> RawCommit {
            serde_json::from_value(json!({"t": t, "performed": 10, "renderStart": start})).unwrap()
        };
        let commits = vec![
            // Before the window's leading margin: not the gesture's.
            timed(-200.0, -230.0),
            timed(40.0, 10.0),
            timed(150.0, 120.0),
            // In the window, but rendered before the lead recorder armed.
            commit(160.0, 4),
        ];
        let site = |t: f64, ms: f64, site: &str| LandSite {
            t,
            ms,
            site: site.to_string(),
        };
        let chains = vec![
            // Inside the first commit's span: already in its React time.
            site(20.0, 6.0, "layout effect"),
            // After every commit: added, and the longest of the two.
            site(200.0, 3.0, "ResizeObserver"),
            site(90.0, 2.0, "CodeMirror measure"),
            // Past the trailing margin.
            site(500.0, 40.0, "not the gesture's"),
        ];
        let m = main_thread(&commits, Some(&chains), (0.0, 300.0));
        assert_eq!(m.react_ms, 60.0);
        assert_eq!(m.untimed, 1);
        assert_eq!(m.inside_chain_ms, Some(6.0));
        assert_eq!(
            m.outside_chain.as_ref().map(|c| c.site.as_str()),
            Some("ResizeObserver")
        );
        assert_eq!(m.total_ms, 63.0);

        // Without --chains the sum is React's alone, and says the chains went unread.
        let bare = main_thread(&commits, None, (0.0, 300.0));
        assert_eq!((bare.total_ms, bare.inside_chain_ms), (60.0, None));

        let drive = Drive {
            gesture: "fold",
            args: json!({"card": "c1"}),
            read: true,
        };
        let raw = json!({
            "settle": [[0.0, true], [300.0, false]],
            "commits": serde_json::to_value(
                commits.iter().map(|c| json!({"t": c.t, "performed": c.performed, "renderStart": c.render_start})).collect::<Vec<_>>()
            ).unwrap(),
            "landChains": serde_json::to_value(&chains).unwrap(),
        });
        let r = reduce(&drive, &raw);
        assert_eq!(r.main_thread.as_ref().map(|m| m.total_ms), Some(63.0));
        let text = reading_extras(&r);
        assert!(
            text.contains(
                "main thread 63.0 ms: react 60.0 ms, 1 untimed + longest outside chain 3.0 ms at ResizeObserver (in-commit chains 6.0 ms)"
            ),
            "{text}"
        );
        let out = serde_json::to_value(&r).unwrap();
        assert_eq!(out["main_thread"]["total_ms"], 63.0);

        // A page with no census has no main-thread reading.
        let none = reduce(
            &drive,
            &json!({"settle": [[0.0, true], [300.0, false]], "commits": null}),
        );
        assert_eq!(none.main_thread, None);
    }

    #[test]
    fn a_page_with_no_trace_reads_no_beats() {
        let drive = Drive {
            gesture: "fold",
            args: json!({"card": "c1"}),
            read: true,
        };
        let r = reduce(
            &drive,
            &json!({"settle": [[2.0, true], [300.0, false]], "beats": [0.0, 4.0], "settleBeats": null}),
        );
        assert!(r.settle_beats.is_empty());
        assert_eq!((r.lead_ms, r.longest_gap_ms), (None, None));
        assert!(reading_extras(&r).contains("lead — ms, longest gap — ms"));
    }
}
