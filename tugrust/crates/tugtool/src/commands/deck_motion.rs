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
//! `bisect` pauses every long-running loop, measures the floor, then wakes one
//! family at a time — every animation of a figure, split by whether the figure
//! is on screen — measures the frame with only that family running, and sorts
//! by the price above the floor. The family whose presence alone raises the
//! cost is the one paying for the compositing walk — named in seconds, on the
//! build in front of the user, rather than by elimination over the source. It
//! is bounded so it finishes inside `eval_handler`'s thirty-second ceiling.
//!
//! ## Exit codes
//!
//! `0` on a reading, `2` when the instance's eval door is shut (with the
//! remedy printed), `1` for everything else.

use crate::changes::AppError;
use crate::cli::{DeckEvalTarget, DeckMotionCommands, DeckTarget};
use crate::commands::tell::{Remedy, resolve_port};
use crate::output::{print_error, print_ok};

/// What a 403 from `/api/eval` means, and the one command that fixes it.
pub const EVAL_GATED_REMEDY: &str = "eval is gated on this instance — run 'tugtool deck motion enable' (loopback only; 'disable' revokes it)";

/// Exit code for a shut eval door. Distinct from 1 so a script can tell
/// "not allowed to ask" from "asked and it went wrong".
pub(crate) const EXIT_GATED: i32 = 2;

/// Report a shut eval door and return [`EXIT_GATED`]: the remedy on stderr,
/// or under `--json` the error envelope carrying it as `eval_gated`.
pub(crate) fn eval_gated(command: &str, json_output: bool) -> i32 {
    if json_output {
        print_error(
            command,
            &AppError::Exit2("eval_gated", EVAL_GATED_REMEDY.to_string()),
        );
    } else {
        eprintln!("{EVAL_GATED_REMEDY}");
    }
    EXIT_GATED
}

/// The name a `deck motion` verb's envelope carries in `command`.
pub fn command_name(cmd: &DeckMotionCommands) -> &'static str {
    match cmd {
        DeckMotionCommands::List { .. } => "deck motion list",
        DeckMotionCommands::Cost { .. } => "deck motion cost",
        DeckMotionCommands::Rest { .. } => "deck motion rest",
        DeckMotionCommands::Layers { .. } => "deck motion layers",
        DeckMotionCommands::Pause { .. } => "deck motion pause",
        DeckMotionCommands::Resume { .. } => "deck motion resume",
        DeckMotionCommands::Bisect { .. } => "deck motion bisect",
        DeckMotionCommands::Input { .. } => "deck motion input",
        DeckMotionCommands::Probe { .. } => "deck motion probe",
        DeckMotionCommands::Gaps { .. } => "deck motion gaps",
        DeckMotionCommands::Frames { .. } => "deck motion frames",
        DeckMotionCommands::Demote { .. } => "deck motion demote",
        DeckMotionCommands::Record { .. } => "deck motion record",
        DeckMotionCommands::Chains { .. } => "deck motion chains",
        DeckMotionCommands::Gesture { .. } => "deck motion gesture",
        DeckMotionCommands::Slide { .. } => "deck motion slide",
        DeckMotionCommands::Settle { .. } => "deck motion settle",
        DeckMotionCommands::Walk { .. } => "deck motion walk",
        DeckMotionCommands::Enable { .. } => "deck motion enable",
        DeckMotionCommands::Disable { .. } => "deck motion disable",
    }
}

/// How long an armed gesture chain runs before it stops itself, in ms.
///
/// It has to span an arm, a gesture somebody sends AFTERWARDS, and that
/// gesture's land — arming first is the whole point, so the window is sized for
/// a human or a second `tugtool` invocation in between rather than for the
/// ~270ms motion. Mirrors `GESTURE_WINDOW_DEFAULT_MS` in
/// `gesture-frame-probe.ts`; the shell supplies it explicitly so the generated
/// call always carries the cap.
const GESTURE_WINDOW_DEFAULT_MS: u32 = 8000;

/// How long `frames` watches when it is not told. Mirrors
/// `HOST_FRAMES_WINDOW_DEFAULT_MS` in `host-frames.ts`; the shell supplies it
/// explicitly so the generated call always carries the window.
const HOST_FRAMES_WINDOW_DEFAULT_MS: u32 = 2000;

/// The `window.__tugMotion` call each reading subcommand posts.
///
/// Pure, and unit-tested against the plan's subcommand table. The selector is
/// JSON-encoded rather than interpolated raw, so a selector carrying quotes —
/// `a[data-x="1"]`, the ordinary shape for anything attribute-matched —
/// survives the round trip instead of terminating the string literal early.
///
/// Returns `None` for `enable` and `disable`, which are defaults writes rather
/// than evaluations, and for `slide` and `walk`, which post many calls of
/// their own (`deck_motion_slide.rs`, `deck_motion_walk.rs`).
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
        DeckMotionCommands::Rest { window, .. } => match window {
            Some(window) => format!("window.__tugMotion.rest({window})"),
            None => "window.__tugMotion.rest()".to_string(),
        },
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
        DeckMotionCommands::Gaps { .. } => "window.__tugMotion.gaps()".to_string(),
        DeckMotionCommands::Frames { window, .. } => format!(
            "window.__tugMotion.hostFrames({})",
            window.unwrap_or(HOST_FRAMES_WINDOW_DEFAULT_MS)
        ),
        DeckMotionCommands::Demote { state, .. } => {
            format!("window.__tugMotion.demote({})", state == "on")
        }
        DeckMotionCommands::Record { state, .. } => match state.as_deref() {
            Some(state) => format!("window.__tugMotion.record({})", state == "on"),
            None => "window.__tugMotion.record()".to_string(),
        },
        DeckMotionCommands::Chains {
            mode, no_stacks, ..
        } => {
            if *no_stacks && mode == "arm" {
                format!(
                    r#"window.__tugMotion.chains({}, {{"stacks": false}})"#,
                    json(mode)
                )
            } else {
                format!("window.__tugMotion.chains({})", json(mode))
            }
        }
        // The window rides EVERY mode, not just `arm`. A call that carried the
        // mode alone would be indistinguishable from one that silently dropped
        // the cap, and the cap is what keeps a forgotten `read` from leaving a
        // loop running at rest.
        DeckMotionCommands::Gesture { mode, window, .. } => format!(
            "window.__tugMotion.gesture({}, {})",
            json(mode),
            window.unwrap_or(GESTURE_WINDOW_DEFAULT_MS)
        ),
        DeckMotionCommands::Enable { .. }
        | DeckMotionCommands::Disable { .. }
        | DeckMotionCommands::Slide { .. }
        | DeckMotionCommands::Settle { .. }
        | DeckMotionCommands::Walk { .. } => return None,
    })
}

/// Where an eval goes: the deck's tugcast port, and the card whose body page
/// evaluates, or `None` for the shell.
#[derive(Debug, Clone, Copy)]
pub(crate) struct EvalDoor<'a> {
    pub port: u16,
    pub card: Option<&'a str>,
}

impl EvalDoor<'_> {
    /// The shell of the deck on `port`.
    pub(crate) fn shell(port: u16) -> EvalDoor<'static> {
        EvalDoor { port, card: None }
    }
}

/// The `--port` / `--instance` pair each subcommand carries, and the
/// `--card` of a verb that evaluates in a chosen page.
fn target_of(cmd: &DeckMotionCommands) -> (&DeckTarget, Option<&str>) {
    fn eval(t: &DeckEvalTarget) -> (&DeckTarget, Option<&str>) {
        (&t.target, t.card.as_deref())
    }
    match cmd {
        DeckMotionCommands::List { target, .. }
        | DeckMotionCommands::Cost { target, .. }
        | DeckMotionCommands::Rest { target, .. }
        | DeckMotionCommands::Layers { target }
        | DeckMotionCommands::Pause { target, .. }
        | DeckMotionCommands::Resume { target, .. }
        | DeckMotionCommands::Bisect { target, .. }
        | DeckMotionCommands::Input { target }
        | DeckMotionCommands::Probe { target }
        | DeckMotionCommands::Gaps { target }
        | DeckMotionCommands::Demote { target, .. }
        | DeckMotionCommands::Record { target, .. }
        | DeckMotionCommands::Chains { target, .. }
        | DeckMotionCommands::Gesture { target, .. }
        | DeckMotionCommands::Slide { target, .. }
        | DeckMotionCommands::Walk { target, .. } => eval(target),
        DeckMotionCommands::Settle { target, .. }
        | DeckMotionCommands::Frames { target, .. }
        | DeckMotionCommands::Enable { target }
        | DeckMotionCommands::Disable { target } => (target, None),
    }
}

pub fn run_deck_motion(cmd: DeckMotionCommands, json_output: bool) -> Result<i32, String> {
    let (target, card) = target_of(&cmd);
    let card: Option<String> = card.map(str::to_owned);
    // Strict ambiguity: the verb reads one specific deck, and a reading taken
    // from a different instance than the one the user is looking at is worse
    // than no reading at all.
    let port = resolve_port(target.port, target.instance.clone())
        .map_err(|e| e.describe(Remedy::Flags))?;
    let door = EvalDoor {
        port,
        card: card.as_deref(),
    };

    match cmd {
        DeckMotionCommands::Enable { .. } => set_eval_opt_in(port, true, json_output),
        DeckMotionCommands::Disable { .. } => set_eval_opt_in(port, false, json_output),
        DeckMotionCommands::Record { state, reload, .. } => {
            run_record(door, state.as_deref(), reload, json_output)
        }
        DeckMotionCommands::Rest {
            window,
            frame_phases: true,
            ..
        } => run_rest_phases(door, window, json_output),
        DeckMotionCommands::Slide {
            from,
            to,
            count,
            sample,
            queries,
            tasks,
            full_census,
            ..
        } => crate::commands::deck_motion_slide::run_slide(
            door,
            &from,
            &to,
            count,
            sample,
            queries,
            tasks,
            full_census,
            json_output,
        ),
        DeckMotionCommands::Settle {
            gesture,
            card,
            pane,
            slot,
            mode,
            space,
            component,
            count,
            tasks,
            chains,
            sample,
            frame_phases,
            streaming,
            quiet_instruments,
            full_census,
            ..
        } => crate::commands::deck_motion_settle::run_settle(
            EvalDoor::shell(port),
            &gesture,
            crate::commands::deck_motion_settle::GestureArgs {
                card,
                pane,
                slot,
                mode,
                space,
                component,
            },
            count,
            tasks,
            chains,
            sample,
            frame_phases,
            streaming,
            crate::commands::deck_motion_settle::Quiet {
                instruments: quiet_instruments,
                full_census,
            },
            json_output,
        ),
        DeckMotionCommands::Walk { restore: true, .. } => {
            crate::commands::deck_motion_walk::run_restore(door, json_output)
        }
        DeckMotionCommands::Walk {
            arms,
            rounds,
            frames,
            driver,
            ..
        } => {
            let arms: Vec<_> = arms
                .iter()
                .map(|a| {
                    crate::commands::deck_motion_walk::WalkArm::parse(a)
                        .expect("clap admits only arm names")
                })
                .collect();
            crate::commands::deck_motion_walk::run_walk(
                door,
                &arms,
                rounds,
                frames,
                &driver,
                json_output,
            )
        }
        other => {
            let command = command_name(&other);
            let code = eval_code_for(&other).expect("only enable/disable have no eval code");
            let result = match post_eval(port, door.card, &code)? {
                EvalOutcome::Gated => return Ok(eval_gated(command, json_output)),
                EvalOutcome::Ok(value) => value,
            };
            if json_output {
                print_ok(command, &result);
            } else {
                render(&other, &result);
            }
            Ok(0)
        }
    }
}

pub(crate) enum EvalOutcome {
    Ok(serde_json::Value),
    Gated,
}

/// Post `code` to the deck's `/api/eval`. With a `card` it is evaluated in that
/// card's body page; without one, in the shell.
pub(crate) fn post_eval(port: u16, card: Option<&str>, code: &str) -> Result<EvalOutcome, String> {
    let url = format!("http://127.0.0.1:{port}/api/eval");
    let mut body = serde_json::json!({ "code": code });
    if let Some(card) = card {
        body["card"] = card.into();
    }
    let response = ureq::post(&url).send_json(body);
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
        print_ok(
            if on {
                "deck motion enable"
            } else {
                "deck motion disable"
            },
            serde_json::json!({"eval": state, "port": port}),
        );
    } else {
        println!("eval {state} on port {port}");
    }
    Ok(0)
}

/// `rest --frame-phases`: the rest window, recorded with the Time Profiler and
/// filed by the rest chain's own stamps.
fn run_rest_phases(
    door: EvalDoor<'_>,
    window: Option<u32>,
    json_output: bool,
) -> Result<i32, String> {
    use crate::commands::deck_motion_phases as phases;
    let Some(xctrace) = phases::xctrace() else {
        eprintln!("frame-phases needs xcrun xctrace (Xcode's Instruments); not found");
        return Ok(EXIT_GATED);
    };
    let pid = phases::deck_web_content(door.port)?;
    // A generous ceiling: the reading stops the recording itself.
    let seconds = window.unwrap_or(1000).div_ceil(1000) + 30;
    if !json_output {
        eprintln!("recording WebContent {pid} with xctrace's Time Profiler");
    }
    let recorder = phases::record(&xctrace, pid, seconds)?;
    let code = match window {
        Some(window) => format!("window.__tugMotion.rest({window}, {{stamps: true}})"),
        None => "window.__tugMotion.rest(undefined, {stamps: true})".to_string(),
    };
    let wall = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    };
    let sent = wall();
    let outcome = post_eval(door.port, door.card, &code);
    let answered = wall();
    let rss_kb = phases::resident_kb(pid);
    let (_, samples) = recorder.finish()?;
    let mut value = match outcome? {
        EvalOutcome::Gated => return Ok(eval_gated("deck motion rest", json_output)),
        EvalOutcome::Ok(value) => value,
    };
    let stamps: Option<Vec<f64>> = value
        .get("stamps")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    // A page that predates the stamps is filed as one row, from the request
    // to its answer on the wall clock: the window plus the eval's round trip,
    // with no stall rows.
    let (stamps, t0, filed_by) = match (stamps, value.get("t0Epoch").and_then(|v| v.as_f64())) {
        (Some(stamps), Some(t0)) => (stamps, t0, "the rest chain's stamps"),
        _ => (
            vec![answered - sent],
            sent,
            "the wall clock around the eval (this page hands back no stamps)",
        ),
    };
    let mut rp = phases::rest_phases(&samples, &stamps, t0, num_at(&value, "floorMs"));
    rp.rss_kb = rss_kb;
    if let Some(object) = value.as_object_mut() {
        object.remove("stamps");
    }
    if json_output {
        print_ok(
            "deck motion rest",
            serde_json::json!({"rest": value, "frame_phases": rp, "filed_by": filed_by}),
        );
    } else {
        println!(
            "note: the Time Profiler stops WebContent every 1 ms to read its stack, so the count below is perturbed — take it from a run without --frame-phases"
        );
        render_rest(&value);
        println!("filed by {filed_by}");
        print!("{}", phases::print_rest_phases(&rp));
    }
    Ok(0)
}

/// How long a reloaded deck is given to come back recording.
const RECORD_RELOAD_WAIT_S: u64 = 90;

/// `record`: throw the deck's switch, and with `--reload` bring in what only a
/// load can install, then report.
fn run_record(
    door: EvalDoor<'_>,
    state: Option<&str>,
    reload: bool,
    json_output: bool,
) -> Result<i32, String> {
    let code = match state {
        Some(state) => format!("window.__tugMotion.record({})", state == "on"),
        None => "window.__tugMotion.record()".to_string(),
    };
    let mut value = match post_eval(door.port, door.card, &code)? {
        EvalOutcome::Gated => return Ok(eval_gated("deck motion record", json_output)),
        EvalOutcome::Ok(value) => value,
    };
    let waiting = !record_next_load(&value).is_empty();
    if reload && state == Some("on") && waiting {
        if !json_output {
            eprintln!(
                "reloading the deck to install {} (a relaunch sheds it)",
                record_next_load(&value).join(" and ")
            );
        }
        // The reload can take the reply with it; what matters is what comes back.
        let _ = post_eval(
            door.port,
            door.card,
            "(setTimeout(function () { window.location.reload(); }, 50), null)",
        );
        let mut back = None;
        for _ in 0..RECORD_RELOAD_WAIT_S {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if let Ok(EvalOutcome::Ok(v)) =
                post_eval(door.port, door.card, "window.__tugMotion.record()")
                && v.get("recording").and_then(|r| r.as_bool()) == Some(true)
                && record_next_load(&v).is_empty()
            {
                back = Some(v);
                break;
            }
        }
        value = back.ok_or_else(|| {
            format!("the deck did not come back recording within {RECORD_RELOAD_WAIT_S} s")
        })?;
    }
    if json_output {
        print_ok("deck motion record", &value);
    } else {
        println!("{}", record_summary(&value));
    }
    Ok(0)
}

/// What the switch says waits on the next load.
fn record_next_load(value: &serde_json::Value) -> Vec<String> {
    value
        .get("nextLoad")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The switch's reading, as one line.
pub fn record_summary(value: &serde_json::Value) -> String {
    let flag = |key: &str| value.get(key).and_then(|v| v.as_bool()) == Some(true);
    if !flag("recording") {
        return "motion recording off".to_string();
    }
    let kinds: Vec<&str> = value
        .get("kinds")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str()).collect())
        .unwrap_or_default();
    let census = if flag("census") {
        "commit census walking"
    } else {
        "no commit census"
    };
    let lead = if flag("leadRecorder") {
        "lead recorder in the page"
    } else {
        "no lead recorder"
    };
    let next = record_next_load(value);
    let next = if next.is_empty() {
        String::new()
    } else {
        format!(
            "; {} on the next load ('--reload' brings it now)",
            next.join(" and ")
        )
    };
    format!(
        "motion recording on: {} kind(s) ({}); {census}; {lead}{next}",
        kinds.len(),
        kinds.join(", ")
    )
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
        DeckMotionCommands::Rest { .. } => render_rest(value),
        DeckMotionCommands::Layers { .. } => render_layers(value),
        DeckMotionCommands::Pause { .. } => render_count(value, "paused"),
        DeckMotionCommands::Resume { .. } => render_count(value, "resumed"),
        DeckMotionCommands::Bisect { .. } => render_bisect(value),
        DeckMotionCommands::Input { .. } => render_input(value),
        DeckMotionCommands::Probe { .. } => render_probe(value),
        DeckMotionCommands::Gaps { .. } => match gaps_text(value) {
            Some(text) => print!("{text}"),
            None => fallback(value),
        },
        DeckMotionCommands::Frames { .. } => match frames_text(value) {
            Some(text) => print!("{text}"),
            None => fallback(value),
        },
        DeckMotionCommands::Demote { .. } => fallback(value),
        DeckMotionCommands::Record { .. } => println!("{}", record_summary(value)),
        DeckMotionCommands::Chains { mode, .. } => render_chains(mode, value),
        DeckMotionCommands::Gesture { mode, .. } => render_gesture(mode, value),
        DeckMotionCommands::Enable { .. }
        | DeckMotionCommands::Disable { .. }
        | DeckMotionCommands::Slide { .. }
        | DeckMotionCommands::Settle { .. }
        | DeckMotionCommands::Walk { .. } => fallback(value),
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
    if let Some(rest) = value.get("rest") {
        render_rest(rest);
    }
    if let Some(samples) = value.get("samples").and_then(|s| s.as_array())
        && !samples.is_empty()
    {
        let recent: Vec<String> = samples
            .iter()
            .map(|s| {
                format!(
                    "{:.2}/{}{}",
                    num_at(s, "costMs"),
                    num_at(s, "updatesPerSecond") as i64,
                    if s.get("inFlight").and_then(|f| f.as_bool()).unwrap_or(false) {
                        "*"
                    } else {
                        ""
                    }
                )
            })
            .collect();
        println!(
            "probe samples as cost ms/updates per s (* = a session was mid-turn): {}",
            recent.join(" ")
        );
    }
}

/// The at-rest reading: how many updates a second held the main thread past
/// the floor, and for how long in total. Zero is the doctrine's invariant, and
/// the display rate is a loop that never left the main thread.
fn render_rest(value: &serde_json::Value) {
    if value.get("updatesPerSecond").is_none() {
        fallback(value);
        return;
    }
    println!(
        "at rest: {} update(s)/s over a {:.0} ms floor, holding the main thread {} ms/s (window {:.0} ms, {} ticks, median gap {:.0} ms, worst {:.0} ms)",
        num_at(value, "updatesPerSecond") as i64,
        num_at(value, "floorMs"),
        num_at(value, "busyMsPerSecond") as i64,
        num_at(value, "windowMs"),
        num_at(value, "ticks") as i64,
        num_at(value, "medianGapMs"),
        num_at(value, "maxGapMs")
    );
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
    match chains_text(mode, value) {
        Some(text) => print!("{text}"),
        None => fallback(value),
    }
}

/// The text [`render_chains`] prints, or `None` for a value it cannot read.
///
/// Each site carries its summed ms beside its chain count, and the summary
/// names the longest chain and the total: a count says how often a site paid,
/// and only the ms say what it cost.
pub(crate) fn chains_text(mode: &str, value: &serde_json::Value) -> Option<String> {
    use std::fmt::Write as _;
    let mut out = String::new();
    if mode != "read" {
        let armed = value.get("armed").and_then(|v| v.as_bool())?;
        let stackless = armed && value.get("stacks").and_then(|v| v.as_bool()) == Some(false);
        let _ = writeln!(
            out,
            "chains {}: cap {} entries{}",
            if armed { "armed" } else { "disarmed" },
            num_at(value, "cap") as i64,
            if stackless { ", no stacks" } else { "" }
        );
        return Some(out);
    }
    let ranked = value.get("ranked").and_then(|r| r.as_array())?;
    let _ = writeln!(
        out,
        "{} chains over {} entries in {} tasks (longest {:.1} ms, total {:.1} ms){}",
        num_at(value, "chains") as i64,
        num_at(value, "entries") as i64,
        num_at(value, "tasks") as i64,
        num_at(value, "longestChainMs"),
        num_at(value, "totalChainMs"),
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
        let _ = writeln!(
            out,
            "  {:>5} chains  {:>7.1} ms  [{}]",
            num_at(site, "chains") as i64,
            num_at(site, "ms"),
            joined(site, "names")
        );
        // The names first: a rebuilt app moves every minified position, and
        // the bundle keeps its function names.
        if let Some(functions) = site.get("functions").and_then(|f| f.as_array())
            && !functions.is_empty()
        {
            let names: Vec<&str> = functions.iter().filter_map(|f| f.as_str()).collect();
            let _ = writeln!(out, "      in    {}", names.join(" ← "));
        }
        for line in str_at(site, "site").lines() {
            let _ = writeln!(out, "      read  {}", line.trim());
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
                let _ = writeln!(out, "      write {first}");
            }
        }
    }
    // The reads that paid, chained or not: at rest, where nothing chains,
    // these are the readers a forced layout is paid by.
    if let Some(paid) = value.get("paid").and_then(|p| p.as_array())
        && !paid.is_empty()
    {
        let _ = writeln!(out, "reads that paid for a layout, by site:");
        for site in paid {
            let _ = writeln!(
                out,
                "  {:>5} reads   {:>7.1} ms  [{}]",
                num_at(site, "reads") as i64,
                num_at(site, "ms"),
                joined(site, "names")
            );
            if let Some(functions) = site.get("functions").and_then(|f| f.as_array())
                && !functions.is_empty()
            {
                let names: Vec<&str> = functions.iter().filter_map(|f| f.as_str()).collect();
                let _ = writeln!(out, "      in    {}", names.join(" ← "));
            }
        }
    }
    Some(out)
}

/// The gesture recorder's reading.
///
/// A `read` prints the GAP SERIES IN FULL, and that is the point rather than a
/// courtesy: the shape `120 59 11 12 14 17 …` is the evidence, and a summary
/// that reported only the worst number would leave a reader unable to tell one
/// long freeze from a run of small ones. The gesture's own gap is marked in
/// place, so the number under study is readable without counting.
///
/// A reading with no stamp says so rather than printing a `-1` nobody can
/// interpret: the recorder is armed before the gesture, so "no gesture was
/// recorded" means the fold never happened inside the window, which is a fact
/// about the procedure rather than about the deck.
fn render_gesture(mode: &str, value: &serde_json::Value) {
    if mode != "read" {
        match value.get("armed").and_then(|v| v.as_bool()) {
            Some(armed) => println!(
                "gesture {}: window {}ms",
                if armed { "armed" } else { "disarmed" },
                num_at(value, "windowMs") as i64
            ),
            None => fallback(value),
        }
        return;
    }
    let Some(gaps) = value.get("gaps").and_then(|g| g.as_array()) else {
        fallback(value);
        return;
    };
    let ticks = num_at(value, "ticks") as i64;
    let period = num_at(value, "framePeriodMs");
    // The mode goes above every other number. A gesture is read at one display
    // mode and compared against the same gesture at another, and a series
    // labelled with the wrong mode is worse than no reading at all.
    if let Some(display) = value.get("display") {
        println!(
            "display {}x{} @{}x",
            num_at(display, "widthPx") as i64,
            num_at(display, "heightPx") as i64,
            num_at(display, "devicePixelRatio")
        );
    }
    if value
        .get("suspended")
        .and_then(|s| s.as_bool())
        .unwrap_or(false)
    {
        println!(
            "gesture SUSPENDED: {ticks} ticks — the window was not being served, \
             and the numbers below say nothing about the deck"
        );
    }
    let index = value
        .get("gestureGapIndex")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let gesture_gap = num_at(value, "gestureGapMs");
    if index < 0 {
        println!(
            "gesture NOT RECORDED: no gesture stamp landed inside the series — \
             {ticks} ticks at {period:.1}ms. Arm, then gesture, then read"
        );
    } else {
        println!(
            "gesture gap {gesture_gap:.0}ms ({:.2} frames) at index {index} of {ticks} ticks \
             at {period:.1}ms",
            if period > 0.0 {
                gesture_gap / period
            } else {
                0.0
            }
        );
    }
    println!(
        "  worst {:.0}ms, {} gap(s) over one frame{}",
        num_at(value, "longestGapMs"),
        num_at(value, "gapsOverOneFrame") as i64,
        if value
            .get("running")
            .and_then(|r| r.as_bool())
            .unwrap_or(false)
        {
            " (chain still running — the series is not final)"
        } else {
            ""
        }
    );
    let series: Vec<String> = gaps
        .iter()
        .enumerate()
        .map(|(i, gap)| {
            let ms = gap.as_f64().unwrap_or(0.0);
            if i as i64 == index {
                format!("[{ms:.0}]")
            } else {
                format!("{ms:.0}")
            }
        })
        .collect();
    println!("  {}", series.join(" "));
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
        "everything running p50 {:.2} ms, everything paused p50 {:.2} ms — read {} of {} family(ies), guiltiest first",
        num_at(value, "baselineP50"),
        num_at(value, "floorP50"),
        num_at(value, "groupsRead") as i64,
        num_at(value, "groupsFound") as i64
    );
    for group in groups {
        println!(
            "  {:>8.2} ms price   alone p50 {:>6.2} ms   {:>4}× in {:>4} figure(s)  {} ({})",
            num_at(group, "price"),
            num_at(group, "aloneP50"),
            num_at(group, "count") as i64,
            num_at(group, "figures") as i64,
            str_at(group, "name"),
            str_at(group, "placement")
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
        "probe {}, {} motion hold(s), demoted {}",
        if armed { "armed" } else { "disarmed" },
        num_at(value, "holds") as i64,
        if demoted { "yes" } else { "no" }
    );
    if let Some(samples) = value.get("samples").and_then(|s| s.as_array()) {
        let recent: Vec<String> = samples
            .iter()
            .map(|s| {
                format!(
                    "{:.2}/{}",
                    num_at(s, "costMs"),
                    num_at(s, "updatesPerSecond") as i64
                )
            })
            .collect();
        if !recent.is_empty() {
            println!(
                "recent samples as cost ms/updates per s: {}",
                recent.join(" ")
            );
        }
    }
}

/// The text `gaps` prints, or `None` for a value it cannot read: a count, the
/// two classes summed apart — judders inside the motion, which the one-period
/// bar is read over, and gaps the set-up ended in, which are the lead's budget
/// — then one line per late frame, newest first, with both beats and how long
/// ago it was. A row with no class (a deck older than the two-beat row) counts
/// as a judder, so an old deck's reading never passes a bar it would not have.
pub(crate) fn gaps_text(value: &serde_json::Value) -> Option<String> {
    let rows = value.get("rows")?.as_array()?;
    let now = value.get("now")?.as_f64()?;
    if rows.is_empty() {
        return Some("no late frames recorded inside a settle\n".to_string());
    }
    let is_lead = |row: &serde_json::Value| str_at(row, "class") == "lead";
    let (lead, judder): (Vec<&serde_json::Value>, Vec<&serde_json::Value>) =
        rows.iter().partition(|row| is_lead(row));
    // Folded from +0.0: an empty `sum::<f64>()` is -0.0, which prints as "-0.0 ms".
    let sum = |rows: &[&serde_json::Value]| {
        rows.iter()
            .map(|r| num_at(r, "gapMs"))
            .fold(0.0, |a, b| a + b)
    };
    // A deck older than the two-beat row records one `beat`, the one in force
    // when the late frame arrived; its start is unknown.
    let legacy =
        |row: &serde_json::Value| row.get("startBeat").is_none() && row.get("beat").is_some();
    let mut text = format!("{} late frame(s) recorded inside a settle\n", rows.len());
    let worst = judder
        .iter()
        .max_by(|a, b| num_at(a, "gapMs").total_cmp(&num_at(b, "gapMs")));
    match worst {
        Some(row) => {
            let period = num_at(row, "periodMs");
            let frames = if period > 0.0 {
                num_at(row, "gapMs") / period
            } else {
                0.0
            };
            text.push_str(&format!(
                "  judder (the one-period bar): {} over, {:.1} ms in all, worst {:.1} ms ({:.1} frames)\n",
                judder.len(),
                sum(&judder),
                num_at(row, "gapMs"),
                frames,
            ));
        }
        None => text.push_str("  judder (the one-period bar): none\n"),
    }
    text.push_str(&format!(
        "  lead (the set-up's budget):   {} gap(s), {:.1} ms in all\n",
        lead.len(),
        sum(&lead),
    ));
    let older = rows.iter().filter(|row| legacy(row)).count();
    if older > 0 {
        text.push_str(&format!(
            "  {older} row(s) from a deck older than the two-beat row: only the beat at the late frame is known, so each reads as a judder\n",
        ));
    }
    for row in rows.iter().rev() {
        let gap = num_at(row, "gapMs");
        let period = num_at(row, "periodMs");
        let frames = if period > 0.0 { gap / period } else { 0.0 };
        let class = if is_lead(row) { "lead" } else { "judder" };
        let beats = if legacy(row) {
            format!("?→{}", str_at(row, "beat"))
        } else {
            format!("{}→{}", str_at(row, "startBeat"), str_at(row, "endBeat"))
        };
        text.push_str(&format!(
            "  {:>7.1} s ago  {:>6.1} ms ({:.1} frames)  {:<6} {:<16} +{:.0} ms into the window\n",
            (now - num_at(row, "at")) / 1000.0,
            gap,
            frames,
            class,
            beats,
            num_at(row, "offsetMs"),
        ));
    }
    Some(text)
}

/// The text `frames` prints, or `None` for a value it cannot read: ticks
/// against the ticks the window should have held, the frames missed, and the
/// worst gap in periods, then one line per gap over the period.
pub(crate) fn frames_text(value: &serde_json::Value) -> Option<String> {
    let period = value.get("periodMs")?.as_f64()?;
    let ticks = value.get("ticks")?.as_f64()?;
    let expected = value.get("expectedTicks")?.as_f64()?;
    let worst = num_at(value, "worstGapMs");
    let periods = |ms: f64| if period > 0.0 { ms / period } else { 0.0 };
    let mut text = format!(
        "{}/{} ticks at {:.2} ms, {} missed, worst gap {:.1} ms ({:.1} periods)\n",
        ticks as i64,
        expected as i64,
        period,
        num_at(value, "missed") as i64,
        worst,
        periods(worst),
    );
    if let Some(gaps) = value.get("gapsOverPeriod").and_then(|g| g.as_array()) {
        for gap in gaps {
            let ms = num_at(gap, "gapMs");
            text.push_str(&format!(
                "  +{:>6.0} ms  {:>6.1} ms ({:.1} periods)\n",
                num_at(gap, "atMs"),
                ms,
                periods(ms),
            ));
        }
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No port, no instance and no card: a `DeckTarget` or a
    /// `DeckEvalTarget`, whichever the verb takes.
    fn target<T: Default>() -> T {
        T::default()
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
    fn rest_omits_a_window_it_was_not_given() {
        let bare = DeckMotionCommands::Rest {
            window: None,
            frame_phases: false,
            target: target(),
        };
        assert_eq!(
            eval_code_for(&bare).as_deref(),
            Some("window.__tugMotion.rest()")
        );
        let windowed = DeckMotionCommands::Rest {
            window: Some(2000),
            frame_phases: false,
            target: target(),
        };
        assert_eq!(
            eval_code_for(&windowed).as_deref(),
            Some("window.__tugMotion.rest(2000)")
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
        assert_eq!(
            eval_code_for(&DeckMotionCommands::Gaps { target: target() }).as_deref(),
            Some("window.__tugMotion.gaps()")
        );
    }

    /// The window always rides the call, so a reading taken bare is the same
    /// 2000 ms one the page would have defaulted to, and a named window is
    /// passed through.
    #[test]
    fn frames_always_carries_its_window() {
        let bare = DeckMotionCommands::Frames {
            window: None,
            target: target(),
        };
        assert_eq!(
            eval_code_for(&bare).as_deref(),
            Some("window.__tugMotion.hostFrames(2000)")
        );
        let windowed = DeckMotionCommands::Frames {
            window: Some(3000),
            target: target(),
        };
        assert_eq!(
            eval_code_for(&windowed).as_deref(),
            Some("window.__tugMotion.hostFrames(3000)")
        );
    }

    /// Ticks against expected, the missed count and the worst gap in periods,
    /// then each gap over the period; a value missing its counts is not read.
    #[test]
    fn frames_prints_ticks_missed_and_the_worst_gap() {
        let value = serde_json::json!({
            "periodMs": 16.0,
            "ticks": 118,
            "expectedTicks": 125,
            "missed": 3,
            "worstGapMs": 48.0,
            "gapsOverPeriod": [{ "atMs": 640.0, "gapMs": 48.0 }],
        });
        let text = frames_text(&value).expect("a reading");
        assert_eq!(
            text,
            "118/125 ticks at 16.00 ms, 3 missed, worst gap 48.0 ms (3.0 periods)\n\
             \x20 +   640 ms    48.0 ms (3.0 periods)\n"
        );
        assert!(frames_text(&serde_json::json!({ "ticks": 1 })).is_none());
    }

    /// The two classes summed apart, then newest first, each with its age, its
    /// gap in ms and in frames, its class and both beats; an empty ring says so
    /// rather than printing nothing.
    #[test]
    fn gaps_prints_each_late_frame_newest_first() {
        let value = serde_json::json!({
            "now": 10_000.0,
            "rows": [
                {"at": 4_000.0, "startBeat": "move", "endBeat": "move", "class": "judder", "gapMs": 50.0, "periodMs": 16.0, "offsetMs": 120.0},
                {"at": 6_000.0, "startBeat": "move", "endBeat": "grow", "class": "judder", "gapMs": 40.0, "periodMs": 16.0, "offsetMs": 300.0},
                {"at": 8_000.0, "startBeat": "set-up", "endBeat": "move", "class": "lead", "gapMs": 80.0, "periodMs": 16.0, "offsetMs": 80.0},
            ],
        });
        let text = gaps_text(&value).expect("a gaps value renders");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "3 late frame(s) recorded inside a settle");
        // The set-up's 80 ms is the lead's, never the worst judder.
        assert_eq!(
            lines[1],
            "  judder (the one-period bar): 2 over, 90.0 ms in all, worst 50.0 ms (3.1 frames)"
        );
        assert_eq!(
            lines[2],
            "  lead (the set-up's budget):   1 gap(s), 80.0 ms in all"
        );
        assert!(lines[3].contains("2.0 s ago"), "{text}");
        assert!(
            lines[3].contains("80.0 ms (5.0 frames)  lead   set-up→move"),
            "{text}"
        );
        assert!(lines[4].contains("move→grow"), "{text}");
        assert!(lines[5].contains("6.0 s ago"), "{text}");
        assert!(
            lines[5].contains("50.0 ms (3.1 frames)  judder move→move"),
            "{text}"
        );
        assert!(lines[5].ends_with("+120 ms into the window"), "{text}");
        // A deck with only set-up gaps has no judder to bar.
        let lead_only = serde_json::json!({
            "now": 1.0,
            "rows": [{"at": 0.0, "startBeat": "set-up", "endBeat": "move", "class": "lead", "gapMs": 70.0, "periodMs": 16.0, "offsetMs": 70.0}],
        });
        let lead_text = gaps_text(&lead_only).expect("renders");
        assert!(
            lead_text.contains("judder (the one-period bar): none"),
            "{lead_text}"
        );
        // A row with no class is a judder: an old deck never passes a bar.
        let classless = serde_json::json!({
            "now": 1.0,
            "rows": [{"at": 0.0, "beat": "move", "gapMs": 50.0, "periodMs": 16.0, "offsetMs": 70.0}],
        });
        let classless_text = gaps_text(&classless).expect("renders");
        assert!(
            classless_text.contains("judder (the one-period bar): 1 over"),
            "{classless_text}"
        );
        assert!(
            classless_text.contains("lead (the set-up's budget):   0 gap(s), 0.0 ms in all"),
            "{classless_text}"
        );
        assert!(
            classless_text.contains("1 row(s) from a deck older than the two-beat row"),
            "{classless_text}"
        );
        assert!(classless_text.contains("judder ?→move"), "{classless_text}");
        assert!(!text.contains("older than"), "{text}");
        let empty = serde_json::json!({"now": 1.0, "rows": []});
        assert_eq!(
            gaps_text(&empty).as_deref(),
            Some("no late frames recorded inside a settle\n")
        );
        assert!(gaps_text(&serde_json::json!({"x": 1})).is_none());
    }

    /// One case per mode, because the mode is the whole of what `chains`
    /// carries and a verb that armed when it was asked to read would restore
    /// nothing and report an empty log as a clean deck.
    #[test]
    fn chains_carries_its_mode() {
        for mode in ["arm", "read", "disarm"] {
            let cmd = DeckMotionCommands::Chains {
                mode: mode.to_string(),
                no_stacks: false,
                target: target(),
            };
            assert_eq!(
                eval_code_for(&cmd).as_deref(),
                Some(format!(r#"window.__tugMotion.chains("{mode}")"#).as_str())
            );
        }
        // `--no-stacks` rides `arm` alone; `read` and `disarm` have no stack to
        // skip, and a second argument there would read as a different call.
        for (mode, code) in [
            (
                "arm",
                r#"window.__tugMotion.chains("arm", {"stacks": false})"#,
            ),
            ("read", r#"window.__tugMotion.chains("read")"#),
            ("disarm", r#"window.__tugMotion.chains("disarm")"#),
        ] {
            let cmd = DeckMotionCommands::Chains {
                mode: mode.to_string(),
                no_stacks: true,
                target: target(),
            };
            assert_eq!(eval_code_for(&cmd).as_deref(), Some(code));
        }
    }

    /// A read prints each site's ms beside its count, and the summary names
    /// the longest chain and the total — the count alone cannot say what a
    /// site cost.
    #[test]
    fn chains_read_prints_ms() {
        let value = serde_json::json!({
            "entries": 40,
            "tasks": 3,
            "chains": 5,
            "longestChainMs": 12.5,
            "totalChainMs": 31.0,
            "chainTimes": [],
            "truncated": false,
            "ranked": [{
                "site": "at pin (smart-scroll.ts:1)\nat effect (tug-list-view.tsx:2)",
                "chains": 4,
                "ms": 28.5,
                "writeSites": ["at write (a.ts:3)\nat caller (b.ts:4)"],
                "names": ["clientHeight", "scrollTop"],
                "functions": ["pin", "effect"],
            }],
        });
        let text = chains_text("read", &value).expect("a read value renders");
        assert!(
            text.starts_with(
                "5 chains over 40 entries in 3 tasks (longest 12.5 ms, total 31.0 ms)\n"
            ),
            "{text}"
        );
        assert!(
            text.contains("      4 chains     28.5 ms  [clientHeight,scrollTop]\n"),
            "{text}"
        );
        assert!(
            text.contains("      read  at pin (smart-scroll.ts:1)\n"),
            "{text}"
        );
        assert!(text.contains("      write at write (a.ts:3)\n"), "{text}");
        assert!(!text.contains("at caller"), "{text}");
        // The names lead, ahead of the positions a rebuild moves.
        let names = text
            .find("      in    pin ← effect\n")
            .expect("the names are printed");
        assert!(names < text.find("      read  ").unwrap(), "{text}");
    }

    /// A reading at rest, where nothing chains, still names the readers that
    /// paid for a layout, by their functions.
    #[test]
    fn chains_read_names_the_reads_that_paid_with_no_chain() {
        let value = serde_json::json!({
            "entries": 300,
            "tasks": 40,
            "chains": 0,
            "longestChainMs": 0.0,
            "totalChainMs": 0.0,
            "chainTimes": [],
            "truncated": false,
            "ranked": [],
            "paid": [{
                "site": "follow@x.js:1:2",
                "functions": ["follow", "onRows"],
                "reads": 12,
                "ms": 40.25,
                "names": ["scrollTop"],
            }],
        });
        let text = chains_text("read", &value).expect("a read value renders");
        assert!(
            text.contains("reads that paid for a layout, by site:\n"),
            "{text}"
        );
        assert!(
            text.contains("     12 reads      40.2 ms  [scrollTop]\n"),
            "{text}"
        );
        assert!(text.contains("      in    follow ← onRows\n"), "{text}");
    }

    #[test]
    fn chains_arm_says_when_it_carries_no_stacks() {
        let stackless = serde_json::json!({"armed": true, "cap": 16000, "stacks": false});
        assert_eq!(
            chains_text("arm", &stackless).as_deref(),
            Some("chains armed: cap 16000 entries, no stacks\n")
        );
        let stacked = serde_json::json!({"armed": true, "cap": 16000, "stacks": true});
        assert_eq!(
            chains_text("arm", &stacked).as_deref(),
            Some("chains armed: cap 16000 entries\n")
        );
        assert_eq!(chains_text("arm", &serde_json::json!({"error": "x"})), None);
    }

    /// One case per mode, and each asserts the TWO-argument form.
    ///
    /// The cap is what keeps a forgotten `read` from leaving a rAF chain
    /// running at rest, and a call that carried the mode alone would pass an
    /// assertion written against a prefix while silently dropping it.
    #[test]
    fn gesture_carries_its_mode_and_its_window() {
        for mode in ["arm", "read", "disarm"] {
            let cmd = DeckMotionCommands::Gesture {
                mode: mode.to_string(),
                window: None,
                target: target(),
            };
            assert_eq!(
                eval_code_for(&cmd).as_deref(),
                Some(
                    format!(r#"window.__tugMotion.gesture("{mode}", {GESTURE_WINDOW_DEFAULT_MS})"#)
                        .as_str()
                )
            );
        }
    }

    /// An explicit `--window` reaches the page rather than being dropped in
    /// favour of the default — the flag exists for a gesture somebody needs
    /// longer to go and perform.
    #[test]
    fn gesture_window_overrides_the_default() {
        let cmd = DeckMotionCommands::Gesture {
            mode: "arm".to_string(),
            window: Some(20_000),
            target: target(),
        };
        assert_eq!(
            eval_code_for(&cmd).as_deref(),
            Some(r#"window.__tugMotion.gesture("arm", 20000)"#)
        );
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
    fn record_sends_a_boolean_and_bare_reports() {
        let record = |state: Option<&str>| DeckMotionCommands::Record {
            state: state.map(str::to_string),
            reload: false,
            target: target(),
        };
        assert_eq!(
            eval_code_for(&record(Some("on"))).as_deref(),
            Some("window.__tugMotion.record(true)")
        );
        assert_eq!(
            eval_code_for(&record(Some("off"))).as_deref(),
            Some("window.__tugMotion.record(false)")
        );
        assert_eq!(
            eval_code_for(&record(None)).as_deref(),
            Some("window.__tugMotion.record()")
        );
    }

    #[test]
    fn record_summary_names_what_it_armed_and_what_waits_on_a_load() {
        let off = serde_json::json!({"recording": false});
        assert_eq!(record_summary(&off), "motion recording off");
        let on = serde_json::json!({
            "recording": true,
            "kinds": ["settle-frames", "settle-land", "settle-beat", "space-switch-frames"],
            "census": false,
            "leadRecorder": false,
            "nextLoad": ["commit census", "lead recorder"],
        });
        let line = record_summary(&on);
        assert!(
            line.starts_with("motion recording on: 4 kind(s) (settle-frames, "),
            "{line}"
        );
        assert!(line.contains("no commit census"), "{line}");
        assert!(
            line.contains("commit census and lead recorder on the next load"),
            "{line}"
        );
        let loaded = serde_json::json!({
            "recording": true, "kinds": ["settle-frames"], "census": true,
            "leadRecorder": true, "nextLoad": [],
        });
        let line = record_summary(&loaded);
        assert!(
            line.contains("commit census walking; lead recorder in the page"),
            "{line}"
        );
        assert!(!line.contains("next load"), "{line}");
    }

    #[test]
    fn enable_and_disable_evaluate_nothing() {
        assert!(eval_code_for(&DeckMotionCommands::Enable { target: target() }).is_none());
        assert!(eval_code_for(&DeckMotionCommands::Disable { target: target() }).is_none());
        // `walk` posts its own page ops rather than one evaluation.
        let walk = DeckMotionCommands::Walk {
            arms: vec!["overview-skip".to_string()],
            rounds: 3,
            frames: 30,
            driver: "width".to_string(),
            restore: false,
            target: target(),
        };
        assert!(eval_code_for(&walk).is_none());
    }

    /// A remedy that does not name the command that fixes it is a dead end:
    /// the user reads "gated" and has nowhere to go.
    #[test]
    fn the_gated_remedy_names_the_command_that_opens_the_door() {
        assert!(EVAL_GATED_REMEDY.contains("tugtool deck motion enable"));
        assert!(EVAL_GATED_REMEDY.contains("disable"));
    }
}
