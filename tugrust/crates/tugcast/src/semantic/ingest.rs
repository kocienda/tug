//! Feeding sources into the index.
//!
//! A source is scrubbed, chunked, embedded and stored as one, and only when its
//! content or the live model has changed. Its stored passages all carry the one
//! model its one batch came back from, so no source ever holds two models. With no
//! model live its passages are stored without vectors, which still serves lexical
//! search, and they are embedded when one arrives.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use tracing::warn;
use tugsem_core::{CHUNKING_VERSION, chunk};

use super::embedder::EmbedderClient;
use super::index::{Replacement, SemanticError, SemanticIndex};
use crate::feeds::secret_filter::scrub_text;
use crate::help_docs::HelpDoc;
use crate::session_ledger::SessionLedger;

/// The source kind of a help unit, whose id is `<document>#<anchor>`.
pub(crate) const HELP_KIND: &str = "help";

/// The source kind of anything drawn from a session, whose id is the session's id
/// or begins with it and a `/`. Marking the session private removes all of them.
pub(crate) const SESSION_KIND: &str = "session";

/// One thing to index.
pub(crate) struct Source<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub context: &'a str,
    pub text: &'a str,
    /// The session this was drawn from, which decides whether it may enter at all.
    pub session: Option<&'a str>,
}

/// What became of a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ingested {
    /// Its content and the live model are what the index already holds.
    Unchanged,
    Stored,
    /// It belongs to a private session, so nothing of it is held.
    Refused,
}

pub(crate) struct Indexer {
    index: Arc<SemanticIndex>,
    embedder: Arc<EmbedderClient>,
    sessions: Option<Arc<SessionLedger>>,
}

impl Indexer {
    pub(crate) fn new(
        index: Arc<SemanticIndex>,
        embedder: Arc<EmbedderClient>,
        sessions: Option<Arc<SessionLedger>>,
    ) -> Self {
        Self {
            index,
            embedder,
            sessions,
        }
    }

    /// Whether a session's text may enter the index. A session whose privacy
    /// cannot be read is treated as private.
    fn may_index(&self, session: &str) -> bool {
        let Some(sessions) = self.sessions.as_ref() else {
            return false;
        };
        matches!(sessions.is_session_private(session), Ok(false))
    }

    /// Bring one source up to date.
    pub(crate) async fn ingest(&self, source: &Source<'_>) -> Result<Ingested, SemanticError> {
        if source
            .session
            .is_some_and(|session| !self.may_index(session))
        {
            self.index.remove_source(source.kind, source.id)?;
            return Ok(Ingested::Refused);
        }

        let text = scrub_text(source.text);
        // The context line is embedded and stored with every passage, so it is
        // scrubbed as the text is.
        let context = scrub_text(source.context);
        let content_hash = content_hash(&context, &text);
        let live = self.embedder.live_model();
        if let Some(state) = self.index.source_state(source.kind, source.id)?
            && state.content_hash == content_hash
            && (live.is_none() || state.model == live)
        {
            return Ok(Ingested::Unchanged);
        }

        let passages = chunk(&context, &text);
        let embedded = match live {
            Some(_) if !passages.is_empty() => {
                let texts = passages.iter().map(|p| p.embedding_text()).collect();
                self.embedder.embed(texts).await.ok()
            }
            _ => None,
        };
        // The embed is where any wait is, and the session may have gone private
        // during it.
        if source
            .session
            .is_some_and(|session| !self.may_index(session))
        {
            self.index.remove_source(source.kind, source.id)?;
            return Ok(Ingested::Refused);
        }
        self.index.replace_source(&Replacement {
            kind: source.kind,
            id: source.id,
            content_hash: &content_hash,
            model: embedded.as_ref().map(|answer| answer.model.as_str()),
            passages: &passages,
            vectors: embedded.as_ref().map_or(&[], |answer| &answer.vectors),
        })?;
        Ok(Ingested::Stored)
    }

    /// Bring the help documents up to date: every unit is one source, and a unit
    /// no document holds any more leaves. A document that cannot be read is left
    /// as it was indexed.
    pub(crate) async fn index_help(&self, docs_dir: &Path) -> Result<(), SemanticError> {
        let mut seen = HashSet::new();
        let mut complete = true;
        for doc in HelpDoc::ALL {
            let dir = docs_dir.to_path_buf();
            let read = tokio::task::spawn_blocking(move || doc.read(&dir)).await;
            let Ok(Ok(markdown)) = read else {
                warn!("semantic index: could not read {}", doc.file_name());
                complete = false;
                continue;
            };
            for (id, title, text) in help_sources(doc, &markdown) {
                let context = format!("{} > {title}", help_title(doc));
                self.ingest(&Source {
                    kind: HELP_KIND,
                    id: &id,
                    context: &context,
                    text: &text,
                    session: None,
                })
                .await?;
                seen.insert(id);
            }
        }
        if complete {
            for id in self.index.source_ids(HELP_KIND)? {
                if !seen.contains(&id) {
                    self.index.remove_source(HELP_KIND, &id)?;
                }
            }
        }
        Ok(())
    }

    /// Remove every source drawn from a session.
    pub(crate) fn remove_session(&self, session: &str) -> Result<(), SemanticError> {
        remove_session_sources(&self.index, session)
    }

    /// Remove what is held for sessions now private: the safety net for a removal
    /// that failed when the session was marked.
    fn purge_private(&self) -> Result<(), SemanticError> {
        let Some(sessions) = self.sessions.as_ref() else {
            return Ok(());
        };
        match sessions.private_session_ids() {
            Ok(ids) => {
                for id in ids {
                    self.remove_session(&id)?;
                }
            }
            Err(err) => warn!("semantic index: could not read private sessions: {err}"),
        }
        Ok(())
    }
}

/// Remove every source drawn from `session`.
pub(crate) fn remove_session_sources(
    index: &SemanticIndex,
    session: &str,
) -> Result<(), SemanticError> {
    let drawn_from = format!("{session}/");
    for id in index.source_ids(SESSION_KIND)? {
        if id == session || id.starts_with(&drawn_from) {
            index.remove_source(SESSION_KIND, &id)?;
        }
    }
    Ok(())
}

/// What a source's chunks depend on, so an unchanged hash means unchanged chunks.
fn content_hash(context: &str, text: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(CHUNKING_VERSION.to_le_bytes());
    hash.update(context.as_bytes());
    hash.update([0]);
    hash.update(text.as_bytes());
    format!("{:x}", hash.finalize())
}

fn help_title(doc: HelpDoc) -> &'static str {
    match doc {
        HelpDoc::Features => "Tug feature guide",
        HelpDoc::Glossary => "Tug glossary",
    }
}

/// A document's units as sources: id, title and text. Units that slug to one
/// anchor are one source, because the anchor is the only address either has.
fn help_sources(doc: HelpDoc, markdown: &str) -> Vec<(String, String, String)> {
    let mut sources: Vec<(String, String, String)> = Vec::new();
    for unit in doc.units(markdown) {
        let id = format!("{}#{}", doc.name(), unit.anchor);
        match sources.iter_mut().find(|(known, _, _)| *known == id) {
            Some((_, _, text)) => {
                text.push_str("\n\n");
                text.push_str(&unit.text);
            }
            None => sources.push((id, unit.title, unit.text)),
        }
    }
    sources
}

/// How long after boot the indexer stays out of the way. Loading the model and
/// embedding take a couple of seconds of CPU, which the first moments of a launch
/// have no room for, and nothing is waiting on them: until then a search is lexical.
pub(crate) const HELP_INDEX_SETTLE: Duration = Duration::from_secs(30);

/// Keep the help documents indexed, off the startup path, for as long as tugcast
/// runs: once after `settle`, and again whenever the live model changes, which is
/// the only other thing that can stale them.
pub(crate) async fn run_help_index(
    indexer: Indexer,
    docs_dir: Option<PathBuf>,
    settle: Duration,
    cancel: CancellationToken,
) {
    tokio::select! {
        _ = cancel.cancelled() => return,
        _ = tokio::time::sleep(settle) => {}
    }
    let mut models = indexer.embedder.watch_model();
    indexer.embedder.start().await;
    loop {
        models.borrow_and_update();
        if let Err(err) = indexer.purge_private() {
            warn!("semantic index: {err}");
        }
        if let Some(dir) = docs_dir.as_deref()
            && let Err(err) = indexer.index_help(dir).await
        {
            warn!("semantic index: {err}");
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            changed = models.changed() => if changed.is_err() { return },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::embedder::fake::{FakeState, client, vector_of};
    use super::super::index::StoredChunk;
    use super::*;
    use std::sync::atomic::Ordering;

    struct Fixture {
        _dir: tempfile::TempDir,
        docs: PathBuf,
        state: Arc<FakeState>,
        index: Arc<SemanticIndex>,
        indexer: Indexer,
    }

    const FEATURES: &str = "# Tug\n\nThe opening prose.\n\n## Opening an arc\n\nType a prompt at the door.\n\n## The join\n\nThe join lands the branch.\n";
    const GLOSSARY: &str =
        "**Arc.** One piece of work.\n\n**Door.** The skill that opens an arc.\n";

    fn fixture_with(state: Arc<FakeState>, sessions: Option<Arc<SessionLedger>>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("docs");
        std::fs::create_dir(&docs).unwrap();
        std::fs::write(docs.join("features.md"), FEATURES).unwrap();
        std::fs::write(docs.join("glossary.md"), GLOSSARY).unwrap();
        let index = Arc::new(SemanticIndex::open(dir.path().join("semantic.db")).unwrap());
        let indexer = Indexer::new(Arc::clone(&index), client(&state), sessions);
        Fixture {
            _dir: dir,
            docs,
            state,
            index,
            indexer,
        }
    }

    fn fixture(model: Option<&str>) -> Fixture {
        fixture_with(FakeState::new(model), None)
    }

    fn sessions_with(id: &str, private: bool) -> (tempfile::TempDir, Arc<SessionLedger>) {
        let dir = tempfile::tempdir().unwrap();
        let ledger = SessionLedger::open(dir.path().join("sessions.db"), 0).unwrap();
        ledger
            .record_spawn(id, "ws", "/proj", "card-1", 1, id, None)
            .unwrap();
        ledger.set_session_private(id, private).unwrap();
        (dir, Arc::new(ledger))
    }

    impl Fixture {
        async fn index_help(&self) {
            self.indexer.embedder.start().await;
            self.indexer.index_help(&self.docs).await.unwrap();
        }

        fn chunk(&self, id: &str) -> StoredChunk {
            self.index
                .chunks()
                .into_iter()
                .find(|chunk| chunk.source_id == id)
                .unwrap()
        }
    }

    #[tokio::test]
    async fn every_help_unit_is_chunked_under_its_anchor_and_embedded() {
        let f = fixture(Some("nl-a"));
        f.index_help().await;

        let mut ids = f.index.source_ids(HELP_KIND).unwrap();
        ids.sort();
        assert_eq!(
            ids,
            [
                "features#opening-an-arc",
                "features#the-join",
                "features#tug",
                "glossary#arc",
                "glossary#door"
            ]
        );
        let chunk = f.chunk("features#opening-an-arc");
        assert_eq!(chunk.context, "Tug feature guide > Opening an arc");
        assert_eq!(
            chunk.body,
            "## Opening an arc\n\nType a prompt at the door."
        );
        assert_eq!(chunk.model.as_deref(), Some("nl-a"));
        assert_eq!(
            chunk.vector,
            Some(vector_of(
                "Tug feature guide > Opening an arc\n## Opening an arc\n\nType a prompt at the door."
            ))
        );
        assert_eq!(f.index.lexical_matches("door"), 2);
    }

    #[tokio::test]
    async fn nothing_is_embedded_again_when_nothing_changed() {
        let f = fixture(Some("nl-a"));
        f.index_help().await;
        assert_eq!(f.state.take_embedded().len(), 5);
        f.index_help().await;
        assert_eq!(f.state.take_embedded(), Vec::<String>::new());
    }

    #[tokio::test]
    async fn a_changed_unit_is_embedded_again_and_only_it() {
        let f = fixture(Some("nl-a"));
        f.index_help().await;
        f.state.take_embedded();
        std::fs::write(
            f.docs.join("features.md"),
            FEATURES.replace("Type a prompt at the door.", "Say what you want."),
        )
        .unwrap();
        f.index_help().await;
        let embedded = f.state.take_embedded();
        assert_eq!(embedded.len(), 1);
        assert!(embedded[0].contains("Say what you want."));
        assert_eq!(f.index.lexical_matches("Say"), 1);
    }

    #[tokio::test]
    async fn a_new_live_model_re_embeds_everything_and_leaves_none_of_the_old() {
        let f = fixture(Some("nl-static"));
        f.index_help().await;
        f.state.take_embedded();
        f.state.switch_model("nl-contextual");
        let mut models = f.indexer.embedder.watch_model();
        models
            .wait_for(|model| model.as_deref() == Some("nl-contextual"))
            .await
            .unwrap();
        f.index_help().await;
        assert_eq!(f.state.take_embedded().len(), 5);
        assert!(
            f.index
                .chunks()
                .iter()
                .all(|chunk| chunk.model.as_deref() == Some("nl-contextual"))
        );
    }

    #[tokio::test]
    async fn a_batch_answered_by_a_newer_model_is_stored_as_that_model() {
        let f = fixture(Some("nl-static"));
        f.indexer.embedder.start().await;
        // The helper has moved, and its announcement has not reached the client.
        *f.state.model.lock() = Some("nl-contextual".to_string());
        f.indexer
            .ingest(&Source {
                kind: HELP_KIND,
                id: "x",
                context: "c",
                text: "Some text.",
                session: None,
            })
            .await
            .unwrap();
        let chunk = f.chunk("x");
        assert_eq!(chunk.model.as_deref(), Some("nl-contextual"));
        assert_eq!(
            f.index
                .source_state(HELP_KIND, "x")
                .unwrap()
                .unwrap()
                .model
                .as_deref(),
            Some("nl-contextual")
        );
    }

    #[tokio::test]
    async fn a_removed_unit_leaves_the_index() {
        let f = fixture(Some("nl-a"));
        f.index_help().await;
        std::fs::write(f.docs.join("glossary.md"), "**Arc.** One piece of work.\n").unwrap();
        f.index_help().await;
        assert_eq!(
            f.index.source_state(HELP_KIND, "glossary#door").unwrap(),
            None
        );
        assert_eq!(f.index.lexical_matches("skill"), 0);
    }

    #[tokio::test]
    async fn an_unreadable_document_is_left_as_it_was_indexed() {
        let f = fixture(Some("nl-a"));
        f.index_help().await;
        std::fs::remove_file(f.docs.join("glossary.md")).unwrap();
        f.index_help().await;
        assert!(
            f.index
                .source_state(HELP_KIND, "glossary#door")
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn a_missing_helper_leaves_the_index_lexical() {
        let state = FakeState::new(Some("nl-a"));
        state.missing.store(true, Ordering::Relaxed);
        let f = fixture_with(state, None);
        f.index_help().await;
        let chunks = f.index.chunks();
        assert_eq!(chunks.len(), 5);
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.vector.is_none() && chunk.model.is_none())
        );
        assert_eq!(f.index.lexical_matches("door"), 2);
    }

    #[tokio::test]
    async fn a_helper_that_arrives_later_embeds_what_was_stored_without_it() {
        let state = FakeState::new(Some("nl-a"));
        state.missing.store(true, Ordering::Relaxed);
        let f = fixture_with(state, None);
        f.index_help().await;
        f.state.missing.store(false, Ordering::Relaxed);
        f.index_help().await;
        assert!(f.index.chunks().iter().all(|chunk| chunk.vector.is_some()));
    }

    #[tokio::test]
    async fn no_live_model_keeps_vectors_already_stored_for_unchanged_content() {
        let f = fixture(Some("nl-a"));
        f.index_help().await;
        f.state.kill();
        let mut models = f.indexer.embedder.watch_model();
        let _ = models.wait_for(|model| model.is_none()).await;
        f.state.missing.store(true, Ordering::Relaxed);
        f.indexer.index_help(&f.docs).await.unwrap();
        assert!(f.index.chunks().iter().all(|chunk| chunk.vector.is_some()));
    }

    #[tokio::test]
    async fn a_secret_never_reaches_the_embedder_or_the_index() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        let secret = "sk-ant-abcdefghijklmnopqrstuvwxyz012345";
        f.indexer
            .ingest(&Source {
                kind: HELP_KIND,
                id: "x",
                context: "c",
                text: &format!("The key is {secret} and that is all."),
                session: None,
            })
            .await
            .unwrap();
        assert!(
            f.state
                .take_embedded()
                .iter()
                .all(|text| !text.contains(secret))
        );
        let chunk = f.chunk("x");
        assert!(!chunk.body.contains(secret));
        assert!(chunk.body.contains("and that is all."));
    }

    #[tokio::test]
    async fn a_secret_in_the_context_line_never_reaches_the_embedder_or_the_index() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        let secret = "sk-ant-abcdefghijklmnopqrstuvwxyz012345";
        f.indexer
            .ingest(&Source {
                kind: HELP_KIND,
                id: "x",
                context: &format!("Pasted {secret} title"),
                text: "Plain words.",
                session: None,
            })
            .await
            .unwrap();
        assert!(
            f.state
                .take_embedded()
                .iter()
                .all(|text| !text.contains(secret))
        );
        assert_eq!(f.chunk("x").context, "Pasted [secret] title");
    }

    #[tokio::test]
    async fn a_private_sessions_source_is_refused_and_never_embedded() {
        let (_dir, sessions) = sessions_with("s1", true);
        let f = fixture_with(FakeState::new(Some("nl-a")), Some(sessions));
        f.indexer.embedder.start().await;
        let outcome = f
            .indexer
            .ingest(&Source {
                kind: SESSION_KIND,
                id: "s1/turn-3",
                context: "c",
                text: "Private words.",
                session: Some("s1"),
            })
            .await
            .unwrap();
        assert_eq!(outcome, Ingested::Refused);
        assert!(f.state.take_embedded().is_empty());
        assert!(f.index.chunks().is_empty());
    }

    #[tokio::test]
    async fn a_session_with_no_ledger_to_ask_is_refused() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        let outcome = f
            .indexer
            .ingest(&Source {
                kind: SESSION_KIND,
                id: "s1",
                context: "c",
                text: "Words.",
                session: Some("s1"),
            })
            .await
            .unwrap();
        assert_eq!(outcome, Ingested::Refused);
    }

    async fn ingest_session(f: &Fixture, id: &str, session: &str) -> Ingested {
        f.indexer
            .ingest(&Source {
                kind: SESSION_KIND,
                id,
                context: "c",
                text: "Open words.",
                session: Some(session),
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn marking_a_session_private_removes_its_chunks_and_only_its() {
        let (_dir, sessions) = sessions_with("s1", false);
        sessions
            .record_spawn("s10", "ws", "/proj", "card-2", 2, "s10", None)
            .unwrap();
        let f = fixture_with(FakeState::new(Some("nl-a")), Some(Arc::clone(&sessions)));
        f.indexer.embedder.start().await;
        assert_eq!(ingest_session(&f, "s1", "s1").await, Ingested::Stored);
        assert_eq!(
            ingest_session(&f, "s1/turn-3", "s1").await,
            Ingested::Stored
        );
        assert_eq!(
            ingest_session(&f, "s10/turn-1", "s10").await,
            Ingested::Stored
        );

        f.indexer.remove_session("s1").unwrap();
        let mut left = f.index.source_ids(SESSION_KIND).unwrap();
        left.sort();
        assert_eq!(left, ["s10/turn-1"]);
    }

    #[tokio::test]
    async fn a_run_purges_what_a_failed_removal_left_behind() {
        let (_dir, sessions) = sessions_with("s1", false);
        let f = fixture_with(FakeState::new(Some("nl-a")), Some(Arc::clone(&sessions)));
        f.indexer.embedder.start().await;
        ingest_session(&f, "s1", "s1").await;
        sessions.set_session_private("s1", true).unwrap();

        f.indexer.purge_private().unwrap();
        assert!(f.index.source_ids(SESSION_KIND).unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_run_loop_re_embeds_when_the_model_moves_and_stops_when_cancelled() {
        let state = FakeState::new(Some("nl-static"));
        let f = fixture_with(Arc::clone(&state), None);
        let Fixture {
            _dir,
            docs,
            index,
            indexer,
            ..
        } = f;
        let cancel = CancellationToken::new();
        let run = tokio::spawn(run_help_index(
            indexer,
            Some(docs),
            Duration::ZERO,
            cancel.clone(),
        ));

        let all_of = |index: &SemanticIndex, model: &str| {
            let chunks = index.chunks();
            chunks.len() == 5 && chunks.iter().all(|c| c.model.as_deref() == Some(model))
        };
        while !all_of(&index, "nl-static") {
            tokio::task::yield_now().await;
        }
        state.switch_model("nl-contextual");
        while !all_of(&index, "nl-contextual") {
            tokio::task::yield_now().await;
        }

        cancel.cancel();
        run.await.unwrap();
    }

    #[tokio::test]
    async fn the_run_loop_embeds_again_after_a_helper_restart() {
        let state = FakeState::new(Some("nl-a"));
        let f = fixture_with(Arc::clone(&state), None);
        let Fixture {
            _dir,
            docs,
            index,
            indexer,
            ..
        } = f;
        // The first helper goes down before anything is embedded, as a crash would.
        state.missing.store(true, Ordering::Relaxed);
        let embedder = Arc::clone(&indexer.embedder);
        let cancel = CancellationToken::new();
        let run = tokio::spawn(run_help_index(
            indexer,
            Some(docs),
            Duration::ZERO,
            cancel.clone(),
        ));
        while index.chunks().len() < 5 {
            tokio::task::yield_now().await;
        }
        assert!(index.chunks().iter().all(|chunk| chunk.vector.is_none()));

        state.missing.store(false, Ordering::Relaxed);
        embedder.start().await;
        while !index.chunks().iter().all(|chunk| chunk.vector.is_some()) {
            tokio::task::yield_now().await;
        }
        cancel.cancel();
        run.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "compiles and runs the real helper"]
    async fn a_real_helper_indexes_the_shipped_help_documents() {
        use super::super::embedder::{EmbedderPipes, EmbedderSpawner};

        struct Compiled(PathBuf);
        impl EmbedderSpawner for Compiled {
            fn spawn(&self) -> std::io::Result<EmbedderPipes> {
                let mut child = tokio::process::Command::new(&self.0)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()?;
                let stdin = child.stdin.take().unwrap();
                let stdout = child.stdout.take().unwrap();
                Ok(EmbedderPipes {
                    stdin: Box::new(stdin),
                    stdout: Box::new(stdout),
                    guard: Box::new(child),
                })
            }
        }

        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("tugembed");
        let compiled = std::process::Command::new("bash")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", dir.path())
            .arg(root.join("tugrust/scripts/compile-tugembed.sh"))
            .arg(&helper)
            .status()
            .unwrap();
        assert!(compiled.success());

        let index = Arc::new(SemanticIndex::open(dir.path().join("semantic.db")).unwrap());
        let client = EmbedderClient::new(Compiled(helper));
        let indexer = Indexer::new(Arc::clone(&index), Arc::clone(&client), None);
        let model = client.start().await.expect("a live model");
        let started = std::time::Instant::now();
        indexer.index_help(&root.join("docs")).await.unwrap();
        let chunks = index.chunks();
        println!(
            "{} passages on {model} in {:?}",
            chunks.len(),
            started.elapsed()
        );
        assert!(chunks.len() > 100);
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.model.as_deref() == Some(&model))
        );
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.vector.as_ref().unwrap().len() == 512)
        );

        // Retrieval alone, with no model turn: where each eval question's passage
        // ranks under each ranker, and how many land in `help.search`'s six.
        {
            use super::super::search::SemanticSearch;
            use serde_json::Value;
            use tugsem_core::{Candidate, Query, rank_by_similarity};
            let search = SemanticSearch::new(Arc::clone(&index), Arc::clone(&client));
            let set: Vec<Value> = serde_json::from_str(
                &std::fs::read_to_string(root.join("tests/operator-eval/questions.json")).unwrap(),
            )
            .unwrap();
            let stored = index.vectors(HELP_KIND, &model, None).unwrap();
            let docs = root.join("docs");
            let mut pool = Vec::new();
            for doc in HelpDoc::ALL {
                let markdown = doc.read(&docs).unwrap();
                pool.extend(doc.units(&markdown).into_iter().map(|unit| (doc, unit)));
            }
            let units: Vec<_> = pool.iter().map(|(_, unit)| unit.clone()).collect();
            let place = |ranked: &[String], anchor: &str| {
                ranked
                    .iter()
                    .position(|source| source == anchor)
                    .map(|p| p + 1)
            };
            let mut within = [0; 4];
            for item in &set {
                let question = item["question"].as_str().unwrap();
                let anchor = item["anchor"].as_str().unwrap();
                let terms = crate::help_docs::search_terms(question);
                let plain: Vec<String> =
                    crate::help_docs::search_units(&units, question, units.len())
                        .0
                        .into_iter()
                        .map(|i| format!("{}#{}", pool[i].0.name(), pool[i].1.anchor))
                        .collect();
                let mut words = index.lexical_sources(HELP_KIND, None, &terms).unwrap();
                let mut seen = HashSet::new();
                words.retain(|source| seen.insert(source.clone()));
                let embedded = client.embed(vec![question.to_string()]).await.unwrap();
                let vector = embedded.vectors[0].as_ref().unwrap();
                let source_of: std::collections::HashMap<i64, &str> = stored
                    .iter()
                    .map(|chunk| (chunk.id, chunk.source_id.as_str()))
                    .collect();
                let mut seen = HashSet::new();
                let meaning: Vec<String> = rank_by_similarity(
                    Query {
                        model: &model,
                        vector,
                    },
                    stored.iter().map(|chunk| Candidate {
                        id: chunk.id,
                        model: &model,
                        vector: &chunk.vector,
                    }),
                    stored.len(),
                )
                .iter()
                .map(|scored| source_of[&scored.id].to_string())
                .filter(|source| seen.insert(source.clone()))
                .collect();
                let fused = search
                    .rank(HELP_KIND, None, question, &terms)
                    .await
                    .unwrap()
                    .sources;
                let places = [&plain, &words, &meaning, &fused].map(|r| place(r, anchor));
                for (count, found) in within.iter_mut().zip(places) {
                    if found.is_some_and(|p| p <= 6) {
                        *count += 1;
                    }
                }
                println!("plain/bm25/cosine/fused {places:?} {anchor}: {question}");
            }
            println!(
                "within six of {}: plain {}, bm25 {}, cosine {}, fused {}",
                set.len(),
                within[0],
                within[1],
                within[2],
                within[3]
            );
        }

        // The readings the relevance question rests on: how near the best passage
        // is for a question the guide answers and for ones it cannot.
        use super::super::search::SemanticSearch;
        use tugsem_core::{Candidate, Query, rank_by_similarity};
        let search = SemanticSearch::new(Arc::clone(&index), Arc::clone(&client));
        let stored = index.vectors(HELP_KIND, &model, None).unwrap();
        for query in [
            "how do I create an arc?",
            "what does a label like 2B on a card mean?",
            "how do I make everything on screen bigger?",
            "zzyzx",
            "what is the capital of France?",
            "how should I roast a turkey?",
        ] {
            let embedded = client.embed(vec![query.to_string()]).await.unwrap();
            let vector = embedded.vectors[0].as_ref().unwrap();
            let best = rank_by_similarity(
                Query {
                    model: &model,
                    vector,
                },
                stored.iter().map(|chunk| Candidate {
                    id: chunk.id,
                    model: &model,
                    vector: &chunk.vector,
                }),
                1,
            );
            let terms = crate::help_docs::search_terms(query);
            let ranked = search.rank(HELP_KIND, None, query, &terms).await.unwrap();
            println!(
                "{query:?}: best cosine {:.3}, words {}, top {:?}",
                best[0].score,
                ranked.any_terms,
                &ranked.sources[..ranked.sources.len().min(6)]
            );
            if query.contains("create an arc") {
                assert!(
                    ranked.sources[..6]
                        .iter()
                        .any(|source| source == "features#opening-an-arc")
                );
            }
        }
    }
}
