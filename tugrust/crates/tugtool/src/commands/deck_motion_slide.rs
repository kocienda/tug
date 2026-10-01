//! `tugtool deck motion slide` — the flow slide, driven and read in one command.
//!
//! The gesture is a click on a session row in the Cards card, which focuses
//! that row's card and slides the flow strip to it. This verb clicks between
//! two named rows `--count` times in each direction and reports, per click and
//! in aggregate, what the deck delivered: frames in the first 200 ms, the
//! first frame's offset, the early gaps, every long frame with its time, how
//! long the main thread was blocked in the click's lead, and when the settle
//! mark went on and off.
//!
//! It exists because every earlier reading of this gesture was JavaScript
//! posted by hand to `/api/eval` and reduced by hand (`briefs/flow-slide-loose-threads-brief.md`,
//! `[F09]`), so no reading could be repeated. The page half is
//! `deck_motion_slide.js`, embedded here; it returns raw times relative to the
//! click and this module reduces them, so the reduction is what the unit tests
//! pin.
//!
//! Every report carries the deck's census beside its numbers. A reading on a
//! half-size deck once passed for a reading on the user's deck (`[F03]` of the
//! same brief); a census is what makes two readings comparable.
//!
//! The window is keyed to a timestamp the page half writes at the click, not to
//! the gesture stamp `deck motion gesture` waits for, which a dispatched click
//! never reaches (`[F08]`).

use crate::commands::deck_motion::{EVAL_GATED_REMEDY, EXIT_GATED, EvalOutcome, post_eval};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The page half: one function expression, applied to a JSON argument object.
const PAGE: &str = include_str!("deck_motion_slide.js");

/// How long each click is recorded for. The settle runs to about 450 ms on the
/// deck as it stands; the rest of the window is where late frames land.
pub const WINDOW_MS: u32 = 1600;

/// The lead the heartbeat reads blocking over — the click's first 260 ms, the
/// window `[F13]` of the remaining-costs brief measured.
pub const LEAD_MS: u32 = 260;

/// "The first 200 ms" every frame count is taken over.
const EARLY_MS: f64 = 200.0;

/// A frame gap over this is a long frame: one and a half periods at 60 Hz, the
/// bar the hand-rolled readings used, kept so the numbers stay comparable.
const LONG_FRAME_MS: f64 = 25.0;

/// The floor under the heartbeat's cadence: a nested zero timer is clamped to
/// at least 4 ms. On the release deck it free-runs slower than that — 7–9 ms
/// gaps at rest — which is why the cadence is measured, not assumed.
const TIMER_CLAMP_MS: f64 = 4.0;

/// How long the heartbeat runs before the click, to measure its cadence.
const PREROLL_MS: u32 = 150;

/// How many early gaps a click's line shows.
const EARLY_GAPS_SHOWN: usize = 6;

/// Quiet time between one click's window and the next click.
const REST_BETWEEN_MS: u64 = 400;

/// What a click costs beyond its window and rest: the two warm-up frames and
/// the eval round trip. Generous, so the samplers outlast the last click.
const CLICK_OVERHEAD_MS: u64 = 400;

/// How long `sample` is given to attach before the first click.
const SAMPLER_ATTACH_MS: u64 = 1500;

/// The eval call for one page op.
pub fn page_call(args: &Value) -> String {
    format!("({})({})", PAGE.trim_end(), args)
}

/// One long frame: when it started, relative to the click, and how long it was.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LongFrame {
    pub at_ms: f64,
    pub gap_ms: f64,
}

/// One click, reduced.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ClickReading {
    /// The row clicked — the card the slide went to.
    pub to: String,
    pub frames_in_early: usize,
    pub first_frame_ms: Option<f64>,
    pub early_gaps_ms: Vec<f64>,
    pub long_frames: Vec<LongFrame>,
    pub lead_block_ms: f64,
    /// The heartbeat's free-running gap before the click; `lead_block_ms` is
    /// the time beyond it.
    pub heartbeat_cadence_ms: f64,
    pub settle_on_ms: Option<f64>,
    pub settle_off_ms: Option<f64>,
    /// Whether focus moved to another pane. A click that moved nothing slid
    /// nothing, and its numbers describe an idle deck.
    pub moved: bool,
}

fn numbers(raw: &Value, key: &str) -> Vec<f64> {
    raw.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|n| n.as_f64()).collect())
        .unwrap_or_default()
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// The heartbeat's free-running gap: the median gap before the click, never
/// under the timer clamp, or the clamp when there are too few beats to say.
fn cadence(pre: &[f64]) -> f64 {
    let mut gaps: Vec<f64> = pre.windows(2).map(|w| w[1] - w[0]).collect();
    if gaps.len() < 3 {
        return TIMER_CLAMP_MS;
    }
    gaps.sort_by(f64::total_cmp);
    gaps[gaps.len() / 2].max(TIMER_CLAMP_MS)
}

/// Main-thread blocking over `[0, LEAD_MS]` from heartbeat times relative to
/// the click: every gap's excess over the heartbeat's own cadence.
///
/// Counting whole gaps over a fixed bar — 4 ms, as the hand-rolled readings
/// did — counts the heartbeat's own free-running cadence as blocking when that
/// cadence is slower than the bar, and on the release deck it is 7–9 ms: every
/// earlier lead figure read high for that reason. The click itself is the
/// first beat, so the click's own task is counted; a gap straddling the
/// window's end counts its part inside, and a heartbeat that never beat again
/// was blocked to the window's end.
fn lead_block(beats: &[f64], cadence: f64) -> f64 {
    let lead = f64::from(LEAD_MS);
    let mut points = vec![0.0];
    points.extend(beats.iter().copied().filter(|t| *t > 0.0));
    let mut blocked = 0.0;
    for w in points.windows(2) {
        if w[0] >= lead {
            break;
        }
        blocked += (w[1].min(lead) - w[0] - cadence).max(0.0);
    }
    if let Some(last) = points.last()
        && *last < lead
    {
        blocked += (lead - last - cadence).max(0.0);
    }
    blocked.round()
}

/// Reduce the page half's raw times for one click.
///
/// `frames` and `beats` are times relative to the click, ascending; `settle`
/// is a list of `[time, present]` flips of the settle mark.
pub fn reduce(raw: &Value) -> ClickReading {
    let frames = numbers(raw, "frames");
    let beats = numbers(raw, "beats");

    let gaps: Vec<(f64, f64)> = frames
        .windows(2)
        .map(|w| (w[0], round1(w[1] - w[0])))
        .collect();

    let heartbeat_cadence_ms = round1(cadence(&numbers(raw, "preBeats")));
    let lead_block_ms = lead_block(&beats, heartbeat_cadence_ms);

    let flips: Vec<(f64, bool)> = raw
        .get("settle")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| Some((m.get(0)?.as_f64()?, m.get(1)?.as_bool()?)))
                .collect()
        })
        .unwrap_or_default();
    let settle_on_ms = flips.iter().find(|(_, on)| *on).map(|(t, _)| *t);
    let settle_off_ms = settle_on_ms.and_then(|on| {
        flips
            .iter()
            .rev()
            .find(|(t, present)| !*present && *t >= on)
            .map(|(t, _)| *t)
    });

    ClickReading {
        to: raw
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        frames_in_early: frames.iter().filter(|t| **t <= EARLY_MS).count(),
        first_frame_ms: frames.first().copied(),
        early_gaps_ms: gaps.iter().take(EARLY_GAPS_SHOWN).map(|g| g.1).collect(),
        long_frames: gaps
            .iter()
            .filter(|(_, gap)| *gap > LONG_FRAME_MS)
            .map(|(at, gap)| LongFrame {
                at_ms: at.round(),
                gap_ms: *gap,
            })
            .collect(),
        lead_block_ms,
        heartbeat_cadence_ms,
        settle_on_ms,
        settle_off_ms,
        moved: raw.get("moved").and_then(|m| m.as_bool()).unwrap_or(false),
    }
}

/// A min–max range over the clicks that have the value.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Span {
    pub min: f64,
    pub max: f64,
}

fn span(values: impl Iterator<Item = f64>) -> Option<Span> {
    values.fold(None, |acc, v| match acc {
        None => Some(Span { min: v, max: v }),
        Some(s) => Some(Span {
            min: s.min.min(v),
            max: s.max.max(v),
        }),
    })
}

/// Every click, summarized.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Summary {
    pub clicks: usize,
    pub moved: usize,
    pub frames_in_early: Option<Span>,
    pub first_frame_ms: Option<Span>,
    pub lead_block_ms: Option<Span>,
    pub heartbeat_cadence_ms: Option<Span>,
    pub settle_on_ms: Option<Span>,
    pub settle_off_ms: Option<Span>,
    /// How many clicks had at least one long frame.
    pub clicks_with_long_frames: usize,
    pub long_frame_gap_ms: Option<Span>,
    pub long_frame_at_ms: Option<Span>,
}

pub fn summarize(readings: &[ClickReading]) -> Summary {
    let longs = || readings.iter().flat_map(|r| r.long_frames.iter());
    Summary {
        clicks: readings.len(),
        moved: readings.iter().filter(|r| r.moved).count(),
        frames_in_early: span(readings.iter().map(|r| r.frames_in_early as f64)),
        first_frame_ms: span(readings.iter().filter_map(|r| r.first_frame_ms)),
        lead_block_ms: span(readings.iter().map(|r| r.lead_block_ms)),
        heartbeat_cadence_ms: span(readings.iter().map(|r| r.heartbeat_cadence_ms)),
        settle_on_ms: span(readings.iter().filter_map(|r| r.settle_on_ms)),
        settle_off_ms: span(readings.iter().filter_map(|r| r.settle_off_ms)),
        clicks_with_long_frames: readings
            .iter()
            .filter(|r| !r.long_frames.is_empty())
            .count(),
        long_frame_gap_ms: span(longs().map(|l| l.gap_ms)),
        long_frame_at_ms: span(longs().map(|l| l.at_ms)),
    }
}

/// Post one page op. `None` when the eval door is shut.
fn page(port: u16, args: Value) -> Result<Option<Value>, String> {
    match post_eval(port, &page_call(&args))? {
        EvalOutcome::Gated => Ok(None),
        EvalOutcome::Ok(value) => {
            if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
                return Err(match value.get("titles") {
                    Some(titles) => format!("{error}; the session rows are {titles}"),
                    None => error.to_string(),
                });
            }
            Ok(Some(value))
        }
    }
}

/// Resolve a name to exactly one row title, or say why it does not.
fn resolve(port: u16, name: &str) -> Result<Option<String>, String> {
    let Some(found) = page(port, json!({"op": "resolve", "name": name}))? else {
        return Ok(None);
    };
    let matches: Vec<&str> = found
        .get("matches")
        .and_then(|m| m.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str()).collect())
        .unwrap_or_default();
    match matches.as_slice() {
        [one] => Ok(Some(one.to_string())),
        _ => Err(format!(
            "'{name}' matches {} session rows in the Cards card; the rows are {}",
            matches.len(),
            found.get("titles").cloned().unwrap_or(Value::Null)
        )),
    }
}

type Recorded = (ClickReading, Vec<QueryRow>);

fn record(port: u16, title: &str, queries: bool) -> Result<Option<Recorded>, String> {
    let raw = page(
        port,
        json!({
            "op": "record",
            "name": title,
            "windowMs": WINDOW_MS,
            "leadMs": LEAD_MS,
            "prerollMs": PREROLL_MS,
            "queries": queries,
        }),
    )?;
    Ok(raw.map(|raw| {
        let rows = raw
            .get("queries")
            .filter(|q| !q.is_null())
            .and_then(|q| serde_json::from_value(q.clone()).ok())
            .unwrap_or_default();
        (reduce(&raw), rows)
    }))
}

/// One selector, as the page half's query recorder saw it in one click, or
/// summed across clicks.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueryRow {
    pub method: String,
    pub selector: String,
    pub count: u64,
    pub ms: f64,
    pub lead_count: u64,
    pub lead_ms: f64,
    pub max_ms: f64,
    /// The caller's stack at the first call seen.
    pub stack: String,
}

/// Sum each (method, selector) across clicks, most expensive first.
pub fn aggregate_queries(rows: Vec<QueryRow>) -> Vec<QueryRow> {
    let mut by_key: Vec<QueryRow> = Vec::new();
    for row in rows {
        match by_key
            .iter_mut()
            .find(|r| r.method == row.method && r.selector == row.selector)
        {
            Some(sum) => {
                sum.count += row.count;
                sum.ms += row.ms;
                sum.lead_count += row.lead_count;
                sum.lead_ms += row.lead_ms;
                sum.max_ms = sum.max_ms.max(row.max_ms);
            }
            None => by_key.push(row),
        }
    }
    by_key.sort_by(|a, b| b.ms.total_cmp(&a.ms));
    by_key
}

/// How many selectors the text report lists.
const QUERIES_SHOWN: usize = 15;

pub fn run_slide(
    port: u16,
    from: &str,
    to: &str,
    count: u32,
    sample: bool,
    queries: bool,
    json_output: bool,
) -> Result<i32, String> {
    let gated = || {
        eprintln!("{EVAL_GATED_REMEDY}");
        Ok(EXIT_GATED)
    };

    let Some(census) = page(port, json!({"op": "census"}))? else {
        return gated();
    };
    let (Some(from), Some(to)) = (resolve(port, from)?, resolve(port, to)?) else {
        return gated();
    };
    if from == to {
        return Err(format!(
            "--from and --to both name '{from}'; a slide needs two cards"
        ));
    }
    if census.get("visibility").and_then(|v| v.as_str()) != Some("visible") {
        eprintln!(
            "warning: the deck reports itself hidden — a covered window stalls requestAnimationFrame, so these frames are not the user's"
        );
    }

    if !json_output {
        print_census(&census);
        if sample {
            println!(
                "note: the samplers stop WebContent to read its stacks, so the frame numbers below are perturbed — take frames from a run without --sample"
            );
        }
        println!(
            "slide '{from}' ⇄ '{to}', {count} click(s) each way, {WINDOW_MS} ms window per click"
        );
        println!();
        println!(
            " #  to                   early  first  early gaps (ms)               lead  settle on→off  long frames (at:gap)"
        );
    }

    // One unrecorded click onto the starting card, so the first recorded click
    // is a real slide rather than a click on the card already focused.
    if record(port, &from, false)?.is_none() {
        return gated();
    }
    std::thread::sleep(std::time::Duration::from_millis(REST_BETWEEN_MS));

    // The samplers start after the warm-up click, so it is not in their
    // reports, and run long enough to cover every recorded click.
    let samplers = if sample {
        let targets = crate::commands::deck_motion_sample::targets(port)?;
        let per_click_ms = u64::from(WINDOW_MS) + REST_BETWEEN_MS + CLICK_OVERHEAD_MS;
        let total_ms = u64::from(count) * 2 * per_click_ms + SAMPLER_ATTACH_MS + 1000;
        let seconds = total_ms.div_ceil(1000) as u32;
        let samplers = crate::commands::deck_motion_sample::start(&targets, seconds)?;
        if !json_output {
            let names: Vec<String> = targets.iter().map(|(l, p)| format!("{l} {p}")).collect();
            eprintln!("sampling {} for {seconds} s", names.join(", "));
        }
        std::thread::sleep(std::time::Duration::from_millis(SAMPLER_ATTACH_MS));
        Some(samplers)
    } else {
        None
    };

    let mut readings = Vec::new();
    let mut query_rows = Vec::new();
    for _ in 0..count {
        for title in [&to, &from] {
            let Some((reading, rows)) = record(port, title, queries)? else {
                return gated();
            };
            if !json_output {
                print_click(readings.len() + 1, &reading);
            }
            readings.push(reading);
            query_rows.extend(rows);
            std::thread::sleep(std::time::Duration::from_millis(REST_BETWEEN_MS));
        }
    }

    let summary = summarize(&readings);
    let query_rows = queries.then(|| aggregate_queries(query_rows));
    let processes = match samplers {
        Some(samplers) => {
            if !json_output {
                eprintln!("waiting for the samplers to finish");
            }
            Some(samplers.finish()?)
        }
        None => None,
    };
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "census": census,
                "from": from,
                "to": to,
                "count": count,
                "windowMs": WINDOW_MS,
                "leadMs": LEAD_MS,
                "earlyMs": EARLY_MS,
                "longFrameMs": LONG_FRAME_MS,
                "clicks": readings,
                "summary": summary,
                "samples": processes,
                "framesPerturbedBySampling": sample,
                "queries": query_rows,
            }))
            .unwrap()
        );
    } else {
        println!();
        print_summary(&summary);
        if let Some(rows) = &query_rows {
            print_queries(rows, readings.len());
        }
        if let Some(processes) = &processes {
            crate::commands::deck_motion_sample::print(processes, readings.len());
        }
    }
    Ok(0)
}

fn print_census(census: &Value) {
    let n = |k: &str| census.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
    println!(
        "deck: {} elements, {} stacking contexts, {} render-layer candidates",
        n("elements"),
        n("stackingContexts"),
        n("renderLayerCandidates")
    );
    if let Some(panes) = census.get("panes").and_then(|p| p.as_array()) {
        let largest: Vec<String> = panes
            .iter()
            .take(5)
            .map(|p| {
                format!(
                    "{} {}{}",
                    p.get("title").and_then(|t| t.as_str()).unwrap_or("?"),
                    p.get("elements").and_then(|e| e.as_i64()).unwrap_or(0),
                    if p.get("parked").and_then(|v| v.as_bool()) == Some(true) {
                        " (parked)"
                    } else {
                        ""
                    }
                )
            })
            .collect();
        println!(
            "      {} pane(s); largest: {}",
            panes.len(),
            largest.join(", ")
        );
    }
}

fn print_queries(rows: &[QueryRow], clicks: usize) {
    let total: f64 = rows.iter().map(|r| r.ms).sum();
    let lead: f64 = rows.iter().map(|r| r.lead_ms).sum();
    let per = |x: f64| if clicks > 0 { x / clicks as f64 } else { 0.0 };
    println!();
    println!(
        "selector queries: {} distinct, {:.1} ms per click ({:.1} ms in the first {LEAD_MS} ms) — timed by a wrapper, which adds a little of its own",
        rows.len(),
        per(total),
        per(lead)
    );
    println!("  ms/click  lead  calls/click  max ms  query");
    for r in rows.iter().take(QUERIES_SHOWN) {
        let selector: String = r.selector.chars().take(70).collect();
        println!(
            "  {:>8.2}  {:>4.1}  {:>11.1}  {:>6.2}  {}({})",
            per(r.ms),
            per(r.lead_ms),
            per(r.count as f64),
            r.max_ms,
            r.method,
            selector
        );
        let stack: String = r.stack.chars().take(150).collect();
        if !stack.is_empty() {
            println!("            from {stack}");
        }
    }
}

fn ms(value: Option<f64>) -> String {
    value.map_or("—".to_string(), |v| format!("{v:.0}"))
}

fn print_click(index: usize, r: &ClickReading) {
    let gaps: Vec<String> = r.early_gaps_ms.iter().map(|g| format!("{g:.0}")).collect();
    let longs: Vec<String> = r
        .long_frames
        .iter()
        .map(|l| format!("{:.0}:{:.0}", l.at_ms, l.gap_ms))
        .collect();
    let title: String = r.to.chars().take(20).collect();
    println!(
        "{index:>2}  {title:<20} {:>5}  {:>5}  {:<29} {:>5}  {:>5}→{:<6} {}{}",
        r.frames_in_early,
        ms(r.first_frame_ms),
        gaps.join(" "),
        format!("{:.0}", r.lead_block_ms),
        ms(r.settle_on_ms),
        ms(r.settle_off_ms),
        if longs.is_empty() {
            "none".to_string()
        } else {
            longs.join(" ")
        },
        match (r.moved, r.settle_on_ms.is_some()) {
            (true, true) => "",
            (true, false) => "  (no settle: focus moved but nothing slid)",
            (false, true) => "  (focus did not move)",
            (false, false) => "  (focus did not move and nothing slid)",
        }
    );
}

fn range(s: Option<Span>) -> String {
    match s {
        None => "—".to_string(),
        Some(s) if s.min == s.max => format!("{:.0}", s.min),
        Some(s) => format!("{:.0}–{:.0}", s.min, s.max),
    }
}

fn print_summary(s: &Summary) {
    println!("{} click(s), {} moved focus", s.clicks, s.moved);
    println!(
        "  frames in the first {EARLY_MS:.0} ms  {}",
        range(s.frames_in_early)
    );
    println!("  first frame              {} ms", range(s.first_frame_ms));
    println!(
        "  lead blocked (first {LEAD_MS} ms)  {} ms, beyond a heartbeat that free-runs at {} ms",
        range(s.lead_block_ms),
        range(s.heartbeat_cadence_ms)
    );
    println!(
        "  settle on / off          {} / {} ms",
        range(s.settle_on_ms),
        range(s.settle_off_ms)
    );
    if s.clicks_with_long_frames == 0 {
        println!("  long frames (> {LONG_FRAME_MS:.0} ms)    none");
    } else {
        println!(
            "  long frames (> {LONG_FRAME_MS:.0} ms)    in {} of {} click(s), {} ms long, at {} ms",
            s.clicks_with_long_frames,
            s.clicks,
            range(s.long_frame_gap_ms),
            range(s.long_frame_at_ms)
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_call_applies_the_function_to_json_arguments() {
        let args = json!({"op": "resolve", "name": "a \"quoted\" name"});
        let call = page_call(&args);
        assert!(call.starts_with("(// The page half"));
        assert!(call.contains("(function (args) {"));
        // The name is JSON-encoded, never interpolated raw.
        assert!(call.ends_with(&format!("}}))({args})")));
        assert!(call.contains(r#""a \"quoted\" name""#));
    }

    #[test]
    fn a_click_reduces_to_the_numbers_the_hand_rolled_reading_took() {
        let raw = json!({
            "title": "beta",
            "frames": [36.0, 50.0, 66.5, 83.0, 100.0, 140.0, 156.0, 190.0, 210.0],
            "preBeats": [-30.0, -22.0, -14.0, -6.0],
            "beats": [0.5, 5.0, 9.0, 120.0, 124.0, 128.0, 240.0, 244.0],
            "settle": [[33.0, true], [33.0, true], [450.0, false], [452.0, false]],
            "moved": true,
        });
        let r = reduce(&raw);
        assert_eq!(r.to, "beta");
        assert_eq!(r.frames_in_early, 8);
        assert_eq!(r.first_frame_ms, Some(36.0));
        assert_eq!(r.early_gaps_ms, vec![14.0, 16.5, 16.5, 17.0, 40.0, 16.0]);
        assert_eq!(
            r.long_frames,
            vec![
                LongFrame {
                    at_ms: 100.0,
                    gap_ms: 40.0
                },
                LongFrame {
                    at_ms: 156.0,
                    gap_ms: 34.0
                },
            ]
        );
        // An 8 ms cadence before the click; then 111 and 112 less the
        // cadence, and the 16 after the last beat less it. The short gaps
        // are the heartbeat running freely.
        assert_eq!(r.heartbeat_cadence_ms, 8.0);
        assert_eq!(r.lead_block_ms, 215.0);
        assert_eq!(r.settle_on_ms, Some(33.0));
        assert_eq!(r.settle_off_ms, Some(452.0));
        assert!(r.moved);
    }

    #[test]
    fn a_click_with_no_settle_and_no_frames_says_so() {
        let r =
            reduce(&json!({"title": "x", "frames": [], "beats": [], "settle": [], "moved": false}));
        assert_eq!(r.frames_in_early, 0);
        assert_eq!(r.first_frame_ms, None);
        assert_eq!(r.settle_on_ms, None);
        assert_eq!(r.settle_off_ms, None);
        assert!(!r.moved);
    }

    /// An off flip before any on belongs to a settle that was already running
    /// when the click landed, and is not this click's end.
    #[test]
    fn an_off_before_the_on_is_not_the_settle_end() {
        let r = reduce(&json!({"frames": [], "beats": [], "settle": [[2.0, false]]}));
        assert_eq!(r.settle_on_ms, None);
        assert_eq!(r.settle_off_ms, None);
    }

    fn row(selector: &str, count: u64, ms: f64, max_ms: f64) -> QueryRow {
        QueryRow {
            method: "Document.querySelector".to_string(),
            selector: selector.to_string(),
            count,
            ms,
            lead_count: count,
            lead_ms: ms,
            max_ms,
            stack: "first".to_string(),
        }
    }

    #[test]
    fn queries_sum_across_clicks_and_sort_by_time() {
        let mut second = row("[data-a]", 2, 1.5, 1.0);
        second.stack = "second".to_string();
        let agg = aggregate_queries(vec![
            row("[data-a]", 3, 2.0, 0.5),
            row("[data-b]", 1, 9.0, 9.0),
            second,
        ]);
        assert_eq!(agg.len(), 2);
        assert_eq!(agg[0].selector, "[data-b]");
        assert_eq!(agg[1].count, 5);
        assert_eq!(agg[1].ms, 3.5);
        assert_eq!(agg[1].max_ms, 1.0);
        // The first stack seen is the one kept.
        assert_eq!(agg[1].stack, "first");
    }

    #[test]
    fn the_summary_spans_every_click() {
        let a = reduce(&json!({
            "frames": [34.0, 50.0], "beats": [4.0, 216.0, 260.0, 264.0],
            "settle": [[31.0, true], [444.0, false]], "moved": true
        }));
        let b = reduce(&json!({
            "frames": [41.0, 57.0, 400.0], "beats": [4.0, 230.0, 234.0, 260.0, 263.0],
            "settle": [[35.0, true], [458.0, false]], "moved": false
        }));
        let s = summarize(&[a, b]);
        assert_eq!(s.clicks, 2);
        assert_eq!(s.moved, 1);
        assert_eq!(
            s.first_frame_ms,
            Some(Span {
                min: 34.0,
                max: 41.0
            })
        );
        assert_eq!(
            s.lead_block_ms,
            Some(Span {
                // No pre-roll, so the clamp: 208 + 40 straddling the end;
                // 222 + 22.
                min: 244.0,
                max: 248.0
            })
        );
        assert_eq!(
            s.settle_on_ms,
            Some(Span {
                min: 31.0,
                max: 35.0
            })
        );
        assert_eq!(
            s.settle_off_ms,
            Some(Span {
                min: 444.0,
                max: 458.0
            })
        );
        assert_eq!(s.clicks_with_long_frames, 1);
        assert_eq!(
            s.long_frame_gap_ms,
            Some(Span {
                min: 343.0,
                max: 343.0
            })
        );
    }
}
