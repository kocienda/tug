//! The forms a figure can take, and a recipe's chart redrawn in another one.
//!
//! [`FORMS`] is the one list a person is shown when they ask what they can ask
//! for: each form's name, what a reader does with it, the everyday words that
//! mean it, and a request that gets one. `tugtool chart forms` prints it.
//!
//! [`reform`] is what `--form` on a recipe runs: the same categories and the
//! same series, drawn as another of the forms that can hold them.

use serde_json::{json, Map, Value};

/// Which fence a form is drawn in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormKind {
    /// A `tugchart`, drawn from numbers.
    Chart,
    /// A `tugdiagram`, drawn from reading code.
    Diagram,
}

impl FormKind {
    pub fn name(self) -> &'static str {
        match self {
            FormKind::Chart => "chart",
            FormKind::Diagram => "diagram",
        }
    }
}

/// One form. `shows` completes "the reader can…", `said` holds the everyday
/// words that ask for it, and `ask` is a whole request that draws one.
pub struct Form {
    pub name: &'static str,
    pub kind: FormKind,
    pub shows: &'static str,
    pub said: &'static [&'static str],
    pub ask: &'static str,
}

pub static FORMS: [Form; 16] = [
    Form {
        name: "bar",
        kind: FormKind::Chart,
        shows: "compare a magnitude across categories",
        said: &[
            "bars",
            "columns",
            "ranking",
            "pie (drawn as one stacked bar)",
        ],
        ask: "/viz lines changed by directory this month as a bar",
    },
    Form {
        name: "line",
        kind: FormKind::Chart,
        shows: "follow one or a few values over time",
        said: &["trend", "over time", "time series"],
        ask: "/viz commits per day this quarter as a line",
    },
    Form {
        name: "area",
        kind: FormKind::Chart,
        shows: "see one value's volume, or parts of a whole, over time",
        said: &["filled trend", "stacked over time", "share over time"],
        ask: "/viz lines added and removed per day as an area",
    },
    Form {
        name: "sparkline",
        kind: FormKind::Chart,
        shows: "see a trend at a glance in a small figure",
        said: &["mini chart", "tiny trend"],
        ask: "/viz build times of the last 20 runs as a sparkline",
    },
    Form {
        name: "dots",
        kind: FormKind::Chart,
        shows: "read a run of outcomes per item, oldest to newest",
        said: &["pass/fail grid", "run history", "streaks"],
        ask: "/viz which tests have been red lately as dots",
    },
    Form {
        name: "histogram",
        kind: FormKind::Chart,
        shows: "see how samples are distributed",
        said: &["distribution", "spread", "buckets"],
        ask: "/viz how big commits are as a histogram",
    },
    Form {
        name: "spans",
        kind: FormKind::Chart,
        shows: "see when things started and ended on one timeline",
        said: &["timeline", "gantt", "waterfall"],
        ask: "/viz where the last build's time went as a timeline",
    },
    Form {
        name: "heat",
        kind: FormKind::Chart,
        shows: "see intensity along one ordered row",
        said: &["heatmap", "busiest", "hot spots in time"],
        ask: "/viz commits by hour of day as a heatmap",
    },
    Form {
        name: "bullet",
        kind: FormKind::Chart,
        shows: "judge a value against its range and target",
        said: &["gauge", "against target", "budget"],
        ask: "/viz each suite's time against its budget as bullets",
    },
    Form {
        name: "scatter",
        kind: FormKind::Chart,
        shows: "see whether one measure moves with another",
        said: &["correlation", "x versus y", "plotted against"],
        ask: "/viz test time against lines changed as a scatter",
    },
    Form {
        name: "flow",
        kind: FormKind::Diagram,
        shows: "follow work moving through parts, with branches",
        said: &["flowchart", "pipeline", "data flow"],
        ask: "/explain how a save reaches the disk as a flow",
    },
    Form {
        name: "sequence",
        kind: FormKind::Diagram,
        shows: "follow messages between a few parties, in time order",
        said: &["message diagram", "who calls whom", "handshake"],
        ask: "/explain how login works as a sequence",
    },
    Form {
        name: "layers",
        kind: FormKind::Diagram,
        shows: "follow something down through strata, and what crosses each boundary",
        said: &["levels", "what it passes through", "top to bottom"],
        ask: "/explain what a keystroke passes through as layers",
    },
    Form {
        name: "stack",
        kind: FormKind::Diagram,
        shows: "see the architecture: what sits on what, and what is outside",
        said: &["architecture", "block diagram", "big picture"],
        ask: "/explain the architecture of this project as a stack",
    },
    Form {
        name: "states",
        kind: FormKind::Diagram,
        shows: "see what a thing can be, and what moves it between states",
        said: &["lifecycle", "state machine", "what states it can be in"],
        ask: "/explain the diff store's lifecycle as states",
    },
    Form {
        name: "tree",
        kind: FormKind::Diagram,
        shows: "see what is inside what: parts and where they live",
        said: &["hierarchy", "what contains what", "component tree"],
        ask: "/explain the parts of the chart engine as a tree",
    },
];

/// The forms as `chart forms --json` prints them, all or one kind.
pub fn forms_json(kind: Option<FormKind>) -> Value {
    Value::Array(
        FORMS
            .iter()
            .filter(|form| kind.is_none_or(|k| k == form.kind))
            .map(|form| {
                json!({
                    "name": form.name,
                    "kind": form.kind.name(),
                    "shows": form.shows,
                    "said": form.said,
                    "ask": form.ask,
                })
            })
            .collect(),
    )
}

/// The forms a chart of categories and series can be redrawn in.
pub const SERIES_FORMS: [&str; 3] = ["bar", "line", "area"];

/// The forms a chart of one row of values can be redrawn in.
pub const ROW_FORMS: [&str; 4] = ["heat", "bar", "line", "area"];

fn label(value: &Value) -> Value {
    match value {
        Value::String(_) => value.clone(),
        other => json!(other.to_string()),
    }
}

/// Redraw `spec` as `form`, keeping its labels, its series and everything a
/// form does not own: title, unit, format, annotations. `bar`, `line`, `area`
/// and `heat` hold the same data, so any of them becomes any other, except
/// that `heat` draws one row and so refuses a chart of several series.
/// Stacking survives between `bar` and `area`.
pub fn reform(spec: &mut Value, form: &str) -> Result<(), String> {
    let Some(obj) = spec.as_object_mut() else {
        return Err("the chart is not an object".to_string());
    };
    let from = obj.get("form").and_then(Value::as_str).unwrap_or_default();
    if from == form {
        return Ok(());
    }
    let holds = |name: &str| ROW_FORMS.contains(&name);
    if !holds(from) || !holds(form) {
        return Err(format!("a {from} chart cannot be redrawn as {form}"));
    }
    let labels: Vec<Value> = obj
        .get(if from == "bar" || from == "heat" {
            "categories"
        } else {
            "x"
        })
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let series: Vec<Value> = if from == "heat" {
        let name = obj
            .get("unit")
            .and_then(Value::as_str)
            .unwrap_or("value")
            .to_string();
        vec![json!({ "name": name, "values": obj.get("values").cloned().unwrap_or(json!([])) })]
    } else {
        obj.get("series")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    if form == "heat" && series.len() != 1 {
        return Err(format!(
            "heat draws one row of values, and this chart has {} series",
            series.len()
        ));
    }
    let stacked = obj.get("layout").and_then(Value::as_str) == Some("stacked");
    for key in ["categories", "x", "series", "values", "orient", "layout"] {
        obj.remove(key);
    }
    let mut put = |key: &str, value: Value| {
        obj.insert(key.to_string(), value);
    };
    put("form", json!(form));
    match form {
        "bar" => {
            put("categories", labels.iter().map(label).collect());
            put("series", Value::Array(series));
            if stacked {
                put("layout", json!("stacked"));
            }
        }
        "heat" => {
            put("categories", labels.iter().map(label).collect());
            let row = series[0]
                .as_object()
                .and_then(|s: &Map<String, Value>| s.get("values"))
                .cloned()
                .unwrap_or(json!([]));
            put("values", row);
        }
        _ => {
            put("x", Value::Array(labels));
            put("series", Value::Array(series));
            if form == "area" && stacked {
                put("layout", json!("stacked"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{ArgKind, RECIPES};
    use crate::context::test_support::assert_valid;

    #[test]
    fn every_form_is_named_once_and_says_how_to_ask() {
        let mut names: Vec<&str> = FORMS.iter().map(|f| f.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), FORMS.len());
        for form in &FORMS {
            assert!(!form.said.is_empty(), "{}", form.name);
            let door = match form.kind {
                FormKind::Chart => "/viz ",
                FormKind::Diagram => "/explain ",
            };
            assert!(form.ask.starts_with(door), "{}", form.name);
            assert!(form.ask.contains(" as "), "{}", form.name);
        }
    }

    #[test]
    fn the_list_narrows_to_one_kind() {
        assert_eq!(forms_json(None).as_array().unwrap().len(), 16);
        let diagrams = forms_json(Some(FormKind::Diagram));
        let names: Vec<&str> = diagrams
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["flow", "sequence", "layers", "stack", "states", "tree"]
        );
    }

    /// The session's guidance tells the model which words mean which form, and
    /// `chart forms` tells the user the same, so the two lists are held equal:
    /// each form's row in its guidance file carries every word in `said`.
    #[test]
    fn the_guidance_names_every_word_a_form_is_said_by() {
        let plugin = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tugplug");
        let charts = std::fs::read_to_string(plugin.join("graphics.md")).unwrap();
        let diagrams = std::fs::read_to_string(plugin.join("diagrams.md")).unwrap();
        for form in &FORMS {
            let text = match form.kind {
                FormKind::Chart => &charts,
                FormKind::Diagram => &diagrams,
            };
            let words: Vec<&str> = form
                .said
                .iter()
                .filter(|word| !word.contains('('))
                .copied()
                .collect();
            let row = format!("| {} | `{}` |", words.join(", "), form.name);
            assert!(text.contains(&row), "no row `{row}`");
        }
    }

    /// Every form a recipe offers under `--form` draws a chart the engine
    /// accepts, from the recipe's own sample.
    #[test]
    fn every_form_a_recipe_offers_is_a_valid_chart_of_its_sample() {
        let mut offered = 0;
        for recipe in &RECIPES {
            for arg in recipe.args.iter().filter(|a| a.flag == "form") {
                let ArgKind::Choice(forms) = arg.kind else {
                    panic!("{}: --form is not a choice", recipe.name);
                };
                for form in forms {
                    let mut spec = (recipe.sample)();
                    reform(&mut spec, form)
                        .unwrap_or_else(|e| panic!("{} as {form}: {e}", recipe.name));
                    assert_eq!(spec["form"], *form, "{}", recipe.name);
                    assert_valid(&spec);
                    offered += 1;
                }
            }
        }
        assert!(offered > 0);
    }

    #[test]
    fn a_stacked_bar_becomes_a_stacked_area_and_a_plain_line() {
        let bar = json!({
            "tugchart": 1, "form": "bar", "layout": "stacked", "title": "t",
            "categories": ["a", "b"],
            "series": [{ "name": "s", "values": [1, 2] }, { "name": "u", "values": [3, 4] }],
            "annotations": [{ "kind": "rule", "value": 2 }],
        });
        let mut area = bar.clone();
        reform(&mut area, "area").unwrap();
        assert_eq!(area["layout"], "stacked");
        assert_eq!(area["x"], json!(["a", "b"]));
        assert!(area.get("categories").is_none());
        assert_eq!(area["annotations"], bar["annotations"]);
        assert_valid(&area);

        let mut line = bar.clone();
        reform(&mut line, "line").unwrap();
        assert!(line.get("layout").is_none());
        assert_eq!(line["series"], bar["series"]);
        assert_valid(&line);
    }

    #[test]
    fn a_heat_row_becomes_one_series_named_by_its_unit_and_back() {
        let heat = json!({
            "tugchart": 1, "form": "heat", "title": "t", "unit": "commits",
            "categories": ["Mon", "Tue"], "values": [3, 5],
        });
        let mut bar = heat.clone();
        reform(&mut bar, "bar").unwrap();
        assert_eq!(
            bar["series"],
            json!([{ "name": "commits", "values": [3, 5] }])
        );
        assert_valid(&bar);
        reform(&mut bar, "heat").unwrap();
        assert_eq!(bar, heat);
    }

    #[test]
    fn heat_refuses_several_series_and_other_forms_are_refused_whole() {
        let mut two = json!({
            "tugchart": 1, "form": "line", "title": "t", "x": [1, 2],
            "series": [{ "name": "s", "values": [1, 2] }, { "name": "u", "values": [3, 4] }],
        });
        let before = two.clone();
        assert!(reform(&mut two, "heat").is_err());
        assert_eq!(two, before);
        let mut dots = json!({ "tugchart": 1, "form": "dots", "title": "t", "rows": [] });
        assert!(reform(&mut dots, "bar").is_err());
    }

    #[test]
    fn numeric_labels_become_text_where_a_form_wants_categories() {
        let mut line = json!({
            "tugchart": 1, "form": "line", "title": "t", "x": [1, 2],
            "series": [{ "name": "s", "values": [1, 2] }],
        });
        reform(&mut line, "bar").unwrap();
        assert_eq!(line["categories"], json!(["1", "2"]));
        assert_valid(&line);
    }
}
