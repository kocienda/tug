//! Feeding sources into the index.
//!
//! A source is scrubbed, chunked, embedded and stored as one, and only when its
//! content or the live model has changed. Its passages go to the embedder a batch
//! at a time, because a question waits behind whatever batch is in the helper, and
//! they are stored under the one model every batch came back from, so no source
//! ever holds two models. With no model live its passages are stored without
//! vectors, which still serves lexical search, and they are embedded when one
//! arrives.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::sync::{Notify, mpsc, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::warn;
use tugsem_core::{CHUNKING_VERSION, chunk, lexical_spans};

use super::coverage::{SemanticCoverage, coverage_channel};
use super::documents::{DocumentWatch, Documents};
use super::embedder::{Embedded, EmbedderClient};
use super::index::{Replacement, SemanticError, SemanticIndex, SourceKey};
use super::observer::{drain_facts, drain_posts};
use super::transcript::CatchUp;
use crate::feeds::secret_filter::scrub_text;
use crate::help_docs::HelpDoc;
use crate::session_ledger::SessionLedger;

/// The source kind of a help unit, whose id is `<document>#<anchor>`.
pub(crate) const HELP_KIND: &str = "help";

/// The source kind of one block of a transcript, whose id is
/// `<session>/<record uuid>.<block index>`.
pub(crate) const TRANSCRIPT_KIND: &str = "transcript";

/// The source kind of one settled fact, whose id is `<session>/<fact id>`, or
/// `-/<fact id>` when it belongs to no session.
pub(crate) const FACT_KIND: &str = "fact";

/// The source kind of one Overview post, whose id is `<session>/<post id>`, or
/// `-/<post id>` when it belongs to no session.
pub(crate) const POST_KIND: &str = "post";

/// The source kind of one section of a project document, whose id is
/// `<project_dir>::<relative path>#<slug>`.
pub(crate) const DOCUMENT_KIND: &str = "document";

/// The kinds drawn from a session, whose ids begin with it and a `/`. Marking the
/// session private or trashing it removes all of them.
pub(crate) const SESSION_KINDS: [&str; 3] = [TRANSCRIPT_KIND, FACT_KIND, POST_KIND];

/// What a session kind's id begins with when it belongs to no session. No session
/// id is ever this.
pub(super) const NO_SESSION: &str = "-";

/// The most passages sent to the embedder at once. A batch is what a question's own
/// embed waits behind, and it has only a few seconds before it gives up.
pub(crate) const EMBED_BATCH: usize = 16;

/// How many times a source is embedded before it is stored with no vectors, when
/// its batches keep coming back under different models.
const EMBED_ATTEMPTS: usize = 2;

/// One thing to index.
pub(crate) struct Source<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub context: &'a str,
    pub text: &'a str,
    /// The session this was drawn from, which decides whether it may enter at all.
    pub session: Option<&'a str>,
    /// What a reader wants of the source beyond its text, as JSON.
    pub meta: Option<&'a str>,
    /// A body too long for a model to read, held for the text shadow alone beside
    /// `text`, which is what is embedded.
    pub lexical: Option<&'a str>,
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
    pub(super) index: Arc<SemanticIndex>,
    pub(super) embedder: Arc<EmbedderClient>,
    pub(super) sessions: Option<Arc<SessionLedger>>,
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
    pub(super) fn may_index(&self, session: &str) -> bool {
        let Some(sessions) = self.sessions.as_ref() else {
            return false;
        };
        matches!(sessions.is_session_private(session), Ok(false))
    }

    /// Bring one source up to date.
    pub(crate) async fn ingest(&self, source: &Source<'_>) -> Result<Ingested, SemanticError> {
        Ok(self.ingest_counted(source).await?.0)
    }

    /// Bring one source up to date, answering also how many passages that stored, none
    /// when nothing moved.
    pub(super) async fn ingest_counted(
        &self,
        source: &Source<'_>,
    ) -> Result<(Ingested, usize), SemanticError> {
        self.store(source, source.meta).await
    }

    /// Bring up to date a source whose `meta` says where it is and not what it is, so
    /// that moving is not changing: its passages are embedded only when its text
    /// moves, and otherwise the new place is written down. Answers how many passages
    /// that stored.
    pub(super) async fn ingest_placed(&self, source: &Source<'_>) -> Result<usize, SemanticError> {
        let (outcome, stored) = self.store(source, None).await?;
        if outcome == Ingested::Unchanged
            && let Some(meta) = source.meta
        {
            self.index
                .set_source_meta(source.kind, source.id, &scrub_text(meta))?;
        }
        Ok(stored)
    }

    /// Bring one source up to date, under a hash that takes in `hashed_meta`.
    async fn store(
        &self,
        source: &Source<'_>,
        hashed_meta: Option<&str>,
    ) -> Result<(Ingested, usize), SemanticError> {
        if source
            .session
            .is_some_and(|session| !self.may_index(session))
        {
            self.index.remove_source(source.kind, source.id)?;
            return Ok((Ingested::Refused, 0));
        }

        let text = scrub_text(source.text);
        // The context line is embedded and stored with every passage, so it is
        // scrubbed as the text is.
        let context = scrub_text(source.context);
        let meta = source.meta.map(scrub_text);
        let lexical = source.lexical.map(scrub_text);
        let hashed_meta = hashed_meta.map(scrub_text);
        let content_hash =
            content_hash(&context, &text, hashed_meta.as_deref(), lexical.as_deref());
        let live = self.embedder.live_model();
        if let Some(state) = self.index.source_state(source.kind, source.id)?
            && state.content_hash == content_hash
            && (live.is_none() || state.model == live)
        {
            return Ok((Ingested::Unchanged, 0));
        }

        let passages = chunk(&context, &text);
        let embedded = match live {
            Some(_) if !passages.is_empty() => {
                let texts: Vec<String> = passages.iter().map(|p| p.embedding_text()).collect();
                self.embed_in_batches(&texts).await
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
            return Ok((Ingested::Refused, 0));
        }
        self.index.replace_source(&Replacement {
            kind: source.kind,
            id: source.id,
            content_hash: &content_hash,
            model: embedded.as_ref().map(|answer| answer.model.as_str()),
            passages: &passages,
            vectors: embedded.as_ref().map_or(&[], |answer| &answer.vectors),
            meta: meta.as_deref(),
            lexical: &lexical
                .as_deref()
                .map_or_else(Vec::new, |body| lexical_spans(&context, body)),
        })?;
        Ok((Ingested::Stored, passages.len()))
    }

    /// Embed one source's texts a batch at a time, and answer them under one model.
    /// A helper that moves between two batches means the whole source is embedded
    /// again, because its chunks must never mix models; `None` if they are still
    /// mixed then, or if any batch fails.
    async fn embed_in_batches(&self, texts: &[String]) -> Option<Embedded> {
        for _ in 0..EMBED_ATTEMPTS {
            let mut whole: Option<Embedded> = None;
            let mut mixed = false;
            for batch in texts.chunks(EMBED_BATCH) {
                let answer = self.embedder.embed(batch.to_vec()).await.ok()?;
                match whole.as_mut() {
                    None => whole = Some(answer),
                    Some(held) if held.model == answer.model => {
                        held.vectors.extend(answer.vectors);
                    }
                    Some(_) => {
                        mixed = true;
                        break;
                    }
                }
            }
            if !mixed {
                return whole;
            }
        }
        None
    }

    /// One page of bringing stored text up to the live model: the sources past
    /// `after` whose model is not the live one, up to `limit` of them, stopping as
    /// soon as a batch's worth of passages has been embedded. Answers where the page
    /// stopped, to pass as the next `after`, or `None` when the round is over, which
    /// is also the answer with no model live.
    ///
    /// This reads what the index holds rather than walking the sources again, which
    /// would bring back what removal took out. Help is not among them: it is
    /// re-ingested from its documents.
    pub(crate) async fn reembed_stale(
        &self,
        after: Option<&SourceKey>,
        limit: usize,
    ) -> Result<Option<SourceKey>, SemanticError> {
        let Some(live) = self.embedder.live_model() else {
            return Ok(None);
        };
        let mut last = None;
        let mut embedded = 0;
        for key in self.index.stale_sources(&live, after, limit)? {
            embedded += self.reembed_source(&key).await?;
            last = Some(key);
            if embedded >= EMBED_BATCH {
                break;
            }
        }
        Ok(last)
    }

    /// Embed one source's stored passages again, answering how many went to the
    /// embedder. One the embedder cannot answer for is left as it is, still stale,
    /// for the next round.
    async fn reembed_source(&self, key: &SourceKey) -> Result<usize, SemanticError> {
        let session = session_of(&key.kind, &key.id);
        if session.is_some_and(|session| !self.may_index(session)) {
            self.index.remove_source(&key.kind, &key.id)?;
            return Ok(0);
        }
        let chunks = self.index.embeddable_chunks(&key.kind, &key.id)?;
        let texts: Vec<String> = chunks.iter().map(|chunk| chunk.text.clone()).collect();
        let Some(answer) = self.embed_in_batches(&texts).await else {
            return Ok(0);
        };
        // The embed is where any wait is, and the session may have gone private
        // during it.
        if session.is_some_and(|session| !self.may_index(session)) {
            self.index.remove_source(&key.kind, &key.id)?;
            return Ok(0);
        }
        let vectors: Vec<(i64, Option<&[f32]>)> = chunks
            .iter()
            .zip(&answer.vectors)
            .map(|(chunk, vector)| (chunk.id, vector.as_deref()))
            .collect();
        self.index.replace_vectors(key, &answer.model, &vectors)?;
        Ok(chunks.len())
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
                    meta: None,
                    lexical: None,
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

/// The session a source was drawn from, if its kind has one.
fn session_of<'a>(kind: &str, id: &'a str) -> Option<&'a str> {
    if !SESSION_KINDS.contains(&kind) {
        return None;
    }
    id.split_once('/')
        .map(|(session, _)| session)
        .filter(|session| *session != NO_SESSION)
}

/// Remove every source drawn from `session`, and the place its transcript's reader
/// had reached, so a session that comes back is read again from the start.
pub(crate) fn remove_session_sources(
    index: &SemanticIndex,
    session: &str,
) -> Result<(), SemanticError> {
    for kind in SESSION_KINDS {
        let ids = index.session_source_ids(kind, session)?;
        index.remove_sources(kind, &ids)?;
    }
    index.delete_cursor(session)
}

/// What a source's chunks depend on, so an unchanged hash means unchanged chunks. A
/// part a source does not have adds nothing, so a source that has neither hashes as
/// it did before there were such parts, and is not embedded again for it.
fn content_hash(context: &str, text: &str, meta: Option<&str>, lexical: Option<&str>) -> String {
    let mut hash = Sha256::new();
    hash.update(CHUNKING_VERSION.to_le_bytes());
    hash.update(context.as_bytes());
    hash.update([0]);
    hash.update(text.as_bytes());
    for (tag, part) in [(1, meta), (2, lexical)] {
        if let Some(part) = part {
            hash.update([0, tag]);
            hash.update(part.as_bytes());
        }
    }
    format!("{:x}", hash.finalize())
}

fn help_title(doc: HelpDoc) -> &'static str {
    match doc {
        HelpDoc::Features => "Tug feature guide",
        HelpDoc::Recipes => "Tug recipes",
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

/// How long after boot the index's worker stays out of the way. Loading the model and
/// embedding take a couple of seconds of CPU, which the first moments of a launch
/// have no room for, and nothing is waiting on them: until then a search is lexical.
pub(crate) const INDEX_SETTLE: Duration = Duration::from_secs(30);

/// What wakes the index's worker and where it reads from.
pub(crate) struct IndexStreams {
    pub docs_dir: Option<PathBuf>,
    /// Fires when the ledger writes a fact or a post.
    pub observer: Arc<Notify>,
    /// Whether to walk what is already on disk. An instance that lives for one
    /// test has no use for it.
    pub catch_up: bool,
    /// Fires when a turn ends, which is a transcript that grew.
    pub ticks: mpsc::Receiver<String>,
    /// Where the worker says how far it has come.
    pub coverage: watch::Sender<SemanticCoverage>,
    /// Where the project documents are heard from. An instance that lives for one
    /// test has none.
    pub documents: Option<DocumentWatch>,
}

/// The background work the worker has yet to do.
struct Owed {
    /// A re-embed round, and where its next page starts.
    round: Option<Option<SourceKey>>,
    facts: bool,
    posts: bool,
    documents: Documents,
    catch_up: CatchUp,
}

impl Owed {
    fn any(&self) -> bool {
        self.round.is_some()
            || self.facts
            || self.posts
            || self.documents.owed()
            || self.catch_up.owed()
    }

    /// Do the first of what is owed, as one unit: at most a batch or so of passages,
    /// so that nothing live waits long behind it. A unit that fails is logged and
    /// not tried again until something else asks for it.
    async fn run_unit(&mut self, indexer: &Indexer) {
        if let Some(after) = self.round.take() {
            match indexer.reembed_stale(after.as_ref(), EMBED_BATCH).await {
                Ok(next) => self.round = next.map(Some),
                Err(err) => warn!("semantic index: {err}"),
            }
        } else if self.facts {
            self.drain_facts(indexer).await;
        } else if self.posts {
            self.drain_posts(indexer).await;
        } else if self.documents.owed() {
            self.documents.run_unit(indexer).await;
        } else {
            self.catch_up.run_unit(indexer).await;
        }
    }

    async fn drain_facts(&mut self, indexer: &Indexer) {
        self.facts = drain_facts(indexer).await.unwrap_or_else(|err| {
            warn!("semantic index: {err}");
            false
        });
    }

    async fn drain_posts(&mut self, indexer: &Indexer) {
        self.posts = drain_posts(indexer).await.unwrap_or_else(|err| {
            warn!("semantic index: {err}");
            false
        });
    }
}

async fn index_help(indexer: &Indexer, docs_dir: Option<&Path>) {
    if let Some(dir) = docs_dir
        && let Err(err) = indexer.index_help(dir).await
    {
        warn!("semantic index: {err}");
    }
}

/// The one task that writes the index, off the startup path, for as long as tugcast
/// runs. It settles, starts the helper and brings the help documents up to date, and
/// then prefers anything live over its background work, which it does one unit at a
/// time with a rest as long as the unit took. With nothing owed it parks on its
/// signals.
///
/// A re-embed round is owed at every start and not only when the model moves: the
/// model a helper announces at start wakes nothing, and a file written under an older
/// model, or with no helper at all, would otherwise stay stale for good. A failure in
/// any arm is logged and never ends the loop.
pub(crate) async fn run_index(
    indexer: Indexer,
    streams: IndexStreams,
    settle: Duration,
    cancel: CancellationToken,
) {
    tokio::select! {
        _ = cancel.cancelled() => return,
        _ = tokio::time::sleep(settle) => {}
    }
    let docs_dir = streams.docs_dir.as_deref();
    let observer = streams.observer;
    let mut ticks = streams.ticks;
    let mut ticks_open = true;
    let mut models = indexer.embedder.watch_model();
    indexer.embedder.start().await;
    if let Err(err) = indexer.purge_private() {
        warn!("semantic index: {err}");
    }
    models.borrow_and_update();
    index_help(&indexer, docs_dir).await;
    let mut owed = Owed {
        round: Some(None),
        facts: true,
        posts: true,
        documents: Documents::new(streams.documents),
        catch_up: CatchUp::new(streams.catch_up, streams.coverage),
    };
    owed.catch_up.publish(&indexer);
    owed.documents.open_projects().await;
    let mut rest_until = Instant::now();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            changed = models.changed() => {
                if changed.is_err() {
                    return;
                }
                index_help(&indexer, docs_dir).await;
                owed.round = Some(None);
                owed.catch_up.publish(&indexer);
            }
            tick = ticks.recv(), if ticks_open => {
                if tick.is_none() {
                    ticks_open = false;
                    continue;
                }
                while ticks.try_recv().is_ok() {}
                owed.catch_up.live_pass(&indexer).await;
            }
            _ = observer.notified() => {
                owed.drain_facts(&indexer).await;
                owed.drain_posts(&indexer).await;
            }
            heard = owed.documents.events.recv(), if owed.documents.listening() => {
                if let Some((project, heard)) = heard {
                    owed.documents.heard(&project, heard).await;
                }
            }
            opened = owed.documents.opens.recv(), if owed.documents.opens_live() => {
                if opened.is_none() {
                    owed.documents.opens_closed();
                    continue;
                }
                while owed.documents.opens.try_recv().is_ok() {}
                owed.documents.open_projects().await;
            }
            loaded = owed.catch_up.loaded(), if owed.catch_up.is_loading() => {
                owed.catch_up.apply(&indexer, loaded);
            }
            _ = tokio::time::sleep_until(rest_until), if owed.any() => {
                let started = Instant::now();
                owed.run_unit(&indexer).await;
                rest_until = Instant::now() + started.elapsed();
            }
        }
    }
}

/// Read everything the worker would, to its end and with no rest, for a run with no
/// boot to wait out. A ledger that has never seen `project` is told of it here.
pub(crate) async fn index_history_now(indexer: &Indexer, project: &str) {
    for (stream, drain) in [("facts", true), ("posts", false)] {
        loop {
            let more = if drain {
                drain_facts(indexer).await
            } else {
                drain_posts(indexer).await
            };
            match more {
                Ok(true) => {}
                Ok(false) => break,
                Err(err) => {
                    warn!("semantic index: reading the {stream}: {err}");
                    break;
                }
            }
        }
    }
    let mut documents = Documents::new(None);
    documents.index_project(project).await;
    while documents.owed() {
        documents.run_unit(indexer).await;
    }
    let mut catch_up = CatchUp::new(true, coverage_channel(false).0);
    catch_up.also_listing(project);
    loop {
        if catch_up.is_loading() {
            let loaded = catch_up.loaded().await;
            catch_up.apply(indexer, loaded);
        } else if catch_up.owed() {
            catch_up.run_unit(indexer).await;
        } else {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::coverage::coverage_channel;
    use super::super::embedder::fake::{FakeState, client, vector_of};
    use super::super::index::{StoredChunk, TranscriptCursor};
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
    const RECIPES: &str = "# How do I\n\nOne recipe per task.\n";
    const GLOSSARY: &str =
        "**Arc.** One piece of work.\n\n**Door.** The skill that opens an arc.\n";

    fn fixture_with(state: Arc<FakeState>, sessions: Option<Arc<SessionLedger>>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("docs");
        std::fs::create_dir(&docs).unwrap();
        std::fs::write(docs.join("features.md"), FEATURES).unwrap();
        std::fs::write(docs.join("recipes.md"), RECIPES).unwrap();
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
                "glossary#door",
                "recipes#how-do-i"
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
        assert_eq!(f.state.take_embedded().len(), 6);
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
        assert_eq!(f.state.take_embedded().len(), 6);
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
                meta: None,
                lexical: None,
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
        assert_eq!(chunks.len(), 6);
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
                meta: None,
                lexical: None,
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
                meta: None,
                lexical: None,
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
                kind: TRANSCRIPT_KIND,
                id: "s1/turn-3",
                context: "c",
                text: "Private words.",
                session: Some("s1"),
                meta: None,
                lexical: None,
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
                kind: TRANSCRIPT_KIND,
                id: "s1/u.0",
                context: "c",
                text: "Words.",
                session: Some("s1"),
                meta: None,
                lexical: None,
            })
            .await
            .unwrap();
        assert_eq!(outcome, Ingested::Refused);
    }

    fn streams_of(docs: PathBuf) -> IndexStreams {
        IndexStreams {
            docs_dir: Some(docs),
            observer: Arc::new(Notify::new()),
            catch_up: true,
            ticks: mpsc::channel(1).1,
            coverage: coverage_channel(true).0,
            documents: None,
        }
    }

    fn cursor_of(session: &str) -> TranscriptCursor {
        TranscriptCursor {
            session_id: session.to_string(),
            path: format!("/p/{session}.jsonl"),
            offset: 10,
            tail_hash: 1,
            turn_count: 1,
            shown_turn: 1,
            open: false,
            pending_close: false,
            pending_close_msg_id: None,
            leaf_uuid: None,
            effective_uuids: None,
        }
    }

    async fn ingest_session(f: &Fixture, id: &str, session: &str) -> Ingested {
        f.indexer
            .ingest(&Source {
                kind: TRANSCRIPT_KIND,
                id,
                context: "c",
                text: "Open words.",
                session: Some(session),
                meta: None,
                lexical: None,
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
        assert_eq!(ingest_session(&f, "s1/u.0", "s1").await, Ingested::Stored);
        assert_eq!(
            ingest_session(&f, "s1/turn-3", "s1").await,
            Ingested::Stored
        );
        assert_eq!(
            ingest_session(&f, "s10/turn-1", "s10").await,
            Ingested::Stored
        );

        f.indexer.remove_session("s1").unwrap();
        let mut left = f.index.source_ids(TRANSCRIPT_KIND).unwrap();
        left.sort();
        assert_eq!(left, ["s10/turn-1"]);
    }

    #[tokio::test]
    async fn a_run_purges_what_a_failed_removal_left_behind() {
        let (_dir, sessions) = sessions_with("s1", false);
        let f = fixture_with(FakeState::new(Some("nl-a")), Some(Arc::clone(&sessions)));
        f.indexer.embedder.start().await;
        ingest_session(&f, "s1/u.0", "s1").await;
        f.index.set_cursor(&cursor_of("s1")).unwrap();
        sessions.set_session_private("s1", true).unwrap();

        f.indexer.purge_private().unwrap();
        assert!(f.index.source_ids(TRANSCRIPT_KIND).unwrap().is_empty());
        assert_eq!(f.index.cursor("s1").unwrap(), None);
    }

    #[tokio::test]
    async fn removing_a_session_takes_every_kind_and_its_cursor_and_nobody_elses() {
        let (_dir, sessions) = sessions_with("s1", false);
        let f = fixture_with(FakeState::new(Some("nl-a")), Some(sessions));
        for kind in [TRANSCRIPT_KIND, FACT_KIND, POST_KIND] {
            for id in ["s1/1", "s10/1", "-/1"] {
                f.index.store_for_test(kind, id);
            }
        }
        f.index.store_for_test(DOCUMENT_KIND, "s1/1");
        f.index.set_cursor(&cursor_of("s1")).unwrap();
        f.index.set_cursor(&cursor_of("s10")).unwrap();

        f.indexer.remove_session("s1").unwrap();

        for kind in [TRANSCRIPT_KIND, FACT_KIND, POST_KIND] {
            let mut left = f.index.source_ids(kind).unwrap();
            left.sort();
            assert_eq!(left, ["-/1", "s10/1"], "{kind}");
        }
        assert_eq!(f.index.source_ids(DOCUMENT_KIND).unwrap(), ["s1/1"]);
        assert_eq!(f.index.cursor("s1").unwrap(), None);
        assert!(f.index.cursor("s10").unwrap().is_some());
    }

    #[tokio::test]
    async fn a_lexical_body_is_found_scrubbed_and_never_embedded() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        let secret = "sk-ant-abcdefghijklmnopqrstuvwxyz012345";
        let body = format!("first line\ncommit 9f3c1e5a built\nthe key is {secret} here\n");
        f.indexer
            .ingest(&Source {
                kind: DOCUMENT_KIND,
                id: "x",
                context: "c",
                text: "The head of a log.",
                session: None,
                meta: Some("{\"line\":3}"),
                lexical: Some(&body),
            })
            .await
            .unwrap();

        let embedded = f.state.take_embedded();
        assert_eq!(embedded, ["c\nThe head of a log."]);
        assert_eq!(f.index.lexical_matches("9f3c1e5a"), 1);
        let chunks = f.index.chunks();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].model.as_deref(), Some("nl-a"));
        assert!(chunks[1].lexical_only);
        assert_eq!(chunks[1].model, None);
        assert_eq!(chunks[1].vector, None);
        assert!(!chunks[1].body.contains(secret));
        assert!(chunks[1].body.contains("[secret] here"));
    }

    async fn ingest_parts(f: &Fixture, meta: Option<&str>, lexical: Option<&str>) -> Ingested {
        f.indexer
            .ingest(&Source {
                kind: DOCUMENT_KIND,
                id: "x",
                context: "c",
                text: "Same text.",
                session: None,
                meta,
                lexical,
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_changed_lexical_body_or_meta_is_a_changed_source() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        assert_eq!(ingest_parts(&f, None, None).await, Ingested::Stored);
        assert_eq!(ingest_parts(&f, None, None).await, Ingested::Unchanged);
        assert_eq!(ingest_parts(&f, Some("{}"), None).await, Ingested::Stored);
        assert_eq!(
            ingest_parts(&f, Some("{}"), Some("b")).await,
            Ingested::Stored
        );
        assert_eq!(
            ingest_parts(&f, Some("{}"), Some("b")).await,
            Ingested::Unchanged
        );
    }

    #[test]
    fn a_source_with_neither_new_part_hashes_as_it_always_did() {
        let mut hash = Sha256::new();
        hash.update(CHUNKING_VERSION.to_le_bytes());
        hash.update(b"c");
        hash.update([0]);
        hash.update(b"t");
        assert_eq!(
            content_hash("c", "t", None, None),
            format!("{:x}", hash.finalize())
        );
    }

    /// Text that chunks to well over two batches.
    fn long_text() -> String {
        (0..40)
            .map(|paragraph| format!("Paragraph {paragraph} {}.", "words ".repeat(70)))
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    async fn ingest_long(f: &Fixture) {
        f.indexer
            .ingest(&Source {
                kind: DOCUMENT_KIND,
                id: "long",
                context: "c",
                text: &long_text(),
                session: None,
                meta: None,
                lexical: None,
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_long_source_reaches_the_embedder_in_capped_batches() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        ingest_long(&f).await;
        let chunks = f.index.chunks();
        assert!(chunks.len() >= 40, "{}", chunks.len());
        let batches = f.state.batches.lock().clone();
        assert!(batches.len() >= 3);
        assert!(batches.iter().all(|&batch| batch <= EMBED_BATCH));
        assert_eq!(batches.iter().sum::<usize>(), chunks.len());
        assert!(chunks.iter().all(|c| c.model.as_deref() == Some("nl-a")));
    }

    #[tokio::test]
    async fn a_model_that_moves_between_batches_leaves_one_model_on_the_source() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        *f.state.model.lock() = Some("nl-b".to_string());
        // The first pass sees the move at its second batch, and the second pass sees
        // only the new model.
        f.state.answer_models.lock().push_back("nl-a".to_string());
        ingest_long(&f).await;
        let chunks = f.index.chunks();
        assert!(chunks.iter().all(|c| c.model.as_deref() == Some("nl-b")));
        assert_eq!(
            f.state.take_embedded().len(),
            2 * EMBED_BATCH + chunks.len()
        );
        assert_eq!(
            f.index
                .source_state(DOCUMENT_KIND, "long")
                .unwrap()
                .unwrap()
                .model
                .as_deref(),
            Some("nl-b")
        );
    }

    #[tokio::test]
    async fn a_model_that_keeps_moving_stores_the_source_with_no_vectors() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        for model in ["nl-a", "nl-b", "nl-a", "nl-b"] {
            f.state.answer_models.lock().push_back(model.to_string());
        }
        ingest_long(&f).await;
        assert!(
            f.index
                .chunks()
                .iter()
                .all(|c| c.model.is_none() && c.vector.is_none())
        );
        assert_eq!(
            f.index
                .source_state(DOCUMENT_KIND, "long")
                .unwrap()
                .unwrap()
                .model,
            None
        );
    }

    /// Run re-embed pages until the round ends.
    async fn reembed_round(f: &Fixture) {
        let mut after = None;
        while let Some(key) = f
            .indexer
            .reembed_stale(after.as_ref(), EMBED_BATCH)
            .await
            .unwrap()
        {
            after = Some(key);
        }
    }

    #[tokio::test]
    async fn a_round_moves_every_kind_but_help_to_the_new_model_and_brings_nothing_back() {
        let (_dir, sessions) = sessions_with("s1", false);
        sessions
            .record_spawn("gone", "ws", "/proj", "card-2", 2, "gone", None)
            .unwrap();
        let state = FakeState::new(Some("nl-a"));
        let f = fixture_with(Arc::clone(&state), Some(sessions));
        f.index_help().await;
        for (kind, id, session, words) in [
            (TRANSCRIPT_KIND, "s1/u.0", Some("s1"), "Block words."),
            (FACT_KIND, "s1/7", Some("s1"), "Fact words."),
            (FACT_KIND, "-/8", None, "App words."),
            (POST_KIND, "gone/9", Some("gone"), "Gone words."),
            (DOCUMENT_KIND, "/p::a.md#b", None, "Document words."),
        ] {
            f.indexer
                .ingest(&Source {
                    kind,
                    id,
                    context: "ctx",
                    text: words,
                    session,
                    meta: None,
                    lexical: (kind == TRANSCRIPT_KIND).then_some("lexicalbody row"),
                })
                .await
                .unwrap();
        }
        f.indexer.remove_session("gone").unwrap();
        state.take_embedded();
        state.switch_model("nl-b");
        let mut models = f.indexer.embedder.watch_model();
        models
            .wait_for(|model| model.as_deref() == Some("nl-b"))
            .await
            .unwrap();

        reembed_round(&f).await;

        let mut embedded = state.take_embedded();
        embedded.sort();
        assert_eq!(
            embedded,
            [
                "ctx\nApp words.",
                "ctx\nBlock words.",
                "ctx\nDocument words.",
                "ctx\nFact words."
            ]
        );
        for chunk in f.index.chunks() {
            let wanted = if chunk.lexical_only {
                None
            } else if chunk.source_id.contains('#') && !chunk.source_id.starts_with('/') {
                Some("nl-a")
            } else {
                Some("nl-b")
            };
            assert_eq!(chunk.model.as_deref(), wanted, "{}", chunk.source_id);
        }
        assert_eq!(f.chunk("s1/7").vector, Some(vector_of("ctx\nFact words.")));
        assert_eq!(
            f.index
                .source_state(FACT_KIND, "s1/7")
                .unwrap()
                .unwrap()
                .model
                .as_deref(),
            Some("nl-b")
        );
        assert!(f.index.source_ids(POST_KIND).unwrap().is_empty());
        assert_eq!(f.index.lexical_matches("Gone"), 0);

        // Nothing is left for another round, and an unchanged source is up to date.
        reembed_round(&f).await;
        let outcome = f
            .indexer
            .ingest(&Source {
                kind: FACT_KIND,
                id: "s1/7",
                context: "ctx",
                text: "Fact words.",
                session: Some("s1"),
                meta: None,
                lexical: None,
            })
            .await
            .unwrap();
        assert_eq!(outcome, Ingested::Unchanged);
        assert!(state.take_embedded().is_empty());
    }

    #[tokio::test]
    async fn a_page_stops_at_its_limit_and_at_a_batch_of_passages() {
        let f = fixture(Some("nl-a"));
        f.indexer.embedder.start().await;
        ingest_long(&f).await;
        for id in ["z/1", "z/2", "z/3"] {
            f.index.store_for_test(DOCUMENT_KIND, id);
        }
        f.state.switch_model("nl-b");
        let mut models = f.indexer.embedder.watch_model();
        models
            .wait_for(|model| model.as_deref() == Some("nl-b"))
            .await
            .unwrap();

        // The long source alone is past a batch, so the page ends with it.
        let long = f.indexer.reembed_stale(None, 10).await.unwrap().unwrap();
        assert_eq!(long.id, "long");
        // The limit stops this one.
        let one = f
            .indexer
            .reembed_stale(Some(&long), 1)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(one.id, "z/1");
        let last = f
            .indexer
            .reembed_stale(Some(&one), 10)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(last.id, "z/3");
        assert_eq!(
            f.indexer.reembed_stale(Some(&last), 10).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn with_no_live_model_a_page_does_nothing() {
        let f = fixture(None);
        f.indexer.embedder.start().await;
        f.index.store_for_test(DOCUMENT_KIND, "a");
        assert_eq!(f.indexer.reembed_stale(None, 10).await.unwrap(), None);
        assert!(f.state.take_embedded().is_empty());
    }

    #[tokio::test]
    async fn a_round_removes_a_source_whose_session_went_private_and_does_not_embed_it() {
        let (_dir, sessions) = sessions_with("s1", false);
        let f = fixture_with(FakeState::new(Some("nl-a")), Some(Arc::clone(&sessions)));
        f.indexer.embedder.start().await;
        f.index.store_for_test(TRANSCRIPT_KIND, "s1/u.0");
        sessions.set_session_private("s1", true).unwrap();
        reembed_round(&f).await;
        assert!(f.state.take_embedded().is_empty());
        assert!(f.index.source_ids(TRANSCRIPT_KIND).unwrap().is_empty());
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
        let run = tokio::spawn(run_index(
            indexer,
            streams_of(docs),
            Duration::ZERO,
            cancel.clone(),
        ));

        let all_of = |index: &SemanticIndex, model: &str| {
            let chunks = index.chunks();
            chunks.len() == 6 && chunks.iter().all(|c| c.model.as_deref() == Some(model))
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
        let run = tokio::spawn(run_index(
            indexer,
            streams_of(docs),
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
        use super::super::embedder::compiled;

        let root = compiled::checkout_root();
        let dir = tempfile::tempdir().unwrap();
        let index = Arc::new(SemanticIndex::open(dir.path().join("semantic.db")).unwrap());
        let client = compiled::client(dir.path());
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
            let search = SemanticSearch::new(
                Arc::clone(&index),
                Arc::clone(&client),
                coverage_channel(false).1,
            );
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
        let search = SemanticSearch::new(
            Arc::clone(&index),
            Arc::clone(&client),
            coverage_channel(false).1,
        );
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
