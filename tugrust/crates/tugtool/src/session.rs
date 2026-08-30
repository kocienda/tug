//! `tugtool session rotate` — ask the wheel to seat a fresh claude
//! session under this card.
//!
//! The verb runs from inside a turn, and the rotation lands at that turn's end.
//! That is not a scheduling convenience: a rotation retires the claude session
//! it runs on, so performing one on receipt would kill the model that asked for
//! it, mid-sentence. The request is recorded and the verb returns; the card
//! rotates seconds later, when the turn the caller is in ends.
//!
//! A caller not in a turn is asking about the next one, and the receipt says
//! so. Nothing is lost — a request is a promise about a turn's end, and there
//! is always a next turn.

use crate::cli::SessionCommands;
use crate::dash::{calling_session_id, post_instance_api};
use crate::output::print_ok;
use serde::Serialize;
use std::process::ExitCode;
use tugdash_core::arc::{ArcStage, stage_model};

/// The `session` command group. Every refusal exits 1 with its reason on
/// stderr, so the asking turn shows what stopped it rather than nothing.
pub fn dispatch(cmd: SessionCommands, json: bool) -> ExitCode {
    let result: Result<(), String> = match cmd {
        SessionCommands::Rotate {
            prompt,
            stage,
            model,
            effort,
            project,
            cancel,
        } => run_rotate(prompt, stage, model, effort, project, cancel, json),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}

/// What `--json` prints for a rotation request.
#[derive(Serialize)]
struct RotatePayload {
    stage: String,
    /// The model the fresh session is seated on, or `None` for the account
    /// default — which changes no selector at all.
    model: Option<String>,
    effort: Option<String>,
    prompt: String,
    /// Always true on success: the request waits for the turn-end edge.
    pending: bool,
    /// Whether this request replaced one already parked for the session.
    replaced: bool,
    /// Whether the card is handed back to the user's own model afterwards.
    hands_back: bool,
}

/// What `--json` prints for a cancellation.
#[derive(Serialize)]
struct RotateCancelPayload {
    cancelled: bool,
}

/// The model a rotation runs on.
///
/// The stage label *is* the role: `devise` / `review` / `implement` resolve
/// through the project's own `[tugtool.dash]` declarations, and any other label
/// means the account default. A second table mapping roles to models would be
/// the same fact written twice.
///
/// Resolved here rather than on the server because the CLI is where the project
/// root is known from cwd.
fn resolve_model(
    stage: &str,
    model: Option<String>,
    project: Option<std::path::PathBuf>,
) -> Option<String> {
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        return Some(model);
    }
    let arc_stage = ArcStage::parse(stage)?;
    let root = match project {
        Some(p) if p.is_absolute() => p,
        Some(p) => std::env::current_dir().ok()?.join(p),
        None => tugtool_core::config::find_project_root().ok()?,
    };
    let config = tugtool_core::config::Config::load_from_project(&root).ok()?;
    stage_model(&config.tugtool.dash, arc_stage)
}

/// The line the asking turn shows.
///
/// The ask happens inside a turn the user is watching, in a tool block they can
/// read, so the receipt is the whole of the announcement: what the card becomes,
/// when, and whether it comes back. The act's own artifact is the stage divider
/// the rotation draws.
///
/// Pure, so the wording is a table test rather than a live-run observation.
fn format_rotation_receipt(
    stage: &str,
    model: Option<&str>,
    hands_back: bool,
    replaced: bool,
) -> String {
    let mut out = format!(
        "TUG-ROTATION-RECEIPT: {stage} · {} · at this turn's end",
        model.unwrap_or("account default")
    );
    if hands_back {
        out.push_str(" · hands back after");
    }
    if replaced {
        out.push_str(" · replaces a pending rotation");
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn run_rotate(
    prompt: Option<String>,
    stage: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    project: Option<std::path::PathBuf>,
    cancel: bool,
    json: bool,
) -> Result<(), String> {
    // Usage is settled before anything is looked up: a caller who spelled the
    // command wrong gets told that, not told about a missing session.
    if cancel && (prompt.is_some() || model.is_some() || effort.is_some() || stage.is_some()) {
        return Err("--cancel withdraws a pending rotation and takes no other flags".to_string());
    }
    let session = calling_session_id("a rotation")?;

    if cancel {
        // Withdrawing is the whole of the ceremony a pending rotation deserves:
        // it has no document and no next stage, so there is nothing left behind
        // to record.
        let response = post_instance_api(
            "/api/session",
            "a rotation",
            serde_json::json!({ "op": "rotate_cancel", "tug_session_id": session }),
        )?;
        let cancelled = response
            .get("cancelled")
            .and_then(|c| c.as_bool())
            .unwrap_or(false);
        if json {
            print_ok("session rotate", RotateCancelPayload { cancelled });
        } else if cancelled {
            println!("TUG-ROTATION-RECEIPT: pending rotation withdrawn");
        } else {
            // A state, not an error: nothing was promised, so nothing broke.
            println!("TUG-ROTATION-RECEIPT: nothing pending");
        }
        return Ok(());
    }

    let Some(prompt) = prompt.filter(|p| !p.is_empty()) else {
        return Err("a rotation needs --prompt: it is what the fresh session opens on".to_string());
    };
    let stage = stage
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "rotate".to_string());
    let model = resolve_model(&stage, model, project.clone());
    let effort = effort.filter(|e| !e.is_empty());

    let mut body = serde_json::json!({
        "op": "rotate",
        "tug_session_id": session,
        "stage": stage,
        "prompt": prompt,
    });
    let dir = match project {
        Some(p) if p.is_absolute() => Some(p),
        Some(p) => std::env::current_dir().ok().map(|cwd| cwd.join(p)),
        None => std::env::current_dir().ok(),
    };
    if let Some(dir) = dir {
        body["project_dir"] = serde_json::Value::String(dir.to_string_lossy().to_string());
    }
    if let Some(model) = model.as_deref() {
        body["model"] = serde_json::Value::String(model.to_owned());
    }
    if let Some(effort) = effort.as_deref() {
        body["effort"] = serde_json::Value::String(effort.to_owned());
    }

    let response = post_instance_api("/api/session", "a rotation", body)?;
    let replaced = response
        .get("replaced")
        .and_then(|r| r.as_bool())
        .unwrap_or(false);
    // A rotation naming a model pins the card there until somebody restores the
    // deck's own selector, and no course's ending will — so the wheel hands
    // it back one turn later, and the ask says so.
    let hands_back = model.is_some();

    if json {
        print_ok(
            "session rotate",
            RotatePayload {
                stage,
                model,
                effort,
                prompt,
                pending: true,
                replaced,
                hands_back,
            },
        );
    } else {
        println!(
            "{}",
            format_rotation_receipt(&stage, model.as_deref(), hands_back, replaced)
        );
        if let Some(first) = prompt.lines().next() {
            println!("{first}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_receipt_says_what_the_card_becomes_and_whether_it_comes_back() {
        assert_eq!(
            format_rotation_receipt("review", Some("opus"), true, false),
            "TUG-ROTATION-RECEIPT: review · opus · at this turn's end · hands back after"
        );
        assert_eq!(
            format_rotation_receipt("review", None, false, false),
            "TUG-ROTATION-RECEIPT: review · account default · at this turn's end"
        );
        assert_eq!(
            format_rotation_receipt("devise", Some("sonnet"), true, true),
            "TUG-ROTATION-RECEIPT: devise · sonnet · at this turn's end · hands back after · replaces a pending rotation"
        );
    }

    #[test]
    fn cancel_takes_no_other_flags() {
        // Settled before any lookup, so the message names the mistake rather
        // than whatever the next step would have complained about.
        let err = run_rotate(
            Some("hello".to_string()),
            None,
            None,
            None,
            None,
            true,
            false,
        )
        .expect_err("a usage error");
        assert!(err.contains("takes no other flags"), "{err}");
    }

    #[test]
    fn an_omitted_model_resolves_through_the_stage_label_and_a_named_one_always_wins() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\nreview_model = \"opus\"\n",
        )
        .unwrap();
        let project = Some(root.to_path_buf());

        assert_eq!(
            resolve_model("review", None, project.clone()),
            Some("opus".to_string()),
            "the stage label is the role, resolved through the project's own declaration"
        );
        assert_eq!(
            resolve_model("devise", None, project.clone()),
            None,
            "a stage the project declares no model for is the account default"
        );
        assert_eq!(
            resolve_model("summarize", None, project.clone()),
            None,
            "a label that is not one of the arc's three is the account default"
        );
        assert_eq!(
            resolve_model("review", Some("haiku".to_string()), project),
            Some("haiku".to_string()),
            "--model always wins"
        );
    }
}
