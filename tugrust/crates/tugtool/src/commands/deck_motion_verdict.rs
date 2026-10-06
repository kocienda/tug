//! The bar, read off the deck's own rows: one verdict line per settle.
//!
//! The app-tests hold every settle to one bar (`expectB09Bar` in
//! `tests/app-test/settle-frames-fixture.ts`): no gap over two display frames
//! from the motion's first frame on, no shown frame off its own curve, nothing
//! run inside the motion — no React commit, no forced layout, no observer
//! delivery — and a land of one frame. The lead before the first frame is the
//! set-up, noted and never barred. Two legs carry their own number by the
//! user's rulings, passed per leg in `at0706-settle-sidebars.test.ts`:
//! resize-to-fit's gap and the sidebars' show land (`Bars::for_drive`).
//!
//! The deck writes the readings those clauses judge in its own rows
//! (`settle-frames`, `settle-land`), but only while the record switch is on
//! (`tugtool deck motion record on`). With it on, `settle` and `slide` hand
//! each drive's rows here and print the verdict beside their own outside
//! reading, so "sometimes drops frames" on the user's deck becomes a named
//! clause with a verdict, taken by typing one verb.
//!
//! The numbers are the fixture's, copied rather than shared because the
//! fixture is TypeScript; each says where it comes from, and a change to one
//! is a change to the other.

use serde::Serialize;
use serde_json::Value;

/// `B09_GAP_FRAMES_BAR` in the fixture: the motion's longest gap, in display frames.
pub const GAP_FRAMES_BAR: f64 = 2.0;

/// `LAND_FRAMES_BAR` in the fixture: the land's frame, in display periods.
pub const LAND_FRAMES_BAR: f64 = 1.5;

/// `RESIZE_TO_FIT_GAP_FRAMES_BAR` in `at0706-settle-sidebars.test.ts`: the
/// resize-to-fit leg's gap bar, re-budgeted on the user's word.
pub const FIT_GAP_FRAMES_BAR: f64 = 2.5;

/// `SIDEBARS_SHOW_LAND_FRAMES_BAR` in `at0706-settle-sidebars.test.ts`: the
/// sidebars-show leg's land bar, re-budgeted on the user's word.
pub const SIDEBAR_SHOW_LAND_FRAMES_BAR: f64 = 2.0;

/// The two numbers one settle is held to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bars {
    pub gap_frames: f64,
    pub land_frames: f64,
}

impl Bars {
    /// Every leg's bar but the two the user re-budgeted.
    pub const DEFAULT: Bars = Bars {
        gap_frames: GAP_FRAMES_BAR,
        land_frames: LAND_FRAMES_BAR,
    };

    /// The bar the app-test holds this drive's leg to: the default, except
    /// resize-to-fit's gap and the sidebars' show land, which `at0706` passes
    /// per leg. A verdict that ignored them would read those two legs red on
    /// the user's deck where the test reads them green.
    pub fn for_drive(gesture: &str, args: &Value) -> Bars {
        match gesture {
            "fit" => Bars {
                gap_frames: FIT_GAP_FRAMES_BAR,
                ..Bars::DEFAULT
            },
            "sidebar" if args.get("open").and_then(Value::as_bool) == Some(true) => Bars {
                land_frames: SIDEBAR_SHOW_LAND_FRAMES_BAR,
                ..Bars::DEFAULT
            },
            _ => Bars::DEFAULT,
        }
    }
}

/// The site the fixture carves out of the forced-layout clause: the bench
/// probe's own rect read, which pays the frame's layout early rather than
/// forcing one of the deck's.
const BENCH_PROBE_SITE: &str = "[bench probe]";

/// One clause of the bar and how it read.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Clause {
    pub name: &'static str,
    /// `Some(true)` green, `Some(false)` red, `None` when the page could not
    /// count it — a census that was not in the page is never a count of none.
    pub pass: Option<bool>,
    pub detail: String,
}

/// The bar over one settle's rows.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Verdict {
    pub clauses: Vec<Clause>,
    /// The set-up: the gesture to the first frame, noted and never barred.
    pub lead_ms: Option<f64>,
}

impl Verdict {
    /// Green when every clause that could be read is green and at least one was.
    pub fn green(&self) -> bool {
        self.clauses.iter().all(|c| c.pass != Some(false))
            && self.clauses.iter().any(|c| c.pass.is_some())
    }

    /// The one line a reading prints.
    pub fn line(&self) -> String {
        let word = if self.clauses.iter().any(|c| c.pass == Some(false)) {
            "RED"
        } else if self.green() {
            "green"
        } else {
            "unread"
        };
        let clauses: Vec<String> = self
            .clauses
            .iter()
            .map(|c| {
                let mark = match c.pass {
                    Some(true) => "ok",
                    Some(false) => "RED",
                    None => "not counted",
                };
                format!("{} {mark} ({})", c.name, c.detail)
            })
            .collect();
        let lead = self
            .lead_ms
            .map_or_else(String::new, |ms| format!("; lead {ms:.1} ms, not barred"));
        format!("verdict {word}: {}{lead}", clauses.join(" · "))
    }
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// A row's event list by site, or `None` when the page sent `null`.
fn events(v: &Value, key: &str) -> Option<Vec<Value>> {
    match v.get(key) {
        Some(Value::Array(items)) => Some(items.clone()),
        _ => None,
    }
}

fn site(e: &Value) -> String {
    e.get("site")
        .and_then(Value::as_str)
        .unwrap_or("-")
        .to_string()
}

fn sites(list: &[Value]) -> String {
    if list.is_empty() {
        return "none".to_string();
    }
    list.iter().map(site).collect::<Vec<_>>().join(" | ")
}

/// Whether any frame standing on both sides of the band got smaller on either
/// axis — `bandShrinks` in the fixture, over the same `id@x,y+WxH` strings.
pub fn band_shrinks(before: &str, after: &str) -> bool {
    fn sizes(band: &str) -> std::collections::HashMap<&str, (f64, f64)> {
        band.split_whitespace()
            .filter_map(|item| {
                let (id, rest) = item.split_once('@')?;
                let (_, size) = rest.split_once('+')?;
                let (w, h) = size.split_once('x')?;
                Some((id, (w.parse().ok()?, h.parse().ok()?)))
            })
            .collect()
    }
    let was = sizes(before);
    sizes(after).iter().any(|(id, (w, h))| {
        was.get(id)
            .is_some_and(|(pw, ph)| *w < pw - 0.5 || *h < ph - 0.5)
    })
}

/// The bar over one settle: its `settle-frames` row, its `settle-land` row if
/// one was written, and whether the gesture shrinks a frame (a shrink pays its
/// land by the user's ruling, so its land is noted and not barred), against
/// `bars`.
pub fn verdict(frames: &Value, land: Option<&Value>, shrinks: bool, bars: Bars) -> Verdict {
    let mut clauses = Vec::new();

    // 1. The motion's gaps, from the first frame on.
    let gap_frames = num(frames, "motionLongestGapFrames");
    let gap_ms = num(frames, "motionLongestGapMs").unwrap_or(-1.0);
    clauses.push(Clause {
        name: "gap",
        pass: gap_frames.map(|g| g <= bars.gap_frames),
        detail: match gap_frames {
            Some(g) => format!("{gap_ms:.0} ms / {g:.2} frames against {}", bars.gap_frames),
            None => "no gap in the row".to_string(),
        },
    });

    // 2. No shown frame off its own curve.
    let off: Vec<String> = frames
        .get("offCurvePaneIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    clauses.push(Clause {
        name: "off-curve",
        pass: Some(off.is_empty()),
        detail: if off.is_empty() {
            "no pane".to_string()
        } else {
            format!(
                "{} tick(s) on {}",
                num(frames, "offCurveTicks").unwrap_or(0.0),
                off.join(", ")
            )
        },
    });

    // 3. Nothing ran inside the motion.
    let motion_at = num(frames, "motionAtMs").unwrap_or(-1.0);
    if motion_at < 0.0 {
        clauses.push(Clause {
            name: "sealed",
            pass: Some(false),
            detail: "the motion gate never closed behind the beats".to_string(),
        });
    } else {
        let commits = events(frames, "motionCommits").map(|list| {
            list.into_iter()
                .filter(|c| c.get("performed").and_then(Value::as_f64).unwrap_or(0.0) > 0.0)
                .collect::<Vec<_>>()
        });
        let forced: Vec<Value> = events(frames, "motionForcedLayouts")
            .unwrap_or_default()
            .into_iter()
            .filter(|e| site(e) != BENCH_PROBE_SITE)
            .collect();
        let deliveries = events(frames, "motionDeliveries");
        let counted = |list: &Option<Vec<Value>>| match list {
            Some(l) => sites(l),
            None => "not counted".to_string(),
        };
        let red = commits.as_ref().is_some_and(|c| !c.is_empty())
            || !forced.is_empty()
            || deliveries.as_ref().is_some_and(|d| !d.is_empty());
        let unread = commits.is_none() || deliveries.is_none();
        clauses.push(Clause {
            name: "sealed",
            pass: if red {
                Some(false)
            } else if unread {
                None
            } else {
                Some(true)
            },
            detail: format!(
                "commits {}; forced layouts {}; deliveries {}",
                counted(&commits),
                sites(&forced),
                counted(&deliveries)
            ),
        });
    }

    // 4. The land is one frame.
    match land {
        None => clauses.push(Clause {
            name: "land",
            pass: Some(false),
            detail: "the settle wrote no land".to_string(),
        }),
        Some(land) => {
            let frame_ms = num(land, "frameMs").unwrap_or(-1.0);
            let frame_frames = num(land, "frameFrames").unwrap_or(f64::INFINITY);
            let pass = if frame_ms <= 0.0 {
                Some(false)
            } else if shrinks {
                Some(true)
            } else {
                Some(frame_frames <= bars.land_frames)
            };
            let ruling = if shrinks {
                ", a shrink pays its land by ruling"
            } else {
                ""
            };
            clauses.push(Clause {
                name: "land",
                pass,
                detail: format!(
                    "{frame_ms:.1} ms / {frame_frames:.2} frames against {}{ruling}",
                    bars.land_frames
                ),
            });
        }
    }

    Verdict {
        clauses,
        lead_ms: num(frames, "firstPaintDelayMs"),
    }
}

/// The verdict over a drive's engine rows as the page sent them —
/// `{frames: [settle-frames…], lands: [settle-land…], before, after}` — over
/// the last settle row and the last land, the settle the drive ended on.
/// `None` when the record switch was off and the page sent no rows.
pub fn verdict_of(engine: Option<&Value>, bars: Bars) -> Option<Verdict> {
    let engine = engine.filter(|v| !v.is_null())?;
    let frames = engine.get("frames")?.as_array()?.last()?;
    let land = engine
        .get("lands")
        .and_then(Value::as_array)
        .and_then(|l| l.last());
    let band = |key: &str| engine.get(key).and_then(Value::as_str).unwrap_or("");
    Some(verdict(
        frames,
        land,
        band_shrinks(band("before"), band("after")),
        bars,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn clean_row() -> Value {
        json!({
            "kind": "settle-frames",
            "motionLongestGapMs": 22.0, "motionLongestGapFrames": 1.29,
            "offCurvePaneIds": [], "offCurveTicks": 0,
            "motionAtMs": 218.0,
            "motionCommits": [], "motionDeliveries": [],
            "motionForcedLayouts": [{"t": 1.0, "ms": 2.0, "site": "[bench probe]"}],
            "firstPaintDelayMs": 76.0,
        })
    }

    fn land(frame_ms: f64, frames: f64) -> Value {
        json!({"kind": "settle-land", "frameMs": frame_ms, "frameFrames": frames, "framePeriodMs": 16.7})
    }

    #[test]
    fn a_clean_settle_reads_green_with_the_lead_noted() {
        let v = verdict(&clean_row(), Some(&land(17.0, 1.0)), false, Bars::DEFAULT);
        assert!(v.green(), "{}", v.line());
        assert_eq!(v.lead_ms, Some(76.0));
        assert!(v.line().starts_with("verdict green:"));
        assert!(v.line().contains("lead 76.0 ms, not barred"));
    }

    #[test]
    fn a_long_motion_gap_is_red() {
        let mut row = clean_row();
        row["motionLongestGapFrames"] = json!(2.4);
        let v = verdict(&row, Some(&land(17.0, 1.0)), false, Bars::DEFAULT);
        assert!(!v.green());
        assert_eq!(v.clauses[0].pass, Some(false));
        assert!(v.line().starts_with("verdict RED:"));
    }

    #[test]
    fn a_commit_that_performed_work_inside_the_motion_is_red_and_an_empty_one_is_not() {
        let mut row = clean_row();
        row["motionCommits"] = json!([{"t": 1.0, "performed": 0, "site": "root"}]);
        assert!(verdict(&row, Some(&land(17.0, 1.0)), false, Bars::DEFAULT).green());
        row["motionCommits"] = json!([{"t": 1.0, "performed": 12, "site": "TugPane"}]);
        let v = verdict(&row, Some(&land(17.0, 1.0)), false, Bars::DEFAULT);
        assert_eq!(v.clauses[2].pass, Some(false));
        assert!(v.clauses[2].detail.contains("TugPane"));
    }

    #[test]
    fn the_bench_probe_read_is_carved_out_and_any_other_forced_layout_is_not() {
        let mut row = clean_row();
        assert_eq!(
            verdict(&row, Some(&land(17.0, 1.0)), false, Bars::DEFAULT).clauses[2].pass,
            Some(true)
        );
        row["motionForcedLayouts"] = json!([{"t": 1.0, "ms": 3.0, "site": "_placeRunHeight"}]);
        assert_eq!(
            verdict(&row, Some(&land(17.0, 1.0)), false, Bars::DEFAULT).clauses[2].pass,
            Some(false)
        );
    }

    #[test]
    fn a_census_the_page_did_not_have_is_not_counted_rather_than_green() {
        let mut row = clean_row();
        row["motionCommits"] = Value::Null;
        let v = verdict(&row, Some(&land(17.0, 1.0)), false, Bars::DEFAULT);
        assert_eq!(v.clauses[2].pass, None);
        assert!(v.clauses[2].detail.contains("commits not counted"));
        // Every readable clause green, one unread: green, and the line says what was not counted.
        assert!(v.green());
        assert!(v.line().contains("sealed not counted"));
    }

    #[test]
    fn a_long_land_is_red_unless_the_gesture_shrinks_a_frame() {
        let v = verdict(&clean_row(), Some(&land(32.0, 1.9)), false, Bars::DEFAULT);
        assert_eq!(v.clauses[3].pass, Some(false));
        let v = verdict(&clean_row(), Some(&land(32.0, 1.9)), true, Bars::DEFAULT);
        assert_eq!(v.clauses[3].pass, Some(true));
        assert!(v.clauses[3].detail.contains("by ruling"));
    }

    #[test]
    fn no_land_and_no_gate_are_red_rather_than_passes_by_absence() {
        let v = verdict(&clean_row(), None, false, Bars::DEFAULT);
        assert_eq!(v.clauses[3].pass, Some(false));
        let mut row = clean_row();
        row["motionAtMs"] = json!(-1);
        assert_eq!(
            verdict(&row, Some(&land(17.0, 1.0)), false, Bars::DEFAULT).clauses[2].pass,
            Some(false)
        );
    }

    #[test]
    fn the_two_re_budgeted_legs_carry_their_own_bar() {
        let show = Bars::for_drive("sidebar", &json!({"component": "c", "open": true}));
        let hide = Bars::for_drive("sidebar", &json!({"component": "c", "open": false}));
        let fit = Bars::for_drive("fit", &json!({}));
        assert_eq!(show.land_frames, SIDEBAR_SHOW_LAND_FRAMES_BAR);
        assert_eq!(show.gap_frames, GAP_FRAMES_BAR);
        assert_eq!(hide, Bars::DEFAULT);
        assert_eq!(fit.gap_frames, FIT_GAP_FRAMES_BAR);
        assert_eq!(fit.land_frames, LAND_FRAMES_BAR);
        assert_eq!(Bars::for_drive("split", &json!({})), Bars::DEFAULT);

        // The show's 1.9-frame land is green on its bar and red on the default.
        let long_land = land(32.0, 1.9);
        assert_eq!(
            verdict(&clean_row(), Some(&long_land), false, show).clauses[3].pass,
            Some(true)
        );
        assert_eq!(
            verdict(&clean_row(), Some(&long_land), false, hide).clauses[3].pass,
            Some(false)
        );
        // Resize-to-fit's 2.2-frame gap likewise.
        let mut row = clean_row();
        row["motionLongestGapFrames"] = json!(2.2);
        let fit_reading = verdict(&row, Some(&land(17.0, 1.0)), false, fit);
        assert_eq!(fit_reading.clauses[0].pass, Some(true));
        assert!(
            fit_reading.clauses[0].detail.contains("against 2.5"),
            "{}",
            fit_reading.line()
        );
        let default_reading = verdict(&row, Some(&land(17.0, 1.0)), false, Bars::DEFAULT);
        assert_eq!(default_reading.clauses[0].pass, Some(false));
    }

    #[test]
    fn band_shrinks_reads_a_frame_that_got_smaller_on_either_axis() {
        assert!(band_shrinks("p1@0,0+800x600", "p1@0,0+800x300"));
        assert!(band_shrinks("p1@0,0+800x600", "p1@0,0+400x600"));
        assert!(!band_shrinks("p1@0,0+800x300", "p1@0,0+800x600"));
        // A frame that arrived or left is not a shrink.
        assert!(!band_shrinks("p1@0,0+800x600", "p2@0,0+10x10"));
    }

    #[test]
    fn verdict_of_reads_the_last_rows_and_none_when_recording_was_off() {
        assert_eq!(verdict_of(None, Bars::DEFAULT), None);
        assert_eq!(verdict_of(Some(&Value::Null), Bars::DEFAULT), None);
        let engine = json!({
            "frames": [clean_row()],
            "lands": [land(17.0, 1.0)],
            "before": "p1@0,0+800x600",
            "after": "p1@0,0+800x600",
        });
        assert!(verdict_of(Some(&engine), Bars::DEFAULT).unwrap().green());
    }
}
