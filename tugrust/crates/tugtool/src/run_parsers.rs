//! The readers `tugtool test run` follows a runner through when it has no
//! parser of its own: TAP, which a long tail of runners can print; a line
//! rule — a regex per item — for anything that prints one line per test,
//! which is what the named kinds (`pytest`, `jest`, `vitest`, `mocha`,
//! `swift`, `ctest`) are made of; and `go test`'s JSON events.
//!
//! Each is a pure function over one line of output, so each is tested
//! against output captured from the real runner. A line a reader cannot
//! place is not an item: a short count is a better failure than a confident
//! wrong one.

use regex::Regex;

use crate::test_run::RunKind;

/// Which of the command's streams a line rule reads.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum Stream {
    Stdout,
    Stderr,
    #[default]
    Both,
}

impl Stream {
    pub fn reads_stdout(self) -> bool {
        matches!(self, Stream::Stdout | Stream::Both)
    }

    pub fn reads_stderr(self) -> bool {
        matches!(self, Stream::Stderr | Stream::Both)
    }
}

/// How one item landed, as a reader places it.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ItemStatus {
    Pass,
    Fail,
    Error,
    Skipped,
}

/// One item a reader found on a line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub name: String,
    pub status: ItemStatus,
    /// Why, when the line said so.
    pub message: String,
}

/// A runner's own count of the whole run, from its closing summary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    pub done: u64,
    pub failed: u64,
    pub skipped: u64,
}

/// What one line told a reader.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LineRead {
    pub item: Option<Item>,
    /// How many items the run will hold, when the line says so.
    pub total: Option<u64>,
    /// The run's own closing count, which replaces what was counted.
    pub tally: Option<Tally>,
    /// The line ends the part of the output items are read from.
    pub stop: bool,
    /// Something worth showing that is not an item.
    pub note: Option<String>,
}

/// A runner's own word for how an item landed, as the report panel's status —
/// `None` for a word outside the map, whose line is then not an item. The
/// words are what runners commonly print, so a rule written for an unknown
/// runner needs no map of its own.
pub fn status_word(word: &str) -> Option<ItemStatus> {
    let word = word.trim().to_lowercase();
    Some(match word.as_str() {
        "pass" | "passed" | "ok" | "✓" | "✔" | "success" | "succeeded" | "xfail" => {
            ItemStatus::Pass
        }
        "fail" | "failed" | "failure" | "✗" | "✘" | "×" | "not ok" | "xpass" | "***failed"
        | "***timeout" | "***exception" => ItemStatus::Fail,
        "error" | "err" | "errored" | "exception" => ItemStatus::Error,
        "skip" | "skipped" | "pending" | "ignored" | "todo" | "not run" | "***not run" | "↓" => {
            ItemStatus::Skipped
        }
        _ => return None,
    })
}

/// A refused rule, said the way the verb reports it.
pub type RuleError = String;

/// One shape of item line: a regex with a `name` group, and either a
/// `status` group read through [`status_word`] or a status of its own.
/// A pattern for a run with one item has a name of its own instead of a
/// group, and a `message` group, where there is one, is the item's why.
#[derive(Clone, Debug)]
pub struct ItemPattern {
    pub regex: Regex,
    pub status: Option<ItemStatus>,
    pub name: Option<&'static str>,
}

/// One item per matching line. A `total` group — on an item's own line or on
/// the `total` regex's — says how many the run will hold; a `stop` line ends
/// the part of the output items are read from, for a runner that repeats its
/// failures in a closing section; and a `summary` line carries the runner's
/// own closing count, which replaces what was counted. That last is for a
/// runner that prints an item line only for some items: jest and vitest,
/// seeing an AI agent in the environment, print a line for each failing file
/// and none for the passing ones, so their count grows with the reds and is
/// made exact at the end.
///
/// A `notes` line is not an item but says where the run is — a build's
/// phase, a count it printed — and its `note` group becomes the text.
#[derive(Clone, Debug)]
pub struct LineRule {
    pub items: Vec<ItemPattern>,
    pub total: Option<Regex>,
    pub stop: Option<Regex>,
    pub summary: Option<Regex>,
    pub notes: Vec<Regex>,
    pub stream: Stream,
}

fn compiled(flag: &str, pattern: &str, groups: &[&str]) -> Result<Regex, RuleError> {
    let regex = Regex::new(pattern).map_err(|e| format!("{flag} does not compile: {e}"))?;
    for group in groups {
        if !regex.capture_names().flatten().any(|n| n == *group) {
            return Err(format!("{flag} has no (?P<{group}>…) group"));
        }
    }
    Ok(regex)
}

/// A built-in rule's regex, which its tests prove compiles.
fn built(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a built-in rule compiles")
}

fn read_by(pattern: &str) -> ItemPattern {
    ItemPattern {
        regex: built(pattern),
        status: None,
        name: None,
    }
}

fn always(pattern: &str, status: ItemStatus) -> ItemPattern {
    ItemPattern {
        regex: built(pattern),
        status: Some(status),
        name: None,
    }
}

/// The one item of a run that has one, under a name of its own.
fn the_item(pattern: &str, status: ItemStatus, name: &'static str) -> ItemPattern {
    ItemPattern {
        regex: built(pattern),
        status: Some(status),
        name: Some(name),
    }
}

/// `3 failed, 1 passed, 4 total` or `1 failed | 1 passed (2)`: the counts a
/// runner's closing line gives, each a number before its word, and a total
/// either named or in parentheses.
fn tally_of(counts: &str) -> Option<Tally> {
    let pair = built(r"(\d+)\s+(failed|passed|skipped|pending|todo|total)\b");
    let mut tally = Tally::default();
    let mut sum = 0;
    let mut total = None;
    for caps in pair.captures_iter(counts) {
        let n: u64 = caps[1].parse().ok()?;
        match &caps[2] {
            "total" => total = Some(n),
            word => {
                sum += n;
                match word {
                    "failed" => tally.failed += n,
                    "skipped" | "pending" | "todo" => tally.skipped += n,
                    _ => {}
                }
            }
        }
    }
    if total.is_none() {
        total = built(r"\((\d+)\)")
            .captures(counts)
            .and_then(|c| c[1].parse().ok());
    }
    tally.done = total.unwrap_or(sum);
    (tally.done > 0 || sum > 0).then_some(tally)
}

impl LineRule {
    /// The rule `--item`, `--total` and `--stream` describe.
    pub fn new(item: &str, total: Option<&str>, stream: Stream) -> Result<Self, RuleError> {
        Ok(LineRule {
            items: vec![ItemPattern {
                regex: compiled("--item", item, &["name", "status"])?,
                status: None,
                name: None,
            }],
            total: total
                .map(|t| compiled("--total", t, &["total"]))
                .transpose()?,
            stop: None,
            summary: None,
            notes: Vec::new(),
            stream,
        })
    }

    /// Read one line, its newline already gone.
    pub fn read(&self, line: &str) -> LineRead {
        let mut read = LineRead::default();
        if self.stop.as_ref().is_some_and(|s| s.is_match(line)) {
            read.stop = true;
            return read;
        }
        if let Some(caps) = self.summary.as_ref().and_then(|s| s.captures(line)) {
            read.tally = caps.name("counts").and_then(|m| tally_of(m.as_str()));
            return read;
        }
        if let Some(caps) = self.total.as_ref().and_then(|t| t.captures(line)) {
            read.total = caps.name("total").and_then(|m| m.as_str().parse().ok());
        }
        if let Some(caps) = self.notes.iter().find_map(|n| n.captures(line)) {
            read.note = caps.name("note").map(|m| m.as_str().to_string());
            return read;
        }
        for pattern in &self.items {
            let Some(caps) = pattern.regex.captures(line) else {
                continue;
            };
            let status = pattern
                .status
                .or_else(|| caps.name("status").and_then(|m| status_word(m.as_str())));
            let name = pattern
                .name
                .map(str::to_string)
                .or_else(|| caps.name("name").map(|m| m.as_str().trim().to_string()));
            if let (Some(status), Some(name)) = (status, name) {
                read.item = Some(Item {
                    name,
                    status,
                    message: caps
                        .name("message")
                        .map(|m| m.as_str().trim().to_string())
                        .unwrap_or_default(),
                });
            }
            if read.total.is_none() {
                read.total = caps.name("total").and_then(|m| m.as_str().parse().ok());
            }
            break;
        }
        read
    }
}

/// The rule a named kind reads its runner with, each written against output
/// captured from the runner (`tests/fixtures/runner-output/`); `None` for a
/// kind that is not a line rule.
pub fn rule_for(kind: RunKind) -> Option<LineRule> {
    let rule = |items: Vec<ItemPattern>, stream| LineRule {
        items,
        total: None,
        stop: None,
        summary: None,
        notes: Vec::new(),
        stream,
    };
    Some(match kind {
        // `pytest -v`: `path::test PASSED   [ 25%]`; the count is on
        // `collecting ... collected 4 items`.
        RunKind::Pytest => LineRule {
            total: Some(built(r"collected (?P<total>\d+) items?")),
            ..rule(
                vec![read_by(
                    r"^(?P<name>\S+::\S+) (?P<status>PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b",
                )],
                Stream::Stdout,
            )
        },
        // One `PASS`/`FAIL <file>` line per file on stderr — for a failing
        // file only, under an agent — and `Test Suites: 1 failed, 1 passed,
        // 2 total` at the end.
        RunKind::Jest => LineRule {
            summary: Some(built(r"^Test Suites:(?P<counts>.*)$")),
            ..rule(
                vec![read_by(r"^(?P<status>PASS|FAIL) (?P<name>\S+)")],
                Stream::Stderr,
            )
        },
        // `✓ file (2 tests | 1 skipped)` and `❯ file (2 tests | 1 failed)`
        // per file — the failing ones only, under an agent — and
        // `Test Files  1 failed | 1 passed (2)` at the end.
        RunKind::Vitest => LineRule {
            summary: Some(built(r"^\s*Test Files\s+(?P<counts>.*)$")),
            ..rule(
                vec![
                    always(r"^\s*✓ (?P<name>\S+) \(\d+ tests?", ItemStatus::Pass),
                    always(r"^\s*❯ (?P<name>\S+) \(\d+ tests?", ItemStatus::Fail),
                    always(r"^\s*↓ (?P<name>\S+) \(\d+ tests?", ItemStatus::Skipped),
                ],
                Stream::Stdout,
            )
        },
        // The spec reporter: `✔ adds`, `1) subtracts wrong`, `- later`. Its
        // closing section repeats each failure as `1) <suite>`, so reading
        // stops at `N passing`.
        RunKind::Mocha => LineRule {
            stop: Some(built(r"^\s*\d+ passing\b")),
            ..rule(
                vec![
                    always(r"^\s*[✔✓] (?P<name>.+?)(?: \(\d+ms\))?$", ItemStatus::Pass),
                    always(r"^\s*\d+\) (?P<name>.+)$", ItemStatus::Fail),
                    always(r"^\s+- (?P<name>.+)$", ItemStatus::Skipped),
                ],
                Stream::Stdout,
            )
        },
        // XCTest's `Test Case '-[Mod.Class test]' passed (…)` and Swift
        // Testing's `<symbol>  Test name() passed after …`, both on stdout.
        RunKind::Swift => rule(
            vec![
                read_by(r"^Test Case '-\[(?P<name>[^\]]+)\]' (?P<status>passed|failed|skipped)"),
                read_by(r"^\S+\s+Test (?P<name>\S+) (?P<status>passed|failed|skipped)\b"),
            ],
            Stream::Both,
        ),
        // `3/4 Test #3: gamma ....***Failed  0.00 sec`, the total on every
        // line.
        RunKind::Ctest => rule(
            vec![read_by(
                r"^\s*\d+/(?P<total>\d+) Test\s+#\d+: (?P<name>\S+) \.+\s*(?P<status>Passed|\*\*\*Failed|\*\*\*Timeout|\*\*\*Exception|\*\*\*Not Run|Not Run)",
            )],
            Stream::Stdout,
        ),
        // `src/a.ts(1,14): error TS2322: …`, and under `--pretty`
        // `src/a.ts:1:14 - error TS2322: …`: one line per type error, the
        // error's text its message.
        RunKind::Tsc => rule(
            vec![
                read_by(r"^(?P<name>\S+\(\d+,\d+\)): (?P<status>error) TS\d+: (?P<message>.+)$"),
                read_by(r"^(?P<name>\S+:\d+:\d+) - (?P<status>error) TS\d+: (?P<message>.+)$"),
            ],
            Stream::Both,
        ),
        // `transforming...`, `✓ 4 modules transformed.`, `rendering
        // chunks...` as the phase; `✓ built in 70ms` or, on stderr,
        // `✗ Build failed in 25ms` as the build's one item.
        RunKind::Vite => LineRule {
            notes: vec![
                built(r"^(?P<note>transforming|rendering chunks|computing gzip size)\.\.\.$"),
                built(r"^✓ (?P<note>\d+ modules? transformed)\.$"),
            ],
            ..rule(
                vec![
                    the_item(r"^✓ built in \S+$", ItemStatus::Pass, "build"),
                    the_item(r"^✗ Build failed in \S+$", ItemStatus::Fail, "build"),
                ],
                Stream::Both,
            )
        },
        _ => return None,
    })
}

/// What a kind counts when the command says nothing: jest and vitest report
/// per file, a cargo build per crate, tsc per error, and vite its build.
pub fn default_unit(kind: RunKind) -> &'static str {
    match kind {
        RunKind::Jest | RunKind::Vitest => "file",
        RunKind::Cargo => "crate",
        RunKind::Tsc => "error",
        RunKind::Vite => "build",
        _ => "test",
    }
}

/// Follows TAP: the unindented `ok`/`not ok` lines are the items, and the
/// `1..N` plan line is the total wherever it appears. Indented lines —
/// subtests and the YAML blocks under a result — are not read, so a run's
/// count is its top-level tests, the ones its plan line counts.
#[derive(Debug, Default)]
pub struct TapReader;

impl TapReader {
    pub fn line(&self, line: &str) -> LineRead {
        let mut read = LineRead::default();
        if let Some(rest) = line.strip_prefix("1..") {
            read.total = rest.split_whitespace().next().and_then(|n| n.parse().ok());
            return read;
        }
        let (failed, rest) = if let Some(rest) = line.strip_prefix("not ok") {
            (true, rest)
        } else if let Some(rest) = line.strip_prefix("ok") {
            (false, rest)
        } else {
            return read;
        };
        // `ok` must be a word of its own: `okay` is not a result.
        if !(rest.is_empty() || rest.starts_with(' ')) {
            return read;
        }
        let (description, directive) = match rest.split_once(" # ") {
            Some((d, dir)) => (d, Some(dir.trim())),
            None => (rest, None),
        };
        // `<number> - <name>`, either part optional.
        let description = description.trim_start();
        let description = description.trim_start_matches(|c: char| c.is_ascii_digit());
        let name = description
            .trim_start()
            .strip_prefix("- ")
            .unwrap_or(description)
            .trim()
            .to_string();
        let word = directive.and_then(|d| d.split_whitespace().next());
        let status = match word.map(str::to_ascii_uppercase).as_deref() {
            Some("SKIP") => ItemStatus::Skipped,
            Some("TODO") => ItemStatus::Pass,
            _ if failed => ItemStatus::Fail,
            _ => ItemStatus::Pass,
        };
        let message = match (failed, directive) {
            (true, Some(d)) => d.to_string(),
            _ => String::new(),
        };
        read.item = Some(Item {
            name,
            status,
            message,
        });
        read
    }
}

/// What a `go test -json` line puts on the reader's screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GoForward {
    /// The line as it came: it was not an event.
    Verbatim,
    /// An `output` event's text — what `go test -v` would have printed.
    Text(String),
    /// An event with nothing to show.
    Nothing,
}

/// Follows `go test -json` (test2json): one JSON event per line. A
/// top-level test's `pass`, `fail` or `skip` is an item — a subtest, named
/// `Parent/child`, is part of its parent, the way TAP's indented results
/// are. `output` events carry the text `go test -v` prints, which is what
/// reaches the reader in their place.
#[derive(Debug, Default)]
pub struct GoReader {
    tests_seen: bool,
}

impl GoReader {
    pub fn line(&mut self, line: &str) -> (LineRead, GoForward) {
        let mut read = LineRead::default();
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            return (read, GoForward::Verbatim);
        };
        let Some(action) = event.get("Action").and_then(|a| a.as_str()) else {
            return (read, GoForward::Verbatim);
        };
        let field = |name: &str| event.get(name).and_then(|v| v.as_str());
        let test = field("Test");
        match (action, test) {
            ("output", _) => {
                let text = field("Output").unwrap_or_default().to_string();
                return (read, GoForward::Text(text));
            }
            ("pass" | "fail" | "skip", Some(test)) => {
                self.tests_seen = true;
                if !test.contains('/') {
                    read.item = Some(Item {
                        name: test.to_string(),
                        status: match action {
                            "pass" => ItemStatus::Pass,
                            "fail" => ItemStatus::Fail,
                            _ => ItemStatus::Skipped,
                        },
                        message: String::new(),
                    });
                }
            }
            // A package that failed with no test run is a build failure.
            ("fail", None) if !self.tests_seen => {
                read.note = field("Package").map(|p| format!("{p} failed"));
            }
            _ => {}
        }
        (read, GoForward::Nothing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/runner-output")
            .join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// Everything a reader makes of a text: its items, its last total, its
    /// closing tally, and nothing past a stop line.
    fn items(
        read: impl Fn(&str) -> LineRead,
        text: &str,
    ) -> (Vec<Item>, Option<u64>, Option<Tally>) {
        let mut items = Vec::new();
        let mut total = None;
        let mut tally = None;
        for line in text.lines() {
            let r = read(&strip(line));
            if r.stop {
                break;
            }
            items.extend(r.item);
            total = r.total.or(total);
            tally = r.tally.or(tally);
        }
        (items, total, tally)
    }

    /// The colour codes a runner prints under `FORCE_COLOR`, which the
    /// wrapper strips before a reader sees the line.
    fn strip(line: &str) -> String {
        built(r"\x1b\[[0-9;]*[A-Za-z]")
            .replace_all(line, "")
            .into_owned()
    }

    fn seen(items: &[Item]) -> Vec<(&str, ItemStatus)> {
        items.iter().map(|i| (i.name.as_str(), i.status)).collect()
    }

    fn named(kind: RunKind, text: &str) -> (Vec<Item>, Option<u64>, Option<Tally>) {
        let rule = rule_for(kind).expect("a named rule");
        items(|l| rule.read(l), text)
    }

    use ItemStatus::{Fail, Pass, Skipped};

    #[test]
    fn tap_counts_the_top_level_tests_of_node_s_output() {
        let tap = TapReader;
        let (items, total, _) = items(|l| tap.line(l), &fixture("node-test.tap"));
        assert_eq!(
            seen(&items),
            [
                ("adds", Pass),
                ("subtracts wrong", Fail),
                ("later", Skipped),
                ("groups", Pass)
            ]
        );
        assert_eq!(total, Some(4));
    }

    #[test]
    fn tap_reads_directives_and_bare_results() {
        let tap = TapReader;
        let todo = tap
            .line("not ok 3 - flaky # TODO fix the clock")
            .item
            .unwrap();
        assert_eq!(
            (todo.status, todo.message.as_str()),
            (Pass, "TODO fix the clock")
        );
        let skip = tap.line("not ok 4 # skip no network").item.unwrap();
        assert_eq!(skip.status, Skipped);
        let bare = tap.line("ok").item.unwrap();
        assert_eq!((bare.name.as_str(), bare.status), ("", Pass));
        assert!(tap.line("okay then").item.is_none());
        assert!(tap.line("    ok 1 - inner").item.is_none());
        assert_eq!(tap.line("1..12").total, Some(12));
    }

    #[test]
    fn every_status_word_maps_and_an_unknown_one_does_not() {
        for (word, status) in [
            ("PASS", Pass),
            ("passed", Pass),
            ("ok", Pass),
            ("✓", Pass),
            ("✔", Pass),
            ("Success", Pass),
            ("succeeded", Pass),
            ("XFAIL", Pass),
            ("FAIL", Fail),
            ("failed", Fail),
            ("failure", Fail),
            ("✗", Fail),
            ("✘", Fail),
            ("×", Fail),
            ("not ok", Fail),
            ("XPASS", Fail),
            ("***Failed", Fail),
            ("***Timeout", Fail),
            ("***Exception", Fail),
            ("ERROR", ItemStatus::Error),
            ("err", ItemStatus::Error),
            ("errored", ItemStatus::Error),
            ("exception", ItemStatus::Error),
            ("SKIP", Skipped),
            ("skipped", Skipped),
            ("pending", Skipped),
            ("ignored", Skipped),
            ("todo", Skipped),
            ("Not Run", Skipped),
            ("***Not Run", Skipped),
            ("↓", Skipped),
        ] {
            assert_eq!(status_word(word), Some(status), "{word}");
        }
        assert_eq!(status_word("RUNNING"), None);
    }

    #[test]
    fn a_line_rule_reads_items_and_its_total() {
        let rule = LineRule::new(
            r"^(?P<status>PASS|FAIL|SKIP|RUN): (?P<name>\S+)",
            Some(r"^running (?P<total>\d+) checks"),
            Stream::Both,
        )
        .unwrap();
        let (items, total, _) = items(
            |l| rule.read(l),
            "running 3 checks\nPASS: a\nRUN: b\nFAIL: b\nSKIP: c\nnoise\n",
        );
        // `RUN` is no status word, so its line is not an item.
        assert_eq!(seen(&items), [("a", Pass), ("b", Fail), ("c", Skipped)]);
        assert_eq!(total, Some(3));
    }

    #[test]
    fn a_rule_without_its_groups_or_that_does_not_compile_is_refused() {
        let err = LineRule::new(r"^(?P<name>\S+)", None, Stream::Both).unwrap_err();
        assert!(err.contains("(?P<status>"), "{err}");
        let err = LineRule::new(r"(?P<name>\S+) (?P<status>\S+)", Some(r"\d+"), Stream::Both)
            .unwrap_err();
        assert!(
            err.contains("--total") && err.contains("(?P<total>"),
            "{err}"
        );
        let err = LineRule::new(r"(", None, Stream::Both).unwrap_err();
        assert!(err.contains("does not compile"), "{err}");
    }

    #[test]
    fn every_named_kind_has_a_rule_and_the_others_have_none() {
        for kind in [
            RunKind::Pytest,
            RunKind::Jest,
            RunKind::Vitest,
            RunKind::Mocha,
            RunKind::Swift,
            RunKind::Ctest,
            RunKind::Tsc,
            RunKind::Vite,
        ] {
            assert!(rule_for(kind).is_some(), "{kind:?}");
        }
        for kind in [
            RunKind::Bun,
            RunKind::Tap,
            RunKind::Lines,
            RunKind::Go,
            RunKind::Cargo,
        ] {
            assert!(rule_for(kind).is_none(), "{kind:?}");
        }
    }

    /// tsc 5 over a file with two type errors, plain and under `--pretty`.
    #[test]
    fn tsc_reads_each_type_error_as_a_red_with_its_message() {
        for fixture_name in ["tsc.txt", "tsc-pretty.txt"] {
            let (items, total, tally) = named(RunKind::Tsc, &fixture(fixture_name));
            let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
            assert_eq!(names.len(), 2, "{fixture_name}: {names:?}");
            assert!(
                names[0].starts_with("src/a.ts") && names[0].contains('1'),
                "{names:?}"
            );
            assert!(
                items.iter().all(|i| i.status == ItemStatus::Error),
                "{fixture_name}"
            );
            assert_eq!(
                items[0].message, "Type 'string' is not assignable to type 'number'.",
                "{fixture_name}"
            );
            assert_eq!((total, tally), (None, None), "{fixture_name}");
        }
        // A green check prints nothing, and counts nothing.
        let (items, _, _) = named(RunKind::Tsc, "");
        assert!(items.is_empty());
    }

    /// vite 7 building a two-module page, green and with a missing import.
    #[test]
    fn vite_reads_its_phases_and_its_build_as_one_item() {
        let rule = rule_for(RunKind::Vite).unwrap();
        let notes: Vec<String> = fixture("vite.txt")
            .lines()
            .filter_map(|l| rule.read(&strip(l)).note)
            .collect();
        assert_eq!(
            notes,
            [
                "transforming",
                "4 modules transformed",
                "rendering chunks",
                "computing gzip size"
            ]
        );
        let (items, _, _) = named(RunKind::Vite, &fixture("vite.txt"));
        assert_eq!(seen(&items), [("build", Pass)]);
        let (items, _, _) = named(RunKind::Vite, &fixture("vite-error.txt"));
        assert_eq!(seen(&items), [("build", Fail)]);
    }

    /// pytest 9.1 under `-v`.
    #[test]
    fn pytest_reads_its_verbose_lines_and_the_collected_count() {
        let (items, total, _) = named(RunKind::Pytest, &fixture("pytest-v.txt"));
        assert_eq!(
            seen(&items),
            [
                ("test_sample.py::test_adds", Pass),
                ("test_sample.py::test_concat", Pass),
                ("test_sample.py::test_subtracts_wrong", Fail),
                ("test_sample.py::test_later", Skipped),
            ]
        );
        assert_eq!(total, Some(4));
    }

    /// jest 30 on stderr. With an AI agent in the environment (the Session
    /// card's case) it prints a line for the failing file alone, so the
    /// count is the closing summary's; without one, a line for each file.
    #[test]
    fn jest_counts_by_file_and_takes_its_closing_summary() {
        let (items, _, tally) = named(RunKind::Jest, &fixture("jest-agent.txt"));
        assert_eq!(seen(&items), [("./math.test.js", Fail)]);
        let expected = Some(Tally {
            done: 2,
            failed: 1,
            skipped: 0,
        });
        assert_eq!(tally, expected);
        let (items, _, plain) = named(RunKind::Jest, &fixture("jest.txt"));
        assert_eq!(
            seen(&items),
            [("./math.test.js", Fail), ("./str.test.js", Pass)]
        );
        assert_eq!(plain, expected);
    }

    /// vitest 4 on stdout, with and without an agent in the environment.
    #[test]
    fn vitest_counts_by_file_and_takes_its_closing_summary() {
        let tally = Some(Tally {
            done: 2,
            failed: 1,
            skipped: 0,
        });
        let (items, _, agent) = named(RunKind::Vitest, &fixture("vitest-agent.txt"));
        assert_eq!(seen(&items), [("math.test.mjs", Fail)]);
        assert_eq!(agent, tally);
        let (items, _, plain) = named(RunKind::Vitest, &fixture("vitest.txt"));
        assert_eq!(
            seen(&items),
            [("str.test.mjs", Pass), ("math.test.mjs", Fail)]
        );
        assert_eq!(plain, tally);
    }

    /// mocha 11's spec reporter. The failure details after `2 passing`
    /// repeat `1) math`, which must not count twice.
    #[test]
    fn mocha_reads_its_spec_reporter_up_to_the_summary() {
        let (items, _, _) = named(RunKind::Mocha, &fixture("mocha.txt"));
        assert_eq!(
            seen(&items),
            [
                ("adds", Pass),
                ("subtracts wrong", Fail),
                ("concat", Pass),
                ("later", Skipped)
            ]
        );
    }

    /// Swift 6.2: XCTest's lines, then Swift Testing's, both on stdout.
    #[test]
    fn swift_reads_xctest_and_swift_testing_alike() {
        let (items, _, _) = named(RunKind::Swift, &fixture("swift-test.txt"));
        assert_eq!(
            seen(&items),
            [
                ("SampleTests.LegacyTests testAdds", Pass),
                ("SampleTests.LegacyTests testLater", Skipped),
                ("SampleTests.LegacyTests testSubtractsWrong", Fail),
                ("modern()", Pass),
                ("modernWrong()", Fail),
            ]
        );
    }

    /// ctest 4.2: the total rides every line, and a disabled test is
    /// `***Not Run`.
    #[test]
    fn ctest_reads_each_test_line_and_its_total() {
        let (items, total, _) = named(RunKind::Ctest, &fixture("ctest.txt"));
        assert_eq!(
            seen(&items),
            [
                ("alpha", Pass),
                ("beta", Pass),
                ("gamma", Fail),
                ("delta", Skipped)
            ]
        );
        assert_eq!(total, Some(4));
    }

    #[test]
    fn a_summary_tally_reads_named_and_parenthesised_totals() {
        assert_eq!(
            tally_of(" 1 failed, 1 skipped, 2 passed, 4 total"),
            Some(Tally {
                done: 4,
                failed: 1,
                skipped: 1
            })
        );
        assert_eq!(
            tally_of(" 3 passed (3)"),
            Some(Tally {
                done: 3,
                failed: 0,
                skipped: 0
            })
        );
        assert_eq!(tally_of(" nothing here"), None);
    }

    /// The test2json events of a run with a pass, a failure, a test with a
    /// subtest, and a skip, as `go doc cmd/test2json` specifies them.
    #[test]
    fn go_counts_top_level_tests_and_replays_their_output() {
        let mut go = GoReader::default();
        let mut items = Vec::new();
        let mut shown = String::new();
        for line in fixture("go-test2json.jsonl").lines() {
            let (read, forward) = go.line(line);
            items.extend(read.item);
            match forward {
                GoForward::Text(text) => shown.push_str(&text),
                GoForward::Verbatim => panic!("every fixture line is an event: {line}"),
                GoForward::Nothing => {}
            }
        }
        assert_eq!(
            seen(&items),
            [
                ("TestAdds", Pass),
                ("TestSubtractsWrong", Fail),
                ("TestGroups", Pass),
                ("TestLater", Skipped)
            ]
        );
        assert!(shown.starts_with("=== RUN   TestAdds\n--- PASS: TestAdds (0.00s)\n"));
        assert!(shown.ends_with("FAIL\texample.com/sample\t0.012s\n"));
        assert!(!shown.contains("\"Action\""));
    }

    #[test]
    fn go_passes_a_line_that_is_not_an_event_and_names_a_build_failure() {
        let mut go = GoReader::default();
        assert_eq!(go.line("# example.com/sample").1, GoForward::Verbatim);
        let (read, _) = go.line(r#"{"Action":"fail","Package":"example.com/sample","Elapsed":0}"#);
        assert_eq!(read.note.as_deref(), Some("example.com/sample failed"));
    }
}
