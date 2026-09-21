//! Per-file watch service — the `FILE_WATCH` / `FILE_WATCH_QUERY` pair.
//!
//! A card that has a file open asks this service to watch it, and gets one
//! JSON state frame per real change: `present` with a sha256, `absent`, or
//! `error`. The workspace `FILESYSTEM` feed cannot answer that question —
//! it only ever carried the bootstrap workspace's tree, so a file opened
//! anywhere else was never watched at all.
//!
//! **The watch is on the parent directory, never on the file.** A save is
//! almost never a write in place: an editor writes a temp file and renames
//! it over the target, and a watch registered on the old inode goes deaf at
//! the rename while reporting nothing. The directory sees the whole
//! sequence — the temp file's creation, the rename, the unlink — and a look
//! at the path afterwards says what is actually there now.
//!
//! **The event kind is never trusted.** FSEvents OR-coalesces its flags, so
//! one event can claim create+modify+remove for a batch of unrelated work in
//! the directory. So any event naming a watched file — whatever its kind,
//! and a watcher error too — marks that file dirty, and the answer comes
//! from looking at the file rather than from reading the event. The frame's
//! `created` list is built the same way: every sibling an event named in the
//! window, kept if it exists when the frame goes out. macOS reports a
//! same-directory rename as two bare `Modify(Name(Any))` events — no create,
//! no pairing — so a list built from `EventKind::Create` alone would be
//! empty exactly when the card's rename ladder needs it.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};

use tugcast_core::protocol::{FeedId, Frame};

use crate::fs_read::{MAX_READ_BYTES, guard_absolute_path, read_stable, sha256_hex};
use crate::path_resolver::resolve_to_claude_form;

/// How long a file sits dirty before it is looked at. One window collects a
/// save's whole burst of events into a single look.
const DEBOUNCE: Duration = Duration::from_millis(100);

/// The second look's delay, when the first one found a file suspiciously
/// short at the same inode — the shape of a truncate-then-write caught
/// between its two halves.
const SETTLE: Duration = Duration::from_millis(150);

/// Requests the deck sends on `FILE_WATCH_QUERY`.
const REQUEST_BUFFER: usize = 32;

/// What the last frame emitted for a path said. A new look that matches it
/// emits nothing: the card already knows.
#[derive(Clone, PartialEq, Eq)]
struct Reported {
    state: &'static str,
    sha256: Option<String>,
    ino: Option<u64>,
}

/// One watched path, keyed by the exact string the client sent.
struct Watched {
    /// The OS path `guard_absolute_path` resolved the client string to.
    resolved: PathBuf,
    /// Gateway form of the parent — the `dirs` key, and the form handed to
    /// `watcher.watch`.
    dir: PathBuf,
    /// Every directory watched on this file's behalf: the parent first,
    /// then its ancestors up to the project root.
    watched_dirs: Vec<PathBuf>,
    /// The file's name within `dir`. Events are matched on this, never on a
    /// comparison of two absolute strings of unknown provenance ([L29]).
    name: OsString,
    /// The client path's own directory form, which the `created` paths are
    /// built from so the card never sees a spelling it did not ask for.
    client_dir: String,
    last: Option<Reported>,
    /// The size the last emitted frame reported — the suspicion rule's
    /// reference point.
    last_size: u64,
    /// Names of other files in `dir` that events have named since this
    /// window opened. Filtered down to the ones that exist when a frame is
    /// built — see `note_sibling`.
    siblings: Vec<OsString>,
    renamed_to: Option<String>,
    /// When the pending look is due; `None` when the file is not dirty.
    deadline: Option<Instant>,
    /// A look is in flight for this path.
    looking: bool,
    /// Another look is owed when the in-flight one lands.
    pending: bool,
    /// The next frame goes out even if nothing changed — a `watch` always
    /// answers.
    force: bool,
}

/// What one look at a path found.
enum Look {
    Present {
        sha256: Option<String>,
        size: u64,
        dev: Option<u64>,
        ino: Option<u64>,
    },
    Absent,
    Error(&'static str),
}

/// The service: one notify watcher, one non-recursive watch per distinct
/// parent directory, and a set of watched files keyed by the client's own
/// path string.
pub(crate) struct FileWatchService {
    out: broadcast::Sender<Frame>,
    requests: mpsc::Receiver<Frame>,
    files: HashMap<String, Watched>,
    dirs: HashMap<PathBuf, usize>,
    seq: Arc<AtomicU64>,
}

impl FileWatchService {
    /// Build the service over the broadcast sender its frames go out on.
    /// The returned sink is what `main.rs` registers as the
    /// `FILE_WATCH_QUERY` input feed.
    pub(crate) fn new(out: broadcast::Sender<Frame>) -> (Self, mpsc::Sender<Frame>) {
        let (tx, rx) = mpsc::channel::<Frame>(REQUEST_BUFFER);
        let service = Self {
            out,
            requests: rx,
            files: HashMap::new(),
            dirs: HashMap::new(),
            seq: Arc::new(AtomicU64::new(0)),
        };
        (service, tx)
    }

    /// Run until `cancel` fires.
    pub(crate) async fn run(mut self, cancel: CancellationToken) {
        // Bridge notify's own thread straight into tokio at the source: the
        // handler closure sends, and nothing polls. An unbounded channel is
        // right here because the sender is an OS callback that must not
        // block, and the consumer collapses a burst into one look anyway.
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<notify::Result<notify::Event>>();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = event_tx.send(res);
        }) {
            Ok(watcher) => watcher,
            Err(err) => {
                error!(error = %err, "FILE_WATCH: could not create the filesystem watcher");
                return;
            }
        };

        let (look_tx, mut look_rx) = mpsc::unbounded_channel::<(String, Look)>();

        loop {
            let due = self.next_deadline();
            tokio::select! {
                _ = cancel.cancelled() => break,
                request = self.requests.recv() => match request {
                    Some(frame) => self.handle_request(&frame, &mut watcher, &look_tx),
                    None => break,
                },
                event = event_rx.recv() => match event {
                    Some(event) => self.handle_event(event),
                    None => break,
                },
                Some((path, look)) = look_rx.recv() => {
                    self.finish_look(path, look, &look_tx);
                }
                _ = sleep_until(due) => self.fire_due(&look_tx),
            }
        }
    }

    // ── Requests ────────────────────────────────────────────────────────

    fn handle_request(
        &mut self,
        frame: &Frame,
        watcher: &mut notify::RecommendedWatcher,
        look_tx: &mpsc::UnboundedSender<(String, Look)>,
    ) {
        let Ok(value) = serde_json::from_slice::<Value>(&frame.payload) else {
            warn!(
                payload_len = frame.payload.len(),
                "FILE_WATCH_QUERY: malformed JSON payload"
            );
            return;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("watch") => match value.get("path").and_then(Value::as_str) {
                Some(path) => self.watch(path.to_string(), watcher, look_tx),
                None => warn!("FILE_WATCH_QUERY: watch with no path"),
            },
            Some("unwatch") => match value.get("path").and_then(Value::as_str) {
                Some(path) => self.unwatch(path, watcher),
                None => warn!("FILE_WATCH_QUERY: unwatch with no path"),
            },
            Some("reset") => self.reset(watcher),
            other => warn!(r#type = ?other, "FILE_WATCH_QUERY: unknown request type"),
        }
    }

    /// Add a path if it is new, and answer — always — with its current state.
    fn watch(
        &mut self,
        client_path: String,
        watcher: &mut notify::RecommendedWatcher,
        look_tx: &mpsc::UnboundedSender<(String, Look)>,
    ) {
        if self.files.contains_key(&client_path) {
            // Already watched: the answer is still owed, so force the next
            // frame and look now.
            if let Some(file) = self.files.get_mut(&client_path) {
                file.force = true;
            }
            self.start_look(&client_path, look_tx);
            return;
        }

        // The guard resolves `~`, refuses relative and `..` paths, and
        // applies the secret denylist itself — its `error` string is the
        // one the frame carries, never a second vocabulary.
        let resolved = match guard_absolute_path(&client_path) {
            Ok(resolved) => resolved,
            Err((_, body)) => {
                let reason = body
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("bad_path")
                    .to_string();
                self.emit_error(&client_path, &reason);
                return;
            }
        };
        let (Some(parent), Some(name)) = (
            resolved.parent().map(Path::to_path_buf),
            resolved.file_name().map(std::ffi::OsStr::to_os_string),
        ) else {
            self.emit_error(&client_path, "bad_path");
            return;
        };
        // Both sides of every later comparison route through the gateway:
        // this is the spelling `watcher.watch` is given AND the `dirs` key
        // an event's resolved parent is looked up by.
        let dir = resolve_to_claude_form(&parent);
        let client_dir = Path::new(&client_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        // The parent, plus the ancestors a teardown could take the file away
        // with. Watching the parent alone is not enough: a `rm -rf` of a
        // directory ABOVE the parent is reported against the directory that
        // was removed, and a watch on the parent never sees it — measured,
        // not assumed. Only a watch on the removed directory's OWN parent
        // hears it, so the chain is what makes a joined-away arc worktree
        // reach the card that had a file open inside it.
        let watched_dirs = watch_chain(&dir);
        for (index, chain_dir) in watched_dirs.iter().enumerate() {
            let refcount = self.dirs.entry(chain_dir.clone()).or_insert(0);
            *refcount += 1;
            if *refcount > 1 {
                continue;
            }
            if let Err(err) = watcher.watch(chain_dir, RecursiveMode::NonRecursive) {
                self.dirs.remove(chain_dir);
                if index == 0 {
                    // The file's own directory. Without it there is nothing
                    // to report, so this one is fatal.
                    error!(dir = ?chain_dir, error = %err, "FILE_WATCH: could not watch directory");
                    for done in watched_dirs.iter().take(index) {
                        self.release_dir(done, watcher);
                    }
                    self.emit_error(&client_path, "io");
                    return;
                }
                // An ancestor we cannot watch costs the teardown case for
                // this file and nothing else.
                warn!(dir = ?chain_dir, error = %err, "FILE_WATCH: could not watch ancestor");
            }
        }

        self.files.insert(
            client_path.clone(),
            Watched {
                resolved,
                dir,
                watched_dirs,
                name,
                client_dir,
                last: None,
                last_size: 0,
                siblings: Vec::new(),
                renamed_to: None,
                deadline: None,
                looking: false,
                pending: false,
                force: true,
            },
        );
        self.start_look(&client_path, look_tx);
    }

    /// Drop one path, releasing its directory watch when it was the last
    /// file in it. An unknown path is a no-op.
    fn unwatch(&mut self, client_path: &str, watcher: &mut notify::RecommendedWatcher) {
        let Some(file) = self.files.remove(client_path) else {
            return;
        };
        for dir in &file.watched_dirs {
            self.release_dir(dir, watcher);
        }
    }

    /// Drop every subscription — what a client sends on a fresh connection,
    /// so a client that vanished cannot leak watches.
    fn reset(&mut self, watcher: &mut notify::RecommendedWatcher) {
        for dir in self.dirs.keys() {
            let _ = watcher.unwatch(dir);
        }
        self.dirs.clear();
        self.files.clear();
    }

    fn release_dir(&mut self, dir: &Path, watcher: &mut notify::RecommendedWatcher) {
        let Some(refcount) = self.dirs.get_mut(dir) else {
            return;
        };
        *refcount -= 1;
        if *refcount == 0 {
            self.dirs.remove(dir);
            if let Err(err) = watcher.unwatch(dir) {
                warn!(dir = ?dir, error = %err, "FILE_WATCH: could not unwatch directory");
            }
        }
    }

    // ── Events ──────────────────────────────────────────────────────────

    fn handle_event(&mut self, event: notify::Result<notify::Event>) {
        let event = match event {
            Ok(event) => event,
            Err(err) => {
                // A watcher error says the stream is unreliable, and says
                // nothing about which file. Everything is suspect.
                warn!(error = %err, "FILE_WATCH: watcher error; re-looking at every path");
                self.mark_all_dirty();
                return;
            }
        };

        if event.paths.is_empty() {
            self.mark_all_dirty();
            return;
        }

        let rename_destination = rename_destination(&event);

        for path in &event.paths {
            let resolved = resolve_to_claude_form(path);
            // The event named a directory some watched file lives UNDER —
            // its own parent, or an ancestor a teardown just removed.
            // Whatever happened to it, nothing below it can be trusted, and
            // the look is what says whether the file is still there.
            //
            // `starts_with` is component-wise, which is the discrimination
            // this needs: `/repo/src` is a string prefix of
            // `/repo/srclib/f.txt` and an ancestor of neither.
            let under: Vec<String> = self
                .files
                .iter()
                .filter(|(_, file)| {
                    file.resolved != resolved && file.resolved.starts_with(&resolved)
                })
                .map(|(key, _)| key.clone())
                .collect();
            if !under.is_empty() {
                for key in under {
                    if let Some(file) = self.files.get_mut(&key) {
                        mark_dirty(file);
                    }
                }
                continue;
            }
            let (Some(parent), Some(name)) = (resolved.parent(), resolved.file_name()) else {
                continue;
            };
            let parent = resolve_to_claude_form(parent);
            if !self.dirs.contains_key(&parent) {
                continue;
            }
            let keys: Vec<String> = self
                .files
                .iter()
                .filter(|(_, file)| file.dir == parent)
                .map(|(key, _)| key.clone())
                .collect();
            for key in keys {
                let Some(file) = self.files.get_mut(&key) else {
                    continue;
                };
                if file.name != name {
                    // A sibling the event named. Whether it was CREATED is
                    // not a question the event can answer — macOS reports a
                    // same-directory rename as two bare `Modify(Name(Any))`
                    // events, one per path, with no create and no pairing —
                    // so the name is remembered and the frame keeps only
                    // the ones that exist when it is built. That is the same
                    // rule the rest of this service runs on: look, do not
                    // read the kind.
                    //
                    // Remembering does NOT wake a look. A sibling rides the
                    // next frame the watched file's own change produces,
                    // which is the case the rename ladder needs; churn
                    // beside a quiet file stays free.
                    note_sibling(file, name);
                    continue;
                }
                // A paired rename whose SOURCE is this file says where it
                // went — the one thing a look at the old path cannot
                // recover, since by then there is nothing there.
                if let Some(destination) = rename_destination
                    .as_ref()
                    .filter(|_| event.paths.first() == Some(path))
                {
                    file.renamed_to = Some(destination.to_string_lossy().to_string());
                }
                mark_dirty(file);
            }
        }
    }

    fn mark_all_dirty(&mut self) {
        for file in self.files.values_mut() {
            mark_dirty(file);
        }
    }

    // ── Looking ─────────────────────────────────────────────────────────

    fn next_deadline(&self) -> Option<Instant> {
        self.files.values().filter_map(|file| file.deadline).min()
    }

    fn fire_due(&mut self, look_tx: &mpsc::UnboundedSender<(String, Look)>) {
        let now = Instant::now();
        let due: Vec<String> = self
            .files
            .iter()
            .filter(|(_, file)| file.deadline.is_some_and(|at| at <= now))
            .map(|(key, _)| key.clone())
            .collect();
        for key in due {
            if let Some(file) = self.files.get_mut(&key) {
                file.deadline = None;
            }
            self.start_look(&key, look_tx);
        }
    }

    /// Start a look, or mark one owed when a look is already in flight.
    /// One running and one pending is the whole queue: the trailing look
    /// always runs, so the last write of a burst is always the last thing
    /// reported.
    fn start_look(&mut self, key: &str, look_tx: &mpsc::UnboundedSender<(String, Look)>) {
        let Some(file) = self.files.get_mut(key) else {
            return;
        };
        if file.looking {
            file.pending = true;
            return;
        }
        file.looking = true;
        let path = file.resolved.clone();
        let last_size = file.last_size;
        let last_ino = file.last.as_ref().and_then(|last| last.ino);
        let key = key.to_string();
        let tx = look_tx.clone();
        tokio::task::spawn_blocking(move || {
            let look = look_at(&path, last_size, last_ino);
            let _ = tx.send((key, look));
        });
    }

    fn finish_look(
        &mut self,
        key: String,
        look: Look,
        look_tx: &mpsc::UnboundedSender<(String, Look)>,
    ) {
        if let Some(file) = self.files.get_mut(&key) {
            file.looking = false;
        }
        self.emit(&key, look);
        let owed = self
            .files
            .get_mut(&key)
            .is_some_and(|file| std::mem::take(&mut file.pending));
        if owed {
            self.start_look(&key, look_tx);
        }
    }

    // ── Emitting ────────────────────────────────────────────────────────

    fn emit(&mut self, key: &str, look: Look) {
        let Some(file) = self.files.get_mut(key) else {
            return;
        };
        let reported = match &look {
            Look::Present { sha256, ino, .. } => Reported {
                state: "present",
                sha256: sha256.clone(),
                ino: *ino,
            },
            Look::Absent => Reported {
                state: "absent",
                sha256: None,
                ino: None,
            },
            Look::Error(reason) => Reported {
                state: "error",
                sha256: Some((*reason).to_string()),
                ino: None,
            },
        };
        let changed = file.last.as_ref() != Some(&reported);
        let force = std::mem::take(&mut file.force);
        if !changed && !force {
            // Nothing to say, so the window's siblings are kept for the
            // frame that does go out rather than thrown away here.
            return;
        }
        // The siblings that are really there. A name an event mentioned and
        // that is gone by now was a temp file the save already cleaned up,
        // and naming it would send the rename ladder after nothing.
        let dir = file.dir.clone();
        let client_dir = file.client_dir.clone();
        let created: Vec<String> = std::mem::take(&mut file.siblings)
            .into_iter()
            .filter(|name| dir.join(name).exists())
            .map(|name| format!("{}/{}", client_dir, name.to_string_lossy()))
            .collect();
        let renamed_to = file.renamed_to.take();
        file.last = Some(reported);
        if let Look::Present { size, .. } = &look {
            file.last_size = *size;
        }

        let mut payload = json!({
            "type": "state",
            "path": key,
            "seq": self.seq.fetch_add(1, Ordering::Relaxed) + 1,
            "created": created,
            "renamedTo": renamed_to,
        });
        let object = payload
            .as_object_mut()
            .expect("the frame payload is built as an object");
        match look {
            Look::Present {
                sha256,
                size,
                dev,
                ino,
            } => {
                object.insert("state".into(), json!("present"));
                object.insert("sha256".into(), json!(sha256));
                object.insert("size".into(), json!(size));
                if let Some(dev) = dev {
                    object.insert("dev".into(), json!(dev));
                }
                if let Some(ino) = ino {
                    object.insert("ino".into(), json!(ino));
                }
            }
            Look::Absent => {
                object.insert("state".into(), json!("absent"));
            }
            Look::Error(reason) => {
                object.insert("state".into(), json!("error"));
                object.insert("error".into(), json!(reason));
            }
        }
        self.send(payload);
    }

    /// An error the service never got far enough to look past — a refused
    /// path, a directory it could not watch.
    fn emit_error(&mut self, key: &str, reason: &str) {
        let payload = json!({
            "type": "state",
            "path": key,
            "seq": self.seq.fetch_add(1, Ordering::Relaxed) + 1,
            "state": "error",
            "error": reason,
        });
        self.send(payload);
    }

    fn send(&self, payload: Value) {
        let bytes = match serde_json::to_vec(&payload) {
            Ok(bytes) => bytes,
            Err(err) => {
                error!(error = %err, "FILE_WATCH: could not serialize a state frame");
                return;
            }
        };
        // No subscriber is the ordinary case at startup, not a failure.
        let _ = self.out.send(Frame::new(FeedId::FILE_WATCH, bytes));
    }
}

/// The directories to watch on one file's behalf: its parent first, then
/// every ancestor up to and including the project root.
///
/// The bound is the project root — the nearest ancestor holding a `.git`
/// entry — and it is the one that matters rather than a number of levels.
/// Below it sit the directories a tool can remove wholesale under a live
/// card (an arc worktree, a checkout's temp tree), and each one's removal
/// is only ever reported to a watch on the directory ABOVE it. Above the
/// project root the watches would buy nothing and cost a great deal: on
/// macOS an FSEvents stream over a home directory delivers that whole tree
/// to this process, which is the firehose the per-file watch exists to
/// replace.
///
/// A file in no project at all is watched by its parent alone.
fn watch_chain(dir: &Path) -> Vec<PathBuf> {
    let mut chain = vec![dir.to_path_buf()];
    let Some(root) = project_root(dir) else {
        return chain;
    };
    let mut current = dir;
    while current != root {
        let Some(parent) = current.parent() else {
            break;
        };
        chain.push(parent.to_path_buf());
        if parent == root {
            break;
        }
        current = parent;
    }
    chain
}

/// The nearest ancestor of `dir` (inclusive) that holds a `.git` entry.
fn project_root(dir: &Path) -> Option<&Path> {
    let mut current = Some(dir);
    while let Some(candidate) = current {
        if candidate.join(".git").exists() {
            return Some(candidate);
        }
        current = candidate.parent();
    }
    None
}

/// Remember a sibling's name for the next frame this file emits.
///
/// Bounded deliberately: a busy directory beside a file nobody is editing
/// would otherwise grow this list for as long as the card stays open, and
/// the rename ladder only ever reads the first few candidates.
fn note_sibling(file: &mut Watched, name: &std::ffi::OsStr) {
    const MAX_SIBLINGS: usize = 64;
    if file.siblings.len() >= MAX_SIBLINGS || file.siblings.iter().any(|held| held == name) {
        return;
    }
    file.siblings.push(name.to_os_string());
}

/// Arm a file's debounce if it is not already armed. The window is
/// single-shot: a burst that keeps arriving does not push the look further
/// out, because the one running + one pending queue already guarantees a
/// trailing look after the last event.
fn mark_dirty(file: &mut Watched) {
    if file.deadline.is_none() {
        file.deadline = Some(Instant::now() + DEBOUNCE);
    }
}

/// The destination of a paired rename, in gateway form — `notify` delivers
/// `Rename(Both)` with `[from, to]`.
fn rename_destination(event: &notify::Event) -> Option<PathBuf> {
    use notify::event::{ModifyKind, RenameMode};
    if !matches!(
        event.kind,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both))
    ) {
        return None;
    }
    let destination = event.paths.get(1)?;
    Some(resolve_to_claude_form(destination))
}

/// Look at a path, with the suspicion rule on top of the guarded read: a
/// file that came back empty (or less than half the size last reported) at
/// the SAME inode is a plain modify caught mid-write, so wait one settle and
/// look again. A new inode is a rename that already completed — there is
/// nothing to wait for, and waiting would only delay the answer.
fn look_at(path: &Path, last_size: u64, last_ino: Option<u64>) -> Look {
    let first = look_once(path);
    if let Look::Present { size, ino, .. } = &first {
        let suspicious = *size == 0 || (last_size > 0 && size.saturating_mul(2) < last_size);
        let same_inode = ino.is_some() && *ino == last_ino;
        if suspicious && same_inode {
            std::thread::sleep(SETTLE);
            return look_once(path);
        }
    }
    first
}

fn look_once(path: &Path) -> Look {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Look::Absent,
        Err(_) => return Look::Error("io"),
    };
    // A directory, a device, or a file too big to serve as text: the card
    // still wants to know it is there, and `sha256: null` says the identity
    // is not available rather than that the file is empty.
    if !metadata.is_file() || metadata.len() > MAX_READ_BYTES {
        let (dev, ino) = identity(&metadata);
        return Look::Present {
            sha256: None,
            size: metadata.len(),
            dev,
            ino,
        };
    }
    match read_stable(path) {
        Ok(read) => {
            let (dev, ino) = identity(&read.metadata);
            Look::Present {
                sha256: Some(sha256_hex(&read.bytes)),
                size: read.metadata.len(),
                dev,
                ino,
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Look::Absent,
        Err(_) => Look::Error("io"),
    }
}

/// `(dev, ino)` on unix, `(None, None)` elsewhere — the same identity pair
/// `/api/fs/read` reports.
fn identity(metadata: &std::fs::Metadata) -> (Option<u64>, Option<u64>) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (Some(metadata.dev()), Some(metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        (None, None)
    }
}

/// Sleep until a deadline, or forever when there is none to wait for.
async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration as StdDuration;

    use tempfile::TempDir;
    use tokio::time::timeout;

    /// A running service plus the two ends a client holds.
    struct Harness {
        requests: mpsc::Sender<Frame>,
        frames: broadcast::Receiver<Frame>,
        cancel: CancellationToken,
    }

    impl Harness {
        fn start() -> Self {
            let (out, frames) = broadcast::channel::<Frame>(256);
            let (service, requests) = FileWatchService::new(out);
            let cancel = CancellationToken::new();
            tokio::spawn(service.run(cancel.clone()));
            Self {
                requests,
                frames,
                cancel,
            }
        }

        async fn send(&self, payload: Value) {
            self.requests
                .send(Frame::new(
                    FeedId::FILE_WATCH_QUERY,
                    serde_json::to_vec(&payload).unwrap(),
                ))
                .await
                .unwrap();
        }

        async fn watch(&self, path: &str) {
            self.send(json!({"type": "watch", "path": path})).await;
        }

        /// The next frame for `path`, or a panic with what the wait was for.
        async fn next_for(&mut self, path: &str) -> Value {
            let deadline = StdDuration::from_secs(10);
            loop {
                let frame = timeout(deadline, self.frames.recv())
                    .await
                    .unwrap_or_else(|_| panic!("no FILE_WATCH frame for {path} within 10s"))
                    .unwrap();
                let value: Value = serde_json::from_slice(&frame.payload).unwrap();
                if value["path"] == json!(path) {
                    return value;
                }
            }
        }

        /// Frames for `path` until one satisfies `done`; returns that one.
        async fn next_matching(&mut self, path: &str, done: impl Fn(&Value) -> bool) -> Value {
            loop {
                let value = self.next_for(path).await;
                if done(&value) {
                    return value;
                }
            }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.cancel.cancel();
        }
    }

    fn write(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
    }

    fn sha(body: &str) -> String {
        sha256_hex(body.as_bytes())
    }

    #[test]
    fn read_stable_reports_the_bytes_it_read() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("quiet.txt");
        write(&file, "one\ntwo\n");
        let read = read_stable(&file).unwrap();
        assert_eq!(read.bytes, b"one\ntwo\n");
        assert_eq!(read.metadata.len(), read.bytes.len() as u64);
    }

    #[tokio::test]
    async fn watch_answers_immediately_with_the_current_state() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("doc.md");
        write(&file, "hello\n");
        let mut h = Harness::start();

        h.watch(file.to_str().unwrap()).await;
        let frame = h.next_for(file.to_str().unwrap()).await;
        assert_eq!(frame["state"], json!("present"));
        assert_eq!(frame["sha256"], json!(sha("hello\n")));
        assert_eq!(frame["size"], json!(6));
        assert_eq!(frame["created"], json!([]));
    }

    #[tokio::test]
    async fn the_watched_key_and_an_events_parent_are_one_spelling() {
        // The tmpdir is the macOS case that matters: `/var/…` to the test,
        // `/private/var/…` to FSEvents. If the two spellings did not collapse
        // to one, the service would be deaf and this would time out.
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("doc.md");
        write(&file, "first\n");
        let mut h = Harness::start();
        h.watch(file.to_str().unwrap()).await;
        h.next_for(file.to_str().unwrap()).await;

        write(&file, "second\n");
        let frame = h
            .next_matching(file.to_str().unwrap(), |v| {
                v["sha256"] == json!(sha("second\n"))
            })
            .await;
        assert_eq!(frame["state"], json!("present"));
    }

    #[tokio::test]
    async fn an_atomic_rename_save_is_reported_with_a_new_inode() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("doc.md");
        write(&file, "before\n");
        let mut h = Harness::start();
        h.watch(file.to_str().unwrap()).await;
        let first = h.next_for(file.to_str().unwrap()).await;
        let old_ino = first["ino"].clone();

        // What every real editor does: write a temp file beside the target
        // and rename it over. A watch on the file's own inode goes deaf here.
        let temp = dir.path().join("doc.md.tmp");
        write(&temp, "after the rename\n");
        std::fs::rename(&temp, &file).unwrap();

        let frame = h
            .next_matching(file.to_str().unwrap(), |v| {
                v["sha256"] == json!(sha("after the rename\n"))
            })
            .await;
        assert_eq!(frame["state"], json!("present"));
        assert_ne!(frame["ino"], old_ino, "a rename brings a new inode");
    }

    #[tokio::test]
    async fn no_frame_reports_a_file_caught_mid_truncate() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("doc.md");
        write(&file, "a file with some real content in it\n");
        let mut h = Harness::start();
        h.watch(file.to_str().unwrap()).await;
        h.next_for(file.to_str().unwrap()).await;

        // Truncate, pause shorter than the settle, rewrite — the shape a
        // naive read reports as an empty file.
        let handle = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&file)
            .unwrap();
        drop(handle);
        std::thread::sleep(StdDuration::from_millis(30));
        write(&file, "the rewritten content, longer than before\n");

        let frame = h
            .next_matching(file.to_str().unwrap(), |v| {
                v["sha256"] == json!(sha("the rewritten content, longer than before\n"))
            })
            .await;
        assert_eq!(frame["state"], json!("present"));
    }

    #[tokio::test]
    async fn a_delete_is_absent_and_a_recreate_is_present_again() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("doc.md");
        write(&file, "here\n");
        let mut h = Harness::start();
        h.watch(file.to_str().unwrap()).await;
        h.next_for(file.to_str().unwrap()).await;

        std::fs::remove_file(&file).unwrap();
        let gone = h
            .next_matching(file.to_str().unwrap(), |v| v["state"] == json!("absent"))
            .await;
        assert_eq!(gone["state"], json!("absent"));

        write(&file, "back again\n");
        let back = h
            .next_matching(file.to_str().unwrap(), |v| v["state"] == json!("present"))
            .await;
        assert_eq!(back["sha256"], json!(sha("back again\n")));
    }

    #[tokio::test]
    async fn a_rename_to_a_sibling_names_the_sibling_in_created() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("doc.md");
        let sibling = dir.path().join("renamed.md");
        write(&file, "moving\n");
        let mut h = Harness::start();
        h.watch(file.to_str().unwrap()).await;
        h.next_for(file.to_str().unwrap()).await;

        std::fs::rename(&file, &sibling).unwrap();

        let frame = h
            .next_matching(file.to_str().unwrap(), |v| v["state"] == json!("absent"))
            .await;
        let created = frame["created"].as_array().unwrap();
        assert!(
            created
                .iter()
                .any(|p| p == &json!(sibling.to_str().unwrap())),
            "the sibling a rename created must ride the frame: {created:?}"
        );
    }

    #[tokio::test]
    async fn a_burst_ends_on_the_last_write_and_seq_only_climbs() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("doc.md");
        write(&file, "burst 00\n");
        let mut h = Harness::start();
        h.watch(file.to_str().unwrap()).await;
        let first = h.next_for(file.to_str().unwrap()).await;
        let mut last_seq = first["seq"].as_u64().unwrap();

        let last_body = "burst 20\n";
        for i in 1..=20 {
            let body = format!("burst {i:02}\n");
            write(&file, &body);
            tokio::time::sleep(StdDuration::from_millis(5)).await;
        }
        write(&file, last_body);

        let frame = h
            .next_matching(file.to_str().unwrap(), |v| {
                v["sha256"] == json!(sha(last_body))
            })
            .await;
        let seq = frame["seq"].as_u64().unwrap();
        assert!(seq > last_seq, "seq must climb: {seq} after {last_seq}");
        last_seq = seq;
        assert_eq!(frame["state"], json!("present"));
        assert!(last_seq > 0);
    }

    #[tokio::test]
    async fn two_files_share_one_directory_watch_and_reset_clears_everything() {
        let dir = TempDir::new().unwrap();
        let one = dir.path().join("one.md");
        let two = dir.path().join("two.md");
        write(&one, "one\n");
        write(&two, "two\n");
        let (out, mut frames) = broadcast::channel::<Frame>(256);
        let (mut service, requests) = FileWatchService::new(out);
        let cancel = CancellationToken::new();

        // Drive the maps directly rather than through the loop: the refcount
        // is the claim under test, and it is not visible on the wire.
        let (look_tx, _look_rx) = mpsc::unbounded_channel::<(String, Look)>();
        let (event_tx, _event_rx) = mpsc::unbounded_channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = event_tx.send(res);
        })
        .unwrap();

        service.watch(one.to_str().unwrap().to_string(), &mut watcher, &look_tx);
        service.watch(two.to_str().unwrap().to_string(), &mut watcher, &look_tx);
        assert_eq!(service.dirs.len(), 1, "one directory, one watch");
        assert_eq!(service.dirs.values().next(), Some(&2));

        service.unwatch(one.to_str().unwrap(), &mut watcher);
        assert_eq!(service.dirs.values().next(), Some(&1));
        service.unwatch(two.to_str().unwrap(), &mut watcher);
        assert!(service.dirs.is_empty(), "the last file out releases it");

        service.watch(one.to_str().unwrap().to_string(), &mut watcher, &look_tx);
        service.reset(&mut watcher);
        assert!(service.files.is_empty() && service.dirs.is_empty());

        drop(requests);
        cancel.cancel();
        let _ = frames.try_recv();
    }

    #[tokio::test]
    async fn a_teardown_several_levels_up_still_reaches_the_file() {
        // A joined arc worktree: the card has a file open inside
        // `<repo>/.tug/worktrees/<name>/`, and the join removes that whole
        // tree. The removal is reported against the directory that was
        // removed — three levels above the file's own parent — so a watch
        // on the parent alone hears nothing at all. This is the case the
        // ancestor chain exists for.
        let repo = TempDir::new().unwrap();
        std::fs::create_dir_all(repo.path().join(".git")).unwrap();
        let worktree = repo.path().join(".tug/worktrees/myarc");
        let dir = worktree.join("src");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("x.ts");
        write(&file, "arc version\n");

        let mut h = Harness::start();
        h.watch(file.to_str().unwrap()).await;
        let first = h.next_for(file.to_str().unwrap()).await;
        assert_eq!(first["state"], json!("present"));

        std::fs::remove_dir_all(&worktree).unwrap();

        let gone = h
            .next_matching(file.to_str().unwrap(), |v| v["state"] == json!("absent"))
            .await;
        assert_eq!(gone["state"], json!("absent"));
    }

    #[test]
    fn the_chain_stops_at_the_project_root() {
        let repo = TempDir::new().unwrap();
        std::fs::create_dir_all(repo.path().join(".git")).unwrap();
        let dir = repo.path().join("a/b");
        std::fs::create_dir_all(&dir).unwrap();

        let chain = watch_chain(&dir);
        assert_eq!(
            chain,
            vec![
                dir.clone(),
                repo.path().join("a"),
                repo.path().to_path_buf()
            ],
            "the parent, then up to and including the root — and no further"
        );

        // No project at all: the parent alone. Watching a home directory
        // would deliver that whole tree to this process on macOS.
        let loose = TempDir::new().unwrap();
        let bare = loose.path().join("notes");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(watch_chain(&bare), vec![bare]);
    }

    #[tokio::test]
    async fn a_directory_whose_name_prefixes_ours_is_a_different_directory() {
        // `/…/src` is a string prefix of `/…/srclib/f.txt`, and a watcher
        // that compared paths as strings would take one for the other. The
        // `dirs` map is keyed on the whole directory, so the question never
        // arises — this is the pin that says so. The store used to carry
        // this discrimination itself, back when it filtered the
        // workspace-wide feed by path.
        let root = TempDir::new().unwrap();
        let ours = root.path().join("srclib");
        let theirs = root.path().join("src");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();
        let file = ours.join("f.txt");
        write(&file, "mine\n");

        let (out, _frames) = broadcast::channel::<Frame>(16);
        let (mut service, _requests) = FileWatchService::new(out);
        let (look_tx, _look_rx) = mpsc::unbounded_channel::<(String, Look)>();
        let (event_tx, _event_rx) = mpsc::unbounded_channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = event_tx.send(res);
        })
        .unwrap();
        let key = file.to_str().unwrap().to_string();
        service.watch(key.clone(), &mut watcher, &look_tx);
        // The `watch` itself schedules the answer it always owes; clear it
        // so what is measured below is the event's effect alone.
        service.files.get_mut(&key).unwrap().deadline = None;

        service.handle_event(Ok(notify::Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![theirs.join("f.txt")],
            attrs: Default::default(),
        }));

        let ours_state = service.files.get(&key).unwrap();
        assert!(
            ours_state.deadline.is_none(),
            "a neighbour directory's file must not mark ours dirty"
        );
        assert!(ours_state.siblings.is_empty());
    }

    #[tokio::test]
    async fn a_secret_path_and_a_relative_path_are_refused_in_the_guards_words() {
        let dir = TempDir::new().unwrap();
        let secret = dir.path().join(".env");
        write(&secret, "TOKEN=1\n");
        let mut h = Harness::start();

        h.watch(secret.to_str().unwrap()).await;
        let refused = h.next_for(secret.to_str().unwrap()).await;
        assert_eq!(refused["state"], json!("error"));
        assert_eq!(refused["error"], json!("denied"));

        h.watch("relative/doc.md").await;
        let bad = h.next_for("relative/doc.md").await;
        assert_eq!(bad["state"], json!("error"));
        assert_eq!(bad["error"], json!("bad_path"));
    }
}
