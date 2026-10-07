//! The bar's verdict on one settle, as the page computed it.
//!
//! The bar is the app-tests' bar and lives in one place: the pure TypeScript
//! module `tugdeck/src/lib/motion-guard/settle-bar.ts`, which the fixture
//! (`tests/app-test/settle-frames-fixture.ts`) imports and the page exposes as
//! `window.__tugMotion.settleVerdict`. The verb's page scripts call it over the
//! deck's own rows (`settle-frames`, `settle-land`) and hand back its clauses
//! as `engine.verdict`, so this end only prints them. It keeps no copy of a
//! number or a clause: two copies of one bar drifted twice, and each time the
//! verb read RED on a leg the test read green.
//!
//! The rows exist only while the record switch is on (`tugtool deck motion
//! record on`). With it on, `settle` and `slide` print the verdict beside their
//! own outside reading, so "sometimes drops frames" on the user's deck becomes
//! a named clause with a verdict, taken by typing one verb.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One clause of the bar and how it read.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Clause {
    pub name: String,
    /// `Some(true)` green, `Some(false)` red, `None` when the page could not
    /// count it — a census that was not in the page is never a count of none.
    pub pass: Option<bool>,
    pub detail: String,
}

/// The bar over one settle.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Verdict {
    #[serde(default)]
    pub clauses: Vec<Clause>,
    /// The set-up: the gesture to the first frame, noted and never barred.
    #[serde(default, rename(deserialize = "leadMs"))]
    pub lead_ms: Option<f64>,
    /// Why there are no clauses to print, when there are none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unread: Option<String>,
}

impl Verdict {
    fn unread(why: impl Into<String>) -> Verdict {
        Verdict {
            clauses: Vec::new(),
            lead_ms: None,
            unread: Some(why.into()),
        }
    }

    /// Green when every clause that could be read is green and at least one was.
    pub fn green(&self) -> bool {
        self.clauses.iter().all(|c| c.pass != Some(false))
            && self.clauses.iter().any(|c| c.pass.is_some())
    }

    /// The one line a reading prints.
    pub fn line(&self) -> String {
        if let Some(why) = &self.unread {
            return format!("verdict unread: {why}");
        }
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

/// The verdict the page wrote beside a drive's engine rows —
/// `{frames, lands, before, after, verdict}`. `None` when the record switch
/// was off and the page sent no rows; an unread verdict, saying why, when the
/// rows came without one.
pub fn verdict_of(engine: Option<&Value>) -> Option<Verdict> {
    let engine = engine.filter(|v| !v.is_null())?;
    let verdict = match engine.get("verdict") {
        None | Some(Value::Null) => {
            return Some(Verdict::unread("the settle wrote no settle-frames row"));
        }
        Some(v) => v,
    };
    if let Some(error) = verdict.get("error").and_then(Value::as_str) {
        return Some(Verdict::unread(error));
    }
    Some(
        serde_json::from_value(verdict.clone())
            .unwrap_or_else(|e| Verdict::unread(format!("the page's verdict did not parse: {e}"))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn engine(verdict: Value) -> Value {
        json!({"frames": [], "lands": [], "before": "", "after": "", "verdict": verdict})
    }

    #[test]
    fn the_pages_clauses_print_as_one_line_with_the_lead_noted() {
        let v = verdict_of(Some(&engine(json!({
            "clauses": [
                {"name": "gap", "pass": true, "detail": "22 ms / 1.29 frames against 2"},
                {"name": "off-curve", "pass": true, "detail": "no pane; rail exempt, arrived in the gesture"},
                {"name": "sealed", "pass": true, "detail": "commits none; forced layouts none; deliveries none"},
                {"name": "land", "pass": true, "detail": "17.0 ms / 1.00 frames against 2"},
            ],
            "leadMs": 76.0,
        }))))
        .unwrap();
        assert!(v.green(), "{}", v.line());
        assert_eq!(v.lead_ms, Some(76.0));
        assert!(v.line().starts_with("verdict green: gap ok (22 ms"));
        assert!(v.line().contains("rail exempt"));
        assert!(v.line().contains("lead 76.0 ms, not barred"));
    }

    #[test]
    fn one_red_clause_makes_the_line_red_and_an_uncounted_one_does_not() {
        let v = verdict_of(Some(&engine(json!({
            "clauses": [
                {"name": "gap", "pass": false, "detail": "50 ms / 3.00 frames against 2"},
                {"name": "sealed", "pass": null, "detail": "commits not counted"},
            ],
            "leadMs": null,
        }))))
        .unwrap();
        assert!(!v.green());
        assert!(v.line().starts_with("verdict RED: gap RED (50 ms"));
        assert!(v.line().contains("sealed not counted"));

        let v = verdict_of(Some(&engine(json!({
            "clauses": [
                {"name": "gap", "pass": true, "detail": "x"},
                {"name": "sealed", "pass": null, "detail": "commits not counted"},
            ],
        }))))
        .unwrap();
        assert!(v.green(), "{}", v.line());
    }

    #[test]
    fn both_page_scripts_take_the_band_the_app_tests_take() {
        // The bar's arrived exemption and its shrink ruling read the band, so
        // a page script that counted a parked rail member as standing would
        // never exempt a rail's arriving frames: the drift the user's deck
        // showed on every rails show. Each script asks the page's own census
        // first and falls back to the fixture's selector spelled out.
        for (name, script) in [
            (
                "deck_motion_settle.js",
                include_str!("deck_motion_settle.js"),
            ),
            ("deck_motion_slide.js", include_str!("deck_motion_slide.js")),
        ] {
            assert!(script.contains("handle.settleBand()"), "{name}");
            assert!(
                script.contains(
                    "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]:not([data-rail-parked]):not([data-departing])"
                ),
                "{name}"
            );
            assert!(
                !script
                    .contains("\"[data-space-layer][data-space-shown] .tug-pane[data-pane-id]\""),
                "{name}"
            );
        }
    }

    #[test]
    fn no_rows_is_none_and_rows_without_a_verdict_say_why() {
        assert_eq!(verdict_of(None), None);
        assert_eq!(verdict_of(Some(&Value::Null)), None);
        let v = verdict_of(Some(&engine(Value::Null))).unwrap();
        assert!(!v.green());
        assert!(v.line().starts_with("verdict unread: the settle wrote no"));
        let v = verdict_of(Some(&engine(
            json!({"error": "this deck predates the shared settle bar"}),
        )))
        .unwrap();
        assert_eq!(
            v.line(),
            "verdict unread: this deck predates the shared settle bar"
        );
    }
}
