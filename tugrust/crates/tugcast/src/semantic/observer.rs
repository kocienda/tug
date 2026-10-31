//! The Observer's stream: facts and posts, as they are written.
//!
//! Each is already the one sentence it is stored as, so a row is one source. A
//! drain reads one page and says whether more is owed, and never loops: a ledger's
//! whole backlog is minutes of embedding, and the worker takes it a unit at a time
//! so that live work can go between. The mark moves only when a page is finished,
//! and a page read again costs nothing, because an unchanged source is not embedded.

use std::collections::HashMap;

use serde_json::json;
use tugcast_core::OverviewPost;

use super::index::SemanticError;
use super::ingest::{EMBED_BATCH, FACT_KIND, Indexer, NO_SESSION, POST_KIND, Source};
use crate::session_ledger::{FactRow, SessionLedger};

const FACTS_MARK: &str = "facts";
const POSTS_MARK: &str = "posts";

/// How many leading characters of its id name a session with no callsign to wear.
const SHORT_ID_CHARS: usize = 8;

/// Log and carry on when a ledger read fails: a stream that cannot read its rows
/// this time is owed nothing until the next signal.
fn read_rows<T>(what: &str, rows: Result<Vec<T>, crate::session_ledger::LedgerError>) -> Vec<T> {
    rows.unwrap_or_else(|err| {
        tracing::warn!("semantic index: could not read {what}: {err}");
        Vec::new()
    })
}

/// A session's callsign for a context line, remembered for the length of a page.
struct Callsigns<'a> {
    sessions: &'a SessionLedger,
    known: HashMap<String, String>,
}

impl<'a> Callsigns<'a> {
    fn new(sessions: &'a SessionLedger) -> Self {
        Self {
            sessions,
            known: HashMap::new(),
        }
    }

    fn of(&mut self, session: &str) -> &str {
        self.known.entry(session.to_string()).or_insert_with(|| {
            self.sessions
                .get(session)
                .ok()
                .flatten()
                .and_then(|row| row.tag)
                .unwrap_or_else(|| session.chars().take(SHORT_ID_CHARS).collect())
        })
    }
}

/// Index the next page of facts, answering whether the page was full, which means
/// more is owed.
pub(super) async fn drain_facts(indexer: &Indexer) -> Result<bool, SemanticError> {
    let Some(sessions) = indexer.sessions.as_ref() else {
        return Ok(false);
    };
    let after = indexer.index.mark(FACTS_MARK)?;
    let page = read_rows("facts", sessions.facts_after(after, EMBED_BATCH));
    let mut callsigns = Callsigns::new(sessions);
    for fact in &page {
        ingest_fact(indexer, fact, &mut callsigns).await?;
    }
    if let Some(last) = page.last() {
        indexer.index.set_mark(FACTS_MARK, last.id)?;
    }
    Ok(page.len() == EMBED_BATCH)
}

/// Index the next page of posts, answering whether the page was full, which means
/// more is owed.
pub(super) async fn drain_posts(indexer: &Indexer) -> Result<bool, SemanticError> {
    let Some(sessions) = indexer.sessions.as_ref() else {
        return Ok(false);
    };
    let after = indexer.index.mark(POSTS_MARK)?;
    let page = read_rows("posts", sessions.overview_posts_after(after, EMBED_BATCH));
    let mut callsigns = Callsigns::new(sessions);
    for (_, post) in &page {
        let Some(post) = post else {
            continue;
        };
        ingest_post(indexer, post, &mut callsigns).await?;
    }
    if let Some((last, _)) = page.last() {
        indexer.index.set_mark(POSTS_MARK, *last)?;
    }
    Ok(page.len() == EMBED_BATCH)
}

async fn ingest_fact(
    indexer: &Indexer,
    fact: &FactRow,
    callsigns: &mut Callsigns<'_>,
) -> Result<(), SemanticError> {
    let session = fact.session_id.as_deref();
    let id = format!("{}/{}", session.unwrap_or(NO_SESSION), fact.id);
    let context = match session {
        Some(session) => format!("{} {}", fact.kind, callsigns.of(session)),
        None => fact.kind.clone(),
    };
    let meta = json!({
        "fact_id": fact.id,
        "kind": fact.kind,
        "at_ms": fact.at_ms,
        "subject": fact.subject,
    })
    .to_string();
    indexer
        .ingest(&Source {
            kind: FACT_KIND,
            id: &id,
            context: &context,
            text: &fact.text,
            session,
            meta: Some(&meta),
            lexical: None,
        })
        .await?;
    Ok(())
}

async fn ingest_post(
    indexer: &Indexer,
    post: &OverviewPost,
    callsigns: &mut Callsigns<'_>,
) -> Result<(), SemanticError> {
    let Some(post_id) = post.id else {
        return Ok(());
    };
    let session = post.session_id.as_deref();
    let id = format!("{}/{post_id}", session.unwrap_or(NO_SESSION));
    let author = post.author.as_str();
    let context = match session {
        Some(session) => format!("{author} post {}", callsigns.of(session)),
        None => format!("{author} post"),
    };
    let meta = json!({ "post_id": post_id, "at_ms": post.at_ms }).to_string();
    indexer
        .ingest(&Source {
            kind: POST_KIND,
            id: &id,
            context: &context,
            text: &post.body,
            session,
            meta: Some(&meta),
            lexical: None,
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;
    use tugcast_core::OverviewAuthor;

    use super::super::embedder::fake::{FakeState, client};
    use super::super::index::SemanticIndex;
    use super::super::ingest::{IndexStreams, run_index};
    use super::*;
    use crate::session_ledger::NewFact;

    struct Fixture {
        dir: tempfile::TempDir,
        state: Arc<FakeState>,
        sessions: Arc<SessionLedger>,
        observer: Arc<Notify>,
    }

    fn fixture(model: Option<&str>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionLedger::open(dir.path().join("sessions.db"), 0).unwrap());
        let observer = Arc::new(Notify::new());
        sessions.set_stream_signal(Arc::clone(&observer));
        Fixture {
            dir,
            state: FakeState::new(model),
            sessions,
            observer,
        }
    }

    impl Fixture {
        /// The index as a fresh connection finds it, which is what a restart reads.
        fn index(&self) -> Arc<SemanticIndex> {
            Arc::new(SemanticIndex::open(self.dir.path().join("semantic.db")).unwrap())
        }

        fn indexer(&self, index: &Arc<SemanticIndex>) -> Indexer {
            Indexer::new(
                Arc::clone(index),
                client(&self.state),
                Some(Arc::clone(&self.sessions)),
            )
        }

        fn run(&self, index: &Arc<SemanticIndex>) -> Run {
            let cancel = CancellationToken::new();
            let task = tokio::spawn(run_index(
                self.indexer(index),
                IndexStreams {
                    docs_dir: None,
                    observer: Arc::clone(&self.observer),
                    catch_up: true,
                    ticks: tokio::sync::mpsc::channel(1).1,
                    coverage: super::super::coverage::coverage_channel(true).0,
                    documents: None,
                },
                Duration::ZERO,
                cancel.clone(),
            ));
            Run { cancel, task }
        }

        fn spawn(&self, id: &str) {
            self.sessions
                .record_spawn(id, "ws", "/proj", id, 1, id, None)
                .unwrap();
        }

        fn fact(&self, session: Option<&str>, text: &str) -> i64 {
            self.sessions
                .record_fact(&NewFact {
                    at_ms: 5,
                    kind: "commit".to_string(),
                    session_id: session.map(str::to_string),
                    subject: Some("abc123".to_string()),
                    text: text.to_string(),
                    payload: "{}".to_string(),
                    dedupe_key: None,
                })
                .unwrap()
                .unwrap()
        }

        fn post(&self, session: Option<&str>, body: &str) -> i64 {
            self.sessions
                .record_overview_post(&OverviewPost {
                    id: None,
                    at_ms: 6,
                    author: OverviewAuthor::Observer,
                    session_id: session.map(str::to_string),
                    wake_reason: None,
                    body: body.to_string(),
                    refs: Vec::new(),
                    elapsed_ms: None,
                    project_dir: None,
                    attachments: Vec::new(),
                    request_id: None,
                    transient: false,
                })
                .unwrap()
        }
    }

    struct Run {
        cancel: CancellationToken,
        task: tokio::task::JoinHandle<()>,
    }

    impl Run {
        async fn stop(self) {
            self.cancel.cancel();
            self.task.await.unwrap();
        }
    }

    async fn until(mut held: impl FnMut() -> bool) {
        while !held() {
            tokio::task::yield_now().await;
        }
    }

    fn holds(index: &SemanticIndex, kind: &str, id: &str) -> bool {
        index.source_state(kind, id).unwrap().is_some()
    }

    #[tokio::test]
    async fn a_page_of_posts_this_build_cannot_read_is_walked_past() {
        let f = fixture(Some("nl-a"));
        let index = f.index();
        let indexer = f.indexer(&index);
        indexer.embedder.start().await;
        for at in 0..EMBED_BATCH {
            let post = f.post(None, &format!("From a newer build {at}."));
            f.sessions.give_post_an_unknown_author_for_test(post);
        }
        let readable = f.post(None, "A post of this build.");

        assert!(drain_posts(&indexer).await.unwrap(), "the page was full");
        assert!(!drain_posts(&indexer).await.unwrap());

        assert!(holds(&index, POST_KIND, &format!("-/{readable}")));
        assert_eq!(index.source_ids(POST_KIND).unwrap().len(), 1);
        assert_eq!(index.mark(POSTS_MARK).unwrap(), readable);
    }

    #[tokio::test]
    async fn facts_and_posts_written_after_start_reach_the_index() {
        let f = fixture(Some("nl-a"));
        let index = f.index();
        let run = f.run(&index);
        let fact = f.fact(None, "Landed the join.");
        let id = format!("-/{fact}");
        until(|| holds(&index, FACT_KIND, &id)).await;
        let post = f.post(None, "The arc reached its end.");
        let id = format!("-/{post}");
        until(|| holds(&index, POST_KIND, &id)).await;
        run.stop().await;

        let chunks = index.chunks();
        let chunk_of = |kind: &str| chunks.iter().find(|c| c.source_kind == kind).unwrap();
        assert_eq!(chunk_of(FACT_KIND).context, "commit");
        assert_eq!(chunk_of(FACT_KIND).body, "Landed the join.");
        assert_eq!(chunk_of(POST_KIND).context, "observer post");
        assert_eq!(chunk_of(POST_KIND).model.as_deref(), Some("nl-a"));
    }

    #[tokio::test]
    async fn a_context_line_names_the_callsign_or_the_ids_first_characters() {
        let f = fixture(Some("nl-a"));
        f.spawn("s1");
        let tag = f.sessions.get("s1").unwrap().unwrap().tag.unwrap();
        let index = f.index();
        let indexer = f.indexer(&index);
        let fact = f.fact(Some("s1"), "Named.");
        let external = f.fact(Some("0f3c1e5a-external"), "Unnamed.");
        let post = f.post(Some("s1"), "A post.");
        indexer.embedder.start().await;
        while drain_facts(&indexer).await.unwrap() {}
        drain_posts(&indexer).await.unwrap();

        let context_of = |kind: &str, id: String| {
            index
                .chunks()
                .into_iter()
                .find(|chunk| chunk.source_kind == kind && chunk.source_id == id)
                .unwrap()
                .context
        };
        assert_eq!(
            context_of(FACT_KIND, format!("s1/{fact}")),
            format!("commit {tag}")
        );
        assert_eq!(
            context_of(FACT_KIND, format!("0f3c1e5a-external/{external}")),
            "commit 0f3c1e5a"
        );
        assert_eq!(
            context_of(POST_KIND, format!("s1/{post}")),
            format!("observer post {tag}")
        );
    }

    #[tokio::test]
    async fn rows_already_in_the_ledger_are_drained_once_and_marks_outlive_the_run() {
        let f = fixture(Some("nl-a"));
        for n in 0..39 {
            f.fact(None, &format!("Old fact {n}."));
        }
        let last = f.fact(None, "The last old fact.");
        let post = f.post(None, "An old post.");
        let index = f.index();
        let run = f.run(&index);
        until(|| {
            index.mark(FACTS_MARK).unwrap() == last && index.mark(POSTS_MARK).unwrap() == post
        })
        .await;
        run.stop().await;
        assert_eq!(f.state.take_embedded().len(), 41);
        drop(index);

        // The worker reaching a new row proves it got past everything before it.
        let index = f.index();
        assert_eq!(index.mark(FACTS_MARK).unwrap(), last);
        let run = f.run(&index);
        let fresh = f.fact(None, "A new fact.");
        let id = format!("-/{fresh}");
        until(|| holds(&index, FACT_KIND, &id)).await;
        run.stop().await;
        assert_eq!(f.state.take_embedded(), ["commit\nA new fact."]);
    }

    #[tokio::test]
    async fn a_drain_stopped_after_one_page_resumes_with_only_the_rest() {
        let f = fixture(Some("nl-a"));
        let ids: Vec<i64> = (0..40)
            .map(|n| f.fact(None, &format!("Fact number {n}.")))
            .collect();
        let index = f.index();
        let indexer = f.indexer(&index);
        indexer.embedder.start().await;

        assert!(drain_facts(&indexer).await.unwrap());
        assert_eq!(index.mark(FACTS_MARK).unwrap(), ids[EMBED_BATCH - 1]);
        assert_eq!(f.state.take_embedded().len(), EMBED_BATCH);
        drop(indexer);
        drop(index);

        let index = f.index();
        let run = f.run(&index);
        until(|| index.mark(FACTS_MARK).unwrap() == ids[39]).await;
        run.stop().await;
        assert_eq!(f.state.take_embedded().len(), 40 - EMBED_BATCH);
    }

    #[tokio::test]
    async fn a_page_that_is_not_full_owes_nothing() {
        let f = fixture(Some("nl-a"));
        let index = f.index();
        let indexer = f.indexer(&index);
        assert!(!drain_facts(&indexer).await.unwrap());
        assert!(!drain_posts(&indexer).await.unwrap());
        f.fact(None, "One fact.");
        assert!(!drain_facts(&indexer).await.unwrap());
    }

    #[tokio::test]
    async fn what_belongs_to_no_session_survives_a_sessions_removal() {
        let f = fixture(Some("nl-a"));
        f.spawn("s1");
        let app_fact = f.fact(None, "App fact.");
        let bare_post = f.post(None, "Channel post.");
        let session_fact = f.fact(Some("s1"), "Session fact.");
        let session_post = f.post(Some("s1"), "Session post.");
        let index = f.index();
        let indexer = f.indexer(&index);
        indexer.embedder.start().await;
        while drain_facts(&indexer).await.unwrap() {}
        drain_posts(&indexer).await.unwrap();

        indexer.remove_session("s1").unwrap();

        assert!(holds(&index, FACT_KIND, &format!("-/{app_fact}")));
        assert!(holds(&index, POST_KIND, &format!("-/{bare_post}")));
        assert!(!holds(&index, FACT_KIND, &format!("s1/{session_fact}")));
        assert!(!holds(&index, POST_KIND, &format!("s1/{session_post}")));
    }

    #[tokio::test]
    async fn a_private_sessions_rows_are_never_embedded_and_a_later_one_stays_out() {
        let f = fixture(Some("nl-a"));
        f.spawn("hidden");
        f.spawn("later");
        f.fact(Some("hidden"), "Hidden words.");
        f.post(Some("hidden"), "Hidden post.");
        f.sessions.set_session_private("hidden", true).unwrap();
        let fact = f.fact(Some("later"), "Later words.");
        let index = f.index();
        let indexer = f.indexer(&index);
        indexer.embedder.start().await;
        while drain_facts(&indexer).await.unwrap() {}
        drain_posts(&indexer).await.unwrap();
        assert!(
            f.state
                .take_embedded()
                .iter()
                .all(|text| !text.contains("Hidden"))
        );
        assert!(holds(&index, FACT_KIND, &format!("later/{fact}")));

        f.sessions.set_session_private("later", true).unwrap();
        indexer.remove_session("later").unwrap();
        while drain_facts(&indexer).await.unwrap() {}
        f.state.switch_model("nl-b");
        let mut models = indexer.embedder.watch_model();
        models
            .wait_for(|model| model.as_deref() == Some("nl-b"))
            .await
            .unwrap();
        let mut after = None;
        while let Some(key) = indexer
            .reembed_stale(after.as_ref(), EMBED_BATCH)
            .await
            .unwrap()
        {
            after = Some(key);
        }
        assert!(!holds(&index, FACT_KIND, &format!("later/{fact}")));
        assert_eq!(index.lexical_matches("Later"), 0);
    }

    #[tokio::test]
    async fn stale_sources_are_embedded_at_start_with_no_model_change_during_the_run() {
        let f = fixture(Some("nl-b"));
        let index = f.index();
        // Stored with no helper, and under a model an update has since moved past.
        index.store_for_test(FACT_KIND, "-/1");
        let passages = tugsem_core::chunk("ctx", "Older words.");
        index
            .replace_source(&super::super::index::Replacement {
                kind: POST_KIND,
                id: "-/2",
                content_hash: "hash",
                model: Some("nl-a"),
                passages: &passages,
                vectors: &[Some(vec![1.0; 16])],
                meta: None,
                lexical: &[],
            })
            .unwrap();
        let run = f.run(&index);
        until(|| {
            let chunks = index.chunks();
            chunks.iter().all(|c| c.model.as_deref() == Some("nl-b"))
        })
        .await;
        run.stop().await;
    }
}
