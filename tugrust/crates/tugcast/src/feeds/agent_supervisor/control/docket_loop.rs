//! The docket loop's CONTROL actions: `arc_keep_going` and `arc_park`, an
//! arc's two answers to a newer version of the brief it runs on, and
//! `follow_up_accept` and `follow_up_dismiss`, the user's answers to a
//! follow-up an arc's audit recorded, and `arc_revert`, which undoes a landed
//! arc's join with a commit on its base.
//!
//! **Keep going** acknowledges the newer brief: the arc runs on its own, the
//! revision notice quiets until the brief moves again, and each decision the
//! newer version added is filed as an idea on the docket the press came from.
//! **Park** asks that the arc stop at its next step boundary so a successor can
//! start from its finished work: an arc already stopped is parked at once, and
//! a running one is parked by the wheel when its stage is next idle with no
//! step open.
//!
//! Each verb is one pure function over the data root and the request's bytes,
//! so the tests drive it without a supervisor. The one effect beyond the
//! records — waking the wheel over a running arc so the park lands at its
//! boundary rather than at the next unrelated tick — is the handler's.

use super::super::*;
use super::records::{refusal, request_id_of};
use super::request::Request;
use tugarc_core::arc::{ArcStopReason, read_arc};
use tugarc_core::brief_revision::{diff, parse_decisions};
use tugarc_core::docket::{self, FileItem};
use tugarc_core::docket_threads::{derive_threads, gather_inputs};
use tugarc_core::idea::{self, IDEA_TEXT_LIMIT, IdeaOrigin, IdeaOriginKind};
use tugarc_core::ops::{Boundary, resolve_boundary};
use tugcast_core::ControlAction;
use tugcore::instance::Paths;

/// What a verb answered, and the arc whose wheel should be woken, if any.
pub(super) struct LoopAnswer {
    pub(super) body: serde_json::Value,
    pub(super) wake: Option<String>,
}

/// `arc_keep_going`: record that the user keeps going past brief version
/// `version`, and file each decision that version added as an idea on the
/// request's docket. A press repeated over a version already kept past files
/// nothing more.
fn keep_going_body(paths: &Paths, req: &Request, verb: &str) -> Result<serde_json::Value, String> {
    let arc = req.text(verb, "arc")?;
    let version = req.number(verb, "version")?;
    let docket_id = req.text(verb, "docket_id")?;
    let repo = req.repo();
    let record = read_arc(paths, repo, &arc).ok_or_else(|| format!("{arc} is not a live arc."))?;
    if record.brief_kept.is_some_and(|kept| kept >= version) {
        return Ok(req.ok(
            verb,
            serde_json::json!({ "arc": arc, "kept_through": record.brief_kept, "ideas": [] }),
        ));
    }
    let docket = docket::dockets(paths, repo, true)
        .into_iter()
        .find(|d| d.id == docket_id)
        .ok_or_else(|| format!("No docket {docket_id} in this checkout."))?;
    let inputs = gather_inputs(paths, repo, &docket);
    let revision = inputs
        .revisions
        .get(&arc)
        .ok_or_else(|| format!("{arc} has no newer brief on this docket to keep going past."))?;
    if revision.to_version != version {
        return Err(format!(
            "The brief has moved to v{}; there is no v{version} to keep going past.",
            revision.to_version
        ));
    }
    let created = derive_threads(&inputs)
        .iter()
        .filter_map(|t| t.arc.as_ref())
        .find(|a| a.name == arc)
        .map(|a| a.created.clone())
        .unwrap_or_default();

    let to = parse_decisions(&revision.to_text);
    let added = diff(&parse_decisions(&revision.from_text), &to).added;
    let mut made = Vec::new();
    for decision in to
        .iter()
        .filter(|d| added.iter().any(|a| a.label == d.label))
    {
        let text: String = format!("{} {}", decision.label, decision.title)
            .chars()
            .take(IDEA_TEXT_LIMIT)
            .collect();
        let origin = IdeaOrigin {
            arc: arc.clone(),
            created: created.clone(),
            kind: IdeaOriginKind::BriefDecision {
                label: decision.label.clone(),
                version,
            },
        };
        let record = idea::create_idea_from(paths, repo, &text, Some(&decision.body), Some(origin))
            .map_err(|e| e.to_string())?;
        made.push(record.id);
    }
    let resolved: Vec<_> = made
        .iter()
        .filter_map(|id| docket::resolve_item(paths, repo, &FileItem::Idea { id: id.clone() }).ok())
        .collect();
    if !resolved.is_empty() {
        docket::file_items(paths, repo, &docket_id, &resolved).map_err(|e| e.to_string())?;
    }
    tugarc_core::arc::append_arc_brief_kept(paths, repo, &arc, version)
        .map_err(|e| e.to_string())?;
    Ok(req.ok(
        verb,
        serde_json::json!({ "arc": arc, "kept_through": version, "ideas": made }),
    ))
}

/// Where a running arc is, for the sentence the card shows while the park
/// waits: its stage, and the step it has open.
fn waiting_at(repo: &std::path::Path, arc: &str, stage: &str) -> String {
    let open = tugarc_core::ops::ledger_file(repo, arc)
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|source| tugtool_core::plan::parse(&source).ok())
        .and_then(|doc| {
            doc.ledger_rows
                .iter()
                .find(|r| r.status == "in progress")
                .and_then(|r| r.anchor.strip_prefix("step-").map(str::to_owned))
        });
    match open {
        Some(step) => format!("{stage} · step {step}"),
        None => stage.to_owned(),
    }
}

/// `arc_park`: write the request, and park the arc now when it is already
/// stopped. A request repeated over the arc it already parked writes nothing
/// and answers the same commit.
fn park_body(paths: &Paths, req: &Request, verb: &str) -> Result<LoopAnswer, String> {
    let arc = req.text(verb, "arc")?;
    let successor = req.text(verb, "successor")?;
    let boundary_word = req.text(verb, "boundary")?;
    let boundary = Boundary::parse(&boundary_word)
        .ok_or_else(|| format!("{boundary_word} is not a boundary: say tip, fork or step:<K>."))?;
    let repo = req.repo();
    let record = read_arc(paths, repo, &arc).ok_or_else(|| format!("{arc} is not a live arc."))?;
    if record.stopping.is_some() {
        return Err(format!(
            "{arc} is stopping; park it once the stop has finished."
        ));
    }
    let parked = |from: String| {
        req.ok(
            verb,
            serde_json::json!({ "arc": arc, "parked": true, "from": from }),
        )
    };
    let resolve = || resolve_boundary(paths, repo, &arc, boundary).map_err(|e| e.to_string());

    if let Some((stage, reason)) = &record.stopped {
        let already = reason == ArcStopReason::Parked.as_str()
            && record
                .park
                .as_ref()
                .is_some_and(|p| p.successor == successor && p.boundary == boundary.format());
        // Resolved before anything is written: a boundary that names no
        // finished work is refused with the record untouched.
        let from = resolve()?;
        if !already {
            tugarc_core::arc::append_arc_park(paths, repo, &arc, &successor, &boundary.format())
                .map_err(|e| e.to_string())?;
            tugarc_core::arc::append_arc_stop(paths, repo, &arc, *stage, ArcStopReason::Parked)
                .map_err(|e| e.to_string())?;
        }
        return Ok(LoopAnswer {
            body: parked(from),
            wake: None,
        });
    }

    tugarc_core::arc::append_arc_park(paths, repo, &arc, &successor, &boundary.format())
        .map_err(|e| e.to_string())?;
    let stage = record
        .current_stage()
        .map(|s| s.as_str())
        .unwrap_or("devise");
    Ok(LoopAnswer {
        body: req.ok(
            verb,
            serde_json::json!({
                "arc": arc,
                "parked": false,
                "waiting": waiting_at(repo, &arc, stage),
            }),
        ),
        wake: Some(arc),
    })
}

/// The arc log, whole; empty when nothing has written one.
fn arc_log_text(paths: &Paths, repo: &std::path::Path) -> String {
    std::fs::read_to_string(tugtool_core::paths::arc_log_path_at(paths, repo)).unwrap_or_default()
}

/// The follow-up an answer names: its arc, its generation's start, its `k`,
/// and its line while no decision has settled it.
struct FollowUp {
    arc: String,
    created: String,
    k: u32,
    line: String,
}

fn follow_up_of(paths: &Paths, req: &Request, verb: &str) -> Result<FollowUp, String> {
    let arc = req.text(verb, "arc")?;
    let created = req.text(verb, "created")?;
    let k = req.number(verb, "k")?;
    let line =
        tugarc_core::arc::open_follow_up(&arc_log_text(paths, req.repo()), &arc, &created, k)?;
    Ok(FollowUp {
        arc,
        created,
        k,
        line,
    })
}

/// `follow_up_accept`: make the follow-up an idea naming its arc, file it on
/// the request's docket, then record the acceptance. The docket is read
/// before anything is written, so a docket that is not there makes no idea.
fn follow_up_accept_body(
    paths: &Paths,
    req: &Request,
    verb: &str,
) -> Result<serde_json::Value, String> {
    let follow = follow_up_of(paths, req, verb)?;
    let docket_id = req.text(verb, "docket_id")?;
    let repo = req.repo();
    if !docket::dockets(paths, repo, true)
        .iter()
        .any(|d| d.id == docket_id)
    {
        return Err(format!("No docket {docket_id} in this checkout."));
    }
    let origin = IdeaOrigin {
        arc: follow.arc.clone(),
        created: follow.created.clone(),
        kind: IdeaOriginKind::FollowUp { k: follow.k },
    };
    let made = idea::create_idea_from(paths, repo, &follow.line, None, Some(origin))
        .map_err(|e| e.to_string())?;
    let item = docket::resolve_item(
        paths,
        repo,
        &FileItem::Idea {
            id: made.id.clone(),
        },
    )
    .map_err(|e| e.to_string())?;
    docket::file_items(paths, repo, &docket_id, &[item]).map_err(|e| e.to_string())?;
    tugarc_core::arc::append_follow_up_accepted(
        paths,
        repo,
        &follow.arc,
        &follow.created,
        follow.k,
        &made.id,
    )
    .map_err(|e| e.to_string())?;
    Ok(req.ok(
        verb,
        serde_json::json!({ "arc": follow.arc, "k": follow.k, "idea": made.id }),
    ))
}

/// `follow_up_dismiss`: record that the user dismissed the follow-up.
fn follow_up_dismiss_body(
    paths: &Paths,
    req: &Request,
    verb: &str,
) -> Result<serde_json::Value, String> {
    let follow = follow_up_of(paths, req, verb)?;
    tugarc_core::arc::append_follow_up_dismissed(
        paths,
        req.repo(),
        &follow.arc,
        &follow.created,
        follow.k,
    )
    .map_err(|e| e.to_string())?;
    Ok(req.ok(
        verb,
        serde_json::json!({ "arc": follow.arc, "k": follow.k }),
    ))
}

/// `arc_revert`: undo a landed arc's join on its base. A request that does
/// not say `dry_run: false` is a dry run, so a press can only commit by
/// asking to.
fn revert_body(paths: &Paths, req: &Request, verb: &str) -> Result<serde_json::Value, String> {
    let arc = req.text(verb, "arc")?;
    let created = req.opt_text("created");
    let dry_run = req
        .value
        .get("dry_run")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let out = tugarc_core::ops::revert_arc(paths, req.repo(), &arc, created.as_deref(), dry_run)
        .map_err(|e| e.to_string())?;
    let mut body = serde_json::json!({
        "arc": out.arc,
        "created": out.created,
        "join": out.join,
        "paths": out.paths.len(),
        "later": out.later,
    });
    if let Some(revert) = out.reverted {
        body["reverted"] = serde_json::json!(revert);
    }
    Ok(req.ok(verb, body))
}

/// One docket-loop verb, start to finish: its `_ok` frame, or the `_err`
/// frame `records.rs` answers every malformed or refused ask with.
pub(super) fn docket_loop_body(paths: &Paths, action: ControlAction, payload: &[u8]) -> LoopAnswer {
    let verb = action.as_str();
    let req = match Request::parse(verb, payload) {
        Ok(req) => req,
        Err(message) => {
            return LoopAnswer {
                body: refusal(verb, message, request_id_of(payload).as_deref()),
                wake: None,
            };
        }
    };
    let answer = match action {
        ControlAction::ArcKeepGoing => {
            keep_going_body(paths, &req, verb).map(|body| LoopAnswer { body, wake: None })
        }
        ControlAction::ArcPark => park_body(paths, &req, verb),
        ControlAction::FollowUpAccept => {
            follow_up_accept_body(paths, &req, verb).map(|body| LoopAnswer { body, wake: None })
        }
        ControlAction::FollowUpDismiss => {
            follow_up_dismiss_body(paths, &req, verb).map(|body| LoopAnswer { body, wake: None })
        }
        ControlAction::ArcRevert => {
            revert_body(paths, &req, verb).map(|body| LoopAnswer { body, wake: None })
        }
        _ => Err(format!("{verb} is not a docket-loop verb")),
    };
    answer.unwrap_or_else(|message| LoopAnswer {
        body: refusal(verb, message, req.request_id.as_deref()),
        wake: None,
    })
}

impl AgentSupervisor {
    /// The docket loop's share of [`AgentSupervisor::handle_control`]. Every
    /// verb reads and writes files, so each runs off the reactor; a park
    /// waiting on a running arc then wakes that arc's wheel, so the request is
    /// answered at the stage's next idle rather than the next unrelated tick.
    pub(in crate::feeds::agent_supervisor) async fn handle_docket_loop_control(
        &self,
        action: ControlAction,
        payload: &[u8],
    ) -> ControlOutcome {
        let verb = action.as_str();
        let owned = payload.to_vec();
        let answer = tokio::task::spawn_blocking(move || {
            docket_loop_body(&Paths::from_env(), action, &owned)
        })
        .await
        .unwrap_or_else(|err| LoopAnswer {
            body: refusal(
                verb,
                format!("{verb} task failed: {err}"),
                request_id_of(payload).as_deref(),
            ),
            wake: None,
        });
        if let Some(arc) = answer.wake {
            self.wake_arc(payload, &arc).await;
        }
        send_control(&self.control_tx, answer.body);
        ControlOutcome::Handled
    }

    /// Send the card an arc is seated on to the arc runner, best-effort: a
    /// wake that cannot be addressed costs the park nothing but its promptness.
    async fn wake_arc(&self, payload: &[u8], arc: &str) {
        let (Some(tx), Some(ledger)) = (self.arc_tick_tx.as_ref(), self.session_ledger.clone())
        else {
            return;
        };
        let Some(project) = Request::parse("arc_park", payload)
            .ok()
            .map(|req| req.repo().to_path_buf())
        else {
            return;
        };
        let Ok(arc_id) = tugarc_core::ops::ensure_arc_id(&project, arc) else {
            return;
        };
        let Some(segment) = ledger
            .bound_session_by_arc()
            .ok()
            .and_then(|map| map.get(&arc_id).cloned())
        else {
            return;
        };
        if let Some((card, _)) = self.card_entry_for_segment(&segment).await {
            let _ = tx.try_send(card.as_str().to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugarc_core::arc::{ArcStage, append_arc_stage, append_arc_start, append_arc_stop};
    use tugcore::test_fixtures::git::{GitFixture, git};

    struct Scratch {
        _repo: tempfile::TempDir,
        _state: tempfile::TempDir,
        repo: std::path::PathBuf,
        paths: Paths,
    }

    fn scratch() -> Scratch {
        let repo_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let repo = repo_dir.path().canonicalize().unwrap();
        GitFixture::init(&repo);
        std::fs::write(repo.join("a.txt"), "base\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "base"]);
        let paths = Paths::under(&state_dir.path().canonicalize().unwrap());
        Scratch {
            _repo: repo_dir,
            _state: state_dir,
            repo,
            paths,
        }
    }

    impl Scratch {
        fn ask(&self, action: ControlAction, fields: serde_json::Value) -> LoopAnswer {
            let mut payload = fields;
            payload["project_dir"] = serde_json::json!(self.repo.to_str().unwrap());
            payload["request_id"] = serde_json::json!("r1");
            docket_loop_body(&self.paths, action, &serde_json::to_vec(&payload).unwrap())
        }

        fn park(&self) -> LoopAnswer {
            self.ask(
                ControlAction::ArcPark,
                serde_json::json!({ "arc": "old", "successor": "old-v2", "boundary": "tip" }),
            )
        }

        fn log(&self) -> String {
            std::fs::read_to_string(tugtool_core::paths::arc_log_path_at(
                &self.paths,
                &self.repo,
            ))
            .unwrap_or_default()
        }
    }

    #[test]
    fn a_stopped_arc_is_parked_at_once_and_a_repeat_answers_the_same_commit() {
        let s = scratch();
        append_arc_start(&s.paths, &s.repo, "old", ".tug/arcs/old/brief.md").unwrap();
        append_arc_stop(
            &s.paths,
            &s.repo,
            "old",
            ArcStage::Devise,
            ArcStopReason::StoppedByUser,
        )
        .unwrap();
        let tip = git(&s.repo, &["rev-parse", "HEAD"]);

        let first = s.park();
        assert_eq!(first.body["action"], "arc_park_ok", "{}", first.body);
        assert_eq!(first.body["parked"], true);
        assert_eq!(first.body["from"], tip.trim(), "no branch: the base tip");
        assert!(first.wake.is_none());
        let record = read_arc(&s.paths, &s.repo, "old").unwrap();
        assert_eq!(record.stopped.unwrap().1, "parked");
        assert!(record.park.unwrap().honoured);

        let lines = s.log().lines().count();
        let again = s.park();
        assert_eq!(again.body["parked"], true);
        assert_eq!(again.body["from"], first.body["from"]);
        assert_eq!(s.log().lines().count(), lines, "a repeat writes nothing");
    }

    #[test]
    fn a_running_arc_waits_for_its_boundary() {
        let s = scratch();
        append_arc_start(&s.paths, &s.repo, "old", ".tug/arcs/old/brief.md").unwrap();
        append_arc_stage(&s.paths, &s.repo, "old", ArcStage::Review, "sess", None).unwrap();
        let answer = s.park();
        assert_eq!(answer.body["action"], "arc_park_ok", "{}", answer.body);
        assert_eq!(answer.body["parked"], false);
        assert_eq!(answer.body["waiting"], "review");
        assert_eq!(answer.wake.as_deref(), Some("old"));
        let record = read_arc(&s.paths, &s.repo, "old").unwrap();
        assert!(record.stopped.is_none());
        assert!(!record.park.unwrap().honoured);
    }

    #[test]
    fn park_refuses_an_unknown_arc_and_a_bad_boundary() {
        let s = scratch();
        let none = s.park();
        assert_eq!(none.body["action"], "arc_park_err", "{}", none.body);
        append_arc_start(&s.paths, &s.repo, "old", ".tug/arcs/old/brief.md").unwrap();
        let bad = s.ask(
            ControlAction::ArcPark,
            serde_json::json!({ "arc": "old", "successor": "old-v2", "boundary": "later" }),
        );
        assert_eq!(bad.body["action"], "arc_park_err", "{}", bad.body);
    }

    const BRIEF_V1: &str = "# Brief\n\n**[B01] Keep the arc.** The arc keeps its brief.\n";
    const BRIEF_V2: &str = "# Brief\n\n**[B01] Keep the arc.** The arc keeps its brief.\n\n**[B02] File additions.** Added decisions become ideas.\n";
    const TASKS: &str = "# Tasks\n";

    /// An arc on brief v1 of a sketch whose newest brief is v2, threaded on a
    /// docket through its sketch.
    fn stale_arc(s: &Scratch) -> String {
        use tugarc_core::sketch;
        let d = docket::create_docket(&s.paths, &s.repo, "Line").unwrap();
        let made = idea::create_idea(&s.paths, &s.repo, "The line", None).unwrap();
        let item = docket::resolve_item(
            &s.paths,
            &s.repo,
            &FileItem::Idea {
                id: made.id.clone(),
            },
        )
        .unwrap();
        docket::file_items(&s.paths, &s.repo, &d.id, &[item]).unwrap();
        let kept = sketch::keep_sketch(
            &s.paths,
            &s.repo,
            &made.id,
            "# Sketch\n\nWant it.\n\nSource: session x, turns 1–2\n",
        )
        .unwrap();
        let brief = s.repo.join("briefs/old.md");
        std::fs::create_dir_all(brief.parent().unwrap()).unwrap();
        std::fs::write(&brief, BRIEF_V1).unwrap();
        sketch::record_brief(&s.paths, &s.repo, &kept.id, &brief, 1, None).unwrap();
        std::fs::write(&brief, BRIEF_V2).unwrap();
        sketch::record_brief(&s.paths, &s.repo, &kept.id, &brief, 1, None).unwrap();
        let dir = s.repo.join(".tug/arcs/old");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("brief.md"), BRIEF_V1).unwrap();
        std::fs::write(dir.join("tasks.md"), TASKS).unwrap();
        append_arc_start(&s.paths, &s.repo, "old", ".tug/arcs/old/brief.md").unwrap();
        tugarc_core::log::append_arc_log(&s.paths, &s.repo, "old", "arc-sketch", &kept.id).unwrap();
        d.id
    }

    #[test]
    fn keep_going_writes_the_line_and_files_one_idea_per_added_decision() {
        let s = scratch();
        let docket_id = stale_arc(&s);
        let answer = s.ask(
            ControlAction::ArcKeepGoing,
            serde_json::json!({ "arc": "old", "version": 2, "docket_id": docket_id }),
        );
        assert_eq!(
            answer.body["action"], "arc_keep_going_ok",
            "{}",
            answer.body
        );
        assert_eq!(answer.body["kept_through"], 2);
        let ideas = answer.body["ideas"].as_array().unwrap();
        assert_eq!(ideas.len(), 1);
        let id = ideas[0].as_str().unwrap();
        let made = idea::idea_in(&s.paths, &s.repo, id).unwrap();
        assert_eq!(made.text, "B02 File additions");
        assert!(matches!(
            made.origin.unwrap().kind,
            IdeaOriginKind::BriefDecision { ref label, version: 2 } if label == "B02"
        ));
        let held = docket::dockets(&s.paths, &s.repo, true);
        assert!(
            held[0]
                .items
                .iter()
                .any(|i| i.key() == format!("idea:{id}"))
        );
        assert_eq!(
            read_arc(&s.paths, &s.repo, "old").unwrap().brief_kept,
            Some(2)
        );

        // A second press files nothing more.
        let again = s.ask(
            ControlAction::ArcKeepGoing,
            serde_json::json!({ "arc": "old", "version": 2, "docket_id": docket_id }),
        );
        assert_eq!(
            again.body["ideas"].as_array().unwrap().len(),
            0,
            "{}",
            again.body
        );
    }

    /// An arc on a docket with two follow-ups, and the generation's start.
    fn followed_arc(s: &Scratch) -> (String, String) {
        let docket_id = stale_arc(s);
        for line in ["Name the rails", "Paint the rails"] {
            tugarc_core::arc::append_arc_follow_up(&s.paths, &s.repo, "old", line).unwrap();
        }
        let created = s
            .log()
            .lines()
            .find(|l| l.contains("arc-start"))
            .and_then(|l| l.split_whitespace().next())
            .unwrap()
            .to_string();
        (docket_id, created)
    }

    #[test]
    fn follow_up_accept_files_exactly_one_idea_and_writes_the_line() {
        let s = scratch();
        let (docket_id, created) = followed_arc(&s);
        let before = idea::ideas(&s.paths, &s.repo).len();
        let answer = s.ask(
            ControlAction::FollowUpAccept,
            serde_json::json!({ "arc": "old", "created": created, "k": 1, "docket_id": docket_id }),
        );
        assert_eq!(
            answer.body["action"], "follow_up_accept_ok",
            "{}",
            answer.body
        );
        let id = answer.body["idea"].as_str().unwrap().to_string();
        assert_eq!(
            idea::ideas(&s.paths, &s.repo).len(),
            before + 1,
            "exactly one idea"
        );
        let made = idea::idea_in(&s.paths, &s.repo, &id).unwrap();
        assert_eq!(made.text, "Name the rails");
        assert!(matches!(
            made.origin.unwrap().kind,
            IdeaOriginKind::FollowUp { k: 1 }
        ));
        let held = docket::dockets(&s.paths, &s.repo, true);
        assert!(
            held[0]
                .items
                .iter()
                .any(|i| i.key() == format!("idea:{id}"))
        );
        assert!(
            s.log()
                .contains(&format!("follow-up-accepted  {created} 1 {id}")),
            "{}",
            s.log()
        );

        // A second answer to the same follow-up is refused, and makes nothing.
        let again = s.ask(
            ControlAction::FollowUpAccept,
            serde_json::json!({ "arc": "old", "created": created, "k": 1, "docket_id": docket_id }),
        );
        assert_eq!(
            again.body["action"], "follow_up_accept_err",
            "{}",
            again.body
        );
        assert_eq!(idea::ideas(&s.paths, &s.repo).len(), before + 1);
    }

    /// A revert request that does not say `dry_run: false` commits nothing;
    /// one that does commits the revert and records it, and a second is
    /// refused naming the first.
    #[test]
    fn arc_revert_is_a_dry_run_unless_it_asks_to_commit() {
        let s = scratch();
        std::fs::write(s.repo.join("a.txt"), "rail\n").unwrap();
        git(&s.repo, &["add", "-A"]);
        git(
            &s.repo,
            &[
                "commit",
                "-q",
                "-m",
                "Lay the rail\n\nTug-Arc: tugarc/rail onto main",
            ],
        );
        let join = git(&s.repo, &["rev-parse", "--short", "HEAD"])
            .trim()
            .to_owned();
        let log = tugtool_core::paths::arc_log_path_at(&s.paths, &s.repo);
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        std::fs::write(
            &log,
            format!(
                "2026-11-01T00:00:00Z  rail  arc-start  brief.md\n2026-11-01T00:00:05Z  rail  {join}  joined via card\n"
            ),
        )
        .unwrap();
        let head = git(&s.repo, &["rev-parse", "HEAD"]);

        let dry = s.ask(
            ControlAction::ArcRevert,
            serde_json::json!({ "arc": "rail" }),
        );
        assert_eq!(dry.body["action"], "arc_revert_ok", "{}", dry.body);
        assert_eq!(dry.body["paths"], 1);
        assert!(dry.body.get("reverted").is_none(), "{}", dry.body);
        assert_eq!(git(&s.repo, &["rev-parse", "HEAD"]), head);

        let real = s.ask(
            ControlAction::ArcRevert,
            serde_json::json!({ "arc": "rail", "dry_run": false }),
        );
        assert_eq!(real.body["action"], "arc_revert_ok", "{}", real.body);
        let revert = real.body["reverted"].as_str().unwrap().to_owned();
        assert_eq!(git(&s.repo, &["rev-parse", "HEAD"]).trim(), revert);
        assert!(
            s.log().contains(&format!("reverted  {revert} ")),
            "{}",
            s.log()
        );

        let again = s.ask(
            ControlAction::ArcRevert,
            serde_json::json!({ "arc": "rail", "dry_run": false }),
        );
        assert_eq!(again.body["action"], "arc_revert_err", "{}", again.body);
        assert!(again.body.to_string().contains(&revert), "{}", again.body);
    }

    #[test]
    fn follow_up_dismiss_writes_only_its_line() {
        let s = scratch();
        let (_, created) = followed_arc(&s);
        let ideas = idea::ideas(&s.paths, &s.repo).len();
        let lines = s.log().lines().count();
        let answer = s.ask(
            ControlAction::FollowUpDismiss,
            serde_json::json!({ "arc": "old", "created": created, "k": 2 }),
        );
        assert_eq!(
            answer.body["action"], "follow_up_dismiss_ok",
            "{}",
            answer.body
        );
        assert_eq!(answer.body["k"], 2);
        assert_eq!(s.log().lines().count(), lines + 1);
        assert!(
            s.log()
                .ends_with(&format!("follow-up-dismissed  {created} 2\n")),
            "{}",
            s.log()
        );
        assert_eq!(
            idea::ideas(&s.paths, &s.repo).len(),
            ideas,
            "no idea is made"
        );

        let unknown = s.ask(
            ControlAction::FollowUpDismiss,
            serde_json::json!({ "arc": "old", "created": created, "k": 9 }),
        );
        assert_eq!(
            unknown.body["action"], "follow_up_dismiss_err",
            "{}",
            unknown.body
        );
    }
}
