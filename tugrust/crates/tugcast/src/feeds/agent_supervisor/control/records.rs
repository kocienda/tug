//! The record family of CONTROL actions: `search_arcs`, `resolve_sketches`
//! and `search_sketches` — the reads behind an `@`-completion of an arc or a
//! sketch, and behind a cited sketch's chip.
//!
//! Each body is a pure function over the data root, the project's checkout
//! and the request, so the tests read it without a supervisor. The handlers
//! run the bodies off the reactor, because every one of them walks files.

use super::super::*;
use std::collections::BTreeSet;
use std::path::Path;
use tugarc_core::archive::{self, ArchiveEntry, ArchiveFate};
use tugarc_core::log::{GenerationEnd, arc_fates, arc_generations, generation_sketch_id};
use tugarc_core::ops::{documents_dir, first_heading};
use tugarc_core::sketch;
use tugcast_core::ControlAction;
use tugcore::instance::Paths;

/// The most rows a search answers with.
const SEARCH_LIMIT: usize = 20;

/// The most ids one `resolve_sketches` may ask after.
const MAX_IDS: usize = 512;

/// A search request: the project it was typed in, the fragment typed, and the
/// caller's id for the ask, echoed so a stale answer can be told apart.
struct SearchRequest {
    project_dir: String,
    query: String,
    request_id: Option<String>,
}

fn parse_search_payload(verb: &str, payload: &[u8]) -> Result<SearchRequest, String> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| format!("{verb} payload is not valid JSON"))?;
    let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    let project_dir = text("project_dir")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{verb} payload is missing project_dir"))?;
    Ok(SearchRequest {
        project_dir,
        query: text("query").unwrap_or_default(),
        request_id: text("request_id"),
    })
}

fn parse_resolve_sketches_payload(payload: &[u8]) -> Result<(String, Vec<String>), String> {
    let value: serde_json::Value = serde_json::from_slice(payload)
        .map_err(|_| "resolve_sketches payload is not valid JSON".to_owned())?;
    let project_dir = value
        .get("project_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "resolve_sketches payload is missing project_dir".to_owned())?
        .to_owned();
    let ids = value
        .get("ids")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "resolve_sketches payload is missing ids".to_owned())?
        .iter()
        .filter_map(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(MAX_IDS)
        .map(str::to_owned)
        .collect();
    Ok((project_dir, ids))
}

/// A brief's first heading, read from the directory that holds it.
pub(super) fn brief_title(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("brief.md")).ok()?;
    first_heading(&text)
}

/// The wire spelling of an archive entry's fate: an abandoned arc reads as a
/// discarded one, since neither landed.
fn archive_fate(fate: ArchiveFate) -> &'static str {
    match fate {
        ArchiveFate::Joined => "joined",
        ArchiveFate::Discarded | ArchiveFate::Abandoned => "discarded",
    }
}

/// One generation of one arc, as `search_arcs` reports it.
struct ArcRow {
    name: String,
    created: String,
    fate: &'static str,
    join_sha: Option<String>,
    title: Option<String>,
    sketch_id: Option<String>,
}

impl ArcRow {
    fn from_entry(entry: &ArchiveEntry) -> ArcRow {
        ArcRow {
            name: entry.name.clone(),
            created: entry.created.clone(),
            fate: archive_fate(entry.fate),
            join_sha: entry.join_sha.clone(),
            title: brief_title(&entry.dir),
            sketch_id: entry.sketch_id.clone(),
        }
    }

    fn matches(&self, needle: &str) -> bool {
        needle.is_empty()
            || self.name.to_lowercase().contains(needle)
            || self
                .title
                .as_deref()
                .is_some_and(|t| t.to_lowercase().contains(needle))
    }

    fn to_json(&self) -> serde_json::Value {
        let mut row = serde_json::json!({
            "name": self.name,
            "created": self.created,
            "fate": self.fate,
        });
        if let Some(sha) = &self.join_sha {
            row["join_sha"] = serde_json::json!(sha);
        }
        if let Some(title) = &self.title {
            row["title"] = serde_json::json!(title);
        }
        if let Some(id) = &self.sketch_id {
            row["sketch_id"] = serde_json::json!(id);
        }
        row
    }
}

/// Every generation of every arc this checkout can read back: each one the
/// log records that is live, joined, or kept (an archive entry, or the newest
/// generation's documents still on disk), and each archive entry the log
/// does not name.
fn arc_rows(paths: &Paths, repo: &Path, log_text: &str) -> Vec<ArcRow> {
    let entries = archive::all_entries(paths, repo);
    let mut names: BTreeSet<String> = arc_fates(log_text).into_keys().collect();
    names.extend(entries.iter().map(|e| e.name.clone()));
    if let Ok(read) = std::fs::read_dir(repo.join(".tug/arcs")) {
        names.extend(
            read.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned()),
        );
    }

    let mut rows = Vec::new();
    let mut covered: BTreeSet<(String, String)> = BTreeSet::new();
    for name in &names {
        let generations = arc_generations(log_text, name);
        let newest = generations.len().saturating_sub(1);
        for (i, generation) in generations.iter().enumerate() {
            let stamp = archive::compact_stamp(&generation.started_at);
            let entry = entries
                .iter()
                .find(|e| &e.name == name && archive::compact_stamp(&e.created) == stamp);
            let live_dir = documents_dir(repo, name);
            let kept_here = i == newest && live_dir.is_dir();
            let (fate, join_sha) = match &generation.end {
                GenerationEnd::Open => ("live", None),
                GenerationEnd::Joined { sha } => ("joined", Some(sha.clone())),
                GenerationEnd::Discarded => ("discarded", None),
            };
            if fate == "discarded" && entry.is_none() && !kept_here {
                continue;
            }
            let title = if kept_here {
                brief_title(&live_dir)
            } else {
                entry.and_then(|e| brief_title(&e.dir))
            };
            let sketch_id = entry.and_then(|e| e.sketch_id.clone()).or_else(|| {
                (i == newest)
                    .then(|| generation_sketch_id(log_text, name))
                    .flatten()
            });
            covered.insert((name.clone(), stamp));
            rows.push(ArcRow {
                name: name.clone(),
                created: generation.started_at.clone(),
                fate,
                join_sha,
                title,
                sketch_id,
            });
        }
    }
    for entry in &entries {
        let key = (entry.name.clone(), archive::compact_stamp(&entry.created));
        if covered.insert(key) {
            rows.push(ArcRow::from_entry(entry));
        }
    }
    rows.sort_by_key(|r| std::cmp::Reverse(archive::compact_stamp(&r.created)));
    rows
}

/// The `search_arcs_ok` body: the newest generations first, at most
/// [`SEARCH_LIMIT`], matching `query` case-insensitively against an arc's
/// name or its brief's title. An empty query answers the newest.
pub(super) fn search_arcs_body(
    paths: &Paths,
    repo: &Path,
    project_dir: &str,
    query: &str,
    request_id: Option<&str>,
    log_text: &str,
) -> serde_json::Value {
    let needle = query.trim().to_lowercase();
    let arcs: Vec<serde_json::Value> = arc_rows(paths, repo, log_text)
        .iter()
        .filter(|r| r.matches(&needle))
        .take(SEARCH_LIMIT)
        .map(ArcRow::to_json)
        .collect();
    serde_json::json!({
        "action": "search_arcs_ok",
        "request_id": request_id,
        "project_dir": project_dir,
        "arcs": arcs,
    })
}

/// The `resolve_sketches_ok` body: each asked id in exactly one of `found`
/// and `missing`. An id is looked for under every checkout on this machine;
/// when two hold it, the asking project's copy answers, else the first.
pub(super) fn resolve_sketches_body(
    paths: &Paths,
    project_dir: &str,
    ids: &[String],
) -> serde_json::Value {
    // [L29]: compared through the gateway, the form a sketch record stores.
    let here = crate::path_resolver::CanonicalPath::from_raw(Path::new(project_dir));
    let here = here.as_str();
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for id in ids {
        let mut records = sketch::find_sketch(paths, id);
        let pick = records
            .iter()
            .position(|(_, r)| r.project_dir == here)
            .unwrap_or(0);
        if records.is_empty() {
            missing.push(id.clone());
            continue;
        }
        let (_, record) = records.swap_remove(pick);
        let mut row = serde_json::json!({
            "id": record.id,
            "project_dir": record.project_dir,
            "versions": record.versions,
        });
        if let Some(arc) = &record.arc {
            row["arc"] = serde_json::json!(arc);
        }
        found.push(row);
    }
    serde_json::json!({
        "action": "resolve_sketches_ok",
        "project_dir": project_dir,
        "found": found,
        "missing": missing,
    })
}

/// The `search_sketches_ok` body: this checkout's sketches, the most recently
/// written first, at most [`SEARCH_LIMIT`], matching `query`
/// case-insensitively against the id, the arc's name or the want.
pub(super) fn search_sketches_body(
    paths: &Paths,
    repo: &Path,
    project_dir: &str,
    query: &str,
    request_id: Option<&str>,
) -> serde_json::Value {
    let needle = query.trim().to_lowercase();
    let sketches: Vec<serde_json::Value> = sketch::sketches(paths, repo)
        .iter()
        .filter_map(|record| {
            let want = sketch::read_version(record, None)
                .ok()
                .and_then(|text| sketch::want_of(&text));
            let arc_name = record.arc.as_ref().map(|a| a.name.as_str());
            let hit = needle.is_empty()
                || record.id.contains(&needle)
                || arc_name.is_some_and(|n| n.to_lowercase().contains(&needle))
                || want
                    .as_deref()
                    .is_some_and(|w| w.to_lowercase().contains(&needle));
            if !hit {
                return None;
            }
            let mut row = serde_json::json!({
                "id": record.id,
                "updated": record.updated(),
            });
            if let Some(arc) = &record.arc {
                row["arc"] = serde_json::json!(arc);
            }
            if let Some(want) = want {
                row["want"] = serde_json::json!(want);
            }
            Some(row)
        })
        .take(SEARCH_LIMIT)
        .collect();
    serde_json::json!({
        "action": "search_sketches_ok",
        "request_id": request_id,
        "project_dir": project_dir,
        "sketches": sketches,
    })
}

/// The `<verb>_err` frame a malformed ask is answered with, so the deck can
/// settle what it held pending rather than wait on a reply that never comes.
pub(super) fn refusal(verb: &str, message: String, request_id: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "action": format!("{verb}_err"),
        "message": message,
        "request_id": request_id,
    })
}

/// The request id of a payload too broken to parse, when it still has one.
pub(super) fn request_id_of(payload: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(payload)
        .ok()?
        .get("request_id")?
        .as_str()
        .map(str::to_owned)
}

fn read_arc_log(paths: &Paths, repo: &Path) -> String {
    let path = tugtool_core::paths::arc_log_path_at(paths, repo);
    std::fs::read_to_string(path).unwrap_or_default()
}

impl AgentSupervisor {
    /// The record family's share of [`AgentSupervisor::handle_control`].
    pub(in crate::feeds::agent_supervisor) async fn handle_records_control(
        &self,
        action: ControlAction,
        payload: &[u8],
    ) -> ControlOutcome {
        let verb = action.as_str();
        let body = match action {
            ControlAction::SearchArcs => match parse_search_payload(verb, payload) {
                Ok(request) => {
                    tokio::task::spawn_blocking(move || {
                        let paths = Paths::from_env();
                        let repo = Path::new(&request.project_dir);
                        let log = read_arc_log(&paths, repo);
                        search_arcs_body(
                            &paths,
                            repo,
                            &request.project_dir,
                            &request.query,
                            request.request_id.as_deref(),
                            &log,
                        )
                    })
                    .await
                }
                Err(message) => Ok(refusal(verb, message, request_id_of(payload).as_deref())),
            },
            ControlAction::ResolveSketches => match parse_resolve_sketches_payload(payload) {
                Ok((project_dir, ids)) => {
                    tokio::task::spawn_blocking(move || {
                        resolve_sketches_body(&Paths::from_env(), &project_dir, &ids)
                    })
                    .await
                }
                Err(message) => Ok(refusal(verb, message, None)),
            },
            ControlAction::SearchSketches => match parse_search_payload(verb, payload) {
                Ok(request) => {
                    tokio::task::spawn_blocking(move || {
                        search_sketches_body(
                            &Paths::from_env(),
                            Path::new(&request.project_dir),
                            &request.project_dir,
                            &request.query,
                            request.request_id.as_deref(),
                        )
                    })
                    .await
                }
                Err(message) => Ok(refusal(verb, message, request_id_of(payload).as_deref())),
            },
            _ => return ControlOutcome::PassThrough,
        };
        let body = body.unwrap_or_else(|err| {
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

    /// A scratch checkout and data root, isolated from the user's.
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
        let paths = Paths::under(&state_dir.path().canonicalize().unwrap());
        Scratch {
            _repo: repo_dir,
            _state: state_dir,
            repo,
            paths,
        }
    }

    impl Scratch {
        fn log(&self, arc: &str, marker: &str, note: &str) {
            append_arc_log(&self.paths, &self.repo, arc, marker, note).unwrap();
        }

        fn log_text(&self) -> String {
            read_arc_log(&self.paths, &self.repo)
        }

        fn write_doc(&self, arc: &str, file: &str, text: &str) {
            let dir = documents_dir(&self.repo, arc);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(file), text).unwrap();
        }

        fn project(&self) -> &str {
            self.repo.to_str().unwrap()
        }
    }

    /// A log line with a chosen timestamp, so generations order without
    /// waiting on the clock.
    fn line(when: &str, arc: &str, marker: &str, note: &str) -> String {
        format!("{when}  {arc}  {marker}  {note}\n")
    }

    #[test]
    fn search_arcs_matches_by_name_and_by_brief_title() {
        let s = scratch();
        s.log("parser", "arc-start", "");
        s.log("renderer", "arc-start", "");
        s.write_doc("parser", "brief.md", "# Faster parsing\n\nbody\n");
        s.write_doc("renderer", "brief.md", "# Glyph caching\n\nbody\n");

        let names = |query: &str| -> Vec<String> {
            let body = search_arcs_body(
                &s.paths,
                &s.repo,
                s.project(),
                query,
                Some("q1"),
                &s.log_text(),
            );
            assert_eq!(body["request_id"], "q1");
            body["arcs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["name"].as_str().unwrap().to_owned())
                .collect()
        };
        assert_eq!(names("pars"), ["parser"]);
        assert_eq!(names("GLYPH"), ["renderer"], "the brief title, any case");
        assert_eq!(names("nothing-like-it"), Vec::<String>::new());

        let body = search_arcs_body(&s.paths, &s.repo, s.project(), "glyph", None, &s.log_text());
        let row = &body["arcs"][0];
        assert_eq!(row["fate"], "live");
        assert_eq!(row["title"], "Glyph caching");
        assert!(row["created"].as_str().is_some_and(|c| !c.is_empty()));
    }

    #[test]
    fn search_arcs_orders_newest_first_and_caps_at_twenty() {
        let s = scratch();
        let mut text = String::new();
        for day in 1..=25 {
            text.push_str(&line(
                &format!("2026-10-{day:02}T00:00:00Z"),
                &format!("arc-{day:02}"),
                "arc-start",
                "",
            ));
        }
        let body = search_arcs_body(&s.paths, &s.repo, s.project(), "", None, &text);
        let arcs = body["arcs"].as_array().unwrap();
        assert_eq!(arcs.len(), SEARCH_LIMIT);
        assert_eq!(arcs[0]["name"], "arc-25", "the newest first");
        assert_eq!(arcs[19]["name"], "arc-06");
    }

    #[test]
    fn search_arcs_reports_each_generation_and_drops_a_discard_nothing_kept() {
        let s = scratch();
        let text = [
            line("2026-10-01T00:00:00Z", "twice", "arc-start", ""),
            line("2026-10-02T00:00:00Z", "twice", "abc1234567", "joined"),
            line("2026-10-03T00:00:00Z", "twice", "arc-start", ""),
            line("2026-10-04T00:00:00Z", "gone", "arc-start", ""),
            line("2026-10-05T00:00:00Z", "gone", "discarded", ""),
        ]
        .concat();
        let body = search_arcs_body(&s.paths, &s.repo, s.project(), "", None, &text);
        assert_eq!(
            body["arcs"],
            serde_json::json!([
                { "name": "twice", "created": "2026-10-03T00:00:00Z", "fate": "live" },
                { "name": "twice", "created": "2026-10-01T00:00:00Z", "fate": "joined", "join_sha": "abc1234567" },
            ]),
            "{body}"
        );
    }

    #[test]
    fn resolve_sketches_finds_an_id_in_another_checkout() {
        let s = scratch();
        s.log("drawn", "arc-start", "");
        s.write_doc(
            "drawn",
            "sketch.md",
            "# Sketch\n\nWant the atoms.\n\nSource: session x, turns 1–2\n",
        );
        let recorded = sketch::record_arc_sketch(&s.paths, &s.repo, "drawn").unwrap();

        // Asked from a different checkout: the id is found where it lives.
        let elsewhere = tempfile::tempdir().unwrap();
        let ids = vec![recorded.id.clone(), "00ff00ff".to_owned()];
        let body = resolve_sketches_body(&s.paths, elsewhere.path().to_str().unwrap(), &ids);
        let found = body["found"].as_array().unwrap();
        assert_eq!(found.len(), 1, "{body}");
        assert_eq!(found[0]["id"], recorded.id.as_str());
        assert_eq!(found[0]["project_dir"], s.project());
        assert_eq!(found[0]["arc"]["name"], "drawn");
        assert_eq!(found[0]["versions"].as_array().unwrap().len(), 1);
        assert_eq!(body["missing"], serde_json::json!(["00ff00ff"]));
    }

    #[test]
    fn search_sketches_matches_the_want_text() {
        let s = scratch();
        for (arc, want) in [
            ("drawn", "Want the atoms."),
            ("other", "Want a faster parse."),
        ] {
            s.log(arc, "arc-start", "");
            s.write_doc(
                arc,
                "sketch.md",
                &format!("# Sketch\n\n{want}\n\nSource: x\n"),
            );
            sketch::record_arc_sketch(&s.paths, &s.repo, arc).unwrap();
        }
        let body = search_sketches_body(&s.paths, &s.repo, s.project(), "ATOMS", Some("q2"));
        assert_eq!(body["request_id"], "q2");
        let rows = body["sketches"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "{body}");
        assert_eq!(rows[0]["arc"]["name"], "drawn");
        assert_eq!(rows[0]["want"], "Want the atoms.");
        assert!(rows[0]["updated"].as_str().is_some());

        let all = search_sketches_body(&s.paths, &s.repo, s.project(), "", None);
        assert_eq!(all["sketches"].as_array().unwrap().len(), 2);
    }
}
