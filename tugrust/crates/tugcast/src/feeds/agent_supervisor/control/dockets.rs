//! The docket family of CONTROL actions: `docket_create`, `docket_rename`,
//! `docket_retire`, `docket_file`, `docket_remove`, `resolve_dockets` and
//! `search_dockets` — every write the Docket card makes, and the reads behind
//! a docket's atom and its `@`-completion.
//!
//! Each verb is one pure function over the data root and the request's bytes,
//! so the tests drive it without a supervisor. Every write goes through
//! `tugarc_core::docket`, the store's one writer; the reply says only how the
//! gesture went, and the DOCKETS feed carries what the store now holds.

use super::super::*;
use super::records::{refusal, request_id_of};
use super::request::{MAX_ENTRIES, Request};
use std::path::Path;
use tugarc_core::docket::{self, FileItem, FileOutcome};
use tugarc_core::docket_threads::{derive_threads, gather_inputs};
use tugcast_core::ControlAction;
use tugcore::instance::Paths;

/// The most rows `search_dockets` answers with.
const SEARCH_LIMIT: usize = 20;

/// The key a placed item is reported under when it never resolved: what the
/// atom named, in the store's key grammar where it can be.
fn placed_key(item: &FileItem) -> String {
    match item {
        FileItem::Arc { name, created, .. } => match created {
            Some(c) => format!("arc:{name}@{c}"),
            None => format!("arc:{name}"),
        },
        FileItem::Sketch { id } => format!("sketch:{id}"),
        FileItem::Idea { id } => format!("idea:{id}"),
        FileItem::Session { uuid, callsign, .. } => format!(
            "session:{}",
            uuid.as_deref().or(callsign.as_deref()).unwrap_or("")
        ),
        FileItem::Commit { sha } => format!("commit:{sha}"),
        FileItem::Brief { path } => format!("brief:{path}"),
        FileItem::Unfileable => "unfileable".to_owned(),
    }
}

/// File what the atoms name: each item resolved against the checkout, the
/// resolved ones filed in one store write, and one outcome per item placed,
/// in the order placed.
fn file_body(paths: &Paths, req: &Request, verb: &str) -> Result<serde_json::Value, String> {
    let id = req.text(verb, "id")?;
    let placed: Vec<serde_json::Value> = req
        .value
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("{verb} payload is missing items"))?
        .iter()
        .take(MAX_ENTRIES)
        .cloned()
        .collect();
    // Each placed item is either resolved (and filed below) or refused now.
    let mut resolved = Vec::new();
    let mut slots: Vec<Result<(), FileOutcome>> = Vec::with_capacity(placed.len());
    for value in placed {
        let item = match serde_json::from_value::<FileItem>(value) {
            Ok(item) => item,
            Err(_) => {
                slots.push(Err(FileOutcome::refused(
                    "unfileable",
                    "That is not something a docket can hold.",
                )));
                continue;
            }
        };
        match docket::resolve_item(paths, req.repo(), &item) {
            Ok(r) => {
                resolved.push(r);
                slots.push(Ok(()));
            }
            Err(reason) => slots.push(Err(FileOutcome::refused(placed_key(&item), reason))),
        }
    }
    let mut filed = if resolved.is_empty() {
        // Nothing to write — but an unknown docket is still an unknown one.
        if docket::dockets(paths, req.repo(), true)
            .iter()
            .all(|d| d.id != id)
        {
            return Err(format!("No docket {id} in this checkout."));
        }
        Vec::new()
    } else {
        docket::file_items(paths, req.repo(), &id, &resolved).map_err(|e| e.to_string())?
    }
    .into_iter();
    let outcomes: Vec<FileOutcome> = slots
        .into_iter()
        .filter_map(|slot| match slot {
            Ok(()) => filed.next(),
            Err(refused) => Some(refused),
        })
        .collect();
    Ok(req.ok(verb, serde_json::json!({ "id": id, "outcomes": outcomes })))
}

/// `resolve_dockets`: each asked id in exactly one of `found` and `missing`,
/// looked for under every checkout on this machine; when two hold it, the
/// asking checkout's copy answers, else the first.
fn resolve_body(paths: &Paths, req: &Request, verb: &str) -> Result<serde_json::Value, String> {
    let ids = req.strings(verb, "ids")?;
    // [L29]: compared through the gateway, the form the store keeps.
    let here = crate::path_resolver::CanonicalPath::from_raw(req.repo());
    let here = here.as_str();
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for id in ids {
        let mut held = docket::find_docket(paths, &id);
        if held.is_empty() {
            missing.push(id);
            continue;
        }
        let pick = held
            .iter()
            .position(|(_, d)| d.project_dir == here)
            .unwrap_or(0);
        let (_, d) = held.swap_remove(pick);
        let threads = derive_threads(&gather_inputs(paths, Path::new(&d.project_dir), &d));
        found.push(serde_json::json!({
            "id": d.id,
            "name": d.name,
            "project_dir": d.project_dir,
            "retired": d.retired(),
            "threads": threads,
        }));
    }
    Ok(req.ok(
        verb,
        serde_json::json!({
            "project_dir": req.project_dir,
            "project_key": here,
            "found": found,
            "missing": missing,
        }),
    ))
}

/// `search_dockets`: this checkout's dockets, newest first, at most
/// [`SEARCH_LIMIT`], matching `query` case-insensitively against the name or
/// as a prefix of the id. An empty query answers the newest.
fn search_body(paths: &Paths, req: &Request, verb: &str) -> serde_json::Value {
    let needle = req
        .value
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let rows: Vec<serde_json::Value> = docket::dockets(paths, req.repo(), true)
        .into_iter()
        .filter(|d| {
            needle.is_empty()
                || d.id.starts_with(&needle)
                || d.name.to_lowercase().contains(&needle)
        })
        .take(SEARCH_LIMIT)
        .map(|d| {
            serde_json::json!({
                "id": d.id,
                "name": d.name,
                "project_dir": d.project_dir,
                "retired": d.retired(),
            })
        })
        .collect();
    req.ok(verb, serde_json::json!({ "dockets": rows }))
}

/// One docket verb, start to finish: its `_ok` frame, or the `_err` frame
/// `records.rs` answers every malformed or refused ask with.
pub(super) fn docket_body(
    paths: &Paths,
    action: ControlAction,
    payload: &[u8],
) -> serde_json::Value {
    let verb = action.as_str();
    let req = match Request::parse(verb, payload) {
        Ok(req) => req,
        Err(message) => return refusal(verb, message, request_id_of(payload).as_deref()),
    };
    let store = |e: tugarc_core::ArcError| e.to_string();
    let body = match action {
        ControlAction::DocketCreate => req.text(verb, "name").and_then(|name| {
            let d = docket::create_docket(paths, req.repo(), &name).map_err(store)?;
            Ok(req.ok(
                verb,
                serde_json::json!({ "docket": { "id": d.id, "name": d.name } }),
            ))
        }),
        ControlAction::DocketRename => req.text(verb, "id").and_then(|id| {
            let name = req.text(verb, "name")?;
            let d = docket::rename_docket(paths, req.repo(), &id, &name).map_err(store)?;
            Ok(req.ok(verb, serde_json::json!({ "id": d.id, "name": d.name })))
        }),
        ControlAction::DocketRetire => req.text(verb, "id").and_then(|id| {
            let retired = req
                .value
                .get("retired")
                .and_then(|v| v.as_bool())
                .ok_or_else(|| format!("{verb} payload is missing retired"))?;
            let d = docket::retire_docket(paths, req.repo(), &id, retired).map_err(store)?;
            Ok(req.ok(
                verb,
                serde_json::json!({ "id": d.id, "retired": d.retired() }),
            ))
        }),
        ControlAction::DocketFile => file_body(paths, &req, verb),
        ControlAction::DocketRemove => req.text(verb, "id").and_then(|id| {
            let keys = req.strings(verb, "keys")?;
            let removed = docket::remove_items(paths, req.repo(), &id, &keys).map_err(store)?;
            Ok(req.ok(verb, serde_json::json!({ "id": id, "removed": removed })))
        }),
        ControlAction::ResolveDockets => resolve_body(paths, &req, verb),
        ControlAction::SearchDockets => Ok(search_body(paths, &req, verb)),
        _ => Err(format!("{verb} is not a docket verb")),
    };
    body.unwrap_or_else(|message| refusal(verb, message, req.request_id.as_deref()))
}

impl AgentSupervisor {
    /// The docket family's share of [`AgentSupervisor::handle_control`]. Every
    /// verb walks files, and the writes take the store's lock, so each runs
    /// off the reactor.
    pub(in crate::feeds::agent_supervisor) async fn handle_docket_control(
        &self,
        action: ControlAction,
        payload: &[u8],
    ) -> ControlOutcome {
        let verb = action.as_str();
        let owned = payload.to_vec();
        let body =
            tokio::task::spawn_blocking(move || docket_body(&Paths::from_env(), action, &owned))
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
    use tugarc_core::log::append_arc_log;

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
            docket_body(&self.paths, action, &serde_json::to_vec(&payload).unwrap())
        }

        fn create(&self, name: &str) -> String {
            let body = self.ask(
                ControlAction::DocketCreate,
                serde_json::json!({ "name": name, "request_id": "r1" }),
            );
            assert_eq!(body["action"], "docket_create_ok", "{body}");
            assert_eq!(body["request_id"], "r1");
            assert_eq!(body["docket"]["name"], name);
            body["docket"]["id"].as_str().unwrap().to_owned()
        }
    }

    #[test]
    fn a_docket_is_made_filed_onto_moved_from_and_emptied() {
        let s = scratch();
        append_arc_log(&s.paths, &s.repo, "rail", "arc-start", "").unwrap();
        let rail = s.create("Rail work");
        let other = s.create("Other work");

        let filed = s.ask(
            ControlAction::DocketFile,
            serde_json::json!({ "id": rail, "items": [{ "kind": "arc", "name": "rail" }] }),
        );
        assert_eq!(filed["action"], "docket_file_ok", "{filed}");
        let outcome = &filed["outcomes"][0];
        assert_eq!(outcome["outcome"], "filed");
        let key = outcome["key"].as_str().unwrap().to_owned();
        assert!(key.starts_with("arc:rail@"), "{key}");

        let moved = s.ask(
            ControlAction::DocketFile,
            serde_json::json!({ "id": other, "items": [{ "kind": "arc", "name": "rail" }] }),
        );
        let outcome = &moved["outcomes"][0];
        assert_eq!(outcome["outcome"], "moved", "{moved}");
        assert_eq!(outcome["from"]["id"], rail.as_str());
        assert_eq!(outcome["from"]["name"], "Rail work");

        let removed = s.ask(
            ControlAction::DocketRemove,
            serde_json::json!({ "id": other, "keys": [key] }),
        );
        assert_eq!(removed["action"], "docket_remove_ok", "{removed}");
        assert_eq!(removed["removed"], serde_json::json!([key]));

        let renamed = s.ask(
            ControlAction::DocketRename,
            serde_json::json!({ "id": other, "name": "Later" }),
        );
        assert_eq!(renamed["name"], "Later", "{renamed}");
        let retired = s.ask(
            ControlAction::DocketRetire,
            serde_json::json!({ "id": other, "retired": true }),
        );
        assert_eq!(retired["retired"], true, "{retired}");

        let found = s.ask(
            ControlAction::SearchDockets,
            serde_json::json!({ "query": "rail" }),
        );
        let names: Vec<&str> = found["dockets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["Rail work"]);

        let resolved = s.ask(
            ControlAction::ResolveDockets,
            serde_json::json!({ "ids": [rail, "00ff00ff"] }),
        );
        assert_eq!(resolved["action"], "resolve_dockets_ok", "{resolved}");
        assert_eq!(resolved["found"][0]["name"], "Rail work");
        assert_eq!(resolved["found"][0]["threads"], serde_json::json!([]));
        assert_eq!(resolved["missing"], serde_json::json!(["00ff00ff"]));
        assert_eq!(
            resolved["project_key"],
            crate::path_resolver::CanonicalPath::from_raw(&s.repo).as_str()
        );
    }

    #[test]
    fn refusals_name_what_was_wrong() {
        let s = scratch();
        let rail = s.create("Rail work");

        let no_project = docket_body(
            &s.paths,
            ControlAction::DocketCreate,
            br#"{"name": "X", "request_id": "r9"}"#,
        );
        assert_eq!(no_project["action"], "docket_create_err");
        assert_eq!(no_project["request_id"], "r9");
        assert!(
            no_project["message"]
                .as_str()
                .unwrap()
                .contains("project_dir"),
            "{no_project}"
        );

        let unknown = s.ask(
            ControlAction::DocketRename,
            serde_json::json!({ "id": "00ff00ff", "name": "Y" }),
        );
        assert_eq!(unknown["action"], "docket_rename_err", "{unknown}");
        let unknown_file = s.ask(
            ControlAction::DocketFile,
            serde_json::json!({ "id": "00ff00ff", "items": [{ "kind": "nonsense" }] }),
        );
        assert_eq!(unknown_file["action"], "docket_file_err", "{unknown_file}");

        let duplicate = s.ask(
            ControlAction::DocketCreate,
            serde_json::json!({ "name": "rail WORK" }),
        );
        assert_eq!(duplicate["action"], "docket_create_err", "{duplicate}");

        // Another checkout's arc is refused item by item, and the docket's
        // other items still file.
        append_arc_log(&s.paths, &s.other, "elsewhere", "arc-start", "").unwrap();
        let mixed = s.ask(
            ControlAction::DocketFile,
            serde_json::json!({ "id": rail, "items": [
                { "kind": "arc", "name": "elsewhere", "project_dir": s.other.to_str().unwrap() },
                { "kind": "nonsense" },
            ] }),
        );
        assert_eq!(mixed["action"], "docket_file_ok", "{mixed}");
        let outcomes = mixed["outcomes"].as_array().unwrap();
        assert_eq!(outcomes.len(), 2);
        assert_eq!(outcomes[0]["key"], "arc:elsewhere");
        assert_eq!(outcomes[0]["outcome"], "refused");
        assert_eq!(outcomes[0]["reason"], docket::NOT_THIS_CHECKOUT);
        assert_eq!(outcomes[1]["outcome"], "refused");
    }
}
