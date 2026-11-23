//! The idea family of CONTROL actions: `idea_create`, `idea_add_session`,
//! `resolve_ideas`, `search_ideas`, `sketch_read` and `sketch_edit` — the
//! Docket card's capture field, the Sketch it gesture's session record, the
//! reads behind an idea's atom and its `@`-completion, and the card's sketch
//! editor.
//!
//! Each verb is one pure function over the data root and the request's bytes,
//! so the tests drive it without a supervisor. Every write goes through
//! `tugarc_core`'s idea and sketch stores, their one writers; the DOCKETS feed
//! carries what the stores now hold.

use super::super::*;
use super::records::{refusal, request_id_of};
use super::request::Request;
use tugarc_core::docket::{self, DocketItem, FileItem, FileOutcome};
use tugarc_core::idea;
use tugarc_core::sketch;
use tugcast_core::ControlAction;
use tugcore::instance::Paths;

/// The most rows `search_ideas` answers with.
const SEARCH_LIMIT: usize = 20;

/// `idea_create`: make the idea, then file it onto the named docket. The
/// docket must be this checkout's; a filing the docket refuses (a retired
/// docket) leaves the idea in the store, and the outcome says why.
fn create_body(paths: &Paths, req: &Request, verb: &str) -> Result<serde_json::Value, String> {
    let docket_id = req.text(verb, "docket_id")?;
    let text = req.text(verb, "text")?;
    let body = req.opt_text("body");
    if docket::dockets(paths, req.repo(), true)
        .iter()
        .all(|d| d.id != docket_id)
    {
        return Err(format!("No docket {docket_id} in this checkout."));
    }
    let made =
        idea::create_idea(paths, req.repo(), &text, body.as_deref()).map_err(|e| e.to_string())?;
    let key = format!("idea:{}", made.id);
    let outcome = match docket::resolve_item(
        paths,
        req.repo(),
        &FileItem::Idea {
            id: made.id.clone(),
        },
    ) {
        Ok(resolved) => docket::file_items(paths, req.repo(), &docket_id, &[resolved])
            .map(|mut out| out.remove(0))
            .unwrap_or_else(|e| FileOutcome::refused(key, e.to_string())),
        Err(reason) => FileOutcome::refused(key, reason),
    };
    Ok(req.ok(
        verb,
        serde_json::json!({
            "idea": { "id": made.id, "text": made.text },
            "outcome": outcome,
        }),
    ))
}

/// The docket in checkout `repo` holding `idea:<id>`, retired or not.
fn docket_of(paths: &Paths, repo: &std::path::Path, id: &str) -> Option<serde_json::Value> {
    docket::dockets(paths, repo, true)
        .into_iter()
        .find(|d| {
            d.items
                .iter()
                .any(|item| matches!(item, DocketItem::Idea { id: held, .. } if held == id))
        })
        .map(|d| serde_json::json!({ "id": d.id, "name": d.name }))
}

/// The newest sketch kept from idea `id` in checkout `repo`: its id and latest
/// version.
fn sketch_of(paths: &Paths, repo: &std::path::Path, id: &str) -> Option<serde_json::Value> {
    sketch::sketches(paths, repo)
        .into_iter()
        .filter(|s| s.idea.as_deref() == Some(id))
        .max_by(|a, b| a.created.cmp(&b.created))
        .map(|s| serde_json::json!({ "id": s.id, "version": s.latest() }))
}

/// `resolve_ideas`: one row per asked id, looked for under every checkout on
/// this machine; when two hold it, the asking checkout's copy answers.
fn resolve_body(paths: &Paths, req: &Request, verb: &str) -> Result<serde_json::Value, String> {
    let ids = req.strings(verb, "ids")?;
    // [L29]: compared through the gateway, the form the store keeps.
    let here = crate::path_resolver::CanonicalPath::from_raw(req.repo());
    let here = here.as_str();
    let rows: Vec<serde_json::Value> = ids
        .into_iter()
        .map(|id| {
            let mut held = idea::find_idea(paths, &id);
            if held.is_empty() {
                return serde_json::json!({ "id": id, "found": false });
            }
            let pick = held
                .iter()
                .position(|(_, r)| r.project_dir == here)
                .unwrap_or(0);
            let (_, record) = held.swap_remove(pick);
            let checkout = std::path::Path::new(&record.project_dir);
            let docket = docket_of(paths, checkout, &id);
            let kept = sketch_of(paths, checkout, &id);
            serde_json::json!({
                "id": record.id,
                "found": true,
                "project_dir": record.project_dir,
                "text": record.text,
                "docket": docket,
                "sketch": kept,
            })
        })
        .collect();
    Ok(req.ok(
        verb,
        serde_json::json!({
            "project_dir": req.project_dir,
            "project_key": here,
            "ideas": rows,
        }),
    ))
}

/// `search_ideas`: this checkout's ideas, newest first, at most
/// [`SEARCH_LIMIT`], matching `query` case-insensitively against the text or
/// as a prefix of the id. An empty query answers the newest.
fn search_body(paths: &Paths, req: &Request, verb: &str) -> serde_json::Value {
    let needle = req
        .opt_text("query")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let rows: Vec<serde_json::Value> = idea::ideas(paths, req.repo())
        .into_iter()
        .filter(|i| {
            needle.is_empty()
                || i.id.starts_with(&needle)
                || i.text.to_lowercase().contains(&needle)
        })
        .take(SEARCH_LIMIT)
        .map(|i| serde_json::json!({ "id": i.id, "text": i.text }))
        .collect();
    req.ok(verb, serde_json::json!({ "ideas": rows }))
}

/// `sketch_read`: a version of the sketch's text, or with `brief` one of its
/// brief versions' snapshot, with the lists the editor's version menu reads.
fn read_body(paths: &Paths, req: &Request, verb: &str) -> Result<serde_json::Value, String> {
    let id = req.text(verb, "id")?;
    let record = sketch::sketch_in(paths, req.repo(), &id)
        .ok_or_else(|| format!("No sketch {id} in this checkout."))?;
    let version = req.opt_number("version");
    let brief = req.opt_number("brief");
    let text = match brief {
        Some(n) => sketch::read_brief_version(&record, n),
        None => sketch::read_version(&record, version),
    }
    .map_err(|e| e.to_string())?;
    let versions: Vec<serde_json::Value> = record
        .versions
        .iter()
        .map(|v| serde_json::json!({ "n": v.n, "at": v.at, "author": v.author }))
        .collect();
    let briefs: Vec<serde_json::Value> = record
        .briefs
        .iter()
        .map(|b| {
            serde_json::json!({
                "n": b.n,
                "at": b.at,
                "title": b.title,
                "sketch_version": b.sketch_version,
            })
        })
        .collect();
    let mut fields = serde_json::json!({
        "id": record.id,
        "version": version.unwrap_or_else(|| record.latest()),
        "versions": versions,
        "briefs": briefs,
        "text": text,
    });
    if let Some(n) = brief {
        fields["brief"] = serde_json::json!(n);
    }
    Ok(req.ok(verb, fields))
}

/// One idea verb, start to finish: its `_ok` frame, or the `_err` frame
/// `records.rs` answers every malformed or refused ask with.
pub(super) fn idea_body(paths: &Paths, action: ControlAction, payload: &[u8]) -> serde_json::Value {
    let verb = action.as_str();
    let req = match Request::parse(verb, payload) {
        Ok(req) => req,
        Err(message) => return refusal(verb, message, request_id_of(payload).as_deref()),
    };
    let store = |e: tugarc_core::ArcError| e.to_string();
    let body = match action {
        ControlAction::IdeaCreate => create_body(paths, &req, verb),
        ControlAction::IdeaAddSession => req.text(verb, "id").and_then(|id| {
            let uuid = req.text(verb, "uuid")?;
            let record = idea::add_session(paths, req.repo(), &id, &uuid).map_err(store)?;
            Ok(req.ok(
                verb,
                serde_json::json!({ "id": record.id, "sessions": record.sessions }),
            ))
        }),
        ControlAction::ResolveIdeas => resolve_body(paths, &req, verb),
        ControlAction::SearchIdeas => Ok(search_body(paths, &req, verb)),
        ControlAction::SketchRead => read_body(paths, &req, verb),
        ControlAction::SketchEdit => req.text(verb, "id").and_then(|id| {
            let text = req.text(verb, "text")?;
            let base = req.number(verb, "base_version")?;
            let out = sketch::edit_sketch(paths, req.repo(), &id, &text, base).map_err(store)?;
            Ok(req.ok(
                verb,
                serde_json::json!({ "id": out.id, "version": out.version }),
            ))
        }),
        _ => Err(format!("{verb} is not an idea verb")),
    };
    body.unwrap_or_else(|message| refusal(verb, message, req.request_id.as_deref()))
}

impl AgentSupervisor {
    /// The idea family's share of [`AgentSupervisor::handle_control`]. Every
    /// verb walks files, and the writes take a store's lock, so each runs off
    /// the reactor.
    pub(in crate::feeds::agent_supervisor) async fn handle_idea_control(
        &self,
        action: ControlAction,
        payload: &[u8],
    ) -> ControlOutcome {
        let verb = action.as_str();
        let owned = payload.to_vec();
        let body =
            tokio::task::spawn_blocking(move || idea_body(&Paths::from_env(), action, &owned))
                .await
                .unwrap_or_else(|err| {
                    refusal(
                        verb,
                        format!("{verb} task failed: {err}"),
                        request_id_of(payload).as_deref(),
                    )
                });
        send_control(&self.control_tx, body);
        ControlOutcome::Handled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEPT: &str = "# Sketch\n\nWant the inbox.\n\nSource: session x, turns 1–2\n";

    struct Scratch {
        _repo: tempfile::TempDir,
        _other: tempfile::TempDir,
        _state: tempfile::TempDir,
        repo: std::path::PathBuf,
        other: std::path::PathBuf,
        paths: Paths,
    }

    fn scratch() -> Scratch {
        let repo_dir = tempfile::tempdir().unwrap();
        let other_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let repo = repo_dir.path().canonicalize().unwrap();
        let other = other_dir.path().canonicalize().unwrap();
        let paths = Paths::under(&state_dir.path().canonicalize().unwrap());
        Scratch {
            _repo: repo_dir,
            _other: other_dir,
            _state: state_dir,
            repo,
            other,
            paths,
        }
    }

    impl Scratch {
        fn ask(&self, action: ControlAction, fields: serde_json::Value) -> serde_json::Value {
            let mut payload = fields;
            if payload.get("project_dir").is_none() {
                payload["project_dir"] = serde_json::json!(self.repo.to_str().unwrap());
            }
            idea_body(&self.paths, action, &serde_json::to_vec(&payload).unwrap())
        }

        fn docket(&self, name: &str) -> String {
            docket::create_docket(&self.paths, &self.repo, name)
                .unwrap()
                .id
        }

        fn create(&self, docket_id: &str, text: &str) -> serde_json::Value {
            self.ask(
                ControlAction::IdeaCreate,
                serde_json::json!({ "docket_id": docket_id, "text": text, "request_id": "r1" }),
            )
        }
    }

    #[test]
    fn create_files_onto_the_docket_and_a_retired_docket_refuses_the_filing() {
        let s = scratch();
        let inbox = s.docket("Inbox");
        let made = s.create(&inbox, "An inbox for ideas");
        assert_eq!(made["action"], "idea_create_ok", "{made}");
        assert_eq!(made["request_id"], "r1");
        assert_eq!(made["idea"]["text"], "An inbox for ideas");
        let id = made["idea"]["id"].as_str().unwrap().to_owned();
        assert_eq!(made["outcome"]["outcome"], "filed");
        assert_eq!(made["outcome"]["key"], format!("idea:{id}"));
        let held = docket::dockets(&s.paths, &s.repo, true);
        assert!(
            held[0]
                .items
                .iter()
                .any(|i| i.key() == format!("idea:{id}")),
            "{held:?}"
        );

        docket::retire_docket(&s.paths, &s.repo, &inbox, true).unwrap();
        let refused = s.create(&inbox, "A second idea");
        assert_eq!(refused["action"], "idea_create_ok", "{refused}");
        assert_eq!(refused["outcome"]["outcome"], "refused");
        assert!(
            refused["outcome"]["reason"]
                .as_str()
                .unwrap()
                .contains("retired"),
            "{refused}"
        );
        // The idea is kept even though the docket would not take it.
        let second = refused["idea"]["id"].as_str().unwrap();
        assert!(idea::idea_in(&s.paths, &s.repo, second).is_some());

        let unknown = s.create("00ff00ff", "Nowhere");
        assert_eq!(unknown["action"], "idea_create_err", "{unknown}");
        assert_eq!(idea::ideas(&s.paths, &s.repo).len(), 2, "no idea made");

        let empty = s.create(&s.docket("Other"), "  ");
        assert_eq!(empty["action"], "idea_create_err", "{empty}");
    }

    #[test]
    fn add_session_appends_and_search_matches_the_text() {
        let s = scratch();
        let inbox = s.docket("Inbox");
        let id = s.create(&inbox, "Lineage threads")["idea"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        s.create(&inbox, "Something else");

        for uuid in ["u-1", "u-2", "u-1"] {
            let added = s.ask(
                ControlAction::IdeaAddSession,
                serde_json::json!({ "id": id, "uuid": uuid }),
            );
            assert_eq!(added["action"], "idea_add_session_ok", "{added}");
        }
        let record = idea::idea_in(&s.paths, &s.repo, &id).unwrap();
        let uuids: Vec<&str> = record.sessions.iter().map(|x| x.uuid.as_str()).collect();
        assert_eq!(uuids, vec!["u-1", "u-2"]);

        let found = s.ask(
            ControlAction::SearchIdeas,
            serde_json::json!({ "query": "LINEAGE" }),
        );
        assert_eq!(found["action"], "search_ideas_ok", "{found}");
        assert_eq!(found["ideas"].as_array().unwrap().len(), 1);
        assert_eq!(found["ideas"][0]["id"], id.as_str());
        let all = s.ask(ControlAction::SearchIdeas, serde_json::json!({}));
        assert_eq!(all["ideas"].as_array().unwrap().len(), 2, "{all}");
    }

    #[test]
    fn resolve_finds_an_idea_in_another_checkout() {
        let s = scratch();
        let inbox = s.docket("Inbox");
        let here = s.create(&inbox, "Here")["idea"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let there = idea::create_idea(&s.paths, &s.other, "There", None).unwrap();

        let resolved = s.ask(
            ControlAction::ResolveIdeas,
            serde_json::json!({ "ids": [here, there.id, "00ff00ff"] }),
        );
        assert_eq!(resolved["action"], "resolve_ideas_ok", "{resolved}");
        let rows = resolved["ideas"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["found"], true);
        assert_eq!(rows[0]["docket"]["id"], inbox.as_str());
        assert_eq!(rows[1]["found"], true);
        assert_eq!(rows[1]["text"], "There");
        assert_eq!(
            rows[1]["project_dir"],
            crate::path_resolver::CanonicalPath::from_raw(&s.other).as_str()
        );
        assert!(rows[1]["docket"].is_null(), "{resolved}");
        assert!(rows[0]["sketch"].is_null(), "{resolved}");
        assert_eq!(
            rows[2],
            serde_json::json!({ "id": "00ff00ff", "found": false })
        );
    }

    #[test]
    fn sketch_edit_refuses_a_stale_base_and_read_returns_a_brief_snapshot() {
        let s = scratch();
        let made = idea::create_idea(&s.paths, &s.repo, "Edit me", None).unwrap();
        let kept = sketch::keep_sketch(&s.paths, &s.repo, &made.id, KEPT).unwrap();

        let edited = s.ask(
            ControlAction::SketchEdit,
            serde_json::json!({ "id": kept.id, "text": "# Mine\n", "base_version": 1 }),
        );
        assert_eq!(edited["action"], "sketch_edit_ok", "{edited}");
        assert_eq!(edited["version"], 2);

        let stale = s.ask(
            ControlAction::SketchEdit,
            serde_json::json!({ "id": kept.id, "text": "# Late\n", "base_version": 1 }),
        );
        assert_eq!(stale["action"], "sketch_edit_err", "{stale}");
        assert_eq!(
            stale["message"],
            "The sketch moved to v2 while you were editing."
        );

        std::fs::create_dir_all(s.repo.join("briefs")).unwrap();
        let brief = "# The brief\n\nDecided.\n";
        std::fs::write(s.repo.join("briefs/edit-brief.md"), brief).unwrap();
        sketch::record_brief(
            &s.paths,
            &s.repo,
            &kept.id,
            std::path::Path::new("briefs/edit-brief.md"),
            1,
            None,
        )
        .unwrap();
        // The file moves on; the snapshot is what was kept.
        std::fs::write(s.repo.join("briefs/edit-brief.md"), "# Changed\n").unwrap();

        let read = s.ask(
            ControlAction::SketchRead,
            serde_json::json!({ "id": kept.id, "brief": 1 }),
        );
        assert_eq!(read["action"], "sketch_read_ok", "{read}");
        assert_eq!(read["text"], brief);
        assert_eq!(read["brief"], 1);
        assert_eq!(read["briefs"][0]["title"], "The brief");
        assert_eq!(read["briefs"][0]["sketch_version"], 1);
        assert_eq!(read["versions"][0]["author"], "model");
        assert_eq!(read["versions"][1]["author"], "user");

        let latest = s.ask(
            ControlAction::SketchRead,
            serde_json::json!({ "id": kept.id }),
        );
        assert_eq!(latest["version"], 2);
        assert_eq!(latest["text"], "# Mine\n");
        let first = s.ask(
            ControlAction::SketchRead,
            serde_json::json!({ "id": kept.id, "version": 1 }),
        );
        assert_eq!(first["text"], KEPT);
    }
}
