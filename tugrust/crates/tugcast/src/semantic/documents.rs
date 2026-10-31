//! The documents stream: what a project declares as its prose, section by section,
//! kept current by the file watcher its workspace already runs.
//!
//! An event's kind is never trusted; the file is looked at. A Briefs Directory set to
//! an absolute path outside the project is not under that watch, so it is read at each
//! project open and each tugcast start and not between them.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::warn;
use tugcast_core::types::FsEvent;
use tugsem_core::{Section, markdown_sections};
use tugtool_core::Config;
use tugtool_core::briefs::{DEFAULT_BRIEFS_TEMPLATE, resolve_briefs_dir};

use super::index::SemanticError;
use super::ingest::{DOCUMENT_KIND, EMBED_BATCH, Indexer, Source};
use crate::feeds::workspace_registry::{WorkspaceEntry, WorkspaceRegistry};

/// A file past this is not prose anyone wrote by hand, and is skipped.
const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;

/// The surface whose paths are a project's documents unless it declares its own.
const PROSE_SURFACE: &str = "prose";

/// A change here can change what is listed.
const CONFIG_PATH: &str = ".tugtool/config.toml";

/// How many batches of file events wait for the worker before a watcher blocks. A
/// watcher blocked for long lags, which reads as a walk.
const EVENT_QUEUE: usize = 64;

/// Answers the Briefs Directory template the user set, if they set one.
pub(crate) type BriefsTemplate = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// What the documents stream hears from. An app-test instance has none of it.
pub(crate) struct DocumentWatch {
    pub registry: Arc<WorkspaceRegistry>,
    /// Fires when a project opens.
    pub opens: mpsc::Receiver<String>,
    pub briefs_template: BriefsTemplate,
}

/// What a project's watcher had to say.
pub(super) enum Heard {
    Batch(Vec<FsEvent>),
    /// Events were lost.
    Lagged,
}

/// A path as the listing holds it: relative to the project with no trailing slash, or
/// `None` when it reaches outside the project.
fn project_relative(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in Path::new(path).components() {
        match part {
            Component::Normal(part) => parts.push(part.to_str()?),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// The paths declared in a list, leaving out and warning of any that reach outside
/// the project.
fn declared_entries<'a>(paths: impl Iterator<Item = &'a String>) -> Vec<String> {
    let mut entries = Vec::new();
    for path in paths {
        match project_relative(path) {
            Some(entry) if !entries.contains(&entry) => entries.push(entry),
            Some(_) => {}
            None => warn!("semantic index: {path:?} is not a project-relative path"),
        }
    }
    entries
}

/// The Briefs Directory as a listing entry: relative when it is in the project, and
/// its whole path when it is not. Joining either to the project gives the directory.
fn briefs_entry(project_dir: &Path, briefs_template: &str) -> String {
    let dir = resolve_briefs_dir(project_dir, briefs_template);
    dir.strip_prefix(project_dir)
        .ok()
        .and_then(|inside| project_relative(&inside.to_string_lossy()))
        .unwrap_or_else(|| dir.to_string_lossy().into_owned())
}

/// The files and directories a project's documents are read from, per
/// `[tugtool.semantic]`: its own list when it declares one, or else the Briefs
/// Directory, when there is one, and the paths of its `prose` surface.
pub(super) fn document_paths(
    project_dir: &Path,
    config: &Config,
    briefs_template: &str,
) -> Vec<String> {
    if let Some(declared) = &config.tugtool.semantic.documents {
        return declared_entries(declared.iter());
    }
    let mut entries = declared_entries(
        config
            .tugtool
            .arc
            .surfaces
            .iter()
            .filter(|surface| surface.name == PROSE_SURFACE)
            .flat_map(|surface| surface.paths.iter()),
    );
    let briefs = briefs_entry(project_dir, briefs_template);
    if project_dir.join(&briefs).is_dir() && !entries.contains(&briefs) {
        entries.insert(0, briefs);
    }
    entries
}

/// Whether `relative` lies inside the directory `entry`, and what follows it there.
fn inside<'a>(entry: &str, relative: &'a str) -> Option<&'a str> {
    if entry.is_empty() {
        return Some(relative);
    }
    relative.strip_prefix(entry)?.strip_prefix('/')
}

/// Whether a path below a listed directory is one a walk of it reads: its `*.md`, and
/// nothing hidden.
fn walked(below: &str) -> bool {
    below.ends_with(".md") && !below.split('/').any(|part| part.starts_with('.'))
}

/// What a project lists, as read at its last walk.
struct Listing {
    paths: Vec<String>,
    /// The default Briefs Directory, which is heard from even while it does not exist,
    /// so the first brief in a new one needs no restart. `None` when the project
    /// declares its own list.
    briefs: Option<String>,
    /// Whether the config could be read. Nothing is removed on the word of one that
    /// could not, since the list it stands in for may be much shorter than the real one.
    readable: bool,
}

/// What an event asks for.
#[derive(Debug, PartialEq, Eq)]
enum Reaction {
    Nothing,
    File,
    Walk,
}

impl Listing {
    fn read(project_dir: &Path, briefs_template: &str) -> (Self, Option<String>) {
        let (config, problem) = match Config::load_from_project(project_dir) {
            Ok(config) => (config, None),
            Err(err) => (Config::default(), Some(err.to_string())),
        };
        let listing = Self {
            paths: document_paths(project_dir, &config, briefs_template),
            briefs: config
                .tugtool
                .semantic
                .documents
                .is_none()
                .then(|| briefs_entry(project_dir, briefs_template)),
            readable: problem.is_none(),
        };
        (listing, problem)
    }

    fn entries(&self) -> impl Iterator<Item = &String> {
        self.paths.iter().chain(self.briefs.iter())
    }

    /// Whether this file is one of the project's documents.
    fn lists_file(&self, relative: &str) -> bool {
        self.entries()
            .any(|entry| entry == relative || inside(entry, relative).is_some_and(walked))
    }

    /// What a path named by an event asks for. A directory that is, holds or lies
    /// inside a listed entry is a walk, because a removed or renamed directory may
    /// report only itself.
    fn react(&self, project_dir: &Path, relative: &str) -> Reaction {
        if relative == CONFIG_PATH {
            return Reaction::Walk;
        }
        if relative.is_empty() {
            return Reaction::Nothing;
        }
        let path = project_dir.join(relative);
        for entry in self.entries() {
            if entry == relative {
                return if path.is_file() {
                    Reaction::File
                } else {
                    Reaction::Walk
                };
            }
            if inside(relative, entry).is_some() {
                return Reaction::Walk;
            }
            let Some(below) = inside(entry, relative) else {
                continue;
            };
            if below.split('/').any(|part| part.starts_with('.')) {
                continue;
            }
            if path.is_dir() {
                return Reaction::Walk;
            }
            if walked(below) {
                return Reaction::File;
            }
            let last = below.rsplit('/').next().unwrap_or(below);
            if !last.contains('.') {
                return Reaction::Walk;
            }
        }
        Reaction::Nothing
    }
}

/// Every file a walk of the listed paths reads, and whether it could look at all of
/// them. A path that does not exist has been looked at.
fn list_files(project_dir: &Path, paths: &[String]) -> (Vec<String>, bool) {
    if std::fs::metadata(project_dir).is_err() {
        return (Vec::new(), false);
    }
    let mut files = Vec::new();
    let mut complete = true;
    for entry in paths {
        match std::fs::metadata(project_dir.join(entry)) {
            Ok(meta) if meta.is_dir() => {
                complete &= list_directory(&project_dir.join(entry), entry, &mut files);
            }
            Ok(_) => files.push(entry.clone()),
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(_) => complete = false,
        }
    }
    files.sort();
    files.dedup();
    (files, complete)
}

fn list_directory(dir: &Path, entry: &str, files: &mut Vec<String>) -> bool {
    let reader = match std::fs::read_dir(dir) {
        Ok(reader) => reader,
        Err(err) => return err.kind() == ErrorKind::NotFound,
    };
    let mut complete = true;
    for child in reader {
        let Ok(child) = child else {
            complete = false;
            continue;
        };
        let name = child.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let relative = if entry.is_empty() {
            name.to_string()
        } else {
            format!("{entry}/{name}")
        };
        match child.file_type() {
            Ok(kind) if kind.is_dir() => {
                complete &= list_directory(&child.path(), &relative, files);
            }
            Ok(_) if name.ends_with(".md") => files.push(relative),
            Ok(_) => {}
            Err(_) => complete = false,
        }
    }
    complete
}

/// What reading a listed file found.
enum Read {
    Text(String),
    /// Not there, not a file, too long or not text: it holds no sections.
    Nothing,
    /// It may hold sections that could not be got at.
    Unreadable,
}

fn read_document(path: &Path) -> Read {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Read::Nothing,
        Err(_) => return Read::Unreadable,
    };
    if !meta.is_file() || meta.len() > MAX_DOCUMENT_BYTES {
        return Read::Nothing;
    }
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map_or(Read::Nothing, Read::Text),
        Err(err) if err.kind() == ErrorKind::NotFound => Read::Nothing,
        Err(_) => Read::Unreadable,
    }
}

fn section_id(project: &str, relative: &str, slug: &str) -> String {
    format!("{project}::{relative}#{slug}")
}

/// A walk over one project's list.
struct Walk {
    project: String,
    /// `None` until the list has been expanded into files.
    files: Option<VecDeque<String>>,
    seen: HashSet<String>,
    /// Whether everything listed could be read, which is what lets the walk's end
    /// remove what it did not see.
    complete: bool,
    /// Something asked for another walk while this one ran.
    again: bool,
}

/// One file part way through being ingested.
struct Reading {
    project: String,
    relative: String,
    sections: VecDeque<Section>,
    /// The ids its sections have, so what it no longer holds can leave.
    ids: HashSet<String>,
}

/// The work of the documents stream, and what it hears from.
pub(super) struct Documents {
    registry: Option<Arc<WorkspaceRegistry>>,
    pub(super) opens: mpsc::Receiver<String>,
    opens_live: bool,
    pub(super) events: mpsc::Receiver<(String, Heard)>,
    events_tx: mpsc::Sender<(String, Heard)>,
    briefs_template: BriefsTemplate,
    /// The entry's cancel for each project being heard from, which says when the
    /// entry has been released and a later open is a new watcher.
    watched: HashMap<String, CancellationToken>,
    listings: HashMap<String, Listing>,
    /// Projects whose unreadable config has been warned of.
    warned: HashSet<String>,
    reading: Option<Reading>,
    /// Files events named, ahead of any walk.
    changed: VecDeque<(String, String)>,
    walks: VecDeque<Walk>,
}

impl Documents {
    pub(super) fn new(watch: Option<DocumentWatch>) -> Self {
        let (events_tx, events) = mpsc::channel(EVENT_QUEUE);
        let (registry, opens, briefs_template) = match watch {
            Some(watch) => (Some(watch.registry), watch.opens, watch.briefs_template),
            None => {
                let none: BriefsTemplate = Arc::new(|| None);
                (None, mpsc::channel(1).1, none)
            }
        };
        Self {
            opens_live: registry.is_some(),
            registry,
            opens,
            events,
            events_tx,
            briefs_template,
            watched: HashMap::new(),
            listings: HashMap::new(),
            warned: HashSet::new(),
            reading: None,
            changed: VecDeque::new(),
            walks: VecDeque::new(),
        }
    }

    pub(super) fn owed(&self) -> bool {
        self.reading.is_some() || !self.changed.is_empty() || !self.walks.is_empty()
    }

    pub(super) fn opens_live(&self) -> bool {
        self.opens_live
    }

    /// The registry's signal has closed, so it will say nothing more.
    pub(super) fn opens_closed(&mut self) {
        self.opens_live = false;
    }

    /// Whether a watcher can be heard from at all.
    pub(super) fn listening(&self) -> bool {
        self.registry.is_some()
    }

    /// Hear from every open project not yet heard from, and walk each. The signal says
    /// only that something opened: a full channel drops its send, and the list is what
    /// is true. Listening starts ahead of the walk, so nothing written during it is lost.
    pub(super) async fn open_projects(&mut self) {
        let Some(registry) = self.registry.clone() else {
            return;
        };
        self.watched.retain(|_, cancel| !cancel.is_cancelled());
        for (_, project) in registry.project_dirs() {
            if self.watched.contains_key(&project) {
                continue;
            }
            let Some(entry) = registry.find_entry_by_path(Path::new(&project)) else {
                continue;
            };
            self.listen(&project, &entry);
            self.index_project(&project).await;
        }
    }

    /// One task per project, which carries its batches here until the entry goes.
    fn listen(&mut self, project: &str, entry: &WorkspaceEntry) {
        self.watched
            .insert(project.to_string(), entry.cancel.clone());
        let mut batches = entry.subscribe_fs();
        let cancel = entry.cancel.clone();
        let events = self.events_tx.clone();
        let project = project.to_string();
        tokio::spawn(async move {
            loop {
                let heard = tokio::select! {
                    _ = cancel.cancelled() => return,
                    batch = batches.recv() => match batch {
                        Ok(batch) => Heard::Batch(batch),
                        Err(broadcast::error::RecvError::Lagged(_)) => Heard::Lagged,
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                };
                if events.send((project.clone(), heard)).await.is_err() {
                    return;
                }
            }
        });
    }

    /// Owe a walk of a project's list. One already running goes on to its end, since a
    /// restart under a steady lag would never finish, and another follows it.
    pub(super) async fn index_project(&mut self, project: &str) {
        if let Some(walk) = self.walks.iter_mut().find(|walk| walk.project == project) {
            walk.again = true;
            return;
        }
        self.read_listing(project).await;
        self.walks.push_back(Walk {
            project: project.to_string(),
            files: None,
            seen: HashSet::new(),
            complete: true,
            again: false,
        });
    }

    async fn read_listing(&mut self, project: &str) {
        let template = (self.briefs_template)().unwrap_or_else(|| DEFAULT_BRIEFS_TEMPLATE.into());
        let dir = PathBuf::from(project);
        let read = tokio::task::spawn_blocking(move || Listing::read(&dir, &template)).await;
        let Ok((listing, problem)) = read else {
            return;
        };
        match problem {
            Some(problem) if self.warned.insert(project.to_string()) => {
                warn!("semantic index: reading the config of {project}: {problem}");
            }
            Some(_) => {}
            None => {
                self.warned.remove(project);
            }
        }
        self.listings.insert(project.to_string(), listing);
    }

    /// Owe a look at one path.
    pub(super) fn reindex_file(&mut self, project: &str, relative: &str) {
        let wanted = (project.to_string(), relative.to_string());
        if !self.changed.contains(&wanted) {
            self.changed.push_back(wanted);
        }
    }

    /// Take in what a project's watcher said.
    pub(super) async fn heard(&mut self, project: &str, heard: Heard) {
        let batch = match heard {
            Heard::Batch(batch) => batch,
            Heard::Lagged => {
                self.index_project(project).await;
                return;
            }
        };
        let dir = PathBuf::from(project);
        let mut walk = false;
        for event in &batch {
            let (first, second) = match event {
                FsEvent::Created { path }
                | FsEvent::Modified { path }
                | FsEvent::Removed { path } => (path, None),
                FsEvent::Renamed { from, to } => (from, Some(to)),
            };
            for path in std::iter::once(first).chain(second) {
                let Some(listing) = self.listings.get(project) else {
                    continue;
                };
                match listing.react(&dir, path) {
                    Reaction::Nothing => {}
                    Reaction::File => self.reindex_file(project, path),
                    Reaction::Walk => walk = true,
                }
            }
        }
        if walk {
            self.index_project(project).await;
        }
    }

    /// Do one unit: at most a batch's worth of passages of the file in hand, or else
    /// the next file, or the next step of a walk.
    pub(super) async fn run_unit(&mut self, indexer: &Indexer) {
        if self.reading.is_none() {
            if let Some((project, relative)) = self.changed.pop_front() {
                self.open_file(indexer, &project, &relative).await;
            } else {
                self.advance_walk(indexer).await;
            }
        }
        if self.reading.is_some() {
            self.ingest_some(indexer).await;
        }
    }

    /// Expand the walk in hand into its files, take its next file, or end it.
    async fn advance_walk(&mut self, indexer: &Indexer) {
        let Some(walk) = self.walks.front_mut() else {
            return;
        };
        let project = walk.project.clone();
        if walk.files.is_none() {
            let dir = PathBuf::from(&project);
            let listing = self.listings.get(&project);
            let paths = listing.map_or_else(Vec::new, |listing| listing.paths.clone());
            let readable = listing.is_some_and(|listing| listing.readable);
            let listed = tokio::task::spawn_blocking(move || list_files(&dir, &paths)).await;
            let (files, complete) = listed.unwrap_or_default();
            walk.files = Some(files.into());
            walk.complete = complete && readable;
        }
        let next = walk.files.as_mut().and_then(VecDeque::pop_front);
        match next {
            Some(relative) => self.open_file(indexer, &project, &relative).await,
            None => self.end_walk(indexer).await,
        }
    }

    async fn end_walk(&mut self, indexer: &Indexer) {
        let Some(walk) = self.walks.pop_front() else {
            return;
        };
        if walk.complete
            && let Err(err) = remove_unseen(indexer, &walk.project, &walk.seen)
        {
            warn!("semantic index: {err}");
        }
        if walk.again {
            self.index_project(&walk.project).await;
        }
    }

    /// Read one file and put its sections in hand. A file not listed, or that holds
    /// none, loses what the index has of it; one that cannot be read keeps it.
    async fn open_file(&mut self, indexer: &Indexer, project: &str, relative: &str) {
        let Some(listing) = self.listings.get(project) else {
            return;
        };
        if !listing.lists_file(relative) {
            if listing.readable {
                self.remove_file(indexer, project, relative);
            }
            return;
        }
        let path = Path::new(project).join(relative);
        let read = tokio::task::spawn_blocking(move || read_document(&path)).await;
        match read.unwrap_or(Read::Unreadable) {
            Read::Text(text) => {
                let sections = markdown_sections(&text);
                let ids = sections
                    .iter()
                    .map(|section| section_id(project, relative, &section.slug))
                    .collect();
                if let Some(walk) = self.walk_of(project) {
                    walk.seen.insert(relative.to_string());
                }
                self.reading = Some(Reading {
                    project: project.to_string(),
                    relative: relative.to_string(),
                    sections: sections.into(),
                    ids,
                });
            }
            Read::Nothing => self.remove_file(indexer, project, relative),
            Read::Unreadable => {
                warn!("semantic index: could not read {relative} in {project}");
                self.mark_incomplete(project);
            }
        }
    }

    fn walk_of(&mut self, project: &str) -> Option<&mut Walk> {
        self.walks.iter_mut().find(|walk| walk.project == project)
    }

    fn mark_incomplete(&mut self, project: &str) {
        if let Some(walk) = self.walk_of(project) {
            walk.complete = false;
        }
    }

    fn remove_file(&mut self, indexer: &Indexer, project: &str, relative: &str) {
        if let Err(err) = remove_file_sources(indexer, project, relative, &HashSet::new()) {
            warn!("semantic index: {err}");
        }
    }

    /// Ingest the file in hand until a batch's worth of passages has been stored or it
    /// is finished, and when it is, let go what it no longer holds. An unchanged section
    /// costs nothing and does not count.
    async fn ingest_some(&mut self, indexer: &Indexer) {
        let Some(reading) = self.reading.as_mut() else {
            return;
        };
        let mut stored = 0;
        let mut failed = false;
        while stored < EMBED_BATCH {
            let Some(section) = reading.sections.pop_front() else {
                break;
            };
            match ingest_section(indexer, &reading.project, &reading.relative, &section).await {
                Ok(count) => stored += count,
                Err(err) => {
                    warn!("semantic index: {err}");
                    failed = true;
                    break;
                }
            }
        }
        if failed {
            if let Some(reading) = self.reading.take() {
                self.mark_incomplete(&reading.project);
            }
            return;
        }
        if reading.sections.is_empty() {
            if let Err(err) =
                remove_file_sources(indexer, &reading.project, &reading.relative, &reading.ids)
            {
                warn!("semantic index: {err}");
            }
            self.reading = None;
        }
    }
}

/// Bring one section up to date, answering how many passages that stored. Its line is
/// where it is and not what it is, so a section that only moved embeds nothing.
async fn ingest_section(
    indexer: &Indexer,
    project: &str,
    relative: &str,
    section: &Section,
) -> Result<usize, SemanticError> {
    let id = section_id(project, relative, &section.slug);
    let context = if section.heading_path.is_empty() {
        relative.to_string()
    } else {
        format!("{relative} > {}", section.heading_path)
    };
    let meta = serde_json::json!({
        "project_dir": project,
        "path": relative,
        "line": section.line,
    })
    .to_string();
    indexer
        .ingest_placed(&Source {
            kind: DOCUMENT_KIND,
            id: &id,
            context: &context,
            text: &section.text,
            session: None,
            meta: Some(&meta),
            lexical: None,
        })
        .await
}

/// Remove a file's sections other than those in `keep`. `$` is the character after
/// `#`, so the range holds the ids that begin with the file's path and a `#`, and the
/// last `#` of an id is the one before its slug, which rules out a longer file name
/// that happens to hold one.
fn remove_file_sources(
    indexer: &Indexer,
    project: &str,
    relative: &str,
    keep: &HashSet<String>,
) -> Result<(), SemanticError> {
    let file = format!("{project}::{relative}");
    let ids = indexer.index.source_ids_between(
        DOCUMENT_KIND,
        &format!("{file}#"),
        &format!("{file}$"),
    )?;
    let leaving: Vec<&String> = ids
        .iter()
        .filter(|id| id.rsplit_once('#').is_some_and(|(path, _)| path == file))
        .filter(|id| !keep.contains(*id))
        .collect();
    indexer.index.remove_sources(DOCUMENT_KIND, &leaving)
}

/// Remove the project's sections of files a finished walk did not see. `;` is the
/// character after `:`.
fn remove_unseen(
    indexer: &Indexer,
    project: &str,
    seen: &HashSet<String>,
) -> Result<(), SemanticError> {
    let prefix = format!("{project}::");
    let ids = indexer
        .index
        .source_ids_between(DOCUMENT_KIND, &prefix, &format!("{project}:;"))?;
    let leaving: Vec<&String> = ids
        .iter()
        .filter(|id| {
            id.strip_prefix(&prefix)
                .and_then(|rest| rest.rsplit_once('#'))
                .is_none_or(|(relative, _)| !seen.contains(relative))
        })
        .collect();
    indexer.index.remove_sources(DOCUMENT_KIND, &leaving)
}

#[cfg(test)]
mod tests {
    use super::super::embedder::fake::{FakeState, client};
    use super::super::index::SemanticIndex;
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;

    const NOTES: &str = "# Plan\n\nThe opening words.\n\n## Retries\n\nBack off and try again.\n\n## Storage\n\nKeep it on disk.\n";

    struct Project {
        _ledger: TempDir,
        dir: TempDir,
        key: String,
        state: Arc<FakeState>,
        index: Arc<SemanticIndex>,
        indexer: Indexer,
        documents: Documents,
    }

    impl Project {
        async fn new() -> Self {
            let ledger = tempfile::tempdir().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let state = FakeState::new(Some("nl-a"));
            let index = Arc::new(SemanticIndex::open(ledger.path().join("semantic.db")).unwrap());
            let indexer = Indexer::new(Arc::clone(&index), client(&state), None);
            indexer.embedder.start().await;
            let key = dir.path().to_string_lossy().into_owned();
            Self {
                _ledger: ledger,
                dir,
                key,
                state,
                index,
                indexer,
                documents: Documents::new(None),
            }
        }

        fn write(&self, relative: &str, text: &str) {
            let path = self.dir.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        fn id(&self, relative: &str, slug: &str) -> String {
            section_id(&self.key, relative, slug)
        }

        async fn walk(&mut self) {
            self.documents.index_project(&self.key.clone()).await;
            self.drain().await;
        }

        async fn drain(&mut self) {
            while self.documents.owed() {
                self.documents.run_unit(&self.indexer).await;
            }
        }

        async fn hear(&mut self, event: FsEvent) {
            let key = self.key.clone();
            self.documents.heard(&key, Heard::Batch(vec![event])).await;
            self.drain().await;
        }

        fn ids(&self) -> Vec<String> {
            let mut ids = self.index.source_ids(DOCUMENT_KIND).unwrap();
            ids.sort();
            ids
        }
    }

    fn config(toml: &str) -> Config {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".tugtool")).unwrap();
        std::fs::write(dir.path().join(CONFIG_PATH), toml).unwrap();
        Config::load_from_project(dir.path()).unwrap()
    }

    const PROSE: &str = "[[tugtool.arc.surface]]\nname = \"prose\"\npaths = [\"tuglaws/\", \"CLAUDE.md\"]\ncheck = []\n[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = []\n";

    #[test]
    fn an_explicit_list_wins() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("briefs")).unwrap();
        let declared = config(&format!(
            "[tugtool.semantic]\ndocuments = [\"notes/\", \"./a.txt\", \"../out\", \"/etc\"]\n{PROSE}"
        ));
        assert_eq!(
            document_paths(dir.path(), &declared, DEFAULT_BRIEFS_TEMPLATE),
            ["notes", "a.txt"]
        );
    }

    #[test]
    fn with_none_declared_it_is_the_briefs_dir_and_the_prose_surface() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("briefs")).unwrap();
        assert_eq!(
            document_paths(dir.path(), &config(PROSE), DEFAULT_BRIEFS_TEMPLATE),
            ["briefs", "tuglaws", "CLAUDE.md"]
        );
    }

    #[test]
    fn nothing_declared_and_no_briefs_dir_yields_no_paths() {
        let dir = tempfile::tempdir().unwrap();
        assert!(document_paths(dir.path(), &Config::default(), DEFAULT_BRIEFS_TEMPLATE).is_empty());
    }

    #[test]
    fn a_relative_absolute_and_placeholder_template_each_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("writing")).unwrap();
        let none = Config::default();
        assert_eq!(document_paths(dir.path(), &none, "writing"), ["writing"]);
        assert_eq!(
            document_paths(dir.path(), &none, "{project_dir}/writing"),
            ["writing"]
        );
        let absolute = elsewhere.path().to_string_lossy().into_owned();
        assert_eq!(
            document_paths(dir.path(), &none, &absolute),
            std::slice::from_ref(&absolute)
        );
    }

    #[tokio::test]
    async fn a_briefs_directory_outside_the_project_is_read_under_its_whole_path() {
        let mut p = Project::new().await;
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::write(elsewhere.path().join("a.md"), "# Away\n\nWords.\n").unwrap();
        let absolute = elsewhere.path().to_string_lossy().into_owned();
        let template = absolute.clone();
        p.documents.briefs_template = Arc::new(move || Some(template.clone()));
        p.walk().await;
        assert_eq!(p.ids(), [p.id(&format!("{absolute}/a.md"), "away")]);
    }

    #[tokio::test]
    async fn a_sections_chunks_carry_its_path_and_heading_and_its_line() {
        let mut p = Project::new().await;
        p.write("briefs/plan.md", NOTES);
        p.walk().await;

        assert_eq!(
            p.ids(),
            [
                p.id("briefs/plan.md", "plan"),
                p.id("briefs/plan.md", "retries"),
                p.id("briefs/plan.md", "storage"),
            ]
        );
        let id = p.id("briefs/plan.md", "retries");
        let chunks = p.index.chunks();
        let chunk = chunks.iter().find(|c| c.source_id == id).unwrap();
        assert_eq!(chunk.context, "briefs/plan.md > Plan > Retries");
        assert_eq!(chunk.body, "## Retries\n\nBack off and try again.");
        let meta: serde_json::Value =
            serde_json::from_str(&p.index.source_meta(DOCUMENT_KIND, &id).unwrap()).unwrap();
        assert_eq!(meta["line"], 5);
        assert_eq!(meta["path"], "briefs/plan.md");
        assert_eq!(meta["project_dir"], p.key.as_str());
    }

    #[tokio::test]
    async fn editing_one_section_embeds_only_it() {
        let mut p = Project::new().await;
        p.write("briefs/plan.md", NOTES);
        p.walk().await;
        p.state.take_embedded();

        p.write(
            "briefs/plan.md",
            &NOTES.replace("Keep it on disk.", "Hold it in memory."),
        );
        p.hear(FsEvent::Modified {
            path: "briefs/plan.md".into(),
        })
        .await;
        let embedded = p.state.take_embedded();
        assert_eq!(embedded.len(), 1, "{embedded:?}");
        assert!(embedded[0].contains("Hold it in memory."));
    }

    #[tokio::test]
    async fn lines_added_above_move_a_section_and_embed_nothing_of_it() {
        let mut p = Project::new().await;
        p.write("briefs/plan.md", NOTES);
        p.walk().await;
        p.state.take_embedded();

        p.write(
            "briefs/plan.md",
            &NOTES.replace(
                "The opening words.",
                "The opening words.\n\nAnd more of them.",
            ),
        );
        p.hear(FsEvent::Modified {
            path: "briefs/plan.md".into(),
        })
        .await;
        assert_eq!(p.state.take_embedded().len(), 1);
        let id = p.id("briefs/plan.md", "storage");
        let meta: serde_json::Value =
            serde_json::from_str(&p.index.source_meta(DOCUMENT_KIND, &id).unwrap()).unwrap();
        assert_eq!(meta["line"], 11);
    }

    #[tokio::test]
    async fn a_second_walk_of_the_same_files_embeds_nothing() {
        let mut p = Project::new().await;
        p.write("briefs/plan.md", NOTES);
        p.walk().await;
        p.state.take_embedded();
        p.walk().await;
        assert!(p.state.take_embedded().is_empty());
    }

    #[tokio::test]
    async fn a_section_taken_out_of_a_file_leaves_and_a_longer_name_is_not_its_file() {
        let mut p = Project::new().await;
        p.write("briefs/a.md", NOTES);
        p.write("briefs/a.md#x.md", "# Other\n\nWords.\n");
        p.walk().await;
        p.write("briefs/a.md", "# Plan\n\nThe opening words.\n");
        p.hear(FsEvent::Modified {
            path: "briefs/a.md".into(),
        })
        .await;
        assert_eq!(
            p.ids(),
            [
                p.id("briefs/a.md", "plan"),
                p.id("briefs/a.md#x.md", "other")
            ]
        );
    }

    #[tokio::test]
    async fn deleting_a_file_removes_its_sources() {
        let mut p = Project::new().await;
        p.write("briefs/a.md", NOTES);
        p.write("briefs/b.md", "# Keep\n\nWords.\n");
        p.walk().await;
        std::fs::remove_file(p.dir.path().join("briefs/a.md")).unwrap();
        p.hear(FsEvent::Removed {
            path: "briefs/a.md".into(),
        })
        .await;
        assert_eq!(p.ids(), [p.id("briefs/b.md", "keep")]);
    }

    #[tokio::test]
    async fn a_rename_reads_both_of_its_paths() {
        let mut p = Project::new().await;
        p.write("briefs/a.md", NOTES);
        p.walk().await;
        std::fs::rename(
            p.dir.path().join("briefs/a.md"),
            p.dir.path().join("briefs/c.md"),
        )
        .unwrap();
        p.hear(FsEvent::Renamed {
            from: "briefs/a.md".into(),
            to: "briefs/c.md".into(),
        })
        .await;
        assert_eq!(
            p.ids(),
            [
                p.id("briefs/c.md", "plan"),
                p.id("briefs/c.md", "retries"),
                p.id("briefs/c.md", "storage"),
            ]
        );
    }

    #[tokio::test]
    async fn removing_a_path_from_the_config_removes_its_sources() {
        let mut p = Project::new().await;
        p.write(
            CONFIG_PATH,
            "[tugtool.semantic]\ndocuments = [\"notes/\", \"guide.md\"]\n",
        );
        p.write("notes/a.md", "# Note\n\nWords.\n");
        p.write("guide.md", "# Guide\n\nWords.\n");
        p.walk().await;
        assert_eq!(p.ids().len(), 2);

        p.write(
            CONFIG_PATH,
            "[tugtool.semantic]\ndocuments = [\"notes/\"]\n",
        );
        p.hear(FsEvent::Modified {
            path: CONFIG_PATH.into(),
        })
        .await;
        assert_eq!(p.ids(), [p.id("notes/a.md", "note")]);
    }

    #[tokio::test]
    async fn a_config_that_will_not_load_removes_nothing() {
        let mut p = Project::new().await;
        p.write(
            CONFIG_PATH,
            "[tugtool.semantic]\ndocuments = [\"notes/\"]\n",
        );
        p.write("notes/a.md", "# Note\n\nWords.\n");
        p.walk().await;

        p.write(CONFIG_PATH, "[tugtool.semantic\n");
        p.hear(FsEvent::Modified {
            path: CONFIG_PATH.into(),
        })
        .await;
        p.hear(FsEvent::Modified {
            path: "notes/a.md".into(),
        })
        .await;
        assert_eq!(p.ids(), [p.id("notes/a.md", "note")]);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn an_unreadable_listed_path_leaves_what_was_indexed() {
        use std::os::unix::fs::PermissionsExt;
        let mut p = Project::new().await;
        p.write("briefs/a.md", NOTES);
        p.write("briefs/gone.md", "# Gone\n\nWords.\n");
        p.walk().await;

        let locked = p.dir.path().join("briefs/a.md");
        std::fs::remove_file(p.dir.path().join("briefs/gone.md")).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // A test run as root reads through the mode, and there is nothing to say then.
        if std::fs::read(&locked).is_err() {
            p.walk().await;
            let ids = p.ids();
            assert_eq!(ids.len(), 4, "{ids:?}");
            assert!(ids.contains(&p.id("briefs/gone.md", "gone")));
        }
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[tokio::test]
    async fn a_project_directory_that_went_away_removes_nothing() {
        let mut p = Project::new().await;
        p.write("briefs/a.md", "# Note\n\nWords.\n");
        p.walk().await;
        let ids = p.ids();
        std::fs::remove_dir_all(p.dir.path()).unwrap();
        p.walk().await;
        assert_eq!(p.ids(), ids);
    }

    #[tokio::test]
    async fn a_file_too_long_or_not_text_is_skipped() {
        let mut p = Project::new().await;
        p.write("briefs/ok.md", "# Ok\n\nWords.\n");
        p.write(
            "briefs/long.md",
            &"x".repeat(MAX_DOCUMENT_BYTES as usize + 1),
        );
        std::fs::write(p.dir.path().join("briefs/bytes.md"), [0xff, 0xfe, 0x00]).unwrap();
        p.walk().await;
        assert_eq!(p.ids(), [p.id("briefs/ok.md", "ok")]);
    }

    #[tokio::test]
    async fn a_directory_gives_its_markdown_and_a_named_file_is_read_as_it_is() {
        let mut p = Project::new().await;
        p.write(
            CONFIG_PATH,
            "[tugtool.semantic]\ndocuments = [\"notes/\", \"LICENSE\"]\n",
        );
        p.write("notes/sub/deep.md", "# Deep\n\nWords.\n");
        p.write("notes/skip.txt", "Not this.\n");
        p.write("notes/.hidden/h.md", "# Hidden\n\nWords.\n");
        p.write("LICENSE", "Do what you like.\n");
        p.write("other.md", "# Other\n\nWords.\n");
        p.walk().await;
        assert_eq!(
            p.ids(),
            [p.id("LICENSE", "top"), p.id("notes/sub/deep.md", "deep")]
        );
    }

    #[tokio::test]
    async fn a_large_file_is_ingested_a_batch_at_a_time() {
        let mut p = Project::new().await;
        let text: String = (0..40)
            .map(|n| format!("# Part {n}\n\nWords of part {n}.\n\n"))
            .collect();
        p.write("briefs/a.md", &text);
        p.documents.index_project(&p.key.clone()).await;
        // Expanding the walk opens the first file and stores its first batch.
        p.documents.run_unit(&p.indexer).await;
        assert_eq!(
            p.index.source_ids(DOCUMENT_KIND).unwrap().len(),
            EMBED_BATCH
        );
        p.drain().await;
        assert_eq!(p.ids().len(), 40);
    }

    #[test]
    fn what_an_event_asks_for() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("briefs/sub")).unwrap();
        std::fs::write(root.join("briefs/a.md"), "x").unwrap();
        std::fs::write(root.join("briefs/a.txt"), "x").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "x").unwrap();
        let listing = Listing {
            paths: vec!["briefs".into(), "CLAUDE.md".into(), "docs/guide".into()],
            briefs: None,
            readable: true,
        };
        for (path, wanted) in [
            ("briefs/a.md", Reaction::File),
            ("briefs/never-was.md", Reaction::File),
            ("CLAUDE.md", Reaction::File),
            (CONFIG_PATH, Reaction::Walk),
            // The entry itself, gone or moved.
            ("briefs", Reaction::Walk),
            // A directory that holds an entry.
            ("docs", Reaction::Walk),
            // A directory inside one, there or gone.
            ("briefs/sub", Reaction::Walk),
            ("briefs/gone", Reaction::Walk),
            ("briefs/a.txt", Reaction::Nothing),
            ("briefs/.a.md.swp", Reaction::Nothing),
            ("briefs/.git/x.md", Reaction::Nothing),
            ("src/main.rs", Reaction::Nothing),
            ("briefsy/a.md", Reaction::Nothing),
            ("", Reaction::Nothing),
        ] {
            assert_eq!(listing.react(root, path), wanted, "{path}");
        }
    }

    /// A real workspace entry, its broadcast and the whole worker.
    mod through_a_workspace {
        use super::super::super::coverage::coverage_channel;
        use super::super::super::ingest::{IndexStreams, run_index};
        use super::*;
        use tokio::sync::Notify;

        struct Worker {
            dir: PathBuf,
            _temp: TempDir,
            _ledger: TempDir,
            key: String,
            index: Arc<SemanticIndex>,
            state: Arc<FakeState>,
            registry: Arc<WorkspaceRegistry>,
            entry: Arc<WorkspaceEntry>,
            cancel: CancellationToken,
            run: tokio::task::JoinHandle<()>,
        }

        impl Worker {
            /// Run the worker over a project holding what `prepare` wrote.
            async fn start(prepare: impl FnOnce(&Path)) -> Self {
                let temp = tempfile::tempdir().unwrap();
                let dir = temp.path().to_path_buf();
                prepare(&dir);
                let ledger = tempfile::tempdir().unwrap();
                let state = FakeState::new(Some("nl-a"));
                let index =
                    Arc::new(SemanticIndex::open(ledger.path().join("semantic.db")).unwrap());
                let indexer = Indexer::new(Arc::clone(&index), client(&state), None);
                let cancel = CancellationToken::new();
                let registry = Arc::new(WorkspaceRegistry::new_for_test());
                let (opens_tx, opens) = mpsc::channel(4);
                registry.set_semantic_open_signal(opens_tx);
                let entry = registry.get_or_create(&dir, cancel.clone()).unwrap();
                let key = entry.workspace_key.as_ref().to_string();
                let run = tokio::spawn(run_index(
                    indexer,
                    IndexStreams {
                        docs_dir: None,
                        observer: Arc::new(Notify::new()),
                        catch_up: false,
                        ticks: mpsc::channel(1).1,
                        coverage: coverage_channel(false).0,
                        documents: Some(DocumentWatch {
                            registry: Arc::clone(&registry),
                            opens,
                            briefs_template: Arc::new(|| None),
                        }),
                    },
                    Duration::ZERO,
                    cancel.clone(),
                ));
                Self {
                    dir,
                    _temp: temp,
                    _ledger: ledger,
                    key,
                    index,
                    state,
                    registry,
                    entry,
                    cancel,
                    run,
                }
            }

            fn id(&self, relative: &str, slug: &str) -> String {
                section_id(&self.key, relative, slug)
            }

            fn say(&self, event: FsEvent) {
                self.entry.fs_broadcast_tx.send(vec![event]).unwrap();
            }

            async fn until(&self, what: impl Fn(&[String]) -> bool) {
                loop {
                    let mut ids = self.index.source_ids(DOCUMENT_KIND).unwrap();
                    ids.sort();
                    if what(&ids) {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }

            async fn stop(self) {
                self.cancel.cancel();
                self.run.await.unwrap();
                drop(self.registry);
            }
        }

        fn write(dir: &Path, relative: &str, text: &str) {
            let path = dir.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        #[tokio::test]
        async fn writing_a_brief_reaches_the_index_with_no_restart() {
            let w = Worker::start(|dir| write(dir, "briefs/a.md", "# First\n\nWords.\n")).await;
            let first = w.id("briefs/a.md", "first");
            w.until(|ids| ids.contains(&first)).await;

            write(&w.dir, "briefs/b.md", "# Second\n\nWords.\n");
            w.say(FsEvent::Created {
                path: "briefs/b.md".into(),
            });
            let second = w.id("briefs/b.md", "second");
            w.until(|ids| ids.contains(&second)).await;
            w.stop().await;
        }

        #[tokio::test]
        async fn the_first_brief_in_a_new_directory_needs_no_restart() {
            let w = Worker::start(|_| {}).await;
            write(&w.dir, "briefs/a.md", "# First\n\nWords.\n");
            w.say(FsEvent::Created {
                path: "briefs/a.md".into(),
            });
            let first = w.id("briefs/a.md", "first");
            w.until(|ids| ids.contains(&first)).await;
            w.stop().await;
        }

        #[tokio::test]
        async fn removing_a_listed_directory_removes_its_documents() {
            let w = Worker::start(|dir| {
                write(
                    dir,
                    ".tugtool/config.toml",
                    "[tugtool.semantic]\ndocuments = [\"notes/\", \"guide.md\"]\n",
                );
                write(dir, "notes/sub/a.md", "# Note\n\nWords.\n");
                write(dir, "guide.md", "# Guide\n\nWords.\n");
            })
            .await;
            w.until(|ids| ids.len() == 2).await;

            std::fs::remove_dir_all(w.dir.join("notes")).unwrap();
            w.say(FsEvent::Removed {
                path: "notes".into(),
            });
            let guide = w.id("guide.md", "guide");
            w.until(|ids| ids == std::slice::from_ref(&guide)).await;
            w.stop().await;
        }

        #[tokio::test]
        async fn a_write_outside_the_list_embeds_nothing() {
            let w = Worker::start(|dir| write(dir, "briefs/a.md", "# First\n\nWords.\n")).await;
            let first = w.id("briefs/a.md", "first");
            w.until(|ids| ids.contains(&first)).await;
            w.state.take_embedded();

            write(&w.dir, "src/outside.md", "# Outside\n\nNot these words.\n");
            w.say(FsEvent::Created {
                path: "src/outside.md".into(),
            });
            // Heard after it, so what it asked for has been done by then.
            write(&w.dir, "briefs/b.md", "# Second\n\nThese words.\n");
            w.say(FsEvent::Created {
                path: "briefs/b.md".into(),
            });
            let second = w.id("briefs/b.md", "second");
            w.until(|ids| ids.contains(&second)).await;

            let embedded = w.state.take_embedded();
            assert!(embedded.iter().all(|text| !text.contains("Not these")));
            assert_eq!(embedded.len(), 1, "{embedded:?}");
            w.stop().await;
        }

        #[tokio::test]
        async fn lost_events_read_as_a_walk() {
            let w = Worker::start(|dir| write(dir, "briefs/a.md", "# First\n\nWords.\n")).await;
            let first = w.id("briefs/a.md", "first");
            w.until(|ids| ids.contains(&first)).await;
            write(&w.dir, "briefs/b.md", "# Second\n\nWords.\n");
            // Far more than the broadcast holds, none of them naming the new file, with
            // the worker kept off the stream by nothing but how many there are.
            for _ in 0..2000 {
                let _ = w.entry.fs_broadcast_tx.send(vec![FsEvent::Modified {
                    path: "src/noise.rs".into(),
                }]);
            }
            let second = w.id("briefs/b.md", "second");
            w.until(|ids| ids.contains(&second)).await;
            w.stop().await;
        }

        #[tokio::test]
        async fn a_project_opened_later_is_walked_and_a_browse_hold_is_not() {
            let w = Worker::start(|_| {}).await;
            let browsed = tempfile::tempdir().unwrap();
            write(browsed.path(), "briefs/b.md", "# Browsed\n\nWords.\n");
            let hold = w
                .registry
                .acquire_for_browse(browsed.path(), w.cancel.clone())
                .unwrap();
            let later = tempfile::tempdir().unwrap();
            write(later.path(), "briefs/c.md", "# Later\n\nWords.\n");
            let opened = w
                .registry
                .get_or_create(later.path(), w.cancel.clone())
                .unwrap();
            let id = section_id(opened.workspace_key.as_ref(), "briefs/c.md", "later");
            w.until(|ids| ids.contains(&id)).await;
            w.until(|ids| ids.len() == 1).await;

            // A session on the browsed directory makes it a project.
            let promoted = w
                .registry
                .get_or_create(browsed.path(), w.cancel.clone())
                .unwrap();
            let id = section_id(promoted.workspace_key.as_ref(), "briefs/b.md", "browsed");
            w.until(|ids| ids.contains(&id)).await;
            drop((hold, opened, promoted));

            w.stop().await;
        }
    }
}
