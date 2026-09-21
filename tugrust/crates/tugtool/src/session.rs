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

use crate::arc::{calling_session_id, post_instance_api};
use crate::cli::SessionCommands;
use crate::output::print_ok;
use serde::Serialize;
use std::process::ExitCode;
use tugarc_core::arc::{ArcStage, stage_model};

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
        // `find` and `show` return their own exit code rather than routing
        // through `Err`, because **`absent` is a third answer, not a
        // failure**: the reference was read, the machine was searched, and
        // the truthful result is that nothing here answers to it. Exit 3
        // says that, and leaves exit 1 meaning what it means everywhere
        // else in this file — the verb could not do its job.
        SessionCommands::Find { reference } => return run_find(&reference, json),
        SessionCommands::Show {
            reference,
            last,
            turn,
            grep,
        } => return run_show(&reference, last, turn, grep.as_deref(), json),
        SessionCommands::IndexPut {
            uuid,
            callsign,
            project_dir,
            instance,
            title,
        } => run_index_put(uuid, callsign, project_dir, instance, title),
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
/// through the project's own `[tugtool.arc]` declarations, and any other label
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
    stage_model(&config.tugtool.arc, arc_stage)
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
    let session = calling_session_id("a rotation", None)?;

    if cancel {
        // Withdrawing is the whole of the ceremony a pending rotation deserves:
        // it has no document and no next stage, so there is nothing left behind
        // to record.
        let response = post_instance_api(
            "/api/session",
            "a rotation",
            serde_json::json!({ "op": "rotate_cancel", "tug_session_id": session.session_id }),
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
        "tug_session_id": session.session_id,
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
    // deck's own selector, and no arc's ending will — so the wheel hands
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

// ── find / show: reading a session from outside it ───────────────────────────

/// Exit status for a reference nothing on this machine answers to.
///
/// Distinct from 1 on purpose. A model asking `find` needs to tell "there
/// is no such session" from "I could not look" — the first is an answer it
/// should act on, the second a fault it should report.
const EXIT_ABSENT: u8 = 3;

/// What `--json` prints for a `find`.
#[derive(Serialize)]
struct FindPayload {
    verdict: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callsign: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transcript: Option<String>,
}

/// One rendered turn, for `show --json`.
#[derive(Serialize)]
struct TurnPayload {
    number: usize,
    user: String,
    assistant: Vec<String>,
}

/// What `--json` prints for a `show`.
#[derive(Serialize)]
struct ShowPayload {
    verdict: &'static str,
    session_id: String,
    project_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callsign: Option<String>,
    turns: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_updated: Option<String>,
    transcript_on_disk: bool,
    shown: Vec<TurnPayload>,
}

fn verdict_word(provenance: tugcore::session_finder::Provenance) -> &'static str {
    match provenance {
        tugcore::session_finder::Provenance::Here => "here",
        tugcore::session_finder::Provenance::Elsewhere => "elsewhere",
    }
}

/// Place a reference and say where it points.
fn run_find(reference: &str, json: bool) -> ExitCode {
    // A spelling that is neither an id nor a callsign never reaches a
    // query, and it is an *error* rather than an absence: the caller
    // mistyped, and telling them "not on this machine" would send them
    // looking for a session instead of at their own command.
    if tugcore::session_finder::Reference::parse(reference).is_none() {
        eprintln!(
            "error: not a session reference: {reference} \
             (expected a uuid, an 8-character short id, a callsign, or project/callsign)"
        );
        return ExitCode::from(1);
    }
    let env = tugcore::session_finder::FinderEnv::from_process();
    match tugcore::session_finder::find(reference, &env) {
        tugcore::session_finder::Finding::Found(found) => {
            let verdict = verdict_word(found.provenance);
            if json {
                print_ok(
                    "session find",
                    FindPayload {
                        verdict,
                        session_id: Some(found.session_id),
                        project_dir: Some(found.project_dir),
                        callsign: found.callsign,
                        title: found.title,
                        instance: found.instance,
                        transcript: found.transcript.map(|p| p.to_string_lossy().into_owned()),
                    },
                );
            } else {
                let mut line = format!("{verdict} {} {}", found.session_id, found.project_dir);
                // Which instance holds it only means something for a
                // session that is not here, and only when the index knew.
                if found.provenance == tugcore::session_finder::Provenance::Elsewhere
                    && let Some(instance) = found.instance.as_deref().filter(|i| !i.is_empty())
                {
                    line.push_str(&format!(" instance {instance}"));
                }
                println!("{line}");
            }
            ExitCode::SUCCESS
        }
        tugcore::session_finder::Finding::Absent => {
            if json {
                print_ok(
                    "session find",
                    FindPayload {
                        verdict: "absent",
                        session_id: None,
                        project_dir: None,
                        callsign: None,
                        title: None,
                        instance: None,
                        transcript: None,
                    },
                );
            } else {
                println!("absent");
            }
            ExitCode::from(EXIT_ABSENT)
        }
    }
}

/// Read a session's transcript back as markdown.
fn run_show(
    reference: &str,
    last: Option<usize>,
    turn: Option<usize>,
    grep: Option<&str>,
    json: bool,
) -> ExitCode {
    if tugcore::session_finder::Reference::parse(reference).is_none() {
        eprintln!(
            "error: not a session reference: {reference} \
             (expected a uuid, an 8-character short id, a callsign, or project/callsign)"
        );
        return ExitCode::from(1);
    }
    let env = tugcore::session_finder::FinderEnv::from_process();
    let found = match tugcore::session_finder::find(reference, &env) {
        tugcore::session_finder::Finding::Found(found) => found,
        tugcore::session_finder::Finding::Absent => {
            // To stderr, so a caller piping the transcript somewhere gets
            // an empty pipe rather than the word `absent` in the middle of
            // what it thought was a document.
            eprintln!("absent");
            return ExitCode::from(EXIT_ABSENT);
        }
    };
    let verdict = verdict_word(found.provenance);
    let heading = found
        .title
        .clone()
        .or_else(|| found.callsign.clone())
        .unwrap_or_else(|| found.session_id.chars().take(8).collect());

    // A session the ledger knows whose JSONL is gone is still a finding —
    // it exists, and saying so beats answering `absent` about a session
    // that is right there in a picker.
    let Some(path) = found.transcript.as_deref() else {
        if json {
            print_ok(
                "session show",
                ShowPayload {
                    verdict,
                    session_id: found.session_id,
                    project_dir: found.project_dir,
                    title: found.title,
                    callsign: found.callsign,
                    turns: 0,
                    last_updated: None,
                    transcript_on_disk: false,
                    shown: Vec::new(),
                },
            );
        } else {
            println!("# {heading}");
            println!("project: {}", found.project_dir);
            println!("session: {}", found.session_id);
            println!("verdict: {verdict}");
            println!("transcript: not on disk");
        }
        return ExitCode::SUCCESS;
    };

    let transcript = tugcore::session_transcript::read(path);
    let (shown, abridged_from) =
        tugcore::session_transcript::select(&transcript.turns, turn, last, grep);

    if json {
        print_ok(
            "session show",
            ShowPayload {
                verdict,
                session_id: found.session_id,
                project_dir: found.project_dir,
                title: found.title,
                callsign: found.callsign,
                turns: transcript.turns.len(),
                last_updated: transcript.last_timestamp.as_deref().map(format_stamp),
                transcript_on_disk: true,
                shown: shown
                    .iter()
                    .map(|t| TurnPayload {
                        number: t.number,
                        user: t.user.clone(),
                        assistant: t.assistant.clone(),
                    })
                    .collect(),
            },
        );
        return ExitCode::SUCCESS;
    }

    println!("# {heading}");
    println!("project: {}", found.project_dir);
    println!("session: {}", found.session_id);
    println!("verdict: {verdict}");
    let updated = transcript
        .last_timestamp
        .as_deref()
        .map(format_stamp)
        .unwrap_or_else(|| "unknown".to_string());
    println!(
        "turns: {}   last updated: {updated}",
        transcript.turns.len()
    );
    println!();
    if let Some(total) = abridged_from {
        println!(
            "(showing the last {} of {total} turns; use --turn or --grep for the rest)",
            tugcore::session_transcript::DEFAULT_TURN_CAP
        );
        println!();
    }
    print!("{}", tugcore::session_transcript::render(&shown));
    ExitCode::SUCCESS
}

/// A transcript's own timestamp as RFC 3339 UTC, or verbatim when it is not
/// a shape this build can parse — a stamp nobody can read is still better
/// than no stamp, and the transcript's format is claude's to change.
fn format_stamp(raw: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(raw) {
        Ok(dt) => dt
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        Err(_) => raw.to_owned(),
    }
}

/// Write one index row. Fixtures only — see the hidden subcommand's doc.
fn run_index_put(
    uuid: String,
    callsign: Option<String>,
    project_dir: String,
    instance: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    let path = tugcore::instance::session_index_db_path();
    let index = tugcore::session_index::SessionIndex::open(&path)
        .map_err(|e| format!("cannot open the session index at {}: {e}", path.display()))?;
    let now = tugcore::session_index::now_ms();
    index
        .upsert(&tugcore::session_index::IndexEntry {
            session_id: uuid,
            line_id: String::new(),
            callsign,
            project_dir,
            project_leaf: String::new(),
            instance: instance.unwrap_or_default(),
            title,
            created_at_ms: now,
            updated_at_ms: now,
        })
        .map_err(|e| format!("cannot write the index row: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_normalizes_to_rfc_3339_utc_or_survives_verbatim() {
        assert_eq!(
            format_stamp("2026-09-21T10:01:00.000Z"),
            "2026-09-21T10:01:00Z"
        );
        assert_eq!(
            format_stamp("2026-09-21T12:01:00.000+02:00"),
            "2026-09-21T10:01:00Z"
        );
        assert_eq!(format_stamp("whenever"), "whenever");
    }

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
            "[tugtool.arc]\nreview_model = \"opus\"\n",
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
