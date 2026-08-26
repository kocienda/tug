//! Shell feed — per-card block-oriented shell execution.
//!
//! The `$` route runs commands against a real shell and threads each
//! command/output exchange into the Dev transcript. This module is the
//! tugcast side: it consumes `SHELL_INPUT` (0x61) frames from the deck and
//! emits `SHELL_OUTPUT` (0x60) frames tagged with the card's `tug_session_id`.
//!
//! # Model (probe: `crates/tugcast/probes/shell-exec/FINDINGS.md`)
//!
//! Each card session owns a **long-lived POSIX-shell child in pipe mode** (no
//! PTY / no controlling TTY), driven by a **sentinel protocol**: after each
//! command the service writes a sentinel emitter, then reads the merged
//! stdout+stderr stream until the sentinel line, which carries the command's
//! exit code and post-command cwd. Pipe mode makes `isatty()` false, so
//! pagers and TUIs self-disable; a hardened env (`PAGER`/`GIT_PAGER`=cat,
//! `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`) and a per-command `</dev/null`
//! redirect close the remaining hang vectors. A genuine long-runner wedges the
//! shell (it blocks on the foreground command), so cancellation cannot be
//! another write — it must **signal the process group** (SIGTERM→SIGKILL),
//! which the dispatcher does out-of-band via the shared pid.
//!
//! The child is the **user's own shell, spawned interactive-login** (`$SHELL
//! -il`), so it sources their startup files — PATH, exports, aliases,
//! functions — and the `$` route feels like their terminal rather than a bare
//! shell. A post-startup preamble then neutralizes the interactive baggage
//! (prompt paint, precmd/preexec hooks, and the SIGTERM-ignore that would
//! defeat the reap) and a discarded warmup exchange absorbs any rc chatter. A
//! profile that hangs or fails the warmup can never brick the route: the child
//! is reaped and a plain rc-less shell takes its place, flagged in the next
//! exchange's output.
//!
//! # Scope + lifecycle
//!
//! One shell child per `tug_session_id`, lazily spawned on the first `exec`
//! in the card's project dir. The child does NOT survive a tugcast restart;
//! it restarts fresh on the next `exec` (the transcript *record* persists via
//! the ledger, not the live process). A `kill` (or per-exchange timeout)
//! reaps the process group and the session respawns on the next `exec`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use tugcast_core::protocol::{FeedId, Frame};

use super::code::parse_tug_session_id;
use super::session_scoped::SessionScopedFeed;
use super::shell_words::SessionWords;
use crate::shell_ledger::{NewShellExchange, ShellLedger};

/// Broadcast capacity for `SHELL_OUTPUT`. Human-typed commands are low
/// volume; the restore tail comes from the ledger CONTROL read, not replay.
pub const SHELL_BROADCAST_CAPACITY: usize = 256;

/// Unique-per-process sentinel marker. The pid keeps it from colliding with
/// any literal text a command might print (a bare `__TUG_SHELL_SENTINEL__`
/// in a file, say) across concurrent tugcast instances.
fn sentinel_marker() -> String {
    format!("__TUG_SHELL_SENTINEL__{}__", std::process::id())
}

/// Per-exchange wall-clock cap. A command still running past this is reaped
/// (pgid signal) and its exchange settles with a null exit code.
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);

/// Grace between SIGTERM and SIGKILL when reaping a wedged process group.
const KILL_GRACE: Duration = Duration::from_millis(400);

/// Cap on the warmup probe that sources the user's rc files. Heavy profiles
/// (nvm, pyenv, version managers) can take a second or two; past this the
/// login shell is judged wedged and the route falls back to a plain shell.
const WARMUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Prefixed to the first exchange after a login-shell warmup failed and the
/// route fell back to a plain shell (no rc files sourced).
const SAFE_MODE_NOTICE: &str =
    "tug: your shell profile failed to load; running a plain shell without it.\n";

// ---------------------------------------------------------------------------
// Wire types (Spec S01)
// ---------------------------------------------------------------------------

/// Inbound `SHELL_INPUT` frame. `cwd` rides the `exec` verb so the service can
/// spawn the session's shell in the card's project dir without a session→dir
/// lookup; it is honored only on the lazy spawn (cwd is shell state after).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ShellInput {
    Exec {
        tug_session_id: String,
        exchange_id: String,
        command: String,
        #[serde(default)]
        cwd: Option<String>,
    },
    // `kill` reaps the session's whole process group (the shell + whatever it
    // is running), so it needs only the routing key; any `exchange_id` the
    // deck sends is ignored by serde.
    Kill {
        tug_session_id: String,
    },
    // `path_commands` requests everything the deck's shell-line classifier
    // needs to decide a line could be a command. The reply is two SHELL_OUTPUT
    // frames: `path_commands` (the login-PATH executable set, from a cache kept
    // fresh by directory mtime) and `shell_words` (the session shell's aliases,
    // functions and builtins). `cwd` is the card's project dir, where the word
    // dump's throwaway shell stands — rc files branch on where they are.
    PathCommands {
        tug_session_id: String,
        #[serde(default)]
        cwd: Option<String>,
    },
    // `shell_grammar` grades one typed line against the login-PATH set, the
    // baked command catalog, and this session's working directory. The reply is
    // one `shell_grammar` SHELL_OUTPUT frame echoing `line`, so the deck can
    // match an answer to the draft it asked about.
    ShellGrammar {
        tug_session_id: String,
        line: String,
    },
    // `shell_classify` asks the SharedAgent whether one line means the shell or
    // means Claude — the question `shell_grammar` could not settle on its own.
    // The reply is one `shell_classify` SHELL_OUTPUT frame echoing `line` and
    // `with_grammar`, which together are the correlation key: the deck caches
    // verdicts with and without documentation separately, so the two must not
    // resolve each other.
    ShellClassify {
        tug_session_id: String,
        line: String,
        #[serde(default)]
        grammar: Option<String>,
    },
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The exec shell: the user's `$SHELL` if it is bash/zsh (the sentinel protocol
/// is POSIX/bash/zsh syntax), else `/bin/zsh`. A fish/nushell user still gets a
/// POSIX exec child — a block-exec shell need not *be* the login shell.
fn resolve_exec_shell() -> String {
    if let Ok(sh) = std::env::var("SHELL") {
        let leaf = sh.rsplit('/').next().unwrap_or("");
        if leaf == "bash" || leaf == "zsh" {
            return sh;
        }
    }
    "/bin/zsh".to_string()
}

// ---------------------------------------------------------------------------
// PATH command set ([P08], Spec S02)
// ---------------------------------------------------------------------------

/// Upper bound on the serialized `commands` array. A login PATH holds ~2–5k
/// names (tens of KB); past this the set is truncated to a sorted prefix and a
/// warning is logged, so a pathological PATH can never blow the transport cap.
const PATH_COMMANDS_SERIALIZED_CAP: usize = 512 * 1024;

/// How often the PATH directories may be re-stat'd. Short enough that a `brew
/// install` is routable by the time the user types the new command's name, long
/// enough that a burst of keystrokes pays for one check.
const PATH_REVALIDATE_THROTTLE: Duration = Duration::from_secs(3);

/// One PATH directory and what was last read from it. Holding the names per
/// directory is what makes revalidation cheap: a directory whose mtime has not
/// moved is not read at all.
struct PathDir {
    path: PathBuf,
    mtime: Option<SystemTime>,
    names: Vec<String>,
}

/// The login-PATH set, kept fresh by directory mtime rather than swept once and
/// trusted forever.
///
/// The login PATH *string* is still probed once per process — a login shell's
/// PATH does not change under a running tugcast. What changes is the contents of
/// its directories, and that is what a `brew install` moves.
struct PathCache {
    dirs: Vec<PathDir>,
    /// The union of every directory's names, sorted — what the deck and the
    /// grader both consult.
    names: Arc<Vec<String>>,
    /// The directories themselves, the grader's per-word probe surface.
    dir_paths: Arc<Vec<PathBuf>>,
    last_check: Instant,
}

impl PathCache {
    fn from_dirs(dirs: Vec<PathDir>) -> Self {
        use std::collections::BTreeSet;
        let names: BTreeSet<&String> = dirs.iter().flat_map(|d| d.names.iter()).collect();
        PathCache {
            names: Arc::new(names.into_iter().cloned().collect()),
            dir_paths: Arc::new(dirs.iter().map(|d| d.path.clone()).collect()),
            dirs,
            last_check: Instant::now(),
        }
    }
}

static PATH_CACHE: std::sync::LazyLock<tokio::sync::Mutex<Option<PathCache>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));

fn dir_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// Read every PATH directory from scratch. The probe and the readdir sweep live
/// in `tuggram`, which is also what grades a typed line against the set — so the
/// deck's precondition and the grader's resolution can never be looking at two
/// different PATHs.
fn build_path_cache() -> PathCache {
    let path = tuggram::probe_login_path();
    let dirs = path
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| {
            let path = PathBuf::from(d);
            PathDir {
                mtime: dir_mtime(&path),
                names: tuggram::command_names_in_dir(&path),
                path,
            }
        })
        .collect();
    PathCache::from_dirs(dirs)
}

/// Re-stat each directory and re-read only the ones that moved.
fn revalidate_path_cache(mut cache: PathCache) -> (PathCache, bool) {
    let mut moved = false;
    for dir in &mut cache.dirs {
        let mtime = dir_mtime(&dir.path);
        if mtime != dir.mtime {
            dir.mtime = mtime;
            dir.names = tuggram::command_names_in_dir(&dir.path);
            moved = true;
        }
    }
    if !moved {
        cache.last_check = Instant::now();
        return (cache, false);
    }
    let previous = Arc::clone(&cache.names);
    let rebuilt = PathCache::from_dirs(cache.dirs);
    // An mtime moves for reasons that leave the *names* alone — a file
    // rewritten in place, a temp file created and removed. Only a change in the
    // set is worth telling anybody about.
    let changed = *rebuilt.names != *previous;
    (rebuilt, changed)
}

/// The login-PATH command set and directories, revalidated at most once per
/// {@link PATH_REVALIDATE_THROTTLE}. The third value is whether the set changed
/// on this call — the signal that every session holding the old set needs the
/// new one.
///
/// All filesystem work runs on `spawn_blocking`. The cache lock is held across
/// that await deliberately: it is what keeps two concurrent triggers from both
/// sweeping.
async fn revalidated_path_commands() -> (Arc<Vec<String>>, Arc<Vec<PathBuf>>, bool) {
    let mut guard = PATH_CACHE.lock().await;
    if let Some(cache) = guard.as_ref() {
        if cache.last_check.elapsed() < PATH_REVALIDATE_THROTTLE {
            return (
                Arc::clone(&cache.names),
                Arc::clone(&cache.dir_paths),
                false,
            );
        }
    }
    let existing = guard.take();
    let rebuilt = tokio::task::spawn_blocking(move || match existing {
        Some(cache) => revalidate_path_cache(cache),
        None => (build_path_cache(), true),
    })
    .await;
    let (cache, changed) = match rebuilt {
        Ok(pair) => pair,
        Err(e) => {
            // The sweep task died; leave the cache empty so the next trigger
            // rebuilds, and answer with nothing rather than with stale truth.
            warn!(error = %e, "path revalidation task failed");
            (PathCache::from_dirs(Vec::new()), false)
        }
    };
    let answer = (
        Arc::clone(&cache.names),
        Arc::clone(&cache.dir_paths),
        changed,
    );
    *guard = Some(cache);
    answer
}

/// Install a cache over exactly these directories, so a test can watch a real
/// directory it controls instead of the machine's PATH.
#[cfg(test)]
async fn seed_path_cache_for_test(dirs: Vec<PathBuf>) {
    let dirs = dirs
        .into_iter()
        .map(|path| PathDir {
            mtime: dir_mtime(&path),
            names: tuggram::command_names_in_dir(&path),
            path,
        })
        .collect();
    *PATH_CACHE.lock().await = Some(PathCache::from_dirs(dirs));
}

/// Age the cache past the throttle, standing in for the wait a test should not
/// have to spend.
#[cfg(test)]
async fn expire_path_throttle_for_test() {
    if let Some(cache) = PATH_CACHE.lock().await.as_mut() {
        cache.last_check = Instant::now()
            .checked_sub(PATH_REVALIDATE_THROTTLE * 2)
            .unwrap_or_else(Instant::now);
    }
}

/// Revalidate the PATH set and, when it changed, push the new set to every
/// session that ever asked for one.
///
/// The push is the point. The deck gates both its typing debounce and its submit
/// path on the command set it holds, so a binary installed a moment ago becomes
/// routable only if the deck's own set is refreshed — a revalidation that
/// stayed inside tugcast would be freshness nobody could see.
async fn revalidate_and_push(
    output: &SessionScopedFeed,
    requesters: &Arc<Mutex<HashSet<String>>>,
) -> (Arc<Vec<String>>, Arc<Vec<PathBuf>>) {
    let (names, dirs, changed) = revalidated_path_commands().await;
    if changed {
        let sessions: Vec<String> = requesters.lock().unwrap().iter().cloned().collect();
        for session in sessions {
            emit_path_commands(output, &session, &names);
        }
    }
    (names, dirs)
}

/// Emit a `path_commands` SHELL_OUTPUT frame for `tug_session_id`. The command
/// array is truncated to a sorted prefix if its serialized form would exceed
/// {@link PATH_COMMANDS_SERIALIZED_CAP}, logging a warning.
fn emit_path_commands(output: &SessionScopedFeed, tug_session_id: &str, commands: &[String]) {
    emit(
        output,
        tug_session_id,
        json!({
            "type": "path_commands",
            "tug_session_id": tug_session_id,
            "commands": capped(commands, "path_commands"),
        }),
    );
}

/// Emit a `shell_words` SHELL_OUTPUT frame: the names the session's shell
/// resolves ahead of PATH. Names only — the deck's precondition is a membership
/// test, and shipping bodies would put a second copy of the expansions
/// somewhere nobody could keep coherent.
fn emit_shell_words(output: &SessionScopedFeed, tug_session_id: &str, names: &[String]) {
    emit(
        output,
        tug_session_id,
        json!({
            "type": "shell_words",
            "tug_session_id": tug_session_id,
            "names": capped(names, "shell_words"),
        }),
    );
}

/// Trim a name array from the tail until its serialized form fits the transport
/// cap, warning if anything was dropped. Cheap to recompute, since a real-world
/// set is well under the cap.
fn capped<'a>(names: &'a [String], what: &str) -> &'a [String] {
    let mut end = names.len();
    while end > 0 {
        let serialized = serde_json::to_string(&names[..end])
            .map(|s| s.len())
            .unwrap_or(0);
        if serialized <= PATH_COMMANDS_SERIALIZED_CAP {
            break;
        }
        end = end * 9 / 10;
    }
    if end < names.len() {
        warn!(
            total = names.len(),
            kept = end,
            "{what} set exceeded the transport cap; truncated to a sorted prefix"
        );
    }
    &names[..end]
}

// ---------------------------------------------------------------------------
// Command-grammar grading
// ---------------------------------------------------------------------------

/// Grade one line and emit the reply frame.
///
/// The grade runs on `spawn_blocking` because head resolution can `stat` a
/// path-shaped command word. `cwd` is the session's own working directory —
/// never tugcast's, which is wherever the host launched it and says nothing
/// about where the user's shell is standing — and `None` means no shell child
/// has spawned yet, which the grader reads as "could not check" rather than as
/// "does not exist".
async fn emit_shell_grammar(
    output: &SessionScopedFeed,
    tug_session_id: &str,
    line: String,
    commands: Arc<Vec<String>>,
    path_dirs: Arc<Vec<PathBuf>>,
    words: tuggram::ShellWords,
    cwd: Option<String>,
) {
    let graded = {
        let line = line.clone();
        tokio::task::spawn_blocking(move || {
            let cwd = cwd.map(PathBuf::from);
            tuggram::grade(
                &line,
                &tuggram::ShellContext {
                    commands: tuggram::CommandSet::new_sorted(&commands),
                    words: &words,
                    path_dirs: &path_dirs,
                    cwd: cwd.as_deref(),
                },
            )
        })
        .await
    };
    let Ok(graded) = graded else {
        warn!(%tug_session_id, "shell grammar: grading task failed");
        return;
    };
    let mut payload = json!({
        "type": "shell_grammar",
        "tug_session_id": tug_session_id,
        "line": line,
        "band": graded.band.as_str(),
    });
    // Only a Maybe carries documentation — it is what arms the model when
    // grammar alone could not tell.
    if let Some(synopsis) = graded.synopsis {
        payload["synopsis"] = json!(synopsis);
    }
    emit(output, tug_session_id, payload);
}

/// Whether a settled command is one that changes what words the shell resolves,
/// and so is worth re-reading the table for.
///
/// **What this catches, and what it does not.** The re-read spawns a fresh
/// interactive-login shell, so it sees whatever the rc files now say: edit
/// `.zshrc` and `source` it and the new alias is in the table. An `alias` typed
/// directly at the `$` route lives only in that session's own shell child's
/// memory, where a fresh login shell cannot see it — that word stays unknown to
/// the classifier until it reaches an rc file. The cost is coverage only: the
/// line goes to Claude, which is the designed degraded path.
fn touches_shell_words(command: &str) -> bool {
    let first = command.split_whitespace().next().unwrap_or("");
    matches!(first, "alias" | "unalias" | "source" | ".")
}

/// The command words of a line, one per segment — the words whose expansions
/// the grade may need. A line the lexer refuses names nothing, and grades
/// `Unknown` on its own.
fn segment_heads(line: &str) -> Vec<String> {
    tuggram::lex(line)
        .unwrap_or_default()
        .iter()
        .filter_map(|s| s.head().map(|h| h.to_string()))
        .collect()
}

/// Make sure the SharedAgent's classify lane has a worker on its way up.
///
/// Idempotent and non-blocking — a lane that already has one does nothing, and
/// no reply depends on it.
fn warm_classify_lane(agent: &crate::shared_agent::SharedAgentHandle) {
    if let Some(pool) = agent {
        pool.ensure_warm(crate::shared_agent::JobClass::Classify);
    }
}

/// Answer one classify request on the asking session's feed.
///
/// Runs on its own task so the dispatcher loop keeps routing `exec` and `kill`
/// while a verdict is outstanding — a classify can take up to its ceiling, and
/// nothing about a shell command should wait on it.
///
/// Every failure shape — no agent, a dead worker, a timeout, an answer naming
/// no label — emits the same `ok:false, verdict:null` frame, because the deck
/// does the same thing with all of them: send the line to Claude ([P06]).
fn spawn_shell_classify(
    output: SessionScopedFeed,
    agent: crate::shared_agent::SharedAgentHandle,
    tug_session_id: String,
    line: String,
    grammar: Option<String>,
) {
    tokio::spawn(async move {
        // An empty synopsis means no documentation — the same filter the
        // CONTROL classify verb applies, so both ingress paths pick the same
        // job wording.
        let grammar = grammar.filter(|s| !s.is_empty());
        let with_grammar = grammar.is_some();
        let result = match agent {
            Some(pool) => pool.run_classify(line.clone(), grammar).await,
            None => Err("shared agent unavailable".to_string()),
        };
        let (ok, verdict, error) = match result {
            Ok(verdict) => (true, Some(verdict), None),
            Err(error) => (false, None, Some(error)),
        };
        emit(
            &output,
            &tug_session_id,
            json!({
                "type": "shell_classify",
                "tug_session_id": tug_session_id,
                "line": line,
                "with_grammar": with_grammar,
                "ok": ok,
                "verdict": verdict,
                "error": error,
            }),
        );
    });
}

// ---------------------------------------------------------------------------
// Per-session shell child
// ---------------------------------------------------------------------------

/// Shared handle onto a running shell child: the process-group leader pid the
/// dispatcher signals to reap a wedged command out-of-band. `None` when no
/// child is live (never spawned, or reaped and awaiting respawn).
#[derive(Default)]
struct SessionShared {
    pid: Option<i32>,
    /// Where this session's shell is standing, as of its last settled exchange.
    /// `None` until a shell child has actually spawned — which is what the
    /// grader needs to tell "this relative path does not exist" from "there is
    /// no directory to look in yet".
    cwd: Option<String>,
    /// Set by the dispatcher when it reaps the in-flight exchange for a `kill`.
    /// The signal reaches the group differently across platforms — the shell
    /// may die (EOF → no exit code) or its foreground child may die (128+SIGTERM)
    /// while the shell survives to emit the sentinel — so the session task reads
    /// this to settle a killed exchange as reaped regardless of which path won.
    killed: bool,
}

/// Commands routed to a per-session task. `kill` is NOT here — it is handled
/// by the dispatcher signaling the shared pid directly, because a wedged task
/// is blocked reading the child's stdout and could never dequeue it.
enum ShellCmd {
    Exec {
        exchange_id: String,
        command: String,
    },
}

/// A live per-session actor: the command channel plus the shared pid the
/// dispatcher signals for `kill`.
struct ShellSession {
    tx: mpsc::Sender<ShellCmd>,
    shared: Arc<Mutex<SessionShared>>,
}

/// The child's stdin + a line reader over its merged stdout.
struct ShellChild {
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    // Held so the child is killed on drop (session teardown / task exit).
    _child: tokio::process::Child,
}

/// Spawn the session shell, preferring the user's interactive login shell so
/// their rc files are in force — the whole point of the `$` route is that it
/// feels like *their* terminal, not some bare shell. A hung or broken rc file
/// must never brick the route, so the login spawn is health-checked (see
/// `spawn_shell_child`'s warmup); on failure the child is reaped and a plain
/// rc-less shell takes its place, with a one-line notice for the next output.
async fn spawn_session_shell(
    spawn_cwd: &PathBuf,
    marker: &str,
    tug_session_id: &str,
) -> std::io::Result<(ShellChild, i32, Option<String>)> {
    if let Ok((sh, pid)) = spawn_shell_child(spawn_cwd, marker, true, tug_session_id).await {
        return Ok((sh, pid, None));
    }
    let (sh, pid) = spawn_shell_child(spawn_cwd, marker, false, tug_session_id).await?;
    Ok((sh, pid, Some(SAFE_MODE_NOTICE.to_string())))
}

/// Spawn one shell child in pipe mode, hardened, as its own process-group
/// leader, in `spawn_cwd`. Merges stderr into stdout (`exec 2>&1`) so the
/// combined stream is what the deck renders and the sentinel rides.
///
/// `login` spawns the user's shell as interactive-login (`-il`), so it sources
/// their startup files (PATH, exports, aliases, functions) exactly as their
/// terminal does; `-i` is also what enables alias expansion. The spawn then
/// runs a discarded warmup probe: it flushes any stdout an rc file printed and
/// confirms the shell answers the sentinel protocol, so a wedged profile is
/// caught here rather than corrupting the first real exchange.
async fn spawn_shell_child(
    spawn_cwd: &PathBuf,
    marker: &str,
    login: bool,
    tug_session_id: &str,
) -> std::io::Result<(ShellChild, i32)> {
    let shell = resolve_exec_shell();
    let mut cmd = Command::new(&shell);
    if login {
        cmd.arg("-il");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // Hardening ([Q03]): no pager, no TUI, no prompts. Note the no-TUI
        // guarantee comes from the no-controlling-TTY session (`setsid` below):
        // a full-screen app checks `isatty(stdout)`, sees a pipe, and declines
        // regardless of `TERM`. So `TERM` is safe to make color-capable.
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("PS1", "")
        .env("PROMPT", "")
        // Terminal colors: the deck renders ANSI SGR (ansi_up + the
        // `--tugx-term-ansi-*` palette), so let commands emit it even though
        // stdout is a pipe, not a TTY. A color-capable `TERM` (dumb suppresses
        // color at the source); `CLICOLOR`/`CLICOLOR_FORCE` enable + force BSD
        // tools (macOS `ls`, etc.) past the not-a-tty check; `FORCE_COLOR` does
        // the same for the Node ecosystem. Only SGR color is unlocked — cursor
        // addressing still needs a TTY, which the session denies.
        .env("TERM", "xterm-256color")
        .env("CLICOLOR", "1")
        .env("CLICOLOR_FORCE", "1")
        .env("FORCE_COLOR", "1")
        // The card's session id, matching what the agent bridge exports for
        // claude's own subprocesses. Load-bearing for `tugutil changes`, which
        // reads `$TUG_SESSION_ID` to resolve the session against the ledger.
        .env("TUG_SESSION_ID", tug_session_id);
    if spawn_cwd.is_dir() {
        cmd.current_dir(spawn_cwd);
    }
    // `setsid` before exec: the child leads a NEW SESSION with NO controlling
    // TTY. Two payoffs: (1) `/dev/tty` opens fail (ENXIO), so a command that
    // grabs the terminal directly — vim, `ssh` / `sudo` password prompts —
    // declines fast instead of hanging on tugcast's tty; (2) the child is a
    // process-group leader (pgid == pid), so `kill(-pid, …)` reaps the shell
    // AND whatever command it is currently running.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    let pid = child.id().map(|p| p as i32).unwrap_or(0);
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("shell stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("shell stdout unavailable"))?;
    // Drain stderr (it is redirected into stdout below, but anything the shell
    // writes before `exec 2>&1` takes effect must not fill the pipe buffer).
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        });
    }
    let mut sh = ShellChild {
        stdin,
        lines: BufReader::new(stdout).lines(),
        _child: child,
    };
    // Preamble, run AFTER the shell has finished sourcing its rc files (so it
    // wins over anything they set). Line by line:
    //   - `exec 2>&1`: merge stderr into stdout so ordering is preserved and
    //     the sentinel (printf to stdout) terminates every exchange.
    //   - `trap - TERM QUIT`: an interactive shell IGNORES SIGTERM, which would
    //     defeat the kill/timeout reap (the shell would outlive the group
    //     signal). Reset the disposition so `reap_group` kills it as before.
    //   - clear precmd/preexec/chpwd hooks and `unfunction` the standalone
    //     `precmd`/`preexec` a theme may have defined (the array clear misses
    //     those) so the prompt is not re-armed after each command.
    //   - `unsetopt promptsp promptcr`: kill zsh's partial-line `%` marker,
    //     which paints even with an empty prompt.
    //   - empty every prompt parameter.
    // Any prompt paint from before this takes effect is absorbed by the warmup
    // exchange below and discarded, so real exchanges start clean.
    sh.stdin
        .write_all(
            b"exec 2>&1\n\
              trap - TERM QUIT\n\
              precmd_functions=() preexec_functions=() chpwd_functions=()\n\
              unfunction precmd preexec chpwd 2>/dev/null\n\
              unsetopt promptsp promptcr 2>/dev/null\n\
              PS1= PS2= PROMPT= RPROMPT= RPS1= PROMPT_COMMAND=\n",
        )
        .await?;
    sh.stdin.flush().await?;

    // Warmup probe: a discarded no-op exchange. It absorbs any stdout an rc
    // file printed and confirms the shell answers the sentinel; a login shell
    // whose profile hangs or never reaches the sentinel is unusable, so reap
    // its process group and report failure for the plain-shell fallback.
    match tokio::time::timeout(WARMUP_TIMEOUT, run_command(&mut sh, marker, ":")).await {
        Ok(Ok(r)) if r.exit_code.is_some() => Ok((sh, pid)),
        _ => {
            reap_group(pid);
            Err(std::io::Error::other("shell warmup failed"))
        }
    }
}

/// Outcome of running one command through the sentinel protocol.
struct ExecResult {
    output: String,
    exit_code: Option<i32>,
    cwd_after: Option<String>,
}

/// Run one command: write it wrapped `</dev/null` (so a stdin-reading command
/// can't swallow the sentinel), then the sentinel emitter, and read the merged
/// stream until the sentinel line. `None` exit code = the stream ended before
/// the sentinel (the child was reaped mid-command).
async fn run_command(
    child: &mut ShellChild,
    marker: &str,
    command: &str,
) -> std::io::Result<ExecResult> {
    let line = format!(
        "{{ {command} ; }} </dev/null\nprintf '\\n%s\\t%d\\t%s\\n' \"{marker}\" \"$?\" \"$PWD\"\n"
    );
    child.stdin.write_all(line.as_bytes()).await?;
    child.stdin.flush().await?;

    let mut output = String::new();
    loop {
        match child.lines.next_line().await? {
            Some(l) => {
                if let Some(rest) = l.strip_prefix(marker) {
                    // `<marker>\t<code>\t<cwd>`
                    let mut parts = rest.trim_start_matches('\t').split('\t');
                    let exit_code = parts.next().and_then(|s| s.parse::<i32>().ok());
                    let cwd_after = parts.next().map(|s| s.to_string());
                    // Drop the single trailing empty line the sentinel's
                    // leading `\n` produced.
                    if output.ends_with('\n') {
                        output.pop();
                    }
                    return Ok(ExecResult {
                        output,
                        exit_code,
                        cwd_after,
                    });
                }
                output.push_str(&l);
                output.push('\n');
            }
            // EOF before the sentinel — the child was reaped (kill / crash).
            None => {
                return Ok(ExecResult {
                    output,
                    exit_code: None,
                    cwd_after: None,
                });
            }
        }
    }
}

/// Signal a process group: SIGTERM, then SIGKILL after a grace. Reaps a wedged
/// shell and the command it is running. Safe no-op for a non-positive pid.
fn reap_group(pid: i32) {
    if pid <= 0 {
        return;
    }
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    tokio::spawn(async move {
        tokio::time::sleep(KILL_GRACE).await;
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    });
}

/// The per-session actor task. Owns the shell child, runs commands serially,
/// and emits exchange frames. Exits when its command channel closes.
#[allow(clippy::too_many_arguments)]
async fn shell_session_task(
    mut rx: mpsc::Receiver<ShellCmd>,
    output: SessionScopedFeed,
    ledger: Option<Arc<ShellLedger>>,
    sessions_ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
    shared: Arc<Mutex<SessionShared>>,
    tug_session_id: String,
    spawn_cwd: PathBuf,
    marker: String,
    exec_timeout: Duration,
    path_requesters: Arc<Mutex<HashSet<String>>>,
    session_words: SessionWords,
) {
    let mut child: Option<ShellChild> = None;
    let mut cwd = spawn_cwd.to_string_lossy().to_string();
    // Prepended to the next exchange's output when a login-shell warmup failed
    // and this session fell back to a plain shell. Set on spawn, cleared once
    // emitted so the notice shows once per fallback, not on every command.
    let mut pending_notice: Option<String> = None;

    while let Some(cmd) = rx.recv().await {
        let ShellCmd::Exec {
            exchange_id,
            command,
        } = cmd;

        // Lazy spawn / respawn.
        if child.is_none() {
            match spawn_session_shell(&spawn_cwd, &marker, &tug_session_id).await {
                Ok((sh, pid, notice)) => {
                    child = Some(sh);
                    {
                        let mut g = shared.lock().unwrap();
                        g.pid = Some(pid);
                        g.cwd = Some(cwd.clone());
                    }
                    if notice.is_some() {
                        pending_notice = notice;
                    }
                    emit(
                        &output,
                        &tug_session_id,
                        json!({ "type": "shell_state", "live": true, "cwd": cwd }),
                    );
                }
                Err(e) => {
                    warn!(error = %e, %tug_session_id, "shell spawn failed");
                    let at = now_ms();
                    emit(
                        &output,
                        &tug_session_id,
                        json!({
                            "type": "exchange_complete", "exchange_id": exchange_id,
                            "command": command, "cwd": cwd,
                            "exit_code": serde_json::Value::Null, "cwd_after": cwd,
                            "duration_ms": 0, "output": format!("shell failed to start: {e}\n"),
                            "started_at": at, "settled_at": at,
                        }),
                    );
                    continue;
                }
            }
        }
        let sh = child.as_mut().unwrap();

        let started_at = now_ms();
        let cwd_before = cwd.clone();
        emit(
            &output,
            &tug_session_id,
            json!({
                "type": "exchange_started", "exchange_id": exchange_id,
                "command": command, "cwd": cwd, "started_at": started_at,
            }),
        );

        shared.lock().unwrap().killed = false;
        let result = tokio::time::timeout(exec_timeout, run_command(sh, &marker, &command)).await;
        // An out-of-band `kill` reaps the group mid-exchange. The signal settles
        // the outcome differently across platforms — the shell dies (EOF → no
        // exit code) or its child dies (128+SIGTERM) while the shell survives to
        // emit the sentinel — so honor the kill flag and settle as reaped either
        // way, rather than leaking the child's signal-death code to the deck.
        let killed = std::mem::take(&mut shared.lock().unwrap().killed);
        let (mut out, exit_code, cwd_after, reaped) = match result {
            Ok(Ok(r)) if killed => (r.output, None, r.cwd_after, true),
            Ok(Ok(r)) => {
                let reaped = r.exit_code.is_none();
                (r.output, r.exit_code, r.cwd_after, reaped)
            }
            Ok(Err(e)) => (format!("shell read error: {e}\n"), None, None, true),
            Err(_) => {
                // Timed out — reap the wedged group.
                let pid = shared.lock().unwrap().pid.unwrap_or(0);
                reap_group(pid);
                (String::new(), None, None, true)
            }
        };
        if let Some(notice) = pending_notice.take() {
            out.insert_str(0, &notice);
        }
        if let Some(c) = &cwd_after {
            cwd = c.clone();
            shared.lock().unwrap().cwd = Some(cwd.clone());
        }
        let settled_at = now_ms();
        let duration_ms = settled_at.saturating_sub(started_at);
        // The settle frame is self-contained — it carries the same
        // command/cwd/timestamps the started frame did, because the deck
        // settles the transcript row in place from THIS frame alone (and
        // the restore path's ledger rows carry the full shape too).
        emit(
            &output,
            &tug_session_id,
            json!({
                "type": "exchange_complete", "exchange_id": exchange_id,
                "command": command, "cwd": cwd_before,
                "exit_code": exit_code.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
                "cwd_after": cwd, "duration_ms": duration_ms, "output": out,
                "started_at": started_at, "settled_at": settled_at,
            }),
        );

        // Persist the settled exchange for restore ([P07]). Insert-on-settle
        // only: an exchange in flight at a crash never lands (it never settled).
        if let Some(ledger) = ledger.as_ref() {
            let row = NewShellExchange {
                tug_session_id: tug_session_id.clone(),
                command: command.clone(),
                output: out.clone(),
                exit_code,
                cwd: cwd_before,
                cwd_after: Some(cwd.clone()),
                started_at_ms: started_at as i64,
                settled_at_ms: settled_at as i64,
            };
            if let Err(e) = ledger.record_exchange(&row) {
                warn!(error = %e, %tug_session_id, "shell ledger: record_exchange failed");
            }
        }

        // The same exchange as a fact. `shell_exchanges` is the verbatim
        // record the card restores from; this is the durable, searchable one
        // the Operator answers "what did I run" out of. Live-only, so no
        // dedupe key: a `$` command settles once and is never replayed.
        //
        // The exit code informs the `shell` fact alone. A test run's verdict
        // is read from its own summary ([P07]) — a failing suite exits
        // non-zero from a perfectly well-formed command.
        if let Some(sessions) = sessions_ledger.as_ref() {
            use crate::feeds::facts_library;
            let at_ms = settled_at as i64;
            let exit = exit_code.map(i64::from);
            let shell_fact = facts_library::shell_fact(
                at_ms,
                Some(&tug_session_id),
                &command,
                facts_library::ShellRoute::User,
                exit.unwrap_or(0) == 0,
                exit,
                Some(&cwd),
                None,
            );
            if let Err(e) = sessions.record_fact(&shell_fact) {
                warn!(error = %e, %tug_session_id, "shell fact write failed");
            }
            if let Some(run) = facts_library::classify_test_run(&command, &out) {
                if let Err(e) = sessions.record_fact(&facts_library::test_run_fact(
                    at_ms,
                    Some(&tug_session_id),
                    &run,
                    None,
                )) {
                    warn!(error = %e, %tug_session_id, "test_run fact write failed");
                }
            }
        }

        // A command just finished running, which is when installs happen in
        // this UI — `brew install x` is typed into this very route. The
        // throttle makes the poke cheap enough to pay on every settle rather
        // than trying to guess which commands install things.
        revalidate_and_push(&output, &path_requesters).await;

        // A command that touched the shell's own word definitions is worth a
        // re-read. Rare and human-initiated, so paying a shell spawn for it is
        // nothing.
        if touches_shell_words(&command) {
            let names = session_words.refresh(Some(Path::new(&cwd))).await;
            emit_shell_words(&output, &tug_session_id, &names);
        }

        // A reaped child (kill / timeout / crash / EOF) is gone; the next exec
        // respawns fresh in the project dir ([Q04] restart-fresh).
        if reaped {
            child = None;
            cwd = spawn_cwd.to_string_lossy().to_string();
            let mut g = shared.lock().unwrap();
            g.pid = None;
            // The next exec respawns in the project dir, so that is where the
            // session now stands.
            g.cwd = Some(cwd.clone());
        }
    }

    // Channel closed (session teardown): reap any live child.
    let pid = shared.lock().unwrap().pid.take();
    if let Some(pid) = pid {
        reap_group(pid);
    }
    debug!(%tug_session_id, "shell session task exited");
}

fn emit(output: &SessionScopedFeed, tug_session_id: &str, payload: serde_json::Value) {
    output.publish(tug_session_id, payload.to_string().as_bytes());
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/// Consume `SHELL_INPUT` frames and route them to per-session shell tasks:
/// `exec` lazily spawns a session's task and enqueues the command; `kill`
/// signals the session's shared pid out-of-band (a wedged task can't dequeue).
/// One task per `tug_session_id`; the map lives for the dispatcher's lifetime.
///
/// `sessions` is the per-instance session ledger, present only so a settled
/// exchange can record its facts ([P06]) — the `$` route is one of the two
/// places a shell command becomes durable, and it had no handle to the facts
/// library before. Optional for the same reason `ledger` is: tests that
/// exercise the wire shape wire neither.
pub async fn shell_dispatcher_task(
    input_rx: mpsc::Receiver<Frame>,
    output: SessionScopedFeed,
    ledger: Option<Arc<ShellLedger>>,
    sessions: Option<Arc<crate::session_ledger::SessionLedger>>,
    agent: crate::shared_agent::SharedAgentHandle,
    cancel: CancellationToken,
) {
    run_dispatcher(
        input_rx,
        output,
        ledger,
        sessions,
        agent,
        cancel,
        EXEC_TIMEOUT,
    )
    .await;
}

/// Dispatcher core with an injectable per-exchange timeout (tests use a short
/// one to exercise the reap-on-timeout path without waiting the full cap).
#[allow(clippy::too_many_arguments)]
async fn run_dispatcher(
    mut input_rx: mpsc::Receiver<Frame>,
    output: SessionScopedFeed,
    ledger: Option<Arc<ShellLedger>>,
    sessions_ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
    agent: crate::shared_agent::SharedAgentHandle,
    cancel: CancellationToken,
    exec_timeout: Duration,
) {
    let mut sessions: HashMap<String, ShellSession> = HashMap::new();
    // Every session that has ever asked for the command set, so a set that
    // changes under them can be pushed rather than waited for. Shared with the
    // session tasks, which poke the revalidation when an exchange settles —
    // that is the moment an install actually happens in this UI.
    let path_requesters: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    // One word table per session, because a table is read from the session's own
    // project directory. Created by whichever verb reaches the session first, so
    // frame ordering can never strand a session tableless.
    let mut words: HashMap<String, SessionWords> = HashMap::new();
    let marker = sentinel_marker();

    loop {
        let frame = tokio::select! {
            _ = cancel.cancelled() => break,
            f = input_rx.recv() => match f {
                Some(f) => f,
                None => break,
            },
        };
        if frame.feed_id != FeedId::SHELL_INPUT {
            continue;
        }
        let Some(input) = parse_shell_input(&frame.payload) else {
            warn!("shell dispatcher: unparseable SHELL_INPUT frame");
            continue;
        };
        match input {
            ShellInput::Exec {
                tug_session_id,
                exchange_id,
                command,
                cwd,
            } => {
                let session_words = words.entry(tug_session_id.clone()).or_default().clone();
                let session = sessions.entry(tug_session_id.clone()).or_insert_with(|| {
                    let (tx, rx) = mpsc::channel(64);
                    let shared = Arc::new(Mutex::new(SessionShared::default()));
                    let spawn_cwd = cwd
                        .as_deref()
                        .map(PathBuf::from)
                        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
                    tokio::spawn(shell_session_task(
                        rx,
                        output.clone(),
                        ledger.clone(),
                        sessions_ledger.clone(),
                        Arc::clone(&shared),
                        tug_session_id.clone(),
                        spawn_cwd,
                        marker.clone(),
                        exec_timeout,
                        Arc::clone(&path_requesters),
                        session_words.clone(),
                    ));
                    ShellSession { tx, shared }
                });
                if session
                    .tx
                    .send(ShellCmd::Exec {
                        exchange_id,
                        command,
                    })
                    .await
                    .is_err()
                {
                    // Task died — drop it so the next exec respawns.
                    sessions.remove(&tug_session_id);
                }
            }
            ShellInput::Kill { tug_session_id } => {
                if let Some(session) = sessions.get(&tug_session_id) {
                    // Flag the kill before signaling, so the flag is visible to
                    // the session task by the time the signal lands and its
                    // `run_command` returns (settling the exchange as reaped).
                    let pid = {
                        let mut g = session.shared.lock().unwrap();
                        g.killed = true;
                        g.pid
                    };
                    if let Some(pid) = pid {
                        reap_group(pid);
                    }
                }
            }
            // Resolve the login-PATH command set (once, cached) and reply for
            // this session ([P08]). Independent of any per-session shell child —
            // the probe never touches the lazily-spawned exec shell.
            ShellInput::PathCommands {
                tug_session_id,
                cwd,
            } => {
                // A card asking for the command set has a composer somebody may
                // type a command into, and a classify cannot pay a cold spawn
                // inside its own 2s ceiling — so the lane comes up now, while
                // nobody is waiting on it.
                warm_classify_lane(&agent);
                // Push first, register after: this session's own reply is the
                // emit below, so registering first would send it the set twice.
                let (commands, _dirs) = revalidate_and_push(&output, &path_requesters).await;
                path_requesters
                    .lock()
                    .unwrap()
                    .insert(tug_session_id.clone());
                emit_path_commands(&output, &tug_session_id, &commands);

                // The companion answer: what this session's own shell resolves
                // ahead of PATH. Read from the card's project dir, since rc
                // files branch on where they are standing.
                let session_words = words.entry(tug_session_id.clone()).or_default();
                let names = session_words.refresh(cwd.as_deref().map(Path::new)).await;
                emit_shell_words(&output, &tug_session_id, &names);
            }
            // Grade one line against the same cached PATH set the deck's own
            // precondition came from, plus this session's working directory.
            ShellInput::ShellGrammar {
                tug_session_id,
                line,
            } => {
                // The grade rides the same typing debounce as the classify, so
                // this is also where a lane reaped mid-session comes back.
                warm_classify_lane(&agent);
                let (commands, path_dirs) = revalidate_and_push(&output, &path_requesters).await;
                let cwd = sessions
                    .get(&tug_session_id)
                    .and_then(|s| s.shared.lock().unwrap().cwd.clone());
                // Read the bodies of the words this line actually names, so an
                // alias or simple function can lend the grade the grammar of
                // what it expands to. Behind the typing debounce, not at submit.
                let session_words = words.entry(tug_session_id.clone()).or_default();
                session_words.ensure_bodies(&segment_heads(&line)).await;
                let snapshot = session_words.snapshot().await;
                emit_shell_grammar(
                    &output,
                    &tug_session_id,
                    line,
                    commands,
                    path_dirs,
                    snapshot,
                    cwd,
                )
                .await;
            }
            // The band the grammar could not settle, asked of the SharedAgent.
            ShellInput::ShellClassify {
                tug_session_id,
                line,
                grammar,
            } => spawn_shell_classify(output.clone(), agent.clone(), tug_session_id, line, grammar),
        }
    }

    // Drop all sessions — each task reaps its child on channel close.
    sessions.clear();
    words.clear();
}

/// Parse a `SHELL_INPUT` payload. Requires a `tug_session_id` (the routing
/// key); a payload without one — or with an unknown `type` — is dropped.
fn parse_shell_input(payload: &[u8]) -> Option<ShellInput> {
    // Fast reject: a frame with no session id can't be routed.
    parse_tug_session_id(payload)?;
    serde_json::from_slice::<ShellInput>(payload).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcast_core::lag::LagPolicy;

    fn exec_frame(sid: &str, ex: &str, cmd: &str, cwd: Option<&str>) -> Frame {
        let mut v = json!({
            "type": "exec", "tug_session_id": sid,
            "exchange_id": ex, "command": cmd,
        });
        if let Some(c) = cwd {
            v["cwd"] = json!(c);
        }
        Frame::new(FeedId::SHELL_INPUT, v.to_string().into_bytes())
    }

    fn kill_frame(sid: &str) -> Frame {
        Frame::new(
            FeedId::SHELL_INPUT,
            json!({ "type": "kill", "tug_session_id": sid })
                .to_string()
                .into_bytes(),
        )
    }

    fn payload_json(f: &Frame) -> serde_json::Value {
        serde_json::from_slice(&f.payload).unwrap()
    }

    /// Drive the dispatcher; collect `exchange_complete` payloads for `sid`
    /// until `count` are seen or the timeout fires. Uses a short per-exchange
    /// timeout so a genuinely-hanging command (a TUI) is reaped within the test.
    async fn drive(frames: Vec<Frame>, sid: &str, count: usize) -> Vec<serde_json::Value> {
        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_dispatcher(
            in_rx,
            output.clone(),
            None,
            None,
            None,
            cancel.clone(),
            Duration::from_secs(3),
        ));
        for f in frames {
            tx.send(f).await.unwrap();
        }
        let mut completes = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while completes.len() < count {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let v = payload_json(&frame);
                    if v["tug_session_id"] == sid && v["type"] == "exchange_complete" {
                        completes.push(v);
                    }
                }
                _ => break,
            }
        }
        cancel.cancel();
        drop(tx);
        let _ = handle.await;
        completes
    }

    #[tokio::test]
    async fn exec_round_trip_and_exit_code() {
        let done = drive(
            vec![
                exec_frame("s1", "e1", "echo hello world", None),
                exec_frame("s1", "e2", "false", None),
            ],
            "s1",
            2,
        )
        .await;
        assert_eq!(done.len(), 2);
        assert_eq!(done[0]["exit_code"], 0);
        assert!(done[0]["output"].as_str().unwrap().contains("hello world"));
        assert_eq!(done[1]["exit_code"], 1);
        // The settle frame is self-contained: the deck settles the row in
        // place from this frame alone, so it must re-carry the command and
        // both timestamps (not just the delta).
        assert_eq!(done[0]["command"], "echo hello world");
        assert!(done[0]["started_at"].as_u64().is_some());
        assert!(done[0]["settled_at"].as_u64().is_some());
        assert!(done[0]["settled_at"].as_u64() >= done[0]["started_at"].as_u64());
    }

    // macOS-gated: this asserts the color-forcing env recipe against BSD `ls`,
    // which honors `CLICOLOR`/`CLICOLOR_FORCE`. GNU `ls` (Linux CI) ignores
    // those and colorizes only via `--color`, so the recipe is a no-op there.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn shell_output_carries_ansi_color() {
        // The deck renders ANSI SGR (ansi_up + the `--tugx-term-ansi-*`
        // palette), so the feed must let commands emit color even though stdout
        // is a pipe, not a TTY. With the color-forcing env, `ls -l /` colorizes
        // its directory entries; the escape must survive the sentinel reader
        // and reach the deck-facing `output` unstripped.
        let done = drive(vec![exec_frame("s1", "e1", "ls -l /", None)], "s1", 1).await;
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["exit_code"], 0);
        let out = done[0]["output"].as_str().unwrap();
        assert!(
            out.contains('\u{1b}'),
            "expected an ANSI escape in colorized ls output, got: {out:?}"
        );
    }

    #[tokio::test]
    async fn cwd_persists_across_commands() {
        let done = drive(
            vec![
                exec_frame("s1", "e1", "cd /tmp", None),
                exec_frame("s1", "e2", "pwd", None),
            ],
            "s1",
            2,
        )
        .await;
        assert_eq!(done.len(), 2);
        // The cwd sentinel tracked into /tmp...
        assert!(done[0]["cwd_after"].as_str().unwrap().contains("tmp"));
        // ...and a later `pwd` prints it — proving shell-state persistence.
        assert!(done[1]["output"].as_str().unwrap().contains("/tmp"));
    }

    #[tokio::test]
    async fn stdin_reading_command_does_not_desync() {
        // `cat` with no args would eat the sentinel emitter without the
        // per-command `</dev/null`; here it must exit 0 and the NEXT command
        // must still be answered (protocol stays synced).
        let done = drive(
            vec![
                exec_frame("s1", "e1", "cat", None),
                exec_frame("s1", "e2", "echo still-synced", None),
            ],
            "s1",
            2,
        )
        .await;
        assert_eq!(done.len(), 2);
        assert_eq!(done[0]["exit_code"], 0);
        assert!(done[1]["output"].as_str().unwrap().contains("still-synced"));
    }

    #[tokio::test]
    async fn interactive_tui_is_reaped_by_the_timeout() {
        // An interactive TUI (vim) renders to the pipe and waits for input —
        // it does NOT reliably auto-decline, so the per-exchange timeout is the
        // backstop: the shell must never hang forever. With the short test
        // timeout the exchange settles with a null exit code (reaped), and a
        // FOLLOW-UP command proves the session respawned and stayed usable.
        let done = drive(
            vec![
                exec_frame("s1", "e1", "vim", None),
                exec_frame("s1", "e2", "echo recovered", None),
            ],
            "s1",
            2,
        )
        .await;
        assert_eq!(done.len(), 2);
        assert_eq!(done[0]["exit_code"], serde_json::Value::Null, "vim reaped");
        assert!(done[1]["output"].as_str().unwrap().contains("recovered"));
    }

    #[tokio::test]
    async fn login_shell_sources_user_rc() {
        // The `$` route runs the user's shell interactive-login, so their rc
        // files are in force: an alias defined there EXPANDS (only interactive
        // shells expand aliases) and an exported var is visible. This is what
        // makes the route feel like *their* terminal, not a bare shell.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".zshrc"),
            "alias tuggreet='echo hello-from-rc'\nexport TUG_RC_MARKER=rc-was-sourced\n",
        )
        .unwrap();
        // Force zsh reading THIS rc (via ZDOTDIR), independent of the dev's own
        // login shell, so the assertion is deterministic across machines.
        unsafe {
            std::env::set_var("SHELL", "/bin/zsh");
            std::env::set_var("ZDOTDIR", dir.path());
        }
        let done = drive(
            vec![
                exec_frame("s1", "e1", "tuggreet", None),
                exec_frame("s1", "e2", "echo \"$TUG_RC_MARKER\"", None),
            ],
            "s1",
            2,
        )
        .await;
        assert_eq!(done.len(), 2);
        assert!(
            done[0]["output"]
                .as_str()
                .unwrap()
                .contains("hello-from-rc"),
            "rc alias must expand: {:?}",
            done[0]["output"]
        );
        assert!(
            done[1]["output"]
                .as_str()
                .unwrap()
                .contains("rc-was-sourced"),
            "rc export must be visible: {:?}",
            done[1]["output"]
        );
    }

    #[tokio::test]
    async fn per_session_isolation() {
        // Two sessions cd to different dirs; neither sees the other's cwd.
        let done_a = drive(
            vec![
                exec_frame("sa", "e1", "cd /tmp", None),
                exec_frame("sa", "e2", "pwd", None),
                exec_frame("sb", "e3", "pwd", Some("/usr")),
            ],
            "sa",
            2,
        )
        .await;
        assert!(done_a[1]["output"].as_str().unwrap().contains("/tmp"));
    }

    #[tokio::test]
    async fn settled_exchange_is_recorded_to_the_ledger() {
        // The settle path writes each exchange to the ledger (insert-on-settle),
        // so a restore can reconstruct the shell rows.
        let ledger = Arc::new(crate::shell_ledger::ShellLedger::open_in_memory().unwrap());
        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_dispatcher(
            in_rx,
            output.clone(),
            Some(Arc::clone(&ledger)),
            None,
            None,
            cancel.clone(),
            Duration::from_secs(3),
        ));
        tx.send(exec_frame("s1", "e1", "echo persisted", Some("/tmp")))
            .await
            .unwrap();
        // Wait for the exchange to settle.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while let Ok(Ok(f)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            if payload_json(&f)["type"] == "exchange_complete" {
                break;
            }
        }
        cancel.cancel();
        drop(tx);
        let _ = handle.await;
        let rows = ledger.list_exchanges("s1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].command, "echo persisted");
        assert!(rows[0].output.contains("persisted"));
        assert_eq!(rows[0].exit_code, Some(0));
    }

    /// The `$` route is the second of the two places a shell command becomes
    /// durable, and it had no handle on the facts library until the session
    /// ledger was threaded here. A command that is a test run records both
    /// facts; the verdict comes from the runner's own summary, never from the
    /// exit code ([P07]).
    #[tokio::test]
    async fn a_settled_user_command_records_its_shell_and_test_run_facts() {
        let sessions = Arc::new(crate::session_ledger::SessionLedger::open_in_memory().unwrap());
        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_dispatcher(
            in_rx,
            output.clone(),
            None,
            Some(Arc::clone(&sessions)),
            None,
            cancel.clone(),
            Duration::from_secs(10),
        ));
        // A real command whose real output carries a real nextest summary —
        // `echo` is the honest way to put a known tail in front of the
        // classifier without pretending to run a suite.
        tx.send(exec_frame(
            "s1",
            "e1",
            "echo '     Summary [ 1.0s] 3 tests run: 3 passed, 0 skipped' && cargo nextest run --help >/dev/null",
            Some("/tmp"),
        ))
        .await
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while let Ok(Ok(f)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            if payload_json(&f)["type"] == "exchange_complete" {
                break;
            }
        }
        cancel.cancel();
        drop(tx);
        let _ = handle.await;

        let facts = sessions.facts_for_test();
        assert_eq!(facts.len(), 2, "a shell fact and its test_run: {facts:?}");
        assert_eq!(facts[0].0, "shell");
        assert!(facts[0].2.starts_with("$ echo"), "{}", facts[0].2);
        assert_eq!(facts[1].0, "test_run");
        assert_eq!(
            facts[1].2,
            "tests: cargo nextest — passed (3 passed, 0 failed)"
        );
    }

    #[tokio::test]
    async fn kill_reaps_a_long_runner() {
        // A long sleep wedges the shell; a kill frame reaps the group, and the
        // exchange settles with a null exit code.
        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(shell_dispatcher_task(
            in_rx,
            output.clone(),
            None,
            None,
            None,
            cancel.clone(),
        ));
        tx.send(exec_frame("s1", "e1", "sleep 60", None))
            .await
            .unwrap();
        // Kill only once the shell has spawned and the exchange has started —
        // a `kill` that lands before the spawn finishes finds no pid to signal.
        let start_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let frame = tokio::time::timeout_at(start_deadline, rx.recv())
                .await
                .expect("exchange must start")
                .unwrap();
            let v = payload_json(&frame);
            if v["type"] == "exchange_started" && v["exchange_id"] == "e1" {
                break;
            }
        }
        tx.send(kill_frame("s1")).await.unwrap();
        let mut settled = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while settled.is_none() {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let v = payload_json(&frame);
                    if v["type"] == "exchange_complete" && v["exchange_id"] == "e1" {
                        settled = Some(v);
                    }
                }
                _ => break,
            }
        }
        cancel.cancel();
        drop(tx);
        let _ = handle.await;
        let v = settled.expect("killed exchange must settle");
        assert_eq!(v["exit_code"], serde_json::Value::Null);
    }

    // ── path_commands ([P08]) ──────────────────────────────────────────────

    fn path_commands_frame(sid: &str) -> Frame {
        Frame::new(
            FeedId::SHELL_INPUT,
            json!({ "type": "path_commands", "tug_session_id": sid })
                .to_string()
                .into_bytes(),
        )
    }

    fn path_commands_frame_in(sid: &str, cwd: &Path) -> Frame {
        Frame::new(
            FeedId::SHELL_INPUT,
            json!({ "type": "path_commands", "tug_session_id": sid, "cwd": cwd })
                .to_string()
                .into_bytes(),
        )
    }

    /// A live dispatcher with its input channel and output subscription, for the
    /// tests that have to do something between one frame and the next.
    struct Harness {
        tx: mpsc::Sender<Frame>,
        rx: tokio::sync::broadcast::Receiver<Frame>,
        cancel: CancellationToken,
        handle: tokio::task::JoinHandle<()>,
    }

    impl Harness {
        fn start() -> Self {
            let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
            let rx = output.subscribe();
            let (tx, in_rx) = mpsc::channel(64);
            let cancel = CancellationToken::new();
            let handle = tokio::spawn(run_dispatcher(
                in_rx,
                output,
                None,
                None,
                None,
                cancel.clone(),
                Duration::from_secs(10),
            ));
            Harness {
                tx,
                rx,
                cancel,
                handle,
            }
        }

        async fn send(&self, frame: Frame) {
            self.tx.send(frame).await.unwrap();
        }

        /// Wait for the next output frame of `kind` for `sid`.
        async fn next(&mut self, sid: &str, kind: &str) -> serde_json::Value {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            loop {
                match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                    Ok(Ok(frame)) => {
                        let v = payload_json(&frame);
                        if v["tug_session_id"] == sid && v["type"] == kind {
                            return v;
                        }
                    }
                    other => panic!("no {kind} frame for {sid}: {other:?}"),
                }
            }
        }

        async fn stop(self) {
            self.cancel.cancel();
            drop(self.tx);
            let _ = self.handle.await;
        }
    }

    fn names_of(frame: &serde_json::Value) -> Vec<String> {
        frame["names"]
            .as_array()
            .expect("names array")
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    /// Point `$SHELL` at zsh and `$ZDOTDIR` at a tempdir holding a known rc, so
    /// the word table under test is the one this test wrote.
    fn with_rc(dir: &Path, rc: &str) {
        std::fs::write(dir.join(".zshrc"), rc).unwrap();
        unsafe {
            std::env::set_var("SHELL", "/bin/zsh");
            std::env::set_var("ZDOTDIR", dir);
        }
    }

    #[tokio::test]
    async fn a_path_commands_request_is_answered_with_the_shell_words_too() {
        let dir = tempfile::tempdir().unwrap();
        with_rc(
            dir.path(),
            "alias tugalias='git status'\ntugfn () { git status $* }\n",
        );
        let mut h = Harness::start();
        h.send(path_commands_frame_in("s1", dir.path())).await;

        assert!(
            !h.next("s1", "path_commands").await["commands"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let names = names_of(&h.next("s1", "shell_words").await);
        assert!(names.iter().any(|n| n == "tugalias"));
        assert!(names.iter().any(|n| n == "tugfn"));
        assert!(
            names.iter().any(|n| n == "setopt"),
            "a builtin on no PATH is exactly what the sweep cannot see"
        );
        assert!(!names.iter().any(|n| n.starts_with('_')));
        h.stop().await;
    }

    #[tokio::test]
    async fn a_shell_that_cannot_be_read_still_answers_the_path_set() {
        unsafe {
            std::env::set_var("SHELL", "/usr/bin/false");
        }
        let mut h = Harness::start();
        h.send(path_commands_frame("s1")).await;
        assert!(
            !h.next("s1", "path_commands").await["commands"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            names_of(&h.next("s1", "shell_words").await).is_empty(),
            "no table, and nothing wedged"
        );
        h.stop().await;
    }

    #[tokio::test]
    async fn a_line_opening_on_an_rc_function_grades_through_its_expansion() {
        let dir = tempfile::tempdir().unwrap();
        with_rc(dir.path(), "tugfn () { git status $* }\n");
        let mut h = Harness::start();
        h.send(path_commands_frame_in("s1", dir.path())).await;
        h.next("s1", "shell_words").await;

        // Dump, fetch, parse, splice — end to end through the dispatcher, on a
        // word that is on no PATH anywhere.
        h.send(grammar_frame("s1", "tugfn")).await;
        assert_eq!(h.next("s1", "shell_grammar").await["band"], "yes");
        h.send(grammar_frame("s1", "tugfn -sb")).await;
        assert_eq!(h.next("s1", "shell_grammar").await["band"], "yes");
        h.stop().await;
    }

    #[tokio::test]
    async fn sourcing_a_changed_rc_refreshes_the_word_table() {
        let dir = tempfile::tempdir().unwrap();
        with_rc(dir.path(), "tugfn () { git status $* }\n");
        let mut h = Harness::start();
        h.send(path_commands_frame_in("s1", dir.path())).await;
        let names = names_of(&h.next("s1", "shell_words").await);
        assert!(!names.iter().any(|n| n == "tuglater"));

        // The rc grows a word, and the user sources it — the shape the refresh
        // trigger exists for.
        with_rc(
            dir.path(),
            "tugfn () { git status $* }\ntuglater () { git log $* }\n",
        );
        h.send(exec_frame(
            "s1",
            "e1",
            &format!("source {}/.zshrc", dir.path().display()),
            Some(&dir.path().to_string_lossy()),
        ))
        .await;

        let names = names_of(&h.next("s1", "shell_words").await);
        assert!(
            names.iter().any(|n| n == "tuglater"),
            "the settled `source` re-read the table: {names:?}"
        );
        h.send(grammar_frame("s1", "tuglater --oneline")).await;
        assert_eq!(h.next("s1", "shell_grammar").await["band"], "yes");
        h.stop().await;
    }

    #[test]
    fn only_the_word_defining_verbs_trigger_a_re_read() {
        assert!(touches_shell_words("alias gs='git status'"));
        assert!(touches_shell_words("  unalias gs"));
        assert!(touches_shell_words("source ~/.zshrc"));
        assert!(touches_shell_words(". ~/.zshrc"));
        assert!(!touches_shell_words("git status"));
        assert!(!touches_shell_words("echo alias"));
        assert!(!touches_shell_words(""));
    }

    /// Drive the dispatcher and collect the first `count` `path_commands`
    /// output frames for `sid`.
    async fn drive_path_commands(
        frames: Vec<Frame>,
        sid: &str,
        count: usize,
    ) -> Vec<serde_json::Value> {
        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_dispatcher(
            in_rx,
            output.clone(),
            None,
            None,
            None,
            cancel.clone(),
            Duration::from_secs(3),
        ));
        for f in frames {
            tx.send(f).await.unwrap();
        }
        let mut got = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while got.len() < count {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let v = payload_json(&frame);
                    if v["tug_session_id"] == sid && v["type"] == "path_commands" {
                        got.push(v);
                    }
                }
                _ => break,
            }
        }
        cancel.cancel();
        drop(tx);
        let _ = handle.await;
        got
    }

    // The PATH probe and the readdir sweep are `tuggram`'s and are covered by
    // its own unit tests; what this module owns is the frame round trip.

    #[tokio::test]
    async fn path_commands_round_trip_over_the_feed() {
        let got = drive_path_commands(vec![path_commands_frame("s1")], "s1", 1).await;
        assert_eq!(got.len(), 1);
        let commands = got[0]["commands"].as_array().expect("commands array");
        // The tugcast test process has a real PATH, so the set is non-empty and
        // sorted, and every entry is a bare name (no path separators).
        assert!(!commands.is_empty());
        let names: Vec<&str> = commands.iter().map(|v| v.as_str().unwrap()).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
        assert!(names.iter().all(|n| !n.contains('/')));
    }

    #[tokio::test]
    async fn path_commands_cache_hit_serves_identical_sets() {
        // Two requests answer from the process-wide cache — same set, same
        // order, no re-probe divergence.
        let got = drive_path_commands(
            vec![path_commands_frame("s1"), path_commands_frame("s2")],
            "s1",
            1,
        )
        .await;
        assert_eq!(got.len(), 1);
        let first = got[0]["commands"].clone();
        let second = drive_path_commands(vec![path_commands_frame("s2")], "s2", 1).await;
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["commands"], first);
    }

    fn make_executable(dir: &Path, name: &str) {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[tokio::test]
    async fn a_binary_installed_after_the_sweep_joins_the_set() {
        let dir = tempfile::tempdir().unwrap();
        seed_path_cache_for_test(vec![dir.path().to_path_buf()]).await;
        let (names, dirs, _) = revalidated_path_commands().await;
        assert!(names.is_empty(), "nothing installed yet");
        assert_eq!(dirs.len(), 1, "the probe surface is the watched directory");

        make_executable(dir.path(), "brandnew");
        expire_path_throttle_for_test().await;
        let (names, _, changed) = revalidated_path_commands().await;
        assert!(
            changed,
            "the set moved, so every holder of it needs telling"
        );
        assert!(names.iter().any(|n| n == "brandnew"));

        // Immediately again: the throttle answers from the cache and reports no
        // change, so a burst of keystrokes costs one sweep.
        let (_, _, changed) = revalidated_path_commands().await;
        assert!(!changed);
    }

    #[tokio::test]
    async fn a_binary_deleted_after_the_sweep_leaves_the_set() {
        let dir = tempfile::tempdir().unwrap();
        make_executable(dir.path(), "doomed");
        seed_path_cache_for_test(vec![dir.path().to_path_buf()]).await;
        let (names, _, _) = revalidated_path_commands().await;
        assert!(names.iter().any(|n| n == "doomed"));

        std::fs::remove_file(dir.path().join("doomed")).unwrap();
        expire_path_throttle_for_test().await;
        let (names, _, changed) = revalidated_path_commands().await;
        assert!(changed);
        assert!(!names.iter().any(|n| n == "doomed"));
    }

    #[tokio::test]
    async fn a_changed_set_is_pushed_to_every_session_holding_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        seed_path_cache_for_test(vec![dir.path().to_path_buf()]).await;
        let _ = revalidated_path_commands().await;

        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let requesters: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        requesters.lock().unwrap().insert("s1".to_string());
        requesters.lock().unwrap().insert("s2".to_string());

        // Nothing moved: nobody is told anything.
        expire_path_throttle_for_test().await;
        revalidate_and_push(&output, &requesters).await;
        assert!(
            rx.try_recv().is_err(),
            "an unchanged set is not worth a frame"
        );

        make_executable(dir.path(), "brandnew");
        expire_path_throttle_for_test().await;
        revalidate_and_push(&output, &requesters).await;

        let mut told: HashSet<String> = HashSet::new();
        while let Ok(frame) = rx.try_recv() {
            let v = payload_json(&frame);
            if v["type"] == "path_commands" {
                assert!(
                    v["commands"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c == "brandnew")
                );
                told.insert(v["tug_session_id"].as_str().unwrap().to_string());
            }
        }
        assert_eq!(told, HashSet::from(["s1".to_string(), "s2".to_string()]));
    }

    // ── shell_grammar ──────────────────────────────────────────────────────

    fn grammar_frame(sid: &str, line: &str) -> Frame {
        Frame::new(
            FeedId::SHELL_INPUT,
            json!({ "type": "shell_grammar", "tug_session_id": sid, "line": line })
                .to_string()
                .into_bytes(),
        )
    }

    /// Drive the dispatcher and collect the first `count` `shell_grammar`
    /// output frames for `sid`.
    async fn drive_grammar(frames: Vec<Frame>, sid: &str, count: usize) -> Vec<serde_json::Value> {
        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_dispatcher(
            in_rx,
            output.clone(),
            None,
            None,
            None,
            cancel.clone(),
            Duration::from_secs(3),
        ));
        for f in frames {
            tx.send(f).await.unwrap();
        }
        let mut got = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while got.len() < count {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let v = payload_json(&frame);
                    if v["tug_session_id"] == sid && v["type"] == "shell_grammar" {
                        got.push(v);
                    }
                }
                _ => break,
            }
        }
        cancel.cancel();
        drop(tx);
        let _ = handle.await;
        got
    }

    #[tokio::test]
    async fn shell_grammar_round_trips_every_band_over_the_feed() {
        let got = drive_grammar(
            vec![
                grammar_frame("s1", "git status"),
                grammar_frame("s1", "git stauts"),
                grammar_frame("s1", "frobnicate the thing"),
                grammar_frame("s1", "echo `date`"),
            ],
            "s1",
            4,
        )
        .await;
        assert_eq!(got.len(), 4);
        let bands: Vec<&str> = got.iter().map(|v| v["band"].as_str().unwrap()).collect();
        assert_eq!(bands, ["yes", "maybe", "no", "unknown"]);
    }

    #[tokio::test]
    async fn shell_grammar_echoes_the_line_and_carries_a_synopsis_only_on_maybe() {
        let got = drive_grammar(
            vec![
                grammar_frame("s1", "git stauts"),
                grammar_frame("s1", "git status"),
            ],
            "s1",
            2,
        )
        .await;
        assert_eq!(got[0]["line"], "git stauts");
        assert!(got[0]["synopsis"].as_str().unwrap().contains("git"));
        assert_eq!(got[1]["line"], "git status");
        assert!(got[1]["synopsis"].is_null());
    }

    #[tokio::test]
    async fn shell_grammar_replies_are_scoped_to_the_asking_session() {
        let got = drive_grammar(
            vec![
                grammar_frame("s1", "git status"),
                grammar_frame("s2", "frobnicate x"),
            ],
            "s2",
            1,
        )
        .await;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["line"], "frobnicate x");
        assert_eq!(got[0]["band"], "no");
    }

    // ── shell_classify ─────────────────────────────────────────────────────

    fn classify_frame(sid: &str, line: &str, grammar: Option<&str>) -> Frame {
        let mut v = json!({ "type": "shell_classify", "tug_session_id": sid, "line": line });
        if let Some(g) = grammar {
            v["grammar"] = json!(g);
        }
        Frame::new(FeedId::SHELL_INPUT, v.to_string().into_bytes())
    }

    /// Drive the dispatcher with a scripted agent and collect the first `count`
    /// `shell_classify` replies for `sid`.
    async fn drive_classify(
        frames: Vec<Frame>,
        answer: Result<String, String>,
        sid: &str,
        count: usize,
    ) -> Vec<serde_json::Value> {
        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        // The classify lane is warm before anybody types, because the card's
        // `path_commands` request warmed it at mount — stand where the deck
        // already put the pool, or the first line here would be answered by the
        // warmup path rather than by the agent.
        let agent = crate::shared_agent::test_support::scripted_haiku_pool(answer);
        agent
            .wait_until_warm(crate::shared_agent::JobClass::Classify)
            .await;
        let handle = tokio::spawn(run_dispatcher(
            in_rx,
            output.clone(),
            None,
            None,
            Some(agent),
            cancel.clone(),
            Duration::from_secs(3),
        ));
        for f in frames {
            tx.send(f).await.unwrap();
        }
        let mut got = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while got.len() < count {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let v = payload_json(&frame);
                    if v["tug_session_id"] == sid && v["type"] == "shell_classify" {
                        got.push(v);
                    }
                }
                _ => break,
            }
        }
        cancel.cancel();
        drop(tx);
        let _ = handle.await;
        got
    }

    /// The correlation key is the echoed line plus `with_grammar` — the deck
    /// parks resolvers under exactly that pair, and caches the two variants
    /// separately, so a reply that dropped either would resolve the wrong wait.
    #[tokio::test]
    async fn shell_classify_echoes_the_line_and_whether_documentation_was_sent() {
        let got = drive_classify(
            vec![
                classify_frame("s1", "ls -la", None),
                classify_frame("s1", "curl -sS x", Some("usage: curl [options]")),
            ],
            Ok("SHELL".to_string()),
            "s1",
            2,
        )
        .await;
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["line"], "ls -la");
        assert_eq!(got[0]["with_grammar"], false);
        assert_eq!(got[0]["ok"], true);
        // Parsed tugcast-side, so the deck sees only the two labels.
        assert_eq!(got[0]["verdict"], "shell");
        assert!(got[0]["error"].is_null());

        assert_eq!(got[1]["line"], "curl -sS x");
        assert_eq!(got[1]["with_grammar"], true);
        assert_eq!(got[1]["verdict"], "shell");
    }

    /// An answer naming no label is a refusal, and a refusal looks like every
    /// other failure to the deck: one degraded shape, so the line goes to
    /// Claude ([P06]).
    #[tokio::test]
    async fn a_classify_refusal_answers_with_the_one_degraded_shape() {
        let got = drive_classify(
            vec![classify_frame("s1", "make it pretty", None)],
            Ok("I am not sure about this one".to_string()),
            "s1",
            1,
        )
        .await;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["ok"], false);
        assert!(got[0]["verdict"].is_null());
        assert!(got[0]["error"].is_string());
        // Still correlated, or the deck could never retire the parked wait.
        assert_eq!(got[0]["line"], "make it pretty");
    }

    /// With no agent at all the verb still answers, in the same degraded shape.
    #[tokio::test]
    async fn a_classify_without_an_agent_answers_degraded() {
        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_dispatcher(
            in_rx,
            output.clone(),
            None,
            None,
            None,
            cancel.clone(),
            Duration::from_secs(3),
        ));
        tx.send(classify_frame("s1", "ls -la", None)).await.unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("a reply arrives")
            .expect("feed alive");
        let v = payload_json(&frame);
        assert_eq!(v["type"], "shell_classify");
        assert_eq!(v["ok"], false);
        assert!(v["verdict"].is_null());
        cancel.cancel();
        drop(tx);
        let _ = handle.await;
    }

    /// One session's verdict can never resolve another session's parked
    /// request — the same claim `shell_grammar` carries, for the same reason.
    #[tokio::test]
    async fn shell_classify_replies_are_scoped_to_the_asking_session() {
        let got = drive_classify(
            vec![
                classify_frame("s1", "ls -la", None),
                classify_frame("s2", "git status", None),
            ],
            Ok("SHELL".to_string()),
            "s2",
            1,
        )
        .await;
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["line"], "git status");
        assert_eq!(got[0]["tug_session_id"], "s2");
    }

    #[tokio::test]
    async fn a_relative_path_grades_unknown_until_the_session_has_a_shell() {
        // No exec has run, so there is no working directory to resolve `./x`
        // against. Absence of validation is not evidence of absence.
        let got = drive_grammar(vec![grammar_frame("s1", "./probe.sh")], "s1", 1).await;
        assert_eq!(got[0]["band"], "unknown");
    }

    #[tokio::test]
    async fn a_relative_path_grades_against_the_session_cwd_once_one_exists() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("probe.sh");
        std::fs::write(&script, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let output = SessionScopedFeed::new(FeedId::SHELL_OUTPUT, 256, LagPolicy::Warn);
        let mut rx = output.subscribe();
        let (tx, in_rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_dispatcher(
            in_rx,
            output.clone(),
            None,
            None,
            None,
            cancel.clone(),
            Duration::from_secs(5),
        ));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);

        // One exec establishes the session's cwd. Wait for it to settle: a
        // grade asked while an exec is still in flight legitimately sees no cwd
        // yet, which is a different case from the one under test here.
        tx.send(exec_frame(
            "s1",
            "e1",
            ":",
            Some(&dir.path().to_string_lossy()),
        ))
        .await
        .unwrap();
        loop {
            let Ok(Ok(frame)) = tokio::time::timeout_at(deadline, rx.recv()).await else {
                panic!("exec never settled");
            };
            if payload_json(&frame)["type"] == "exchange_complete" {
                break;
            }
        }

        tx.send(grammar_frame("s1", "./probe.sh")).await.unwrap();
        tx.send(grammar_frame("s1", "./nosuch.sh")).await.unwrap();
        let mut got = Vec::new();
        while got.len() < 2 {
            let Ok(Ok(frame)) = tokio::time::timeout_at(deadline, rx.recv()).await else {
                break;
            };
            let v = payload_json(&frame);
            if v["type"] == "shell_grammar" {
                got.push(v);
            }
        }
        cancel.cancel();
        drop(tx);
        let _ = handle.await;

        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["band"], "unknown", "it resolves but has no grammar");
        assert_eq!(got[1]["band"], "no");
    }
}
