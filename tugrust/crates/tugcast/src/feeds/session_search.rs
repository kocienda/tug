//! Session search for the composer's `@` popup: every session on this machine
//! that a typed fragment names, as the rows a session atom is minted from.
//!
//! The sessions are the ones the Overview's session surface serves —
//! [`merged_history_rows`], this ledger's rows merged with the machine-wide
//! index and folded by line — so the exclusions are that read's and are not
//! restated here: an `apptest-` instance's sessions, Tug's own shared-agent
//! activity and private sessions never appear. What this adds is the match,
//! the order and the one further exclusion a mention needs: a session with no
//! callsign has no name for its chip to read, so it is not offered.

use std::path::Path;

use serde_json::{Value, json};

use crate::feeds::operator::{HistoryRow, merged_history_rows};
use crate::session_ledger::{SessionLedger, stored_project_dir};

/// How many sessions an answer carries when the request names no limit.
pub(crate) const DEFAULT_LIMIT: usize = 20;

/// The most sessions one answer carries, whatever the request asks for.
pub(crate) const MAX_LIMIT: usize = 200;

/// The sessions `query` names, most relevant first, as `search_sessions_ok`
/// rows.
///
/// A session matches when the query is a case-insensitive fragment of its
/// callsign, its title, its project's leaf name or the `<project>/<callsign>`
/// spelling a session atom wears. A query that is empty once trimmed matches
/// every session, which is how a bare `@` shows recents.
///
/// The order is the asking project's own sessions first, then the rest, each
/// by most recent use. `project_dir` is the asking project under any spelling;
/// an empty one ranks by recency alone.
pub(crate) fn search_sessions(
    ledger: &SessionLedger,
    index_path: &Path,
    query: &str,
    project_dir: &str,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let needle = query.trim().to_lowercase();
    let asking = stored_project_dir(project_dir);
    let asking = asking.trim_end_matches('/');

    let mut hits: Vec<(bool, HistoryRow, String)> = merged_history_rows(ledger, index_path, None)?
        .into_iter()
        .filter_map(|history| {
            let callsign = history.row.tag.as_deref().map(str::trim).unwrap_or("");
            if callsign.is_empty() {
                return None;
            }
            let leaf = tugcore::session_index::project_leaf_of(&history.row.project_dir);
            // `<leaf>/<callsign>` holds the leaf and the callsign as fragments
            // of itself, so one haystack answers three of the four fields.
            let reference = format!("{leaf}/{callsign}").to_lowercase();
            let title = history.row.name.as_deref().unwrap_or("").to_lowercase();
            if !needle.is_empty() && !reference.contains(&needle) && !title.contains(&needle) {
                return None;
            }
            let own = !asking.is_empty() && history.row.project_dir.trim_end_matches('/') == asking;
            Some((own, history, leaf))
        })
        .collect();

    hits.sort_by(|(a_own, a, _), (b_own, b, _)| {
        b_own
            .cmp(a_own)
            .then(b.row.last_used_at.cmp(&a.row.last_used_at))
            // Two sessions used in the same millisecond still have one order.
            .then(a.row.session_id.cmp(&b.row.session_id))
    });
    hits.truncate(limit.clamp(1, MAX_LIMIT));

    Ok(hits
        .into_iter()
        .map(|(_, history, leaf)| {
            json!({
                "session_id": history.row.session_id,
                "callsign": history.row.tag,
                "title": history.row.name,
                "project_dir": history.row.project_dir,
                "project_leaf": leaf,
                "last_used_at_ms": history.row.last_used_at,
                // Which record knew the session, and the instance that
                // recorded it when that is not this one.
                "source": history.source.as_str(),
                "instance": history.instance,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcore::session_index::{IndexEntry, SessionIndex};

    struct Fixture {
        ledger: SessionLedger,
        index_path: std::path::PathBuf,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        Fixture {
            ledger: SessionLedger::open_in_memory().expect("in-memory ledger"),
            index_path: dir.path().join("session_index.db"),
            _dir: dir,
        }
    }

    fn indexed(
        uuid: &str,
        project_dir: &str,
        callsign: Option<&str>,
        title: Option<&str>,
        instance: &str,
        updated_at_ms: i64,
    ) -> IndexEntry {
        IndexEntry {
            session_id: uuid.into(),
            line_id: String::new(),
            callsign: callsign.map(str::to_owned),
            project_dir: project_dir.into(),
            project_leaf: String::new(),
            instance: instance.into(),
            title: title.map(str::to_owned),
            created_at_ms: updated_at_ms - 10,
            updated_at_ms,
        }
    }

    fn ids(rows: &[Value]) -> Vec<&str> {
        rows.iter()
            .map(|row| row["session_id"].as_str().expect("session_id"))
            .collect()
    }

    /// This ledger holds two sessions of `/proj/alpha` — one of them private —
    /// and the index holds sessions other instances recorded: one in another
    /// project, one with no callsign, one the harness made, and the private
    /// one again.
    fn seeded() -> Fixture {
        let f = fixture();
        f.ledger
            .record_spawn(
                "own-1",
                "ws",
                "/proj/alpha",
                "card-1",
                1_000,
                "line-1",
                Some("faint-surf"),
            )
            .expect("spawn");
        f.ledger
            .record_spawn(
                "secret",
                "ws",
                "/proj/alpha",
                "card-2",
                9_000,
                "line-2",
                Some("quiet-moth"),
            )
            .expect("spawn");
        f.ledger
            .set_session_private("secret", true)
            .expect("marked private");

        let index = SessionIndex::open(&f.index_path).expect("index");
        for entry in [
            indexed(
                "elsewhere",
                "/proj/eucit",
                Some("curly-apple"),
                Some("Parser rewrite"),
                "debug-b",
                5_000,
            ),
            indexed(
                "nameless",
                "/proj/eucit",
                None,
                Some("Parser notes"),
                "debug-b",
                6_000,
            ),
            indexed(
                "harness",
                "/proj/eucit",
                Some("curly-test"),
                None,
                "apptest-1234",
                7_000,
            ),
            indexed(
                "secret",
                "/proj/alpha",
                Some("quiet-moth"),
                None,
                "debug-b",
                9_000,
            ),
        ] {
            index.upsert(&entry).expect("indexed");
        }
        f
    }

    #[test]
    fn a_session_in_another_project_is_found_by_each_of_its_names() {
        let f = seeded();
        for query in ["curly", "APPLE", "parser rew", "eucit", "eucit/curly-apple"] {
            let rows = search_sessions(&f.ledger, &f.index_path, query, "/proj/alpha", 20)
                .expect("search");
            assert_eq!(ids(&rows), ["elsewhere"], "query {query:?}: {rows:?}");
        }
        let rows =
            search_sessions(&f.ledger, &f.index_path, "curly", "/proj/alpha", 20).expect("search");
        let row = &rows[0];
        assert_eq!(row["callsign"], "curly-apple");
        assert_eq!(row["title"], "Parser rewrite");
        assert_eq!(row["project_dir"], "/proj/eucit");
        assert_eq!(row["project_leaf"], "eucit");
        assert_eq!(row["source"], "index");
        assert_eq!(row["instance"], "debug-b");
    }

    #[test]
    fn private_harness_and_nameless_sessions_are_never_offered() {
        let f = seeded();
        // Each is asked for by a name only it carries.
        for query in ["quiet-moth", "curly-test", "parser notes"] {
            let rows = search_sessions(&f.ledger, &f.index_path, query, "/proj/alpha", 20)
                .expect("search");
            assert!(rows.is_empty(), "query {query:?} found {rows:?}");
        }
    }

    #[test]
    fn an_empty_query_is_recents_with_the_asking_project_first() {
        let f = seeded();
        // `own-1` was last used long before `elsewhere`, and still leads:
        // it is the asking project's.
        let from_alpha =
            search_sessions(&f.ledger, &f.index_path, "  ", "/proj/alpha", 20).expect("search");
        assert_eq!(ids(&from_alpha), ["own-1", "elsewhere"]);
        assert_eq!(from_alpha[0]["source"], "ledger");
        assert_eq!(from_alpha[0]["instance"], Value::Null);

        // Asked from nowhere in particular, recency alone decides.
        let from_nowhere = search_sessions(&f.ledger, &f.index_path, "", "", 20).expect("search");
        assert_eq!(ids(&from_nowhere), ["elsewhere", "own-1"]);

        let capped =
            search_sessions(&f.ledger, &f.index_path, "", "/proj/alpha", 1).expect("search");
        assert_eq!(ids(&capped), ["own-1"], "the limit cuts after the ranking");
    }

    #[test]
    fn a_missing_index_leaves_the_ledger_rows() {
        let f = fixture();
        f.ledger
            .record_spawn(
                "only",
                "ws",
                "/proj/alpha",
                "card-1",
                1_000,
                "line-1",
                Some("lone-pine"),
            )
            .expect("spawn");
        let rows = search_sessions(&f.ledger, &f.index_path, "pine", "", 20).expect("search");
        assert_eq!(ids(&rows), ["only"]);
    }
}
