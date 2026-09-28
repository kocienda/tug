//! `tugtool deck motion` — ask the running deck what is moving, and what it costs.
//!
//! The shipping app keeps `developerExtrasEnabled` and `isInspectable` off in
//! every build by decision, so the build a user is actually running is the one
//! build nobody can open a console on. This verb is the console that decision
//! leaves room for: it posts a one-line expression to `POST /api/eval` and
//! prints what the page hands back.
//!
//! Nothing new is on the wire. `/api/eval` already exists in every build, is
//! loopback-only, and is gated on dev mode or a per-instance `diag/eval`
//! opt-in; the deck already binds `window.__tugMotion` in every build. This is
//! the shell end of a door that was already there — no new tugproto message,
//! no new deck handler, and no host code.
//!
//! ## The subcommand that settles an incident
//!
//! `bisect` pauses each loop group in turn, measures the frame's render cost
//! with it paused, resumes it, and sorts by the drop. The group whose absence
//! collapses the cost is the one paying for the compositing walk — named in
//! seconds, on the build in front of the user, rather than by elimination over
//! the source. It is bounded so it finishes inside `eval_handler`'s
//! thirty-second ceiling.
//!
//! ## Exit codes
//!
//! `0` on a reading, `2` when the instance's eval door is shut (with the
//! remedy printed), `1` for everything else.

use crate::cli::{DeckMotionCommands, DeckTarget};
use crate::commands::tell::{Remedy, resolve_port};

/// What a 403 from `/api/eval` means, and the one command that fixes it.
pub const EVAL_GATED_REMEDY: &str = "eval is gated on this instance — run 'tugtool deck motion enable' (loopback only; 'disable' revokes it)";

/// Exit code for a shut eval door. Distinct from 1 so a script can tell
/// "not allowed to ask" from "asked and it went wrong".
const EXIT_GATED: i32 = 2;

/// The `window.__tugMotion` call each reading subcommand posts.
///
/// Pure, and unit-tested against the plan's subcommand table. The selector is
/// JSON-encoded rather than interpolated raw, so a selector carrying quotes —
/// `a[data-x="1"]`, the ordinary shape for anything attribute-matched —
/// survives the round trip instead of terminating the string literal early.
///
/// Returns `None` for `enable` and `disable`, which are defaults writes rather
/// than evaluations.
pub fn eval_code_for(cmd: &DeckMotionCommands) -> Option<String> {
    let json = |s: &str| serde_json::to_string(s).expect("a string always encodes");
    Some(match cmd {
        DeckMotionCommands::List { within, .. } => match within {
            Some(selector) => {
                format!("window.__tugMotion.list({{within: {}}})", json(selector))
            }
            None => "window.__tugMotion.list()".to_string(),
        },
        DeckMotionCommands::Cost { frames, .. } => {
            format!("window.__tugMotion.cost({frames})")
        }
        DeckMotionCommands::Layers { .. } => "window.__tugMotion.layers()".to_string(),
        DeckMotionCommands::Pause { selector, .. } => {
            format!("window.__tugMotion.pause({})", json(selector))
        }
        DeckMotionCommands::Resume { selector, .. } => {
            format!("window.__tugMotion.resume({})", json(selector))
        }
        DeckMotionCommands::Bisect { frames, cap, .. } => {
            let mut options: Vec<String> = Vec::new();
            if let Some(frames) = frames {
                options.push(format!("frames: {frames}"));
            }
            if let Some(cap) = cap {
                options.push(format!("cap: {cap}"));
            }
            if options.is_empty() {
                "window.__tugMotion.bisect()".to_string()
            } else {
                format!("window.__tugMotion.bisect({{{}}})", options.join(", "))
            }
        }
        DeckMotionCommands::Input { .. } => "window.__tugMotion.input()".to_string(),
        DeckMotionCommands::Probe { .. } => "window.__tugMotion.probe()".to_string(),
        DeckMotionCommands::Demote { state, .. } => {
            format!("window.__tugMotion.demote({})", state == "on")
        }
        DeckMotionCommands::Chains { mode, .. } => {
            format!("window.__tugMotion.chains({})", json(mode))
        }
        DeckMotionCommands::Enable { .. } | DeckMotionCommands::Disable { .. } => return None,
    })
}

/// The `--port` / `--instance` pair each subcommand carries.
fn target_of(cmd: &DeckMotionCommands) -> &DeckTarget {
    match cmd {
        DeckMotionCommands::List { target, .. }
        | DeckMotionCommands::Cost { target, .. }
        | DeckMotionCommands::Layers { target }
        | DeckMotionCommands::Pause { target, .. }
        | DeckMotionCommands::Resume { target, .. }
        | DeckMotionCommands::Bisect { target, .. }
        | DeckMotionCommands::Input { target }
        | DeckMotionCommands::Probe { target }
        | DeckMotionCommands::Demote { target, .. }
        | DeckMotionCommands::Chains { target, .. }
        | DeckMotionCommands::Enable { target }
        | DeckMotionCommands::Disable { target } => target,
    }
}

pub fn run_deck_motion(cmd: DeckMotionCommands, json_output: bool) -> Result<i32, String> {
    let target = target_of(&cmd);
    // Strict ambiguity: the verb reads one specific deck, and a reading taken
    // from a different instance than the one the user is looking at is worse
    // than no reading at all.
    let port = resolve_port(target.port, target.instance.clone())
        .map_err(|e| e.describe(Remedy::Flags))?;

    match cmd {
        DeckMotionCommands::Enable { .. } => set_eval_opt_in(port, true, json_output),
        DeckMotionCommands::Disable { .. } => set_eval_opt_in(port, false, json_output),
        other => {
            let code = eval_code_for(&other).expect("only enable/disable have no eval code");
            let result = match post_eval(port, &code)? {
                EvalOutcome::Gated => {
                    eprintln!("{EVAL_GATED_REMEDY}");
                    return Ok(EXIT_GATED);
                }
                EvalOutcome::Ok(value) => value,
            };
            if json_output {
                println!("{}", serde_json::to_string_pretty(&result).unwrap());
            } else {
                render(&other, &result);
            }
            Ok(0)
        }
    }
}

enum EvalOutcome {
    Ok(serde_json::Value),
    Gated,
}

fn post_eval(port: u16, code: &str) -> Result<EvalOutcome, String> {
    let url = format!("http://127.0.0.1:{port}/api/eval");
    let response = ureq::post(&url).send_json(serde_json::json!({ "code": code }));
    let mut response = match response {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(403)) => return Ok(EvalOutcome::Gated),
        Err(ureq::Error::StatusCode(code)) => {
            return Err(format!("POST {url} returned status {code}"));
        }
        Err(e) => return Err(format!("POST {url} failed: {e}")),
    };
    if response.status().as_u16() == 403 {
        return Ok(EvalOutcome::Gated);
    }
    let body: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|e| format!("reading response failed: {e}"))?;
    if body.get("status").and_then(|s| s.as_str()) != Some("ok") {
        let message = body
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("eval failed");
        return Err(message.to_string());
    }
    Ok(EvalOutcome::Ok(
        body.get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    ))
}

/// Set or clear the per-instance `diag/eval` opt-in the eval handler gates on.
fn set_eval_opt_in(port: u16, on: bool, json_output: bool) -> Result<i32, String> {
    let url = format!("http://127.0.0.1:{port}/api/defaults/diag/eval");
    let outcome = if on {
        ureq::put(&url)
            .send_json(serde_json::json!({"kind": "bool", "value": true}))
            .map(|r| r.status().as_u16())
    } else {
        ureq::delete(&url).call().map(|r| r.status().as_u16())
    };
    let status = match outcome {
        Ok(status) => status,
        // Deleting a key that was never set is "already closed", not a failure.
        Err(ureq::Error::StatusCode(404)) if !on => 404,
        Err(e) => return Err(format!("{url} failed: {e}")),
    };
    if status != 200 && status != 404 {
        return Err(format!("{url} returned status {status}"));
    }
    let state = if on { "enabled" } else { "disabled" };
    if json_output {
        println!(
            "{}",
            serde_json::json!({"status": "ok", "eval": state, "port": port})
        );
    } else {
        println!("eval {state} on port {port}");
    }
    Ok(0)
}

// ---------------------------------------------------------------------------
// Text rendering — one function per subcommand, over the raw result
// ---------------------------------------------------------------------------

/// A value whose shape the renderer does not recognize is printed whole
/// rather than silently dropped: the deck's reading is the ground truth, and
/// a renderer that has fallen behind it should say so by showing everything.
fn fallback(value: &serde_json::Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap());
}

fn render(cmd: &DeckMotionCommands, value: &serde_json::Value) {
    match cmd {
        DeckMotionCommands::List { .. } => render_list(value),
        DeckMotionCommands::Cost { .. } => render_cost(value),
        DeckMotionCommands::Layers { .. } => render_layers(value),
        DeckMotionCommands::Pause { .. } => render_count(value, "paused"),
        DeckMotionCommands::Resume { .. } => render_count(value, "resumed"),
        DeckMotionCommands::Bisect { .. } => render_bisect(value),
        DeckMotionCommands::Input { .. } => render_input(value),
        DeckMotionCommands::Probe { .. } => render_probe(value),
        DeckMotionCommands::Demote { .. } => fallback(value),
        DeckMotionCommands::Chains { mode, .. } => render_chains(mode, value),
        DeckMotionCommands::Enable { .. } | DeckMotionCommands::Disable { .. } => fallback(value),
    }
}

fn str_at<'a>(value: &'a serde_json::Value, key: &str) -> &'a str {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

fn num_at(value: &serde_json::Value, key: &str) -> f64 {
    value.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

fn joined(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|i| i.as_str().unwrap_or("?").to_string())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default()
}

fn render_list(value: &serde_json::Value) {
    let Some(entries) = value.get("entries").and_then(|e| e.as_array()) else {
        fallback(value);
        return;
    };
    println!(
        "{} animations, {} long-running",
        num_at(value, "total") as i64,
        num_at(value, "longRunning") as i64
    );
    for entry in entries {
        println!(
            "  {:<36} {:<10} {:<24} {}",
            str_at(entry, "name"),
            str_at(entry, "playState"),
            joined(entry, "properties"),
            str_at(entry, "target")
        );
        let violations = joined(entry, "violations");
        if !violations.is_empty() {
            println!("      violates: {violations}");
        }
    }
    if let Some(retained) = value.get("retainedTransitions") {
        let count = num_at(retained, "count") as i64;
        if count > 0 {
            println!(
                "  {count} retained transition(s): {}",
                joined(retained, "targets")
            );
        }
    }
}

fn render_cost(value: &serde_json::Value) {
    if value.get("p50").is_none() {
        fallback(value);
        return;
    }
    let burst = value
        .get("burst")
        .and_then(|b| b.as_array())
        .map(|b| b.len())
        .unwrap_or(0);
    println!(
        "render cost over {burst} frames: p50 {:.2} ms  p95 {:.2} ms  max {:.2} ms",
        num_at(value, "p50"),
        num_at(value, "p95"),
        num_at(value, "max")
    );
    if let Some(samples) = value.get("samples").and_then(|s| s.as_array())
        && !samples.is_empty()
    {
        let recent: Vec<String> = samples
            .iter()
            .map(|s| {
                format!(
                    "{:.2}{}",
                    num_at(s, "costMs"),
                    if s.get("inFlight").and_then(|f| f.as_bool()).unwrap_or(false) {
                        "*"
                    } else {
                        ""
                    }
                )
            })
            .collect();
        println!(
            "probe samples (* = a session was mid-turn): {}",
            recent.join(" ")
        );
    }
}

fn render_layers(value: &serde_json::Value) {
    if value.get("elements").is_none() {
        fallback(value);
        return;
    }
    println!(
        "{} elements, {} stacking contexts, {} render-layer candidates (upper bound)",
        num_at(value, "elements") as i64,
        num_at(value, "stackingContexts") as i64,
        num_at(value, "renderLayerCandidates") as i64
    );
    println!(
        "max depth {}, mean depth {:.1}, deepest stacking chain {}",
        num_at(value, "maxDepth") as i64,
        num_at(value, "meanDepth"),
        num_at(value, "maxStackingDepth") as i64
    );
    if let Some(histogram) = value.get("stackingHistogram").and_then(|h| h.as_array()) {
        for bucket in histogram.iter().take(10) {
            let Some(pair) = bucket.as_array() else {
                continue;
            };
            let name = pair.first().and_then(|n| n.as_str()).unwrap_or("?");
            let count = pair.get(1).and_then(|c| c.as_i64()).unwrap_or(0);
            println!("  {count:>6}  {name}");
        }
    }
}

/// The chain reading, ranked by the read that pays.
///
/// `arm` and `disarm` hand back only `{armed, cap}`, so they print one line and
/// say what the cap is — a truncated reading is a lower bound, and the reader
/// needs to know the ceiling before the gesture rather than after.
///
/// A `read` prints the ranked sites with their writing sites beneath, because
/// the read is the fixable end: the write is usually something the code must do,
/// and the read is what can move above it or batch with its peers. Each site is
/// a multi-line stack, indented so the ranking stays legible.
fn render_chains(mode: &str, value: &serde_json::Value) {
    if mode != "read" {
        match value.get("armed").and_then(|v| v.as_bool()) {
            Some(armed) => println!(
                "chains {}: cap {} entries",
                if armed { "armed" } else { "disarmed" },
                num_at(value, "cap") as i64
            ),
            None => fallback(value),
        }
        return;
    }
    let Some(ranked) = value.get("ranked").and_then(|r| r.as_array()) else {
        fallback(value);
        return;
    };
    println!(
        "{} chains over {} entries in {} tasks{}",
        num_at(value, "chains") as i64,
        num_at(value, "entries") as i64,
        num_at(value, "tasks") as i64,
        if value
            .get("truncated")
            .and_then(|t| t.as_bool())
            .unwrap_or(false)
        {
            " (TRUNCATED — a lower bound)"
        } else {
            ""
        }
    );
    for site in ranked.iter().take(10) {
        println!(
            "  {:>5} chains  [{}]",
            num_at(site, "chains") as i64,
            joined(site, "names")
        );
        for line in str_at(site, "site").lines() {
            println!("      read  {}", line.trim());
        }
        if let Some(writes) = site.get("writeSites").and_then(|w| w.as_array()) {
            for write in writes {
                let first = write
                    .as_str()
                    .unwrap_or("")
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                println!("      write {first}");
            }
        }
    }
}

fn render_count(value: &serde_json::Value, key: &str) {
    match value.get(key).and_then(|v| v.as_i64()) {
        Some(count) => println!("{count} animation(s) {key}"),
        None => fallback(value),
    }
}

fn render_bisect(value: &serde_json::Value) {
    let Some(groups) = value.get("groups").and_then(|g| g.as_array()) else {
        fallback(value);
        return;
    };
    println!(
        "baseline p50 {:.2} ms — read {} of {} group(s), guiltiest first",
        num_at(value, "baselineP50"),
        num_at(value, "groupsRead") as i64,
        num_at(value, "groupsFound") as i64
    );
    for group in groups {
        println!(
            "  {:>8.2} ms drop   paused p50 {:>6.2} ms   {:>4}×  {}",
            num_at(group, "drop"),
            num_at(group, "pausedP50"),
            num_at(group, "count") as i64,
            str_at(group, "name")
        );
    }
}

fn render_input(value: &serde_json::Value) {
    let Some(supported) = value.get("supported").and_then(|s| s.as_bool()) else {
        fallback(value);
        return;
    };
    if !supported {
        println!("this engine reports no `event` performance entries");
        return;
    }
    match value.get("p95").and_then(|p| p.as_f64()) {
        Some(p95) => println!("input-to-next-paint p95 {p95:.0} ms"),
        None => println!("input-to-next-paint: no entries yet"),
    }
    if let Some(entries) = value.get("entries").and_then(|e| e.as_array()) {
        for entry in entries.iter().rev().take(10) {
            println!(
                "  {:>6.0} ms  {}",
                num_at(entry, "duration"),
                str_at(entry, "name")
            );
        }
    }
}

fn render_probe(value: &serde_json::Value) {
    if value.get("armed").is_none() {
        fallback(value);
        return;
    }
    let armed = value
        .get("armed")
        .and_then(|a| a.as_bool())
        .unwrap_or(false);
    let demoted = value
        .get("demoted")
        .and_then(|d| d.as_bool())
        .unwrap_or(false);
    println!(
        "probe {}, {} motion hold(s), {} trip(s), demoted {}",
        if armed { "armed" } else { "disarmed" },
        num_at(value, "holds") as i64,
        num_at(value, "trips") as i64,
        if demoted { "yes" } else { "no" }
    );
    if let Some(samples) = value.get("samples").and_then(|s| s.as_array()) {
        let recent: Vec<String> = samples
            .iter()
            .map(|s| format!("{:.2}", num_at(s, "costMs")))
            .collect();
        if !recent.is_empty() {
            println!("recent samples: {}", recent.join(" "));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> DeckTarget {
        DeckTarget {
            port: None,
            instance: None,
        }
    }

    #[test]
    fn list_without_a_scope_takes_no_argument() {
        let cmd = DeckMotionCommands::List {
            within: None,
            target: target(),
        };
        assert_eq!(
            eval_code_for(&cmd).as_deref(),
            Some("window.__tugMotion.list()")
        );
    }

    #[test]
    fn list_with_a_scope_passes_it_as_within() {
        let cmd = DeckMotionCommands::List {
            within: Some(".tug-pane".to_string()),
            target: target(),
        };
        assert_eq!(
            eval_code_for(&cmd).as_deref(),
            Some(r#"window.__tugMotion.list({within: ".tug-pane"})"#)
        );
    }

    #[test]
    fn cost_carries_its_frame_count() {
        let cmd = DeckMotionCommands::Cost {
            frames: 45,
            target: target(),
        };
        assert_eq!(
            eval_code_for(&cmd).as_deref(),
            Some("window.__tugMotion.cost(45)")
        );
    }

    #[test]
    fn layers_input_and_probe_take_no_arguments() {
        assert_eq!(
            eval_code_for(&DeckMotionCommands::Layers { target: target() }).as_deref(),
            Some("window.__tugMotion.layers()")
        );
        assert_eq!(
            eval_code_for(&DeckMotionCommands::Input { target: target() }).as_deref(),
            Some("window.__tugMotion.input()")
        );
        assert_eq!(
            eval_code_for(&DeckMotionCommands::Probe { target: target() }).as_deref(),
            Some("window.__tugMotion.probe()")
        );
    }

    /// One case per mode, because the mode is the whole of what `chains`
    /// carries and a verb that armed when it was asked to read would restore
    /// nothing and report an empty log as a clean deck.
    #[test]
    fn chains_carries_its_mode() {
        for mode in ["arm", "read", "disarm"] {
            let cmd = DeckMotionCommands::Chains {
                mode: mode.to_string(),
                target: target(),
            };
            assert_eq!(
                eval_code_for(&cmd).as_deref(),
                Some(format!(r#"window.__tugMotion.chains("{mode}")"#).as_str())
            );
        }
    }

    /// The case the JSON encoding exists for. An attribute selector is the
    /// ordinary way to name one card's glyphs, and interpolating it raw would
    /// close the string literal three characters early and hand the page a
    /// syntax error instead of a reading.
    #[test]
    fn a_selector_carrying_quotes_survives_encoding() {
        let cmd = DeckMotionCommands::Pause {
            selector: r#"a[data-x="1"]"#.to_string(),
            target: target(),
        };
        assert_eq!(
            eval_code_for(&cmd).as_deref(),
            Some(r#"window.__tugMotion.pause("a[data-x=\"1\"]")"#)
        );
    }

    #[test]
    fn resume_takes_the_same_selector_treatment() {
        let cmd = DeckMotionCommands::Resume {
            selector: ".tug-progress-pulsing-dot-dot".to_string(),
            target: target(),
        };
        assert_eq!(
            eval_code_for(&cmd).as_deref(),
            Some(r#"window.__tugMotion.resume(".tug-progress-pulsing-dot-dot")"#)
        );
    }

    #[test]
    fn bisect_omits_options_it_was_not_given() {
        let bare = DeckMotionCommands::Bisect {
            frames: None,
            cap: None,
            target: target(),
        };
        assert_eq!(
            eval_code_for(&bare).as_deref(),
            Some("window.__tugMotion.bisect()")
        );
        let capped = DeckMotionCommands::Bisect {
            frames: Some(10),
            cap: Some(4),
            target: target(),
        };
        assert_eq!(
            eval_code_for(&capped).as_deref(),
            Some("window.__tugMotion.bisect({frames: 10, cap: 4})")
        );
    }

    #[test]
    fn demote_sends_a_boolean_rather_than_the_word() {
        let on = DeckMotionCommands::Demote {
            state: "on".to_string(),
            target: target(),
        };
        let off = DeckMotionCommands::Demote {
            state: "off".to_string(),
            target: target(),
        };
        assert_eq!(
            eval_code_for(&on).as_deref(),
            Some("window.__tugMotion.demote(true)")
        );
        assert_eq!(
            eval_code_for(&off).as_deref(),
            Some("window.__tugMotion.demote(false)")
        );
    }

    #[test]
    fn enable_and_disable_evaluate_nothing() {
        assert!(eval_code_for(&DeckMotionCommands::Enable { target: target() }).is_none());
        assert!(eval_code_for(&DeckMotionCommands::Disable { target: target() }).is_none());
    }

    /// A remedy that does not name the command that fixes it is a dead end:
    /// the user reads "gated" and has nowhere to go.
    #[test]
    fn the_gated_remedy_names_the_command_that_opens_the_door() {
        assert!(EVAL_GATED_REMEDY.contains("tugtool deck motion enable"));
        assert!(EVAL_GATED_REMEDY.contains("disable"));
    }
}
