//! `tugtool deck motion walk` — price the compositing walk, with a named
//! subtree skipped or removed.
//!
//! On a full deck, any frame that carries a style change pays WebKit's
//! compositing walk before it paints, and the walk is priced by population.
//! Which population — elements, stacking contexts, or render-layer candidates
//! — and how much of it each part of the deck contributes are what this verb
//! reads. `cost` cannot: it samples a still deck, whose frames have nothing
//! dirty and so run no walk at all.
//!
//! A reading is `p50(driven) − p50(floor)`. The floor burst writes nothing;
//! the driven burst toggles one style property on a hidden fixed 1px element
//! inside every sampled frame, which makes every one of those frames walk.
//! Each arm — the Overview's unseen rows skipped, the Overview removed, the
//! parked workspaces removed, the largest Session transcript removed, or that
//! transcript's skipped rows forced to render — is read paired with a baseline
//! taken just before it and repeated over rounds, so a live deck's drift
//! cancels instead of reading as a price. The deck's running loops are paused
//! for each burst and played again after it, so a loop that dirties style every
//! frame cannot make the floor walk too.
//!
//! It runs on the release deck the user already has, through the eval door,
//! with no new deck build: the page half is `deck_motion_walk.js`, embedded
//! here. A relaunch would reset the Overview — the very population being
//! measured — so a verb that needed one could not take this reading.
//!
//! Every arm is an inline-style write the page records and restores exactly;
//! every run ends with a `restore` op, and a run whose closing `restore` found
//! anything to put back fails, so a green run is the proof the deck was left
//! as found.

use crate::commands::deck_motion::{EVAL_GATED_REMEDY, EXIT_GATED};
#[cfg(test)]
use crate::commands::deck_motion_slide::script_call;
use crate::commands::deck_motion_slide::script_page;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The page half: one function expression, applied to a JSON argument object.
const PAGE: &str = include_str!("deck_motion_walk.js");

/// Undriven samples taken after an arm lands and before the floor is read,
/// so the engine has re-decided relevance and the arm's own style change has
/// left the frame.
const SETTLE_FRAMES: u32 = 10;

/// The least delta that counts as moving the walk, in ms, when the baselines
/// agree more closely than this.
const MOVED_FLOOR_MS: f64 = 0.5;

/// How far the page's mirrored predicates may drift from
/// `__tugMotion.layers()` before the census says so, as a fraction.
const DRIFT_WARN: f64 = 0.01;

/// The arms, in the order a default run reads them and the names `--arms`
/// accepts.
pub const ARM_NAMES: [&str; 5] = [
    "overview-skip",
    "overview-absent",
    "parked-absent",
    "transcript-absent",
    "transcript-unskipped",
];

/// One subtree to skip or remove for a reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkArm {
    /// The Overview's cells, all but each column's last, as `content-visibility:
    /// auto` with their measured height — the rule a shipped skip would carry.
    OverviewSkip,
    /// The Overview's shown columns, `display: none`.
    OverviewAbsent,
    /// Every parked workspace layer, `display: none`.
    ParkedAbsent,
    /// The largest Session transcript in the shown workspace, `display: none`.
    TranscriptAbsent,
    /// That transcript's skipped cells forced to render — the control for
    /// whether `content-visibility: auto` takes a row out of the walk.
    TranscriptUnskipped,
}

impl WalkArm {
    pub const ALL: [WalkArm; 5] = [
        WalkArm::OverviewSkip,
        WalkArm::OverviewAbsent,
        WalkArm::ParkedAbsent,
        WalkArm::TranscriptAbsent,
        WalkArm::TranscriptUnskipped,
    ];

    pub fn as_str(self) -> &'static str {
        ARM_NAMES[WalkArm::ALL.iter().position(|a| *a == self).unwrap()]
    }

    pub fn parse(name: &str) -> Option<WalkArm> {
        ARM_NAMES
            .iter()
            .position(|n| *n == name)
            .map(|i| WalkArm::ALL[i])
    }

    /// How many subjects the census found for this arm. An arm with none is
    /// not measured: a reading of nothing removed is a reading of noise.
    fn subjects_in(self, census: &Value) -> i64 {
        let subjects = &census["subjects"];
        let int = |v: &Value| v.as_i64().unwrap_or(0);
        match self {
            WalkArm::OverviewSkip | WalkArm::OverviewAbsent => {
                int(&subjects["overview"]["columns"])
            }
            WalkArm::ParkedAbsent => int(&subjects["parked"]["layers"]),
            WalkArm::TranscriptAbsent => i64::from(!subjects["transcript"].is_null()),
            WalkArm::TranscriptUnskipped => int(&subjects["transcript"]["skippedCells"]),
        }
    }
}

/// The eval call for one page op.
#[cfg(test)]
pub fn page_call(args: &Value) -> String {
    script_call(PAGE, args)
}

/// The argument object for one `measure` op.
pub fn measure_args(arm: &str, frames: u32, driver: &str) -> Value {
    json!({
        "op": "measure",
        "arm": arm,
        "frames": frames,
        "settle": SETTLE_FRAMES,
        "driver": driver,
    })
}

/// A population, as the page counts it. Negative when an arm adds to the walk
/// rather than removing from it.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Population {
    pub elements: f64,
    pub stacking_contexts: f64,
    pub render_layer_candidates: f64,
    #[serde(default)]
    pub sticky: f64,
}

/// One `measure` op's answer.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    #[serde(default)]
    pub subjects: i64,
    #[serde(default)]
    pub already_skipped: i64,
    #[serde(default)]
    pub quieted: i64,
    #[serde(default)]
    pub removed: Population,
    #[serde(default)]
    pub floor: Vec<f64>,
    #[serde(default)]
    pub driven: Vec<f64>,
    #[serde(default)]
    pub scroll_mismatches: Vec<String>,
}

impl Measured {
    pub fn walk(&self) -> f64 {
        walk_of(&self.floor, &self.driven)
    }

    pub fn walk_mean(&self) -> f64 {
        walk_mean_of(&self.floor, &self.driven)
    }
}

/// Nearest-rank p50 over a sorted copy — `summarize` in
/// `tugdeck/src/lib/motion-guard/render-cost-probe.ts`, so a walk read here
/// and a cost read there round the same way. Empty reads as zero.
pub fn p50(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let rank = ((0.5 * sorted.len() as f64).ceil() as usize).saturating_sub(1);
    sorted[rank.min(sorted.len() - 1)]
}

/// The walk one reading carries: what the driven frames cost above the floor.
pub fn walk_of(floor: &[f64], driven: &[f64]) -> f64 {
    p50(driven) - p50(floor)
}

/// The arithmetic mean; empty reads as zero.
pub fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

/// The walk by means rather than medians. WebKit hands a page without
/// cross-origin isolation a `performance.now()` that ticks in whole
/// milliseconds, so every sample is an integer and a p50 cannot move by less
/// than one. Each sample's start falls at a different phase of that tick, so
/// the mean of many carries the fraction the median rounds away.
pub fn walk_mean_of(floor: &[f64], driven: &[f64]) -> f64 {
    mean(driven) - mean(floor)
}

/// Whether an arm moved the walk: its median delta clears both half a
/// millisecond and the spread of the run's own baselines.
pub fn moved(median: f64, baseline_spread: f64) -> bool {
    median.abs() > MOVED_FLOOR_MS.max(baseline_spread)
}

/// An arm over its rounds.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ArmStats {
    /// Per round: the paired baseline's walk minus the arm's. Positive means
    /// the arm made the walk cheaper.
    pub deltas: Vec<f64>,
    pub median: f64,
    pub min: f64,
    pub max: f64,
    pub moved: bool,
}

/// Reduce one arm's rounds, each a `(baseline walk, arm walk)` pair taken
/// seconds apart.
pub fn reduce_arm(pairs: &[(f64, f64)], baseline_spread: f64) -> ArmStats {
    let deltas: Vec<f64> = pairs.iter().map(|(base, arm)| base - arm).collect();
    let median = p50(&deltas);
    let min = deltas.iter().copied().fold(f64::INFINITY, f64::min);
    let max = deltas.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    ArmStats {
        median,
        min: if deltas.is_empty() { 0.0 } else { min },
        max: if deltas.is_empty() { 0.0 } else { max },
        moved: moved(median, baseline_spread),
        deltas,
    }
}

/// Max minus min of the run's baseline walks; zero for fewer than two.
pub fn spread(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    max - min
}

/// Milliseconds per thousand of one term, or `None` when the arm removed none
/// of it — a price over nothing is not a price.
pub fn price(median: f64, removed: f64) -> Option<f64> {
    (removed != 0.0).then(|| median / removed * 1000.0)
}

/// The per-term prices of one arm.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prices {
    pub elements: Option<f64>,
    pub stacking_contexts: Option<f64>,
    pub render_layer_candidates: Option<f64>,
}

pub fn prices(median: f64, removed: &Population) -> Prices {
    Prices {
        elements: price(median, removed.elements),
        stacking_contexts: price(median, removed.stacking_contexts),
        render_layer_candidates: price(median, removed.render_layer_candidates),
    }
}

/// The per-term median of an arm's removed populations over its rounds; the
/// skip arm's varies with what the engine decided to skip each time.
fn median_population(removed: &[Population]) -> Population {
    let term = |f: fn(&Population) -> f64| p50(&removed.iter().map(f).collect::<Vec<_>>());
    Population {
        elements: term(|p| p.elements),
        stacking_contexts: term(|p| p.stacking_contexts),
        render_layer_candidates: term(|p| p.render_layer_candidates),
        sticky: term(|p| p.sticky),
    }
}

/// What a closing `restore` op's answer says was left behind, or `None` when
/// it found nothing. A clean run's closing `restore` is the proof the deck
/// was left as found, so anything it put back fails the run.
pub fn restore_failure(answer: &Value) -> Option<String> {
    let n = |k: &str| answer.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
    let found: Vec<String> = [
        ("replayed", "write(s) replayed"),
        ("marks", "touched mark(s) removed"),
        ("drivers", "driver node(s) removed"),
    ]
    .iter()
    .filter(|(k, _)| n(k) != 0)
    .map(|(k, what)| format!("{} {what}", n(k)))
    .collect();
    (!found.is_empty()).then(|| format!("the closing restore found {}", found.join(", ")))
}

/// Whether the page's whole-document counts and `__tugMotion.layers()`'s
/// disagree past [`DRIFT_WARN`] on any term — the mirrored predicates have
/// drifted from their source.
pub fn drifted(census: &Value) -> Vec<&'static str> {
    let doc = &census["document"];
    let layers = &census["layers"];
    if layers.is_null() {
        return Vec::new();
    }
    ["elements", "stackingContexts", "renderLayerCandidates"]
        .into_iter()
        .filter(|k| {
            let a = doc[*k].as_f64().unwrap_or(0.0);
            let b = layers[*k].as_f64().unwrap_or(0.0);
            (a - b).abs() > DRIFT_WARN * a.max(b)
        })
        .collect()
}

/// What a watchdog stop means, and the one thing that fixes it.
const WATCHDOG_MESSAGE: &str = "the reading's 20 s watchdog fired: requestAnimationFrame stopped, most likely because the Tug window is occluded or covered — the deck was restored; bring the Tug window to the front and run again";

/// The command that puts back what an interrupted reading left.
const RESTORE_COMMAND: &str = "tugtool deck motion walk --restore";

/// Post one page op; a watchdog stop is translated into its cause.
fn page(port: u16, args: Value) -> Result<Option<Value>, String> {
    script_page(port, PAGE, args).map_err(|e| {
        if e == "watchdog" {
            WATCHDOG_MESSAGE.to_string()
        } else {
            e
        }
    })
}

fn measure(port: u16, arm: &str, frames: u32, driver: &str) -> Result<Option<Measured>, String> {
    let Some(value) = page(port, measure_args(arm, frames, driver))? else {
        return Ok(None);
    };
    serde_json::from_value(value)
        .map(Some)
        .map_err(|e| format!("unreadable measure answer: {e}"))
}

/// One arm's reduced reading.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ArmReading {
    arm: &'static str,
    subjects: i64,
    already_skipped: i64,
    removed: Population,
    #[serde(flatten)]
    stats: ArmStats,
    price: Prices,
    /// The same arm read by [`walk_mean_of`], against the baselines' own
    /// mean spread.
    by_mean: ArmStats,
    price_by_mean: Prices,
}

/// Only the `restore` op: put back whatever an interrupted reading left.
pub fn run_restore(port: u16, json_output: bool) -> Result<i32, String> {
    let Some(answer) = page(port, json!({"op": "restore"}))? else {
        eprintln!("{EVAL_GATED_REMEDY}");
        return Ok(EXIT_GATED);
    };
    if json_output {
        println!("{}", serde_json::to_string_pretty(&answer).unwrap());
    } else {
        match restore_failure(&answer) {
            Some(found) => println!(
                "{}",
                found.replacen("the closing restore found", "restored", 1)
            ),
            None => println!("nothing to restore"),
        }
    }
    Ok(0)
}

pub fn run_walk(
    port: u16,
    arms: &[WalkArm],
    rounds: u32,
    frames: u32,
    driver: &str,
    json_output: bool,
) -> Result<i32, String> {
    let Some(census) = page(port, json!({"op": "census"}))? else {
        eprintln!("{EVAL_GATED_REMEDY}");
        return Ok(EXIT_GATED);
    };
    let touched = census["touched"].as_i64().unwrap_or(0);
    if touched > 0 || census["pending"].as_bool() == Some(true) {
        return Err(format!(
            "an earlier reading left {touched} touched element(s) on this deck — run '{RESTORE_COMMAND}' first"
        ));
    }
    if census["visibility"].as_str() != Some("visible") {
        eprintln!(
            "warning: the deck reports itself hidden — a covered window stalls requestAnimationFrame, so these frames are not the user's"
        );
    }
    let drift = drifted(&census);
    if !drift.is_empty() {
        eprintln!(
            "warning: the page's {} count(s) differ from __tugMotion.layers() by more than 1% — the predicates in deck_motion_walk.js have drifted from perf-monitor.ts",
            drift.join(", ")
        );
    }
    if !json_output {
        print_census(&census);
    }

    let read: Vec<WalkArm> = arms
        .iter()
        .copied()
        .filter(|arm| {
            let found = arm.subjects_in(&census) > 0;
            if !found && !json_output {
                println!("{}: no subject on this deck, not measured", arm.as_str());
            }
            found
        })
        .collect();

    // Rounds × arms, each arm paired with a baseline taken just before it. Any
    // failure still runs the closing restore before it is reported.
    let readings = take_readings(port, &read, rounds, frames, driver);
    let closing = page(port, json!({"op": "restore"}));
    let readings = match readings? {
        Some(r) => r,
        None => {
            eprintln!("{EVAL_GATED_REMEDY}");
            return Ok(EXIT_GATED);
        }
    };
    let closing = match closing? {
        Some(c) => c,
        None => {
            eprintln!("{EVAL_GATED_REMEDY}");
            return Ok(EXIT_GATED);
        }
    };

    let baseline_walks: Vec<f64> = readings.iter().map(|(base, _, _)| base.walk()).collect();
    let baseline_floors: Vec<f64> = readings
        .iter()
        .map(|(base, _, _)| p50(&base.floor))
        .collect();
    let baseline_spread = spread(&baseline_walks);
    let baseline_means: Vec<f64> = readings
        .iter()
        .map(|(base, _, _)| base.walk_mean())
        .collect();
    let baseline_mean_spread = spread(&baseline_means);
    let quieted = readings
        .iter()
        .flat_map(|(base, _, m)| [base.quieted, m.quieted])
        .max()
        .unwrap_or(0);
    let mut mismatches: Vec<(String, String)> = Vec::new();
    for (_, arm, m) in &readings {
        for subject in &m.scroll_mismatches {
            let entry = (arm.as_str().to_string(), subject.clone());
            if !mismatches.contains(&entry) {
                mismatches.push(entry);
            }
        }
    }

    let reduced: Vec<ArmReading> = read
        .iter()
        .map(|arm| {
            let of_arm: Vec<&(Measured, WalkArm, Measured)> =
                readings.iter().filter(|(_, a, _)| a == arm).collect();
            let pairs: Vec<(f64, f64)> = of_arm
                .iter()
                .map(|(b, _, m)| (b.walk(), m.walk()))
                .collect();
            let removed =
                median_population(&of_arm.iter().map(|(_, _, m)| m.removed).collect::<Vec<_>>());
            let stats = reduce_arm(&pairs, baseline_spread);
            let mean_pairs: Vec<(f64, f64)> = of_arm
                .iter()
                .map(|(b, _, m)| (b.walk_mean(), m.walk_mean()))
                .collect();
            let by_mean = reduce_arm(&mean_pairs, baseline_mean_spread);
            ArmReading {
                arm: arm.as_str(),
                subjects: of_arm.first().map(|(_, _, m)| m.subjects).unwrap_or(0),
                already_skipped: of_arm
                    .iter()
                    .map(|(_, _, m)| m.already_skipped)
                    .max()
                    .unwrap_or(0),
                price: prices(stats.median, &removed),
                price_by_mean: prices(by_mean.median, &removed),
                by_mean,
                removed,
                stats,
            }
        })
        .collect();

    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "census": census,
                "baseline": {
                    "median": p50(&baseline_walks),
                    "spread": baseline_spread,
                    "floorMedian": p50(&baseline_floors),
                    "meanMedian": p50(&baseline_means),
                    "meanSpread": baseline_mean_spread,
                },
                "arms": reduced,
                "quieted": quieted,
                "scrollMismatches": mismatches
                    .iter()
                    .map(|(arm, subject)| json!({"arm": arm, "subject": subject}))
                    .collect::<Vec<_>>(),
                "driver": driver,
                "rounds": rounds,
                "frames": frames,
                "restore": closing,
            }))
            .unwrap()
        );
    } else {
        println!();
        println!(
            "baseline walk {:.2} ms (spread {:.2}), floor p50 {:.2} ms; driver {driver}, {rounds} round(s) × {frames} frames, {quieted} running animation(s) quieted per burst",
            p50(&baseline_walks),
            baseline_spread,
            p50(&baseline_floors),
        );
        println!(
            "by mean: baseline walk {:.2} ms (spread {:.2}) — the page clock ticks in whole ms, so read sub-millisecond deltas here",
            p50(&baseline_means),
            baseline_mean_spread,
        );
        println!();
        print_arms(&reduced);
    }
    for (arm, subject) in &mismatches {
        eprintln!(
            "warning: {arm} did not put {subject} back where it was (scroll offset or follow-state) — scroll it back by hand"
        );
    }
    if let Some(found) = restore_failure(&closing) {
        eprintln!("{found} — the reading did not leave the deck as it found it");
        return Ok(1);
    }
    Ok(0)
}

type Round = (Measured, WalkArm, Measured);

fn take_readings(
    port: u16,
    arms: &[WalkArm],
    rounds: u32,
    frames: u32,
    driver: &str,
) -> Result<Option<Vec<Round>>, String> {
    let mut readings = Vec::new();
    for _ in 0..rounds {
        for arm in arms {
            let Some(base) = measure(port, "baseline", frames, driver)? else {
                return Ok(None);
            };
            let Some(m) = measure(port, arm.as_str(), frames, driver)? else {
                return Ok(None);
            };
            readings.push((base, *arm, m));
        }
    }
    Ok(Some(readings))
}

fn int(v: &Value) -> i64 {
    v.as_f64().unwrap_or(0.0) as i64
}

fn population_line(p: &Value) -> String {
    format!(
        "{} el / {} sc / {} cand / {} sticky",
        int(&p["elements"]),
        int(&p["stackingContexts"]),
        int(&p["renderLayerCandidates"]),
        int(&p["sticky"])
    )
}

fn histogram_line(h: &Value) -> String {
    h.as_array()
        .map(|rows| {
            rows.iter()
                .map(|r| format!("{} {}", r[0].as_str().unwrap_or("?"), int(&r[1])))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn print_census(census: &Value) {
    println!("deck: {}", population_line(&census["document"]));
    let layers = &census["layers"];
    if !layers.is_null() {
        println!(
            "      __tugMotion.layers(): {} el / {} sc / {} cand",
            int(&layers["elements"]),
            int(&layers["stackingContexts"]),
            int(&layers["renderLayerCandidates"])
        );
    }
    let s = &census["subjects"];
    let o = &s["overview"];
    println!(
        "overview: {} column(s), {} cell(s) — {}",
        int(&o["columns"]),
        int(&o["cells"]),
        population_line(&o["population"])
    );
    println!(
        "  stacking contexts: {}",
        histogram_line(&o["stackingHistogram"])
    );
    println!("  sticky: {}", histogram_line(&o["stickyHistogram"]));
    println!(
        "parked: {} layer(s) — {}",
        int(&s["parked"]["layers"]),
        population_line(&s["parked"]["population"])
    );
    let t = &s["transcript"];
    if t.is_null() {
        println!("transcript: none in the shown workspace");
    } else {
        println!(
            "transcript: '{}', {} cell(s), {} skipped — {}",
            t["title"].as_str().unwrap_or(""),
            int(&t["cells"]),
            int(&t["skippedCells"]),
            population_line(&t["population"])
        );
    }
    if let Some(panes) = census["panes"].as_array() {
        let largest: Vec<String> = panes
            .iter()
            .take(5)
            .map(|p| {
                format!(
                    "{} {}{}",
                    p["title"].as_str().unwrap_or("?"),
                    int(&p["elements"]),
                    if p["parked"].as_bool() == Some(true) {
                        " (parked)"
                    } else {
                        ""
                    }
                )
            })
            .collect();
        println!("panes: {}; largest: {}", panes.len(), largest.join(", "));
    }
}

fn opt(x: Option<f64>) -> String {
    x.map(|v| format!("{v:.3}"))
        .unwrap_or_else(|| "—".to_string())
}

fn print_arms(arms: &[ArmReading]) {
    println!(
        "{:<22}{:<22}{:<8}{:<28}ms per 1k el / sc / cand",
        "arm", "delta ms (min..max)", "moved", "removed el / sc / cand"
    );
    for a in arms {
        let delta = format!(
            "{:.2} ({:.2}..{:.2})",
            a.stats.median, a.stats.min, a.stats.max
        );
        let removed = format!(
            "{} / {} / {}",
            a.removed.elements as i64,
            a.removed.stacking_contexts as i64,
            a.removed.render_layer_candidates as i64
        );
        let price = format!(
            "{} / {} / {}",
            opt(a.price.elements),
            opt(a.price.stacking_contexts),
            opt(a.price.render_layer_candidates)
        );
        println!(
            "{:<22}{:<22}{:<8}{:<28}{}",
            a.arm,
            delta,
            if a.stats.moved { "yes" } else { "no" },
            removed,
            price
        );
        println!(
            "  by mean: {:.2} ({:.2}..{:.2}), moved {}, {} / {} / {}",
            a.by_mean.median,
            a.by_mean.min,
            a.by_mean.max,
            if a.by_mean.moved { "yes" } else { "no" },
            opt(a.price_by_mean.elements),
            opt(a.price_by_mean.stacking_contexts),
            opt(a.price_by_mean.render_layer_candidates)
        );
        if a.already_skipped > 0 {
            println!(
                "  {} cell(s) already skipped by the deck",
                a.already_skipped
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Commands, DeckCommands, DeckMotionCommands};
    use clap::Parser;

    fn parse_walk(argv: &[&str]) -> Result<DeckMotionCommands, clap::Error> {
        let mut full = vec!["tugtool", "deck", "motion", "walk"];
        full.extend_from_slice(argv);
        let cli = Cli::try_parse_from(full)?;
        match cli.command {
            Some(Commands::Deck(DeckCommands::Motion(cmd))) => Ok(cmd),
            _ => panic!("not a deck motion command"),
        }
    }

    #[test]
    fn walk_is_driven_p50_minus_floor_p50() {
        // Nearest rank: the ceil(n/2)-th smallest — the middle of an odd
        // count, the lower middle of an even one, as `summarize` takes it.
        assert_eq!(p50(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(p50(&[4.0, 1.0, 3.0, 2.0]), 2.0);
        assert_eq!(p50(&[]), 0.0);
        assert_eq!(walk_of(&[1.0, 1.2, 0.9], &[7.0, 6.0, 8.0, 6.5]), 6.5 - 1.0);
    }

    #[test]
    fn the_mean_walk_resolves_what_a_whole_millisecond_median_cannot() {
        // Integer samples, as a coarsened clock gives them: the medians agree,
        // the means carry the 0.2 ms between the two.
        let floor = [2.0, 2.0, 2.0, 2.0, 2.0];
        let a = [4.0, 4.0, 4.0, 5.0, 5.0];
        let b = [4.0, 4.0, 4.0, 4.0, 5.0];
        assert_eq!(walk_of(&floor, &a), walk_of(&floor, &b));
        assert!((walk_mean_of(&floor, &a) - walk_mean_of(&floor, &b) - 0.2).abs() < 1e-9);
        assert_eq!(mean(&[]), 0.0);
    }

    #[test]
    fn an_arm_delta_pairs_with_the_baseline_before_it() {
        // The baseline drifts up 1 ms a round; the arm sits 2 ms under its own
        // baseline each time. Pairing reads 2 every round.
        let pairs = [(6.0, 4.0), (7.0, 5.0), (8.0, 5.5)];
        let stats = reduce_arm(&pairs, spread(&[6.0, 7.0, 8.0]));
        assert_eq!(stats.deltas, vec![2.0, 2.0, 2.5]);
        assert_eq!(stats.median, 2.0);
        assert_eq!(stats.min, 2.0);
        assert_eq!(stats.max, 2.5);
        // Spread is 2 ms, and a 2 ms median does not clear it.
        assert!(!stats.moved);
    }

    #[test]
    fn moved_uses_the_larger_of_half_a_millisecond_and_the_baseline_spread() {
        assert!(!moved(0.4, 0.1));
        assert!(moved(0.6, 0.1));
        assert!(!moved(0.9, 1.0));
        assert!(moved(1.1, 1.0));
        assert!(moved(-1.1, 1.0));
    }

    #[test]
    fn price_is_omitted_when_nothing_was_removed() {
        let removed = Population {
            elements: 2000.0,
            stacking_contexts: 0.0,
            render_layer_candidates: 500.0,
            sticky: 0.0,
        };
        let p = prices(1.0, &removed);
        assert_eq!(p.elements, Some(0.5));
        assert_eq!(p.stacking_contexts, None);
        assert_eq!(p.render_layer_candidates, Some(2.0));
    }

    #[test]
    fn transcript_unskipped_prices_with_a_negative_population() {
        // Rendering the skipped rows made the walk 0.8 ms dearer (a negative
        // delta) by adding 4,000 elements (a negative removal): the price per
        // thousand is positive, as it would be for a removal.
        let added = Population {
            elements: -4000.0,
            stacking_contexts: -100.0,
            render_layer_candidates: -800.0,
            sticky: 0.0,
        };
        let p = prices(-0.8, &added);
        assert_eq!(p.elements, Some(0.2));
        assert_eq!(p.stacking_contexts, Some(8.0));
        assert_eq!(p.render_layer_candidates, Some(1.0));
    }

    #[test]
    fn arms_default_to_all_five_in_table_order() {
        let DeckMotionCommands::Walk {
            arms,
            rounds,
            frames,
            driver,
            restore,
            ..
        } = parse_walk(&[]).unwrap()
        else {
            panic!("not walk");
        };
        assert_eq!(arms, ARM_NAMES.map(String::from).to_vec());
        let parsed: Vec<WalkArm> = arms.iter().map(|a| WalkArm::parse(a).unwrap()).collect();
        assert_eq!(parsed, WalkArm::ALL.to_vec());
        assert_eq!(
            (rounds, frames, driver.as_str(), restore),
            (3, 30, "width", false)
        );

        let DeckMotionCommands::Walk { arms, .. } =
            parse_walk(&["--arms", "parked-absent,overview-skip"]).unwrap()
        else {
            panic!("not walk");
        };
        assert_eq!(arms, vec!["parked-absent", "overview-skip"]);
    }

    #[test]
    fn an_unknown_arm_is_refused() {
        assert!(parse_walk(&["--arms", "overview-skip,sidebar-absent"]).is_err());
        assert!(parse_walk(&["--driver", "opacity"]).is_err());
        assert!(parse_walk(&["--driver", "transform"]).is_ok());
        assert_eq!(WalkArm::parse("sidebar-absent"), None);
        for arm in WalkArm::ALL {
            assert_eq!(WalkArm::parse(arm.as_str()), Some(arm));
        }
    }

    #[test]
    fn the_measure_call_carries_arm_frames_settle_and_driver_as_json() {
        let call = page_call(&measure_args("overview-skip", 30, "transform"));
        // The whole script, parenthesized, applied to the JSON object — no
        // argument is interpolated into the script's own text.
        assert_eq!(
            call,
            format!(
                "({})({})",
                PAGE.trim_end(),
                r#"{"arm":"overview-skip","driver":"transform","frames":30,"op":"measure","settle":10}"#
            )
        );
        assert!(PAGE.trim_end().ends_with("})"));
    }

    #[test]
    fn a_closing_restore_that_found_anything_fails_the_run() {
        assert_eq!(
            restore_failure(&json!({"replayed": 0, "marks": 0, "drivers": 0})),
            None
        );
        let found = restore_failure(&json!({"replayed": 2, "marks": 0, "drivers": 1})).unwrap();
        assert!(found.contains("2 write(s) replayed"));
        assert!(found.contains("1 driver node(s) removed"));
        assert!(!found.contains("mark"));
    }

    #[test]
    fn the_census_says_when_the_mirrored_predicates_drift() {
        let census = json!({
            "document": {"elements": 10000, "stackingContexts": 1000, "renderLayerCandidates": 5000},
            "layers": {"elements": 10050, "stackingContexts": 1100, "renderLayerCandidates": 5000},
        });
        assert_eq!(drifted(&census), vec!["stackingContexts"]);
        assert!(drifted(&json!({"document": {}, "layers": null})).is_empty());
    }

    #[test]
    fn an_arm_with_no_subject_on_the_deck_is_not_measured() {
        let census = json!({"subjects": {
            "overview": {"columns": 1},
            "parked": {"layers": 0},
            "transcript": {"skippedCells": 0},
        }});
        assert_eq!(WalkArm::OverviewSkip.subjects_in(&census), 1);
        assert_eq!(WalkArm::ParkedAbsent.subjects_in(&census), 0);
        assert_eq!(WalkArm::TranscriptAbsent.subjects_in(&census), 1);
        assert_eq!(WalkArm::TranscriptUnskipped.subjects_in(&census), 0);
        let no_transcript = json!({"subjects": {"transcript": null}});
        assert_eq!(WalkArm::TranscriptAbsent.subjects_in(&no_transcript), 0);
    }
}
