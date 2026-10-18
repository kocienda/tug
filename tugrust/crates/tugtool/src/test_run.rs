//! `tugtool test run` — wrap a test command so every run leaves a record
//! beside its output.
//!
//! The command's stdout and stderr are copied through as they arrive, its
//! exit status is the wrapper's, and nothing it prints is lost. Beside that
//! pass-through the wrapper follows the run's progress from stderr and, at
//! exit, records the run's junit document in `test_results.db`, so a red run
//! whose output was filtered or scrolled away is named by
//! `tugtool test last --failures` rather than by running it again.
//!
//! Bun and nextest are quiet about passing tests when stderr is not a
//! terminal: bun prints nothing for a green file, and nextest prints no
//! `PASS` line. So the wrapper asks each for one mark per passing test —
//! bun's `--dots`, nextest's `--status-level pass` — counts the marks, and
//! swallows them, so what reaches the reader is what the bare command would
//! have printed — with one accepted exception: bun's dots mode also prints
//! its summary lines without their leading space and its `(fail)` lines
//! without their timings, and those reach the reader as bun wrote them. The
//! live count is worth that; the counts, names, messages and exit status are
//! unchanged. `cargo test` already prints one line per test, on stdout, and
//! is followed there with nothing added or taken away.
//!
//! A run's total is the runner's own count, never an estimate. nextest and
//! libtest say how many tests they will run before they run any. bun does
//! not, so before a bun run the wrapper asks bun for it: the same command
//! with a test-name pattern no test carries, which loads every file and
//! registers every test, runs none, and says how many it skipped
//! ([`collect_bun_total`]). A command that already filters by test name has
//! no such count to ask for, and its run carries none. When a run ends, its
//! last report carries the counts its junit document recorded.
//!
//! A run that writes no junit document — a `cargo test`, or a nextest run
//! that named no `--junit` — is recorded from what the follower counted off
//! the stream, with the failing tests it saw as the record's failures. So
//! the wrap needs nothing of the project's runner configuration.
//!
//! Every parser here is a pure function over bytes or lines, unit-tested
//! against output captured from the real runners.

use parking_lot::{Condvar, Mutex};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use tugtool_core::test_ledger::{self, JunitFailure, JunitRun, TestRun};

use crate::changes::AppError;
use crate::progress::{RunReport, post_run_progress};
use crate::session_identity::have_calling_session;
use crate::test_ledger_cli::{git_facts, now_epoch, read_junit, record};

/// Which runner the wrapped command is.
#[derive(Copy, Clone, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum RunKind {
    Bun,
    Nextest,
    /// `cargo test` — libtest's own reporter: `running N tests`, then one
    /// `test <name> ... ok` line per test, on stdout, and no junit document.
    CargoTest,
}

/// What a run has shown so far.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    /// Tests finished, passing and failing.
    pub done: u64,
    /// Tests the run will execute, when the runner says so up front.
    pub total: Option<u64>,
    pub failures: u64,
    /// The latest thing worth showing: a failing test, a crate compiling, the
    /// last test finished, or `running`.
    pub text: String,
    /// The failing tests so far, in the order they failed, up to
    /// [`FAILED_KEPT`] — the rows the block's run panel draws as reds.
    pub failed: Vec<FailedTest>,
}

/// One failing test, as a report carries it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FailedTest {
    /// How many tests had finished when it failed: where its mark sits on
    /// the run's band.
    pub index: u64,
    pub name: String,
    /// Why, when the runner said so on the line it failed on (bun does;
    /// nextest's reason comes later, in its output).
    pub message: String,
}

/// The most failing tests one report carries. A run that fails more than
/// this is one whose tally is the news, not its fortieth red.
pub const FAILED_KEPT: usize = 32;

impl Progress {
    fn note_failure(&mut self, name: &str, message: &str) {
        if self.failed.len() < FAILED_KEPT {
            self.failed.push(FailedTest {
                index: self.done,
                name: name.to_string(),
                message: message.to_string(),
            });
        }
    }
}

/// Where progress goes as it changes. The wrapper calls `observe` on every
/// change; a sink decides how often to act on it. Returns the session the
/// sink reached, once it reaches one.
pub trait ProgressSink: Send {
    fn observe(&mut self, progress: &Progress) -> Option<String>;

    /// The run is over: stop, and answer the session reached, if any.
    fn finish(&mut self) -> Option<String> {
        None
    }
}

/// A sink that goes nowhere.
pub struct NoSink;

impl ProgressSink for NoSink {
    fn observe(&mut self, _: &Progress) -> Option<String> {
        None
    }
}

/// How often the poster may post while no new failure has appeared.
const POST_EVERY: Duration = Duration::from_secs(1);

/// When a progress state may be posted: the first at once, a failure-count
/// rise at once, anything else no sooner than [`POST_EVERY`] after the last
/// post. Whatever state is latest when that time comes is the one posted, so
/// the states in between are dropped rather than queued.
#[derive(Debug, Default)]
struct Throttle {
    last_post: Option<Instant>,
    failures_posted: u64,
}

impl Throttle {
    fn due(&self, progress: &Progress, now: Instant) -> Instant {
        match self.last_post {
            None => now,
            Some(_) if progress.failures > self.failures_posted => now,
            Some(at) => (at + POST_EVERY).max(now),
        }
    }

    fn posted(&mut self, progress: &Progress, at: Instant) {
        self.last_post = Some(at);
        self.failures_posted = progress.failures;
    }
}

/// What the poster thread and the pump share.
#[derive(Default)]
struct PosterState {
    latest: Option<Progress>,
    stop: bool,
    session: Option<String>,
}

/// A sink that posts progress to the calling session's block from a thread
/// of its own, so a slow or hung instance never holds up the pump copying
/// the run's output. It keeps only the latest state and posts it on the
/// [`Throttle`]'s schedule; the first session a post reaches is the one the
/// run is recorded under.
struct Poster {
    shared: Arc<(Mutex<PosterState>, Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Poster {
    fn start(post: impl Fn(&Progress) -> Option<String> + Send + 'static) -> Self {
        let shared = Arc::new((Mutex::new(PosterState::default()), Condvar::new()));
        let theirs = shared.clone();
        let thread = std::thread::spawn(move || {
            let (lock, wake) = &*theirs;
            let mut throttle = Throttle::default();
            loop {
                // `last` once the run is over: the state still waiting, if
                // any, is posted at once — it is the one the block keeps.
                let (next, last) = {
                    let mut state = lock.lock();
                    loop {
                        if state.stop {
                            break (state.latest.take(), true);
                        }
                        let now = Instant::now();
                        match state.latest.as_ref().map(|p| throttle.due(p, now)) {
                            Some(due) if due <= now => break (state.latest.take(), false),
                            Some(due) => {
                                wake.wait_for(&mut state, due - now);
                            }
                            None => wake.wait(&mut state),
                        }
                    }
                };
                let Some(progress) = next else {
                    if last {
                        return;
                    }
                    continue;
                };
                let reached = post(&progress);
                throttle.posted(&progress, Instant::now());
                if let Some(id) = reached {
                    let mut state = lock.lock();
                    if state.session.is_none() {
                        state.session = Some(id);
                    }
                }
                if last {
                    return;
                }
            }
        });
        Poster {
            shared,
            thread: Some(thread),
        }
    }
}

impl ProgressSink for Poster {
    fn observe(&mut self, progress: &Progress) -> Option<String> {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock();
        state.latest = Some(progress.clone());
        wake.notify_one();
        state.session.clone()
    }

    fn finish(&mut self) -> Option<String> {
        {
            let (lock, wake) = &*self.shared;
            lock.lock().stop = true;
            wake.notify_one();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.shared.0.lock().session.clone()
    }
}

/// The report a progress state becomes.
fn report_of(progress: &Progress, label: &str, needles: &[String]) -> RunReport {
    let units: Vec<serde_json::Value> = progress
        .failed
        .iter()
        .map(|f| {
            let mut row = serde_json::json!({ "name": f.name, "status": "fail", "index": f.index });
            if !f.message.is_empty() {
                row["message"] = f.message.clone().into();
            }
            row
        })
        .collect();
    RunReport {
        label: Some(label.to_string()),
        text: progress.text.clone(),
        done: Some(progress.done),
        total: progress.total,
        failures: Some(progress.failures),
        unit: Some("test".to_string()),
        jobs: None,
        units: Some(serde_json::Value::Array(units)),
        needles: needles.to_vec(),
    }
}

/// A test-name pattern no test carries: bun loads and registers everything
/// under it and runs nothing.
const NO_TEST_NAME: &str = "tugtool-test-run-collects-no-test-has-this-name";

/// Whether a bun command already narrows by test name, so that no pass can
/// count what it will run without running it.
fn bun_filters_by_name(command: &[String]) -> bool {
    command.iter().take_while(|a| *a != "--").any(|a| {
        a == "-t"
            || a == "--only"
            || a.starts_with("--test-name-pattern")
            || (a.starts_with("-t") && !a.starts_with("--"))
    })
}

/// The test count in bun's answer to a pattern that matched nothing:
/// `… matched 0 tests. Searched 732 files (skipping 10998 tests) [2.47s]`.
fn parse_bun_collected(output: &str) -> Option<u64> {
    let tail = &output[output.find("(skipping ")? + "(skipping ".len()..];
    tail[..tail.find(' ')?].parse().ok()
}

/// How many tests a bun command will run, from bun itself: the command with
/// [`NO_TEST_NAME`] as its test-name pattern. `None` when the command filters
/// by name already, or bun did not answer in the shape it is read in.
fn collect_bun_total(command: &[String]) -> Option<u64> {
    if bun_filters_by_name(command) {
        return None;
    }
    let split = command
        .iter()
        .position(|a| a == "--")
        .unwrap_or(command.len());
    let out = Command::new(command.first()?)
        .args(&command[1..split])
        .args(["-t", NO_TEST_NAME])
        .args(&command[split..])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    parse_bun_collected(&strip_ansi(&String::from_utf8_lossy(&out.stderr)))
}

/// The sink a run reports through: a [`Poster`] when there is a calling
/// session to report to, and nothing at all otherwise.
fn sink_for(args: &RunArgs) -> Box<dyn ProgressSink> {
    if !have_calling_session() {
        return Box::new(NoSink);
    }
    let label = args.label.clone().unwrap_or_else(|| args.suite.clone());
    let needles = args.needles.clone();
    Box::new(Poster::start(move |progress| {
        post_run_progress(&report_of(progress, &label, &needles))
    }))
}

/// Strip ANSI CSI sequences (`ESC [ … letter`), so a runner that colours its
/// output under `FORCE_COLOR` still parses.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// bun
// ---------------------------------------------------------------------------

/// A stateful filter over bun's stderr under `--dots`.
///
/// bun prints one `.` per passing test, with no newline, on lines of their
/// own. Each `.` on a line that so far holds only dots is a provisional tick.
/// At the newline a dots-only line is swallowed — dots and newline both — and
/// its ticks stand. A dot run followed by anything else on the same line was
/// content (`./src/x.ts`, `...more`), so it is flushed verbatim and its ticks
/// are withdrawn. Chunk boundaries fall anywhere; the state carries across.
#[derive(Debug, Default)]
pub struct BunDots {
    pending: usize,
    /// Whether the current line holds only dots so far.
    mid_content: bool,
    ticks: u64,
}

impl BunDots {
    /// Filter one chunk, returning the bytes to forward.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(chunk.len());
        for &b in chunk {
            match b {
                b'.' if !self.mid_content => {
                    self.pending += 1;
                    self.ticks += 1;
                }
                b'\n' => {
                    if self.pending > 0 && !self.mid_content {
                        // A dots-only line: swallowed whole.
                        self.pending = 0;
                    } else {
                        out.push(b);
                    }
                    self.mid_content = false;
                }
                _ => {
                    if self.pending > 0 {
                        out.extend(std::iter::repeat_n(b'.', self.pending));
                        self.ticks -= self.pending as u64;
                        self.pending = 0;
                    }
                    self.mid_content = true;
                    out.push(b);
                }
            }
        }
        out
    }

    /// Passing tests counted so far, provisional ticks included — a green run
    /// is one long unterminated line of dots, and its count is live.
    pub fn ticks(&self) -> u64 {
        self.ticks
    }
}

/// Follows bun's stderr line by line: counts `(fail) ` lines, and pairs each
/// with the `error: ` line that preceded it — the one place bun says why,
/// since its junit `<failure>` carries no message.
#[derive(Debug, Default)]
pub struct BunFailures {
    last_error: Option<String>,
    /// `(full name, message)` per failure, in order. The full name is bun's
    /// describe path joined with ` > `.
    pub failed: Vec<(String, String)>,
}

impl BunFailures {
    /// Read one line (without its newline). Returns true when it was a
    /// failure.
    pub fn line(&mut self, raw: &str) -> bool {
        let line = strip_ansi(raw);
        let line = line.trim_end();
        if let Some(msg) = line.trim_start().strip_prefix("error: ") {
            self.last_error = Some(msg.trim().to_string());
            return false;
        }
        let Some(rest) = line.strip_prefix("(fail) ") else {
            return false;
        };
        // A timed line ends ` [0.26ms]`.
        let name = match rest.rfind(" [") {
            Some(idx) if rest.ends_with(']') => &rest[..idx],
            _ => rest,
        };
        let message = self.last_error.take().unwrap_or_default();
        self.failed.push((name.to_string(), message));
        true
    }

    /// Fill in each message-less junit failure from the stderr it was printed
    /// on, matching on the test's name as the tail of bun's full path. Each
    /// stderr failure is used once.
    pub fn merge_into(&self, doc: &mut JunitRun) {
        let mut used = vec![false; self.failed.len()];
        for f in doc.failures.iter_mut().filter(|f| f.message.is_empty()) {
            let found = self.failed.iter().enumerate().position(|(i, (full, _))| {
                !used[i] && (full == &f.name || full.ends_with(&format!(" > {}", f.name)))
            });
            if let Some(i) = found {
                used[i] = true;
                f.message = self.failed[i].1.clone();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// nextest
// ---------------------------------------------------------------------------

/// What one line of nextest's stderr said.
#[derive(Debug, Clone, PartialEq)]
pub enum NextestLine {
    /// `Starting N tests across M binaries`.
    Starting(u64),
    /// `PASS [ …] <binary> <test>` — swallowed from the output.
    Pass(String),
    /// `FAIL`, `SIGSEGV`, `SIGABRT`, `TIMEOUT`, `LEAK-FAIL` `[ …] <binary> <test>`.
    Fail(String),
    /// `Compiling <crate> v…`.
    Compiling(String),
    /// `Summary [ …]` — the status lines after it repeat the failures.
    Summary,
    Other,
}

const NEXTEST_FAIL_WORDS: &[&str] = &["FAIL", "SIGSEGV", "SIGABRT", "TIMEOUT", "LEAK-FAIL"];

/// Classify one line of nextest's stderr.
pub fn nextest_line(raw: &str) -> NextestLine {
    let line = strip_ansi(raw);
    let t = line.trim();
    if let Some(rest) = t.strip_prefix("Starting ") {
        let mut words = rest.split_whitespace();
        if let (Some(n), Some(unit), Some("across")) = (words.next(), words.next(), words.next())
            && (unit == "tests" || unit == "test")
            && let Ok(n) = n.parse()
        {
            return NextestLine::Starting(n);
        }
    }
    if let Some(rest) = t.strip_prefix("Compiling ") {
        return match rest.split_whitespace().next() {
            Some(name) => NextestLine::Compiling(name.to_string()),
            None => NextestLine::Other,
        };
    }
    if t.starts_with("Summary [") {
        return NextestLine::Summary;
    }
    let after_status = |word: &str| -> Option<String> {
        let rest = t.strip_prefix(word)?.trim_start();
        let rest = rest.strip_prefix('[')?;
        let (_, test) = rest.split_once("] ")?;
        Some(test.trim().to_string())
    };
    if let Some(test) = after_status("PASS") {
        return NextestLine::Pass(test);
    }
    for word in NEXTEST_FAIL_WORDS {
        if let Some(test) = after_status(word) {
            return NextestLine::Fail(test);
        }
    }
    NextestLine::Other
}

// ---------------------------------------------------------------------------
// cargo test
// ---------------------------------------------------------------------------

/// What one line of `cargo test`'s stdout said — libtest's reporter.
#[derive(Debug, Clone, PartialEq)]
pub enum CargoTestLine {
    /// `running N tests` — one per test binary, so the counts add up.
    Running(u64),
    /// `test <name> ... ok`.
    Pass(String),
    /// `test <name> ... FAILED`.
    Fail(String),
    /// Everything else, `ignored` and `test result:` lines included.
    Other,
}

/// Classify one line of `cargo test`'s stdout.
pub fn cargo_test_line(raw: &str) -> CargoTestLine {
    let line = strip_ansi(raw);
    let t = line.trim();
    if let Some(rest) = t.strip_prefix("running ") {
        let mut words = rest.split_whitespace();
        if let (Some(n), Some("test" | "tests"), None) = (words.next(), words.next(), words.next())
            && let Ok(n) = n.parse()
        {
            return CargoTestLine::Running(n);
        }
    }
    if let Some(rest) = t.strip_prefix("test ")
        && let Some((name, status)) = rest.rsplit_once(" ... ")
    {
        return match status.trim() {
            "ok" => CargoTestLine::Pass(name.to_string()),
            "FAILED" => CargoTestLine::Fail(name.to_string()),
            _ => CargoTestLine::Other,
        };
    }
    CargoTestLine::Other
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/// The argv to spawn: the command, with the runner's progress and record
/// flags inserted before any `--` that hands arguments on to the tests.
pub fn wrapped_argv(kind: RunKind, command: &[String], junit_tmp: Option<&Path>) -> Vec<String> {
    let split = command
        .iter()
        .position(|a| a == "--")
        .unwrap_or(command.len());
    let marks = asks_for_marks(kind, command);
    let extra: Vec<String> = match kind {
        RunKind::Bun => {
            let mut v = Vec::new();
            if marks {
                v.push("--dots".to_string());
            }
            v.push("--reporter=junit".to_string());
            if let Some(p) = junit_tmp {
                v.push(format!("--reporter-outfile={}", p.display()));
            }
            v
        }
        RunKind::Nextest if marks => vec!["--status-level".to_string(), "pass".to_string()],
        RunKind::Nextest => Vec::new(),
        // libtest already prints every test; nothing to ask for.
        RunKind::CargoTest => Vec::new(),
    };
    let mut argv = command[..split].to_vec();
    argv.extend(extra);
    argv.extend_from_slice(&command[split..]);
    argv
}

/// Whether the wrapper asks the runner for its one-mark-per-pass output —
/// bun's `--dots`, nextest's `--status-level pass` — which it then counts
/// and swallows. A command that already names that flag asked for the
/// output itself, so the wrapper adds nothing and swallows nothing: what
/// the command prints is what the bare command would have printed. Read
/// before any `--`, past which the arguments are the tests' own.
pub fn asks_for_marks(kind: RunKind, command: &[String]) -> bool {
    let mut runner_args = command.iter().take_while(|a| *a != "--");
    match kind {
        RunKind::Bun => !runner_args.any(|a| a == "--dots"),
        RunKind::Nextest => !runner_args.any(|a| a.starts_with("--status-level")),
        RunKind::CargoTest => false,
    }
}

/// The followers a run's stderr feeds, and the progress they add up to.
struct Follow {
    kind: RunKind,
    /// Whether the per-pass marks are the wrapper's to swallow — true when
    /// it asked for them ([`asks_for_marks`]), false when the command did.
    swallow_marks: bool,
    dots: BunDots,
    bun: BunFailures,
    line: Vec<u8>,
    nextest_summary: bool,
    progress: Progress,
}

impl Follow {
    fn new(kind: RunKind) -> Self {
        Follow {
            kind,
            swallow_marks: true,
            dots: BunDots::default(),
            bun: BunFailures::default(),
            line: Vec::new(),
            nextest_summary: false,
            progress: Progress {
                text: "running".into(),
                ..Progress::default()
            },
        }
    }

    /// Take one stderr chunk, returning what to forward.
    fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        match self.kind {
            RunKind::Bun => {
                // bun's pass-through is the dots filter's; the lines it
                // forwards only feed the counts.
                let filtered = self.dots.feed(chunk);
                self.lines(&filtered);
                self.progress.done = self.dots.ticks() + self.progress.failures;
                if self.swallow_marks {
                    filtered
                } else {
                    chunk.to_vec()
                }
            }
            RunKind::Nextest => self.lines(chunk),
            // cargo's stderr is the build; the tests are on stdout.
            RunKind::CargoTest => chunk.to_vec(),
        }
    }

    /// Take one stdout chunk, returning what to forward — which is all of
    /// it, always. Only `cargo test` reports on stdout, and it is read
    /// without being filtered.
    fn feed_stdout(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.kind == RunKind::CargoTest {
            self.lines(chunk);
        }
        chunk.to_vec()
    }

    /// The run as a record, from the stream alone — for a runner that wrote
    /// no junit document. A nextest test's name is `<binary> <path>`, and
    /// the binary is the record's file.
    fn tally(&self) -> JunitRun {
        let failures = self
            .progress
            .failed
            .iter()
            .map(|f| {
                let (file, name) = match self.kind {
                    RunKind::Nextest => f
                        .name
                        .split_once(' ')
                        .map(|(b, t)| (b.to_string(), t.to_string()))
                        .unwrap_or_else(|| (String::new(), f.name.clone())),
                    _ => (String::new(), f.name.clone()),
                };
                JunitFailure {
                    file,
                    name,
                    classname: String::new(),
                    message: f.message.clone(),
                    detail: String::new(),
                }
            })
            .collect();
        JunitRun {
            tests: self.progress.done as i64,
            failed: self.progress.failures as i64,
            skipped: 0,
            files: Vec::new(),
            failures,
        }
    }

    /// Split bytes into whole lines and read each; returns the lines to
    /// forward.
    fn lines(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len());
        for &b in bytes {
            self.line.push(b);
            if b == b'\n' {
                let line = std::mem::take(&mut self.line);
                if self.take_line(&line) {
                    out.extend_from_slice(&line);
                }
            }
        }
        out
    }

    /// Flush a final unterminated line.
    fn finish(&mut self) -> Vec<u8> {
        let line = std::mem::take(&mut self.line);
        if !line.is_empty() && self.take_line(&line) && self.kind == RunKind::Nextest {
            return line;
        }
        Vec::new()
    }

    /// Read one whole line; returns whether nextest's line is forwarded.
    fn take_line(&mut self, bytes: &[u8]) -> bool {
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim_end_matches(['\n', '\r']);
        match self.kind {
            RunKind::Bun => {
                if self.bun.line(text) {
                    self.progress.failures += 1;
                    if let Some((name, message)) = self.bun.failed.last().cloned() {
                        self.progress.done = self.dots.ticks() + self.progress.failures;
                        self.progress.note_failure(&name, &message);
                        self.progress.text = name;
                    }
                }
                true
            }
            RunKind::Nextest => {
                if self.nextest_summary {
                    return true;
                }
                match nextest_line(text) {
                    NextestLine::Starting(n) => self.progress.total = Some(n),
                    NextestLine::Compiling(name) => {
                        self.progress.text = format!("compiling {name}")
                    }
                    NextestLine::Pass(test) => {
                        self.progress.done += 1;
                        self.progress.text = test;
                        return !self.swallow_marks;
                    }
                    NextestLine::Fail(test) => {
                        self.progress.done += 1;
                        self.progress.failures += 1;
                        self.progress.note_failure(&test, "");
                        self.progress.text = test;
                    }
                    NextestLine::Summary => self.nextest_summary = true,
                    NextestLine::Other => {}
                }
                true
            }
            RunKind::CargoTest => {
                match cargo_test_line(text) {
                    CargoTestLine::Running(n) => {
                        self.progress.total = Some(self.progress.total.unwrap_or(0) + n)
                    }
                    CargoTestLine::Pass(test) => {
                        self.progress.done += 1;
                        self.progress.text = test;
                    }
                    CargoTestLine::Fail(test) => {
                        self.progress.done += 1;
                        self.progress.failures += 1;
                        self.progress.note_failure(&test, "");
                        self.progress.text = test;
                    }
                    CargoTestLine::Other => {}
                }
                true
            }
        }
    }
}

/// Everything `test run` was asked.
pub struct RunArgs {
    pub suite: String,
    pub kind: RunKind,
    pub junit: Option<PathBuf>,
    pub label: Option<String>,
    pub needles: Vec<String>,
    pub command: Vec<String>,
}

/// A fresh path for bun's junit document, removed after recording.
fn junit_tmp_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "tugtool-test-run-{}-{nanos}.xml",
        std::process::id()
    ))
}

/// Copy a child stream to `dest`, chunk by chunk, through `filter`.
fn pump<R: Read>(mut src: R, mut filter: impl FnMut(&[u8]) -> Vec<u8>, to_stderr: bool) {
    let mut buf = [0u8; 8192];
    loop {
        let n = match src.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let bytes = filter(&buf[..n]);
        if bytes.is_empty() {
            continue;
        }
        if to_stderr {
            let mut e = std::io::stderr().lock();
            let _ = e.write_all(&bytes);
            let _ = e.flush();
        } else {
            let mut o = std::io::stdout().lock();
            let _ = o.write_all(&bytes);
            let _ = o.flush();
        }
    }
}

/// `tugtool test run`.
pub fn run(args: RunArgs) -> Result<(), AppError> {
    let Some(program) = args.command.first() else {
        return Err(AppError::Exit2(
            "unresolved",
            "test run names the command to run after `--`".into(),
        ));
    };
    // The document the run is recorded from, when there is one: the path
    // named, or a temporary one bun is pointed at. A nextest or cargo run
    // with no path is recorded from the follower's tally instead.
    let junit_path = match (args.kind, &args.junit) {
        (_, Some(p)) => Some(p.clone()),
        (RunKind::Bun, None) => Some(junit_tmp_path()),
        (RunKind::Nextest | RunKind::CargoTest, None) => None,
    };
    let remove_junit = args.kind == RunKind::Bun && args.junit.is_none();
    let argv = wrapped_argv(
        args.kind,
        &args.command,
        junit_path.as_deref().filter(|_| args.kind == RunKind::Bun),
    );
    let sink = Arc::new(Mutex::new(sink_for(&args)));
    // The count is for the block's report; with no block to report to, the
    // run is not made to wait on it.
    let collected = match args.kind {
        RunKind::Bun if have_calling_session() => collect_bun_total(&args.command),
        _ => None,
    };

    let started_at = now_epoch();
    let started_wall = SystemTime::now();
    let clock = Instant::now();
    let mut child = match Command::new(program)
        .args(&argv[1..])
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(err) => {
            eprintln!("[test] cannot run {program}: {err}");
            return Err(AppError::ExitStatus(127));
        }
    };

    let follow = Arc::new(Mutex::new(Follow {
        swallow_marks: asks_for_marks(args.kind, &args.command),
        ..Follow::new(args.kind)
    }));
    follow.lock().progress.total = collected;
    let session: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let stdout = child.stdout.take().expect("stdout is piped");
    let (f, s, sess) = (follow.clone(), sink.clone(), session.clone());
    let out_thread = std::thread::spawn(move || {
        pump(
            stdout,
            |chunk| {
                let mut follow = f.lock();
                let before = follow.progress.clone();
                let out = follow.feed_stdout(chunk);
                if follow.progress != before {
                    observe(&s, &sess, &follow.progress);
                }
                out
            },
            false,
        )
    });

    let stderr = child.stderr.take().expect("stderr is piped");
    let (f, s, sess) = (follow.clone(), sink.clone(), session.clone());
    let err_thread = std::thread::spawn(move || {
        pump(
            stderr,
            |chunk| {
                let mut follow = f.lock();
                let before = follow.progress.clone();
                let out = follow.feed(chunk);
                if follow.progress != before {
                    observe(&s, &sess, &follow.progress);
                }
                out
            },
            true,
        )
    });

    let status = child.wait();
    let _ = out_thread.join();
    let _ = err_thread.join();
    // Both streams are closed, so a final unterminated line is whole.
    {
        let mut follow = follow.lock();
        let tail = follow.finish();
        if !tail.is_empty() {
            let _ = std::io::stderr().lock().write_all(&tail);
        }
    }
    let code = match status {
        Ok(st) => exit_code_of(st),
        Err(err) => {
            eprintln!("[test] lost the command: {err}");
            1
        }
    };

    // Record. Telemetry-grade: a failure here is one stderr line and changes
    // nothing about the run's own status.
    let follow = follow.lock();
    let mut doc = match &junit_path {
        Some(junit_path) => {
            let fresh = std::fs::metadata(junit_path)
                .and_then(|m| m.modified())
                .is_ok_and(|m| m >= started_wall);
            if fresh {
                match read_junit(junit_path) {
                    Ok(d) => Some(d),
                    Err(why) => {
                        eprintln!("[test] no per-test record: {why}");
                        None
                    }
                }
            } else {
                eprintln!(
                    "[test] no per-test record: {} was not written",
                    junit_path.display()
                );
                None
            }
        }
        None => Some(follow.tally()),
    };
    if let Some(d) = doc.as_mut()
        && args.kind == RunKind::Bun
    {
        follow.bun.merge_into(d);
    }
    // The block's last report carries the record's counts, so the panel a
    // finished run leaves says what the record says.
    if let Some(d) = doc.as_ref() {
        observe(&sink, &session, &final_progress(&follow.progress, d));
    }
    if let Some(id) = sink.lock().finish() {
        session.lock().get_or_insert(id);
    }
    if remove_junit && let Some(junit_path) = &junit_path {
        let _ = std::fs::remove_file(junit_path);
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let run_root = test_ledger::run_root_for(&cwd);
    let (branch, head_sha, dirty) = git_facts(&run_root);
    let run = TestRun {
        started_at,
        ended_at: now_epoch(),
        run_root: run_root.to_string_lossy().into_owned(),
        branch,
        head_sha,
        dirty,
        suite: args.suite.clone(),
        session_id: session.lock().clone(),
        command: args.command.join(" "),
        exit_code: i64::from(code),
        wall_secs: clock.elapsed().as_secs_f64(),
    };
    if let Err(why) = record(&run, doc.as_ref()) {
        eprintln!("[test] not recorded: {why}");
    }
    let failed = doc
        .as_ref()
        .map(|d| d.failed as u64)
        .unwrap_or(follow.progress.failures);
    if failed > 0 {
        eprintln!(
            "[test] {}: {failed} failed — tugtool test last --failures names them",
            args.suite
        );
    }
    match code {
        0 => Ok(()),
        c => Err(AppError::ExitStatus(c)),
    }
}

/// A run's last progress state: what the follower saw, with the counts its
/// record holds.
fn final_progress(seen: &Progress, record: &JunitRun) -> Progress {
    let tests = u64::try_from(record.tests).unwrap_or(0);
    Progress {
        done: tests,
        total: Some(tests),
        failures: u64::try_from(record.failed).unwrap_or(0),
        ..seen.clone()
    }
}

fn observe(
    sink: &Arc<Mutex<Box<dyn ProgressSink>>>,
    session: &Arc<Mutex<Option<String>>>,
    progress: &Progress,
) {
    if let Some(id) = sink.lock().observe(progress) {
        let mut s = session.lock();
        if s.is_none() {
            *s = Some(id);
        }
    }
}

/// The child's status as an exit code: its own, or 128 + the signal that
/// ended it, the shell's convention.
fn exit_code_of(status: std::process::ExitStatus) -> u8 {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(c), _) => c.clamp(0, 255) as u8,
        (None, Some(sig)) => (128 + sig).clamp(0, 255) as u8,
        (None, None) => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// bun 1.3.9's stderr under `--dots`, captured from a two-file run with
    /// one pass and one failure in each.
    const BUN_DOTS_STDERR: &str = ".\n\nb.test.ts:\n1 | import { test, expect } from \"bun:test\";\n3 | test(\"throws\", () => { throw new Error(\"boom\"); });\n                                                 ^\nerror: boom\n      at <anonymous> (/tmp/b.test.ts:3:46)\n(fail) throws\n.\n\na.test.ts:\nerror: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1\n\n(fail) parser > bad two\n\n\n2 pass\n2 fail\n3 expect() calls\nRan 4 tests across 2 files. [10.00ms]\n";

    /// cargo-nextest's stderr under `--status-level pass`, as a non-TTY run
    /// writes it: three binaries, twelve tests, one failure, and the summary
    /// that repeats the failure.
    const NEXTEST_STDERR: &str = "   Compiling tugcast v0.1.0 (/x/tugcast)\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.27s\n────────────\n Nextest run ID cbfc32fd with nextest profile: default\n    Starting 12 tests across 3 binaries\n        PASS [   0.004s] tugcore a::one\n        PASS [   0.004s] tugcore a::two\n        PASS [   0.004s] tugcore a::three\n        PASS [   0.004s] tugcore a::four\n        FAIL [   0.007s] tugcore tests::bad\n  stderr ───\n    thread 'tests::bad' panicked at src/lib.rs:5:24:\n        PASS [   0.004s] tugtool b::one\n        PASS [   0.004s] tugtool b::two\n        PASS [   0.004s] tugtool b::three\n        PASS [   0.004s] tugtool b::four\n        PASS [   0.004s] tugcast c::one\n        PASS [   0.004s] tugcast c::two\n        PASS [   0.004s] tugcast c::three\n────────────\n     Summary [   0.009s] 12 tests run: 11 passed, 1 failed, 0 skipped\n        FAIL [   0.007s] tugcore tests::bad\nerror: test run failed\n";

    fn feed_all(dots: &mut BunDots, chunks: &[&str]) -> String {
        let mut out = Vec::new();
        for c in chunks {
            out.extend(dots.feed(c.as_bytes()));
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn a_dots_line_is_swallowed_and_counted() {
        let mut dots = BunDots::default();
        let out = feed_all(&mut dots, &["...", "\n\na.test.ts:\n"]);
        assert_eq!(out, "\na.test.ts:\n");
        assert_eq!(dots.ticks(), 3);
    }

    #[test]
    fn a_path_that_starts_with_a_dot_is_content() {
        let mut dots = BunDots::default();
        assert_eq!(feed_all(&mut dots, &["./src/x.ts\n"]), "./src/x.ts\n");
        assert_eq!(dots.ticks(), 0);
    }

    #[test]
    fn a_dot_run_split_across_chunks_is_one_run() {
        let mut dots = BunDots::default();
        assert_eq!(feed_all(&mut dots, &["..", "..", ".\n", "x\n"]), "x\n");
        assert_eq!(dots.ticks(), 5);
        let mut dots = BunDots::default();
        assert_eq!(feed_all(&mut dots, &["..", ".more\n"]), "...more\n");
        assert_eq!(dots.ticks(), 0, "the ticks are withdrawn");
    }

    #[test]
    fn dots_followed_by_content_on_one_line_are_forwarded() {
        let mut dots = BunDots::default();
        assert_eq!(feed_all(&mut dots, &["...more\n"]), "...more\n");
        assert_eq!(dots.ticks(), 0);
    }

    #[test]
    fn a_green_run_counts_live_before_any_newline() {
        let mut dots = BunDots::default();
        assert_eq!(feed_all(&mut dots, &["...."]), "");
        assert_eq!(dots.ticks(), 4);
    }

    #[test]
    fn the_real_bun_stderr_loses_only_its_dots() {
        let mut follow = Follow::new(RunKind::Bun);
        let out = String::from_utf8(follow.feed(BUN_DOTS_STDERR.as_bytes())).unwrap();
        assert!(
            !out.lines()
                .any(|l| !l.is_empty() && l.chars().all(|c| c == '.'))
        );
        assert!(out.contains("(fail) parser > bad two\n"));
        assert!(out.starts_with("\nb.test.ts:\n"));
        assert_eq!(follow.progress.failures, 2);
        assert_eq!(follow.progress.done, 4, "two dots and two failures");
        assert_eq!(follow.progress.text, "parser > bad two");
        assert_eq!(
            follow.bun.failed,
            vec![
                ("throws".to_string(), "boom".to_string()),
                (
                    "parser > bad two".to_string(),
                    "expect(received).toBe(expected)".to_string()
                ),
            ]
        );
    }

    #[test]
    fn a_timed_fail_line_drops_its_time() {
        let mut f = BunFailures::default();
        f.line("error: nope");
        assert!(f.line("(fail) a > b [0.26ms]"));
        assert_eq!(f.failed[0], ("a > b".to_string(), "nope".to_string()));
    }

    #[test]
    fn stderr_messages_fill_the_junit_failures_bun_left_bare() {
        let mut follow = Follow::new(RunKind::Bun);
        follow.feed(BUN_DOTS_STDERR.as_bytes());
        let mut doc = test_ledger::parse_junit(
            r#"<testsuites>
                 <testsuite name="b.test.ts" file="b.test.ts">
                   <testcase name="throws" classname="" file="b.test.ts"><failure type="AssertionError" /></testcase>
                 </testsuite>
                 <testsuite name="a.test.ts" file="a.test.ts">
                   <testsuite name="parser" file="a.test.ts">
                     <testcase name="bad two" classname="parser" file="a.test.ts"><failure type="AssertionError" /></testcase>
                   </testsuite>
                 </testsuite>
               </testsuites>"#,
        )
        .unwrap();
        follow.bun.merge_into(&mut doc);
        assert_eq!(doc.failures[0].message, "boom");
        assert_eq!(doc.failures[1].message, "expect(received).toBe(expected)");
    }

    #[test]
    fn nextest_lines_give_total_passes_failure_and_crate() {
        let mut follow = Follow::new(RunKind::Nextest);
        let mut seen_compiling = None;
        let mut out = Vec::new();
        for line in NEXTEST_STDERR.split_inclusive('\n') {
            out.extend(follow.feed(line.as_bytes()));
            if seen_compiling.is_none() && follow.progress.text.starts_with("compiling") {
                seen_compiling = Some(follow.progress.text.clone());
            }
        }
        assert_eq!(seen_compiling.as_deref(), Some("compiling tugcast"));
        assert_eq!(follow.progress.total, Some(12));
        assert_eq!(follow.progress.done, 12, "11 passes and 1 failure");
        assert_eq!(
            follow.progress.failures, 1,
            "the summary's repeat is not a second failure"
        );
        let out = String::from_utf8(out).unwrap();
        assert!(!out.contains("PASS ["), "pass lines are swallowed");
        assert_eq!(out.matches("FAIL [").count(), 2, "both FAIL lines stay");
        assert!(out.contains("Summary ["));
    }

    #[test]
    fn nextest_line_classification() {
        assert_eq!(
            nextest_line("    Starting 1 test across 1 binary"),
            NextestLine::Starting(1)
        );
        assert_eq!(
            nextest_line("     SIGSEGV [   0.1s] bin crash::it"),
            NextestLine::Fail("bin crash::it".into())
        );
        assert_eq!(
            nextest_line("   Compiling tugcast v0.1.0 (/x)"),
            NextestLine::Compiling("tugcast".into())
        );
        assert_eq!(
            nextest_line("\u{1b}[32m        PASS\u{1b}[0m [   0.004s] bin a::b"),
            NextestLine::Pass("bin a::b".into())
        );
        assert_eq!(nextest_line("PASSWORD [x] y"), NextestLine::Other);
    }

    #[test]
    fn flags_go_before_the_test_arguments() {
        let cmd: Vec<String> = ["bun", "test", "--", "-t", "x"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            wrapped_argv(RunKind::Bun, &cmd, Some(Path::new("/tmp/j.xml"))),
            vec![
                "bun",
                "test",
                "--dots",
                "--reporter=junit",
                "--reporter-outfile=/tmp/j.xml",
                "--",
                "-t",
                "x"
            ]
        );
        let cmd: Vec<String> = ["cargo", "nextest", "run"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            wrapped_argv(RunKind::Nextest, &cmd, None),
            vec!["cargo", "nextest", "run", "--status-level", "pass"]
        );
    }

    #[test]
    fn marks_the_command_asked_for_itself_are_forwarded_not_swallowed() {
        let argv =
            |words: &[&str]| -> Vec<String> { words.iter().map(|s| s.to_string()).collect() };
        let cmd = argv(&["cargo", "nextest", "run", "--status-level", "all"]);
        assert!(!asks_for_marks(RunKind::Nextest, &cmd));
        assert_eq!(wrapped_argv(RunKind::Nextest, &cmd, None), cmd);
        let mut follow = Follow {
            swallow_marks: false,
            ..Follow::new(RunKind::Nextest)
        };
        let mut out = Vec::new();
        for line in NEXTEST_STDERR.split_inclusive('\n') {
            out.extend(follow.feed(line.as_bytes()));
        }
        assert_eq!(out, NEXTEST_STDERR.as_bytes(), "nothing is swallowed");
        assert_eq!(follow.progress.done, 12, "and every pass is still counted");

        let cmd = argv(&["bun", "test", "--dots"]);
        assert!(!asks_for_marks(RunKind::Bun, &cmd));
        assert_eq!(
            wrapped_argv(RunKind::Bun, &cmd, None),
            argv(&["bun", "test", "--dots", "--reporter=junit"])
        );
        let mut follow = Follow {
            swallow_marks: false,
            ..Follow::new(RunKind::Bun)
        };
        assert_eq!(follow.feed(b"....\n"), b"....\n".to_vec());
        assert_eq!(follow.progress.done, 4);

        // A `--status-level` past the `--` is a test's argument, not nextest's.
        assert!(asks_for_marks(
            RunKind::Nextest,
            &argv(&["cargo", "nextest", "run", "--", "--status-level"])
        ));
    }

    fn state(done: u64, failures: u64) -> Progress {
        Progress {
            done,
            total: None,
            failures,
            text: format!("t{done}"),
            failed: Vec::new(),
        }
    }

    #[test]
    fn the_throttle_holds_a_state_a_second_and_lets_a_failure_through_at_once() {
        let t0 = Instant::now();
        let mut throttle = Throttle::default();
        assert_eq!(
            throttle.due(&state(1, 0), t0),
            t0,
            "the first posts at once"
        );
        throttle.posted(&state(1, 0), t0);

        let soon = t0 + Duration::from_millis(200);
        assert_eq!(throttle.due(&state(2, 0), soon), t0 + POST_EVERY);
        assert_eq!(
            throttle.due(&state(3, 1), soon),
            soon,
            "0 → 1 failures posts at once"
        );
        throttle.posted(&state(3, 1), soon);
        assert_eq!(
            throttle.due(&state(4, 1), soon),
            soon + POST_EVERY,
            "a failure already posted is no rise"
        );
    }

    /// The poster keeps one state, not a queue: what was superseded inside
    /// the second is never posted, and a failure goes out without waiting.
    #[test]
    fn the_poster_drops_intermediate_states_and_posts_a_failure_at_once() {
        let posts: Arc<Mutex<Vec<Progress>>> = Arc::default();
        let seen = posts.clone();
        let mut poster = Poster::start(move |p| {
            seen.lock().push(p.clone());
            Some("seg-1".to_string())
        });
        let wait_for = |n: usize| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while posts.lock().len() < n {
                assert!(Instant::now() < deadline, "the poster never posted {n}");
                std::thread::sleep(Duration::from_millis(5));
            }
        };

        poster.observe(&state(1, 0));
        wait_for(1);
        poster.observe(&state(2, 0));
        poster.observe(&state(3, 0));
        let before = Instant::now();
        poster.observe(&state(4, 1));
        wait_for(2);
        assert!(
            before.elapsed() < POST_EVERY,
            "the failure did not wait out the second"
        );
        assert_eq!(poster.finish(), Some("seg-1".to_string()));
        assert_eq!(*posts.lock(), vec![state(1, 0), state(4, 1)]);
    }

    #[test]
    fn a_report_carries_the_runners_total_and_never_one_of_its_own() {
        let needles = vec!["just test".to_string()];
        let counted = Progress {
            total: Some(10998),
            ..state(120, 2)
        };
        let bun = report_of(&counted, "bun test · tugdeck", &needles);
        assert_eq!(bun.text, "t120");
        assert_eq!(
            (bun.done, bun.total, bun.failures),
            (Some(120), Some(10998), Some(2))
        );
        assert_eq!(bun.needles, needles);

        // No count from the runner: no total, whatever the history says.
        let filtered = report_of(&state(5, 0), "bun test · tugdeck", &needles);
        assert_eq!((filtered.done, filtered.total), (Some(5), None));
    }

    #[test]
    fn bun_says_how_many_tests_it_collected_when_none_matched() {
        let stderr = "bun test v1.3.9 (cf6cdbbb)\n\nerror: regex \"x\" matched 0 tests. Searched 732 files (skipping 10998 tests) [2.47s]\n";
        assert_eq!(parse_bun_collected(stderr), Some(10998));
        assert_eq!(parse_bun_collected("Ran 4 tests across 2 files."), None);
    }

    #[test]
    fn a_command_that_filters_by_test_name_has_no_count_to_ask_for() {
        let argv =
            |words: &[&str]| -> Vec<String> { words.iter().map(|s| s.to_string()).collect() };
        assert!(!bun_filters_by_name(&argv(&["bun", "test", "src/lib"])));
        assert!(bun_filters_by_name(&argv(&["bun", "test", "-t", "drag"])));
        assert!(bun_filters_by_name(&argv(&["bun", "test", "--test-name-pattern=drag"])));
        assert!(bun_filters_by_name(&argv(&["bun", "test", "--only"])));
        assert!(!bun_filters_by_name(&argv(&["bun", "test", "--", "-t"])));
    }

    #[test]
    fn the_last_report_carries_the_records_counts() {
        let seen = Progress {
            total: Some(10998),
            ..state(10990, 1)
        };
        let record = JunitRun {
            tests: 10998,
            failed: 2,
            ..JunitRun::default()
        };
        let last = final_progress(&seen, &record);
        assert_eq!(
            (last.done, last.total, last.failures),
            (10998, Some(10998), 2)
        );
        assert_eq!(last.text, seen.text);
    }

    #[test]
    fn a_report_names_its_unit_and_carries_each_failure_as_a_row() {
        let mut follow = Follow::new(RunKind::Nextest);
        for line in [
            "    Starting 3 tests across 1 binary\n",
            "        PASS [   0.010s] tugcast feeds::a\n",
            "        FAIL [   0.020s] tugcast feeds::jots::reopen_keeps_chips\n",
            "        PASS [   0.010s] tugcast feeds::c\n",
        ] {
            follow.feed(line.as_bytes());
        }
        let report = report_of(&follow.progress, "rust", &[]);
        assert_eq!(report.unit.as_deref(), Some("test"));
        assert_eq!(
            report.units,
            Some(serde_json::json!([
                {"name": "tugcast feeds::jots::reopen_keeps_chips", "status": "fail", "index": 2}
            ])),
            "the row sits where the run was when it failed"
        );
    }

    #[test]
    fn a_bun_failure_row_carries_the_message_bun_printed_with_it() {
        let mut follow = Follow::new(RunKind::Bun);
        follow.feed(b"..\nerror: expected 2, got 1\n(fail) jots > keeps chips [0.26ms]\n");
        assert_eq!(
            follow.progress.failed,
            vec![FailedTest {
                index: 3,
                name: "jots > keeps chips".into(),
                message: "expected 2, got 1".into(),
            }]
        );
    }

    /// `cargo test`'s stdout, as libtest writes it for two binaries: three
    /// tests, one failure, one ignored, and a doc-test binary with none.
    const CARGO_TEST_STDOUT: &str = "\nrunning 3 tests\ntest a::one ... ok\ntest a::two ... FAILED\ntest a::three ... ignored\n\nfailures:\n\n---- a::two stdout ----\nthread 'a::two' panicked at src/lib.rs:5:9:\nboom\n\nfailures:\n    a::two\n\ntest result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n\nrunning 1 test\ntest b::one ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n   Doc-tests x\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";

    #[test]
    fn cargo_test_stdout_is_followed_whole_and_forwarded_whole() {
        let mut follow = Follow::new(RunKind::CargoTest);
        let mut out = Vec::new();
        for chunk in CARGO_TEST_STDOUT.as_bytes().chunks(17) {
            out.extend(follow.feed_stdout(chunk));
        }
        assert_eq!(out, CARGO_TEST_STDOUT.as_bytes(), "nothing is swallowed");
        assert_eq!(
            follow.progress.total,
            Some(4),
            "the binaries' counts add up"
        );
        assert_eq!(
            follow.progress.done, 3,
            "ignored is neither a pass nor a fail"
        );
        assert_eq!(follow.progress.failures, 1);
        assert_eq!(follow.progress.failed[0].name, "a::two");
        // Its stderr is the build, and passes through untouched.
        assert_eq!(
            follow.feed(b"   Compiling x v0.1.0\n"),
            b"   Compiling x v0.1.0\n".to_vec()
        );
    }

    #[test]
    fn cargo_test_line_classification() {
        assert_eq!(
            cargo_test_line("running 12 tests"),
            CargoTestLine::Running(12)
        );
        assert_eq!(cargo_test_line("running 1 test"), CargoTestLine::Running(1));
        assert_eq!(
            cargo_test_line("test parser::reads_a_dash - should panic ... ok"),
            CargoTestLine::Pass("parser::reads_a_dash - should panic".into())
        );
        assert_eq!(
            cargo_test_line("test src/lib.rs - run (line 3) ... FAILED"),
            CargoTestLine::Fail("src/lib.rs - run (line 3)".into())
        );
        assert_eq!(cargo_test_line("test a ... ignored"), CargoTestLine::Other);
        assert_eq!(
            cargo_test_line("test result: FAILED. 1 passed; 1 failed"),
            CargoTestLine::Other
        );
    }

    #[test]
    fn a_run_with_no_junit_is_recorded_from_the_tally() {
        let mut follow = Follow::new(RunKind::Nextest);
        for line in NEXTEST_STDERR.split_inclusive('\n') {
            follow.feed(line.as_bytes());
        }
        let doc = follow.tally();
        assert_eq!((doc.tests, doc.failed, doc.skipped), (12, 1, 0));
        assert_eq!(doc.failures.len(), 1);
        assert_eq!(
            doc.failures[0].file, "tugcore",
            "nextest's binary is the file"
        );
        assert_eq!(doc.failures[0].name, "tests::bad");

        let mut follow = Follow::new(RunKind::CargoTest);
        follow.feed_stdout(CARGO_TEST_STDOUT.as_bytes());
        let doc = follow.tally();
        assert_eq!((doc.tests, doc.failed), (3, 1));
        assert_eq!(doc.failures[0].name, "a::two");
        assert_eq!(
            doc.failures[0].file, "",
            "libtest names no binary on the line"
        );
    }

    #[test]
    fn failures_past_the_cap_are_counted_but_not_carried() {
        let mut follow = Follow::new(RunKind::Nextest);
        for i in 0..(FAILED_KEPT + 5) {
            follow.feed(format!("        FAIL [   0.020s] bin t{i}\n").as_bytes());
        }
        assert_eq!(follow.progress.failures, (FAILED_KEPT + 5) as u64);
        assert_eq!(follow.progress.failed.len(), FAILED_KEPT);
    }
}
