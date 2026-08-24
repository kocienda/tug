//! Devise-skeleton plan parsing and linting.
//!
//! The grammar a plan document is written in is line-oriented — headings with
//! explicit `{#anchor}` suffixes, bold `**Field:**` lines inside each step, and
//! one pipe table for the Step Status Ledger — so the scanner here is
//! hand-rolled and no markdown crate enters the workspace.
//!
//! The split between what this module checks and what a reviewer checks is
//! deliberate: everything here is mechanical conformance (section presence,
//! anchor uniqueness, label discipline, step field presence, dependency
//! resolution, ledger integrity, banned test shapes). Design soundness,
//! sequencing, and technical choice belong to the reviewer.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use sha2::{Digest, Sha256};

/// How much a diagnostic matters. Only [`Severity::Error`] gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// The document is wrong in a way that will mislead a reader or a tool.
    Error,
    /// Worth fixing, but the document still works.
    Warning,
}

impl Severity {
    /// The wire spelling, matching `JsonIssue`'s `severity` field.
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One lint finding. Maps one-to-one onto `tugutil`'s `JsonIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    /// Stable rule id, e.g. `"PL001"`.
    pub code: String,
    /// Error or warning.
    pub severity: Severity,
    /// One sentence naming what is wrong.
    pub message: String,
    /// 1-indexed source line, when the finding has one.
    pub line: Option<usize>,
    /// The anchor the finding is about, without the leading `#`.
    pub anchor: Option<String>,
}

impl Diagnostic {
    fn at(code: &str, severity: Severity, message: impl Into<String>, line: usize) -> Self {
        Diagnostic {
            code: code.to_string(),
            severity,
            message: message.into(),
            line: Some(line),
            anchor: None,
        }
    }

    fn whole_doc(code: &str, severity: Severity, message: impl Into<String>) -> Self {
        Diagnostic {
            code: code.to_string(),
            severity,
            message: message.into(),
            line: None,
            anchor: None,
        }
    }

    fn anchored(mut self, anchor: impl Into<String>) -> Self {
        self.anchor = Some(anchor.into());
        self
    }
}

/// A heading line, with its explicit anchor when it declared one.
#[derive(Debug, Clone)]
pub struct Heading {
    /// Number of leading `#` characters.
    pub level: usize,
    /// Heading text with the `{#anchor}` suffix removed.
    pub text: String,
    /// The declared anchor, without the leading `#`.
    pub anchor: Option<String>,
    /// 1-indexed source line.
    pub line: usize,
}

/// One `#### Step N:` section and the fields found inside it.
#[derive(Debug, Clone)]
pub struct Step {
    /// The `N` in `Step N`, when the heading spelled one.
    pub number: Option<usize>,
    /// The step title, with the step number prefix removed.
    pub title: String,
    /// The declared anchor, without the leading `#`.
    pub anchor: Option<String>,
    /// 1-indexed line of the step heading.
    pub line: usize,
    /// The `**Commit:**` line, when present.
    pub commit: Option<String>,
    /// The `**References:**` line and its text, when present.
    pub references: Option<(usize, String)>,
    /// Whether a `**Tasks:**` block was found.
    pub has_tasks: bool,
    /// The `**Tests:**` block's line and body lines, when present.
    pub tests: Option<(usize, Vec<String>)>,
    /// Whether a `**Checkpoint:**` block was found.
    pub has_checkpoint: bool,
    /// `(line, anchor)` for every anchor named on a `**Depends on:**` line.
    pub depends: Vec<(usize, String)>,
}

/// One row of the Step Status Ledger table.
#[derive(Debug, Clone)]
pub struct LedgerRow {
    /// The step anchor the row names, without the leading `#`.
    pub anchor: String,
    /// The step title as the ledger spells it.
    pub title: String,
    /// The status cell, lowercased and trimmed.
    pub status: String,
    /// The commit cell, `None` when it is a placeholder dash.
    pub commit: Option<String>,
    /// 1-indexed source line.
    pub line: usize,
}

/// One round recorded in the Review Record.
///
/// The stamp is the content identity the round vouches for. It is absent on
/// every round written before `tugutil plan stamp` existed, and on a round
/// whose review has not reached its final step yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRound {
    /// The `N` in `**Round N — …**`.
    pub number: usize,
    /// The round's date, as the lead-in spelled it (`YYYY-MM-DD`).
    pub date: String,
    /// The model that ran the round.
    pub model: String,
    /// The `plan:<hex>` token found anywhere in the round's paragraph.
    pub stamp: Option<String>,
    /// 1-indexed line of the round's bold lead-in.
    pub line: usize,
}

/// What a document's Review Record says about the content on disk now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewState {
    /// The newest stamped round's stamp equals the document's content stamp.
    Reviewed,
    /// A round carries a stamp, and the document has moved since.
    Stale,
    /// No rounds, or no round carrying a stamp — nothing vouches for anything.
    NeverReviewed,
}

impl ReviewState {
    /// The wire spelling, as `plan status` reports it.
    pub fn as_str(self) -> &'static str {
        match self {
            ReviewState::Reviewed => "reviewed",
            ReviewState::Stale => "stale",
            ReviewState::NeverReviewed => "never-reviewed",
        }
    }
}

impl fmt::Display for ReviewState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A parsed plan document.
#[derive(Debug, Clone)]
pub struct PlanDoc {
    /// The `##` title line's text, when the document opened with one.
    pub title: Option<String>,
    /// Every heading, in source order.
    pub headings: Vec<Heading>,
    /// Every declared anchor, in source order, without the leading `#`.
    pub anchors: Vec<(String, usize)>,
    /// Every plan-local label declaration, e.g. `("P01", 174)`.
    pub labels: Vec<(String, usize)>,
    /// Label declarations whose number is not two digits.
    pub malformed_labels: Vec<(String, usize)>,
    /// Headings that declared a `[D##]` label, which belongs to `design-decisions.md`.
    pub design_decision_labels: Vec<(String, usize)>,
    /// Every `#### Step N:` section, in source order.
    pub steps: Vec<Step>,
    /// 1-indexed line of the `{#step-status-ledger}` heading, when present.
    pub ledger_line: Option<usize>,
    /// The ledger table's rows.
    pub ledger_rows: Vec<LedgerRow>,
    /// Inclusive 1-indexed line range of the `{#review-record}` section, from
    /// its heading through the last line before the next heading of the same
    /// level or shallower. `None` when the document declares no such section.
    pub review_record_span: Option<(usize, usize)>,
    /// Every round the Review Record declares, in source order — so the newest
    /// is last, which is the one a verdict is derived from.
    pub review_rounds: Vec<ReviewRound>,
}

/// Returned when a document is not a plan at all — a brief, a note, or a
/// program plan that carries no execution steps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotAPlan;

impl fmt::Display for NotAPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("not a plan document")
    }
}

impl std::error::Error for NotAPlan {}

/// Sections a plan must carry, by anchor.
const REQUIRED_SECTIONS: &[&str] = &[
    "plan-metadata",
    "phase-overview",
    "execution-steps",
    "step-status-ledger",
    "deliverables",
];

/// Statuses the Step Status Ledger accepts.
const LEDGER_STATUSES: &[&str] = &["pending", "in progress", "done"];

/// Test shapes this codebase bans outright.
const BANNED_TEST_SHAPES: &[(&str, &str)] = &[
    ("happy-dom", "happy-dom"),
    ("jsdom", "jsdom"),
    ("@testing-library/react", "@testing-library/react"),
    ("mock-store", "mock-store assertion tests"),
    ("mock store", "mock-store assertion tests"),
];

/// Letters that introduce a plan-local label.
const LABEL_LETTERS: &[char] = &['P', 'Q', 'S', 'T', 'L', 'R', 'M'];

/// Parse a plan document.
///
/// Detection is positive: a document is a plan when it declares an
/// `{#execution-steps}` section. `dash/` also holds briefs, notes, and a
/// program plan that carries ratified decisions and phases but no steps —
/// none of those are plans, and none of them should be linted as one.
pub fn parse(source: &str) -> Result<PlanDoc, NotAPlan> {
    let headings = collect_headings(source);
    if !headings
        .iter()
        .any(|h| h.anchor.as_deref() == Some("execution-steps"))
    {
        return Err(NotAPlan);
    }

    let mut doc = PlanDoc {
        title: headings
            .iter()
            .find(|h| h.level == 2)
            .map(|h| h.text.clone()),
        anchors: headings
            .iter()
            .filter_map(|h| h.anchor.clone().map(|a| (a, h.line)))
            .collect(),
        headings: headings.clone(),
        labels: Vec::new(),
        malformed_labels: Vec::new(),
        design_decision_labels: Vec::new(),
        steps: Vec::new(),
        ledger_line: None,
        ledger_rows: Vec::new(),
        review_record_span: review_record_span(source, &headings),
        review_rounds: Vec::new(),
    };
    doc.review_rounds = collect_review_rounds(source, doc.review_record_span);

    // Labels are declared either by a heading (`#### [P01] …`) or by a bold
    // lead-in (`**Spec S01: …**`, `**Table T01: …**`, `**Risk R01: …**`).
    for heading in &headings {
        match read_label(&heading.text) {
            Some(Label::Plan { id, two_digits }) => {
                doc.labels.push((id.clone(), heading.line));
                if !two_digits {
                    doc.malformed_labels.push((id, heading.line));
                }
            }
            Some(Label::DesignDecision { id }) => {
                doc.design_decision_labels.push((id, heading.line));
            }
            None => {}
        }
    }

    let mut current_step: Option<Step> = None;
    let mut current_field: Option<String> = None;
    let mut in_ledger = false;
    let mut in_fence = false;

    for (index, raw) in source.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim_end();

        // A fenced block is a sample, not structure — a spec that shows the
        // Review Record's markdown must not declare its heading.
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }

        if let Some(level) = heading_level(line) {
            if let Some(step) = current_step.take() {
                if level <= 4 {
                    doc.steps.push(step);
                } else {
                    current_step = Some(step);
                }
            }
            current_field = None;

            let heading = headings
                .iter()
                .find(|h| h.line == line_no)
                .expect("every heading line was collected");
            in_ledger = heading.anchor.as_deref() == Some("step-status-ledger");
            if in_ledger {
                doc.ledger_line = Some(line_no);
            }
            if let Some((number, title)) = read_step_heading(&heading.text) {
                current_step = Some(Step {
                    number,
                    title,
                    anchor: heading.anchor.clone(),
                    line: line_no,
                    commit: None,
                    references: None,
                    has_tasks: false,
                    tests: None,
                    has_checkpoint: false,
                    depends: Vec::new(),
                });
            }
            continue;
        }

        if in_ledger && line.trim_start().starts_with('|') {
            if let Some(row) = read_ledger_row(line, line_no) {
                doc.ledger_rows.push(row);
            }
            continue;
        }

        if line.trim_start().starts_with("**") {
            if let Some(Label::Plan { id, two_digits }) = read_label(line.trim_start()) {
                doc.labels.push((id.clone(), line_no));
                if !two_digits {
                    doc.malformed_labels.push((id, line_no));
                }
            }
        }

        let Some(step) = current_step.as_mut() else {
            continue;
        };

        if let Some((field, rest)) = read_bold_field(line) {
            current_field = Some(field.clone());
            match field.as_str() {
                "Commit" => step.commit = Some(rest.trim().to_string()),
                "References" => step.references = Some((line_no, rest.trim().to_string())),
                "Tasks" => step.has_tasks = true,
                "Tests" => step.tests = Some((line_no, Vec::new())),
                "Checkpoint" => step.has_checkpoint = true,
                "Depends on" => {
                    for anchor in read_dependency_entries(rest) {
                        step.depends.push((line_no, anchor));
                    }
                }
                _ => {}
            }
            continue;
        }

        if current_field.as_deref() == Some("Tests")
            && let Some((_, body)) = step.tests.as_mut()
        {
            body.push(line.to_string());
        }
    }

    if let Some(step) = current_step.take() {
        doc.steps.push(step);
    }

    Ok(doc)
}

/// Run every rule over a parsed plan. Diagnostics come back in source order.
pub fn lint(doc: &PlanDoc) -> Vec<Diagnostic> {
    let mut out = Vec::new();

    let declared: BTreeSet<&str> = doc.anchors.iter().map(|(a, _)| a.as_str()).collect();

    // PL001 — required sections.
    for required in REQUIRED_SECTIONS {
        if !declared.contains(required) {
            out.push(Diagnostic::whole_doc(
                "PL001",
                Severity::Error,
                format!("required section `#{required}` is missing"),
            ));
        }
    }

    // PL002 / PL003 — anchor uniqueness and spelling.
    let mut first_seen: BTreeMap<&str, usize> = BTreeMap::new();
    for (anchor, line) in &doc.anchors {
        match first_seen.get(anchor.as_str()) {
            Some(first) => out.push(
                Diagnostic::at(
                    "PL002",
                    Severity::Error,
                    format!("anchor `#{anchor}` is already declared on line {first}"),
                    *line,
                )
                .anchored(anchor.clone()),
            ),
            None => {
                first_seen.insert(anchor.as_str(), *line);
            }
        }
        if !anchor
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            || anchor.is_empty()
        {
            out.push(
                Diagnostic::at(
                    "PL003",
                    Severity::Error,
                    format!("anchor `#{anchor}` uses characters outside `[a-z0-9-]`"),
                    *line,
                )
                .anchored(anchor.clone()),
            );
        }
    }

    // PL004 — a section heading with no explicit anchor.
    for heading in &doc.headings {
        if (heading.level == 3 || heading.level == 4) && heading.anchor.is_none() {
            out.push(Diagnostic::at(
                "PL004",
                Severity::Warning,
                format!("heading `{}` declares no `{{#anchor}}`", heading.text),
                heading.line,
            ));
        }
    }

    // PL005 — `[D##]` is the design-decisions namespace, not a plan's.
    for (id, line) in &doc.design_decision_labels {
        out.push(Diagnostic::at(
            "PL005",
            Severity::Error,
            format!(
                "`[{id}]` names a decision in `tuglaws/design-decisions.md`; a plan-local decision is `[P##]`"
            ),
            *line,
        ));
    }

    // PL006 / PL007 — label discipline.
    let mut label_first: BTreeMap<&str, usize> = BTreeMap::new();
    for (id, line) in &doc.labels {
        match label_first.get(id.as_str()) {
            Some(first) => out.push(Diagnostic::at(
                "PL006",
                Severity::Error,
                format!("label `[{id}]` is already declared on line {first}"),
                *line,
            )),
            None => {
                label_first.insert(id.as_str(), *line);
            }
        }
    }
    for (id, line) in &doc.malformed_labels {
        out.push(Diagnostic::at(
            "PL007",
            Severity::Warning,
            format!("label `[{id}]` should carry a two-digit number"),
            *line,
        ));
    }

    // PL027 — a stepped plan with no ledger at all. Step identity is
    // load-bearing: the step verbs, the dash-log, and every display key a
    // run's progress by ledger row, so a plan that has steps but no ledger is
    // one the machinery cannot drive.
    if !doc.steps.is_empty() && doc.ledger_line.is_none() && doc.ledger_rows.is_empty() {
        out.push(Diagnostic::whole_doc(
            "PL027",
            Severity::Error,
            "this plan has execution steps but no Step Status Ledger — nothing can track or resume the run",
        ));
    }

    // PL015 / PL016 / PL017 / PL018 — the ledger.
    if doc.ledger_line.is_some() && doc.ledger_rows.is_empty() {
        out.push(Diagnostic::at(
            "PL015",
            Severity::Error,
            "the Step Status Ledger section carries no table rows",
            doc.ledger_line.unwrap_or(1),
        ));
    }
    if !doc.ledger_rows.is_empty() {
        let ledger_anchors: BTreeSet<&str> =
            doc.ledger_rows.iter().map(|r| r.anchor.as_str()).collect();
        let step_anchors: BTreeSet<&str> = doc
            .steps
            .iter()
            .filter_map(|s| s.anchor.as_deref())
            .collect();
        for missing in step_anchors.difference(&ledger_anchors) {
            out.push(
                Diagnostic::at(
                    "PL016",
                    Severity::Error,
                    format!("step `#{missing}` has no Step Status Ledger row"),
                    doc.ledger_line.unwrap_or(1),
                )
                .anchored(missing.to_string()),
            );
        }
        for extra in ledger_anchors.difference(&step_anchors) {
            let line = doc
                .ledger_rows
                .iter()
                .find(|r| r.anchor == *extra)
                .map(|r| r.line)
                .unwrap_or(1);
            out.push(
                Diagnostic::at(
                    "PL016",
                    Severity::Error,
                    format!("ledger row `#{extra}` names no step in this plan"),
                    line,
                )
                .anchored(extra.to_string()),
            );
        }
    }
    for row in &doc.ledger_rows {
        if !LEDGER_STATUSES.contains(&row.status.as_str()) {
            out.push(
                Diagnostic::at(
                    "PL017",
                    Severity::Error,
                    format!(
                        "ledger status `{}` is not one of pending / in progress / done",
                        row.status
                    ),
                    row.line,
                )
                .anchored(row.anchor.clone()),
            );
        }
        if row.status == "done" && row.commit.is_none() {
            out.push(
                Diagnostic::at(
                    "PL018",
                    Severity::Warning,
                    format!(
                        "ledger row `#{}` is done with no commit recorded",
                        row.anchor
                    ),
                    row.line,
                )
                .anchored(row.anchor.clone()),
            );
        }
    }

    // Per-step rules.
    let step_number_by_anchor: BTreeMap<&str, usize> = doc
        .steps
        .iter()
        .filter_map(|s| Some((s.anchor.as_deref()?, s.number?)))
        .collect();

    for step in &doc.steps {
        let anchor_of = |d: Diagnostic| match &step.anchor {
            Some(a) => d.anchored(a.clone()),
            None => d,
        };
        let label = step
            .number
            .map(|n| format!("Step {n}"))
            .unwrap_or_else(|| step.title.clone());

        // PL026 — an unnumbered step. The number is the step's identity: the
        // anchor, the ledger row, and the step verbs all spell it, so a
        // heading whose `Step …:` prefix does not parse as an integer is a
        // step nothing can start, finish, or resume.
        if step.number.is_none() {
            out.push(anchor_of(Diagnostic::at(
                "PL026",
                Severity::Error,
                format!("{label} has no step number — a step heading reads `Step N: <title>`"),
                step.line,
            )));
        }

        if step.commit.is_none() {
            out.push(anchor_of(Diagnostic::at(
                "PL008",
                Severity::Error,
                format!("{label} has no `**Commit:**` line"),
                step.line,
            )));
        }
        if step.references.is_none() {
            out.push(anchor_of(Diagnostic::at(
                "PL009",
                Severity::Error,
                format!("{label} has no `**References:**` line"),
                step.line,
            )));
        }
        if !step.has_tasks {
            out.push(anchor_of(Diagnostic::at(
                "PL010",
                Severity::Error,
                format!("{label} has no Tasks block"),
                step.line,
            )));
        }
        if step.tests.is_none() {
            out.push(anchor_of(Diagnostic::at(
                "PL011",
                Severity::Warning,
                format!("{label} has no Tests block"),
                step.line,
            )));
        }
        if !step.has_checkpoint {
            out.push(anchor_of(Diagnostic::at(
                "PL012",
                Severity::Error,
                format!("{label} has no Checkpoint block"),
                step.line,
            )));
        }

        for (line, dep) in &step.depends {
            if !declared.contains(dep.as_str()) {
                out.push(Diagnostic::at(
                    "PL013",
                    Severity::Error,
                    format!("{label} depends on `#{dep}`, which this plan does not declare"),
                    *line,
                ));
                continue;
            }
            if let (Some(own), Some(other)) = (step.number, step_number_by_anchor.get(dep.as_str()))
                && *other >= own
            {
                out.push(Diagnostic::at(
                    "PL014",
                    Severity::Error,
                    format!("{label} depends on `#{dep}`, which comes later in the plan"),
                    *line,
                ));
            }
        }

        if let Some((line, text)) = &step.references {
            if cites_line_numbers(text) {
                out.push(Diagnostic::at(
                    "PL019",
                    Severity::Warning,
                    format!("{label}'s references cite line numbers, which go stale"),
                    *line,
                ));
            }
            if !carries_citation(text) {
                out.push(Diagnostic::at(
                    "PL021",
                    Severity::Warning,
                    format!("{label}'s references carry no citation"),
                    *line,
                ));
            }
        }

        if let Some((line, body)) = &step.tests {
            for (needle, name) in BANNED_TEST_SHAPES {
                if body.iter().any(|l| l.to_ascii_lowercase().contains(needle)) {
                    out.push(Diagnostic::at(
                        "PL020",
                        Severity::Error,
                        format!("{label}'s Tests block proposes {name}, which this codebase bans"),
                        *line,
                    ));
                }
            }
        }

        if let (Some(number), Some(anchor)) = (step.number, step.anchor.as_deref())
            && anchor != format!("step-{number}")
        {
            out.push(Diagnostic::at(
                "PL022",
                Severity::Warning,
                format!("{label}'s anchor `#{anchor}` does not match its number"),
                step.line,
            ));
        }
    }

    // PL024 — a plan that plans no tests at all.
    //
    // PL011 has to stay a warning: an integration-checkpoint step legitimately
    // carries its gates in Tasks. But PL020 can only inspect Tests blocks that
    // exist, so a per-step warning on its own makes *no* test planning cheaper
    // than wrong test planning — omitting the block skips the ban. The rule
    // that cannot be satisfied by omission is this one, at the plan level.
    if !doc.steps.is_empty() && doc.steps.iter().all(|s| s.tests.is_none()) {
        out.push(Diagnostic::whole_doc(
            "PL024",
            Severity::Error,
            "no step in this plan carries a Tests block — a plan says how it will be checked",
        ));
    }

    // PL023 — the Review Record.
    if !declared.contains("review-record") {
        out.push(Diagnostic::whole_doc(
            "PL023",
            Severity::Warning,
            "no `{#review-record}` section — a reviewed plan records what the review found",
        ));
    }

    // PL025 — a round that vouches for nothing.
    //
    // A round with no stamp cannot say which bytes it read, so the document
    // reads `never-reviewed` however carefully the round was written.
    for round in &doc.review_rounds {
        if round.stamp.is_none() {
            out.push(Diagnostic::at(
                "PL025",
                Severity::Warning,
                format!(
                    "round {} records no content stamp — run `tugutil plan stamp`",
                    round.number
                ),
                round.line,
            ));
        }
    }

    out.sort_by_key(|d| (d.line.unwrap_or(0), d.code.clone()));
    out
}

/// Whether any diagnostic in a run is error-severity.
pub fn has_errors(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(|d| d.severity == Severity::Error)
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

fn collect_headings(source: &str) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for (index, raw) in source.lines().enumerate() {
        let line = raw.trim_end();
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(level) = heading_level(line) else {
            continue;
        };
        let text = line[level..].trim();
        let (text, anchor) = split_anchor(text);
        out.push(Heading {
            level,
            text: text.to_string(),
            anchor,
            line: index + 1,
        });
    }
    out
}

/// Whether a line opens or closes a fenced block. Both CommonMark spellings
/// count: a plan that shows sample markdown reaches for whichever one its
/// sample does not itself contain.
fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

fn heading_level(line: &str) -> Option<usize> {
    if !line.starts_with('#') {
        return None;
    }
    let level = line.chars().take_while(|c| *c == '#').count();
    if !(2..=6).contains(&level) {
        return None;
    }
    if line[level..].starts_with(' ') {
        Some(level)
    } else {
        None
    }
}

fn split_anchor(text: &str) -> (&str, Option<String>) {
    let Some(open) = text.rfind("{#") else {
        return (text, None);
    };
    if !text.ends_with('}') {
        return (text, None);
    }
    let anchor = &text[open + 2..text.len() - 1];
    (text[..open].trim_end(), Some(anchor.to_string()))
}

fn read_step_heading(text: &str) -> Option<(Option<usize>, String)> {
    let rest = text.strip_prefix("Step ")?;
    let colon = rest.find(':')?;
    let number = rest[..colon].trim().parse::<usize>().ok();
    Some((number, rest[colon + 1..].trim().to_string()))
}

/// `**Field:** rest` → `("Field", "rest")`.
fn read_bold_field(line: &str) -> Option<(String, &str)> {
    let trimmed = line.trim_start();
    let body = trimmed.strip_prefix("**")?;
    let close = body.find(":**")?;
    let name = &body[..close];
    if name.is_empty() || name.contains("**") {
        return None;
    }
    Some((name.to_string(), &body[close + 3..]))
}

/// The anchors a `**Depends on:**` line declares, without the leading `#`.
///
/// A dependency is a comma-separated entry that is *entirely* an anchor. Plans
/// also write prose on this line — "parallel to #step-1 … it does not wait on
/// #step-4" — and an anchor mentioned inside a sentence is a reference, not a
/// declared dependency. Reading those as edges would report a cycle a careful
/// author deliberately explained they do not have.
fn read_dependency_entries(text: &str) -> Vec<String> {
    text.split(',')
        .filter_map(|entry| {
            let entry = entry.trim().trim_matches('`').trim();
            let anchor = entry.strip_prefix('#')?;
            let valid = !anchor.is_empty()
                && anchor
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            valid.then(|| anchor.to_string())
        })
        .collect()
}

fn read_ledger_row(line: &str, line_no: usize) -> Option<LedgerRow> {
    let cells: Vec<&str> = line
        .trim()
        .trim_start_matches('|')
        .trim_end_matches('|')
        .split('|')
        .map(str::trim)
        .collect();
    if cells.len() < 3 {
        return None;
    }
    let anchor = cells[0].strip_prefix('#')?;
    if anchor.is_empty() {
        return None;
    }
    let commit = cells
        .get(3)
        .map(|c| c.trim_matches('`').trim())
        .filter(|c| !c.is_empty() && *c != "—" && *c != "-" && *c != "–");
    Some(LedgerRow {
        anchor: anchor.to_string(),
        title: cells[1].to_string(),
        status: cells[2].to_ascii_lowercase(),
        commit: commit.map(str::to_string),
        line: line_no,
    })
}

enum Label {
    Plan { id: String, two_digits: bool },
    DesignDecision { id: String },
}

/// Read a label declaration from a heading or a bold lead-in.
///
/// Two spellings declare one: `[P01] …` (decisions and questions) and
/// `**Spec S01: …` / `**Table T01: …` / `**Risk R01: …` (the bold forms).
fn read_label(text: &str) -> Option<Label> {
    let text = text.trim_start_matches('*').trim_start();
    if let Some(rest) = text.strip_prefix('[') {
        let close = rest.find(']')?;
        return classify_label(&rest[..close]);
    }
    // `Spec S01:` / `Table T01:` / `Risk R01:` — the label is the second token.
    let mut tokens = text.split_whitespace();
    let first = tokens.next()?;
    if !matches!(first, "Spec" | "Table" | "Risk" | "Mitigation" | "Metric") {
        return None;
    }
    let second = tokens.next()?.trim_end_matches(':');
    classify_label(second)
}

fn classify_label(id: &str) -> Option<Label> {
    let mut chars = id.chars();
    let letter = chars.next()?;
    let digits: String = chars.collect();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if letter == 'D' {
        return Some(Label::DesignDecision { id: id.to_string() });
    }
    if !LABEL_LETTERS.contains(&letter) {
        return None;
    }
    Some(Label::Plan {
        id: id.to_string(),
        two_digits: digits.len() == 2,
    })
}

/// Whether a references line cites a `path:line` pair.
fn cites_line_numbers(text: &str) -> bool {
    text.split_whitespace().any(|token| {
        let token =
            token.trim_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '/' && c != ':');
        let Some((path, tail)) = token.rsplit_once(':') else {
            return false;
        };
        !tail.is_empty()
            && tail.chars().all(|c| c.is_ascii_digit())
            && (path.contains('.') || path.contains('/'))
    })
}

/// Whether a references line cites anything at all — a label, an anchor, or a path.
fn carries_citation(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("n/a") {
        return false;
    }
    trimmed.contains('[') || trimmed.contains("(#") || trimmed.contains('`')
}

// --- the Review Record -----------------------------------------------------

/// The inclusive line range of the `{#review-record}` section: its heading
/// through the last line before the next heading of the same level or
/// shallower, or the end of the file.
fn review_record_span(source: &str, headings: &[Heading]) -> Option<(usize, usize)> {
    let record = headings
        .iter()
        .find(|h| h.anchor.as_deref() == Some("review-record"))?;
    let end = headings
        .iter()
        .find(|h| h.line > record.line && h.level <= record.level)
        .map(|h| h.line - 1)
        .unwrap_or_else(|| source.lines().count());
    Some((record.line, end.max(record.line)))
}

/// Read every round declared inside the Review Record's span.
///
/// A round's paragraph runs from its lead-in to the next lead-in or the end of
/// the section, and its stamp may sit anywhere inside it — the skill writes the
/// prose and `plan stamp` inserts the token, so the two are not required to
/// share a line by anything but convention.
fn collect_review_rounds(source: &str, span: Option<(usize, usize)>) -> Vec<ReviewRound> {
    let Some((start, end)) = span else {
        return Vec::new();
    };
    let lines: Vec<&str> = source.lines().collect();

    // A fenced sample of the round grammar is documentation, not a round —
    // the same rule `collect_headings` applies to fenced headings.
    let mut in_fence = false;
    let mut rounds: Vec<ReviewRound> = Vec::new();
    for line_no in start..=end.min(lines.len()) {
        let line = lines[line_no - 1].trim_end();
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some((number, date, model)) = read_review_round_lead_in(line) {
            rounds.push(ReviewRound {
                number,
                date,
                model,
                stamp: None,
                line: line_no,
            });
        }
        if let Some(round) = rounds.last_mut()
            && round.stamp.is_none()
            && let Some(stamp) = read_stamp_token(line)
        {
            round.stamp = Some(stamp);
        }
    }
    rounds
}

/// `**Round 2 — 2026-08-14, opus.**` → `(2, "2026-08-14", "opus")`.
///
/// A lead-in that does not spell all three fields is simply not a round: the
/// Review Record is prose, and prose that happens to open in bold is common.
fn read_review_round_lead_in(line: &str) -> Option<(usize, String, String)> {
    let body = line.trim_start().strip_prefix("**")?;
    let close = body.find("**")?;
    let lead = &body[..close];
    let rest = lead.strip_prefix("Round ")?;
    let (number, tail) = rest.split_once('—')?;
    let number = number.trim().parse::<usize>().ok()?;
    let (date, model) = tail.split_once(',')?;
    let date = date.trim();
    if !is_iso_date(date) {
        return None;
    }
    let model = model.trim().trim_end_matches('.').trim();
    if model.is_empty() {
        return None;
    }
    Some((number, date.to_string(), model.to_string()))
}

/// `` `plan:9f2a4c1b7e0d3856` `` → `"9f2a4c1b7e0d3856"`.
fn read_stamp_token(line: &str) -> Option<String> {
    let at = line.find("`plan:")?;
    let rest = &line[at + "`plan:".len()..];
    let close = rest.find('`')?;
    let hex = &rest[..close];
    if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(hex.to_ascii_lowercase())
}

fn is_iso_date(text: &str) -> bool {
    text.len() == 10
        && text.chars().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// The content identity of a plan: the first 16 hex characters of the SHA-256
/// of its canonical extract.
///
/// The extract is what a review is *about*, which is narrower than the file.
/// Implementing a plan rewrites its ledger status and commit cells and ticks
/// its task boxes; a stamp that moved on any of that would report every plan
/// stale the moment its own first step landed, and a staleness signal that
/// fires on progress trains a reader to click through it. So the extract drops
/// the Review Record entirely (the stamp lives inside it and could never
/// otherwise be written), drops formatting-only lines, reduces each ledger row
/// to the two cells that describe the *plan* rather than its progress, and
/// unticks every checkbox.
///
/// The 16-hex-of-SHA-256 shape is `tugchanges_core::content_hash`'s, so this
/// codebase has one content-identity convention rather than two.
pub fn content_stamp(doc: &PlanDoc, source: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    for (index, raw) in source.lines().enumerate() {
        let line_no = index + 1;
        if let Some((start, end)) = doc.review_record_span
            && (start..=end).contains(&line_no)
        {
            continue;
        }
        let line = raw.trim_end();
        if line.trim().is_empty() || is_thematic_break(line) {
            continue;
        }
        // Ledger rows are reduced to anchor + title. The cells come off the
        // parsed `LedgerRow` rather than off a re-split of the line, so this
        // reads the row through `read_ledger_row`'s convention (0=anchor,
        // 1=title) and cannot pick up `rewrite_ledger_line`'s one-off indexing.
        if let Some(row) = doc.ledger_rows.iter().find(|r| r.line == line_no) {
            kept.push(format!("| #{} | {} |", row.anchor, row.title));
            continue;
        }
        kept.push(untick(line));
    }
    let digest = Sha256::digest(kept.join("\n").as_bytes());
    let mut out = String::with_capacity(16);
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// A thematic break — three or more `-` and nothing else. A markdown table
/// separator (`|---|---|`) carries pipes and is therefore not one.
fn is_thematic_break(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.len() >= 3 && trimmed.chars().all(|c| c == '-')
}

/// Normalize a ticked task checkbox back to unticked, keeping indentation.
fn untick(line: &str) -> String {
    let indent_len = line.len() - line.trim_start().len();
    let (indent, body) = line.split_at(indent_len);
    match body
        .strip_prefix("- [x]")
        .or_else(|| body.strip_prefix("- [X]"))
    {
        Some(rest) => format!("{indent}- [ ]{rest}"),
        None => line.to_string(),
    }
}

/// What the Review Record says about the content on disk now.
///
/// The comparison is against the **newest stamped round only**. An older
/// round's stamp is history: it says what that round covered, not what the
/// document is.
pub fn review_state(doc: &PlanDoc, source: &str) -> ReviewState {
    let Some(stamp) = doc
        .review_rounds
        .iter()
        .rev()
        .find_map(|r| r.stamp.as_deref())
    else {
        return ReviewState::NeverReviewed;
    };
    if stamp == content_stamp(doc, source) {
        ReviewState::Reviewed
    } else {
        ReviewState::Stale
    }
}

/// Why a Review Record stamp was refused.
///
/// Like [`LedgerEditError`], every variant leaves the document untouched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampError {
    /// The document declares no `{#execution-steps}` section.
    NotAPlan,
    /// The document has no `{#review-record}` section.
    NoRecord,
    /// The Review Record declares no round to stamp.
    NoRound,
    /// The newest round already carries a stamp.
    AlreadyStamped { round: usize, stamp: String },
    /// The rewritten document did not read back with the stamp it wrote.
    RoundTrip,
}

impl fmt::Display for StampError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StampError::NotAPlan => f.write_str("not a plan document"),
            StampError::NoRecord => f.write_str("no Review Record section to stamp"),
            StampError::NoRound => f.write_str("no review round to stamp"),
            StampError::AlreadyStamped { round, stamp } => {
                write!(f, "round {round} is already stamped `plan:{stamp}`")
            }
            StampError::RoundTrip => f.write_str("the stamped round did not read back"),
        }
    }
}

impl std::error::Error for StampError {}

/// Insert the document's content stamp into the newest Review Record round.
///
/// The stamp is the last edit of a review, because any edit after it
/// invalidates it. Re-stamping is an error rather than a silent rewrite: two
/// stamps on one round cannot both be true, and the second one would quietly
/// claim a review that never read those bytes.
///
/// Returns the edited source, already re-parsed and verified — the same
/// compute-then-reparse-then-verify shape [`set_ledger_status`] established.
pub fn set_review_stamp(source: &str) -> Result<String, StampError> {
    let doc = parse(source).map_err(|_| StampError::NotAPlan)?;
    if doc.review_record_span.is_none() {
        return Err(StampError::NoRecord);
    }
    let round = doc.review_rounds.last().ok_or(StampError::NoRound)?;
    if let Some(stamp) = &round.stamp {
        return Err(StampError::AlreadyStamped {
            round: round.number,
            stamp: stamp.clone(),
        });
    }

    // The extract elides the Review Record, so inserting the stamp inside it
    // cannot move the hash the stamp is claiming. That is what makes a
    // self-consistent stamp possible at all.
    let stamp = content_stamp(&doc, source);
    let edited = insert_stamp(source, round.line, &stamp).ok_or(StampError::RoundTrip)?;

    let reparsed = parse(&edited).map_err(|_| StampError::RoundTrip)?;
    let back = reparsed.review_rounds.last().ok_or(StampError::RoundTrip)?;
    if back.number != round.number
        || back.stamp.as_deref() != Some(stamp.as_str())
        || content_stamp(&reparsed, &edited) != stamp
    {
        return Err(StampError::RoundTrip);
    }

    Ok(edited)
}

/// Write `Reviewed \`plan:<hash>\`.` immediately after a round's bold lead-in,
/// preserving every other byte of the line.
fn insert_stamp(source: &str, line_no: usize, stamp: &str) -> Option<String> {
    let mut pieces: Vec<&str> = source.split_inclusive('\n').collect();
    let piece = *pieces.get(line_no.checked_sub(1)?)?;
    let (content, eol) = match piece.strip_suffix('\n') {
        Some(rest) => (rest, "\n"),
        None => (piece, ""),
    };

    let open = content.find("**")?;
    let close = content[open + 2..].find("**")? + open + 4;
    let (lead, rest) = content.split_at(close);
    let rebuilt = format!("{lead} Reviewed `plan:{stamp}`.{rest}{eol}");
    pieces[line_no - 1] = &rebuilt;
    Some(pieces.concat())
}

// --- ledger editing --------------------------------------------------------

/// Why a Step Status Ledger edit was refused.
///
/// Every variant leaves the document untouched: the edit is computed in memory
/// and only handed back to the caller once it has been re-parsed and verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerEditError {
    /// The document declares no `{#execution-steps}` section.
    NotAPlan,
    /// The document has no Step Status Ledger.
    NoLedger,
    /// The ledger carries no row for this step anchor.
    NoRow { anchor: String },
    /// The row's current status does not permit the requested one.
    BadTransition {
        anchor: String,
        from: String,
        to: String,
    },
    /// The rewritten document did not read back with the requested values.
    RoundTrip { anchor: String },
}

impl fmt::Display for LedgerEditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LedgerEditError::NotAPlan => f.write_str("not a plan document"),
            LedgerEditError::NoLedger => f.write_str("no Step Status Ledger"),
            LedgerEditError::NoRow { anchor } => {
                write!(f, "no ledger row for #{anchor}")
            }
            LedgerEditError::BadTransition { anchor, from, to } => {
                write!(f, "#{anchor} is '{from}'; it cannot become '{to}'")
            }
            LedgerEditError::RoundTrip { anchor } => {
                write!(f, "the edited ledger row #{anchor} did not read back")
            }
        }
    }
}

impl std::error::Error for LedgerEditError {}

/// Which statuses a row may move to, from where.
///
/// `in progress` is reachable from `in progress` so an interrupted run can
/// re-enter the step it was on without a hand-edit; the rewrite is a no-op and
/// the returned text is byte-identical. A `done` row is terminal.
fn transition_allowed(from: &str, to: &str) -> bool {
    match to {
        "in progress" => from == "pending" || from == "in progress",
        "done" => from == "pending" || from == "in progress",
        _ => false,
    }
}

/// Set one Step Status Ledger row's status, and its commit cell on `done`.
///
/// The row is located by the same parse `lint` runs, rewritten in place — only
/// the status and commit cells' contents move, every other byte of the line and
/// of the document is preserved — and the result is re-parsed before it is
/// returned. Anything that does not read back exactly as asked is a refusal, so
/// a caller that gets a string can write it knowing the ledger still parses.
///
/// `anchor` is spelled without the leading `#` (`"step-3"`).
pub fn set_ledger_status(
    source: &str,
    anchor: &str,
    status: &str,
    commit: Option<&str>,
) -> Result<String, LedgerEditError> {
    let doc = parse(source).map_err(|_| LedgerEditError::NotAPlan)?;
    if doc.ledger_line.is_none() {
        return Err(LedgerEditError::NoLedger);
    }
    let row = doc
        .ledger_rows
        .iter()
        .find(|r| r.anchor == anchor)
        .ok_or_else(|| LedgerEditError::NoRow {
            anchor: anchor.to_string(),
        })?;

    if !transition_allowed(&row.status, status) {
        return Err(LedgerEditError::BadTransition {
            anchor: anchor.to_string(),
            from: row.status.clone(),
            to: status.to_string(),
        });
    }

    let edited = rewrite_ledger_line(source, row.line, Some(status), commit).ok_or_else(|| {
        LedgerEditError::RoundTrip {
            anchor: anchor.to_string(),
        }
    })?;

    // The proof the edit did what it claimed: re-read the document it produced.
    let reparsed = parse(&edited).map_err(|_| LedgerEditError::RoundTrip {
        anchor: anchor.to_string(),
    })?;
    let back = reparsed
        .ledger_rows
        .iter()
        .find(|r| r.anchor == anchor)
        .ok_or_else(|| LedgerEditError::RoundTrip {
            anchor: anchor.to_string(),
        })?;
    let commit_reads_back = match commit {
        Some(sha) => back.commit.as_deref() == Some(sha),
        None => true,
    };
    if back.status != status || back.title != row.title || !commit_reads_back {
        return Err(LedgerEditError::RoundTrip {
            anchor: anchor.to_string(),
        });
    }

    Ok(edited)
}

/// Point one Step Status Ledger row's commit cell at a different commit,
/// leaving its status exactly as it stands.
///
/// This is the repair a rewritten history needs: after a dash's rounds are
/// replayed onto a moved base, a `done` row's recorded sha names a commit that
/// is no longer on the branch. Status is untouched on purpose — `done` is
/// terminal, and the row did not become less done by having its commit moved.
///
/// `anchor` is spelled without the leading `#` (`"step-3"`).
pub fn rewrite_ledger_commit_cell(
    source: &str,
    anchor: &str,
    commit: &str,
) -> Result<String, LedgerEditError> {
    let doc = parse(source).map_err(|_| LedgerEditError::NotAPlan)?;
    if doc.ledger_line.is_none() {
        return Err(LedgerEditError::NoLedger);
    }
    let row = doc
        .ledger_rows
        .iter()
        .find(|r| r.anchor == anchor)
        .ok_or_else(|| LedgerEditError::NoRow {
            anchor: anchor.to_string(),
        })?;

    let edited = rewrite_ledger_line(source, row.line, None, Some(commit)).ok_or_else(|| {
        LedgerEditError::RoundTrip {
            anchor: anchor.to_string(),
        }
    })?;

    let reparsed = parse(&edited).map_err(|_| LedgerEditError::RoundTrip {
        anchor: anchor.to_string(),
    })?;
    let back = reparsed
        .ledger_rows
        .iter()
        .find(|r| r.anchor == anchor)
        .ok_or_else(|| LedgerEditError::RoundTrip {
            anchor: anchor.to_string(),
        })?;
    if back.commit.as_deref() != Some(commit)
        || back.status != row.status
        || back.title != row.title
    {
        return Err(LedgerEditError::RoundTrip {
            anchor: anchor.to_string(),
        });
    }
    Ok(edited)
}

/// Rewrite one table line's status cell and/or commit cell, preserving the
/// line's indentation, cell padding, and line ending. `None` when the line does
/// not have the cells to rewrite.
fn rewrite_ledger_line(
    source: &str,
    line_no: usize,
    status: Option<&str>,
    commit: Option<&str>,
) -> Option<String> {
    let mut pieces: Vec<&str> = source.split_inclusive('\n').collect();
    let piece = *pieces.get(line_no.checked_sub(1)?)?;
    let (content, eol) = match piece.strip_suffix('\n') {
        Some(rest) => (rest, "\n"),
        None => (piece, ""),
    };

    let indent = &content[..content.len() - content.trim_start().len()];
    let body_end = content.trim_end().len();
    let (body, trailing) = content[indent.len()..].split_at(body_end - indent.len());

    // `| #step-1 | Title | pending | — |` splits into a leading empty segment,
    // then one segment per cell: anchor, title, status, commit.
    let mut cells: Vec<String> = body.split('|').map(str::to_string).collect();
    if let Some(status) = status {
        set_cell(cells.get_mut(3)?, status);
    } else if cells.len() < 4 {
        return None;
    }
    if let Some(sha) = commit {
        set_cell(cells.get_mut(4)?, &format!("`{sha}`"));
    }

    let rebuilt = format!("{indent}{}{trailing}{eol}", cells.join("|"));
    pieces[line_no - 1] = &rebuilt;
    Some(pieces.concat())
}

/// Replace a cell's content, keeping whatever padding it wore.
fn set_cell(cell: &mut String, value: &str) {
    let lead = &cell[..cell.len() - cell.trim_start().len()];
    let trail = &cell[cell.trim_end().len()..];
    let (lead, trail) = if cell.trim().is_empty() {
        (" ", " ")
    } else {
        (lead, trail)
    };
    let replaced = format!("{lead}{value}{trail}");
    *cell = replaced;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plan carrying every required section and one clean step.
    const MINIMAL: &str = r#"## A Minimal Plan {#minimal-plan}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | Someone |

### Review Record {#review-record}

**Round 1 — 2026-08-13, opus.** Reviewed `plan:0123456789abcdef`. Lint: 0 errors.

### Phase Overview {#phase-overview}

Some context.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The only step | pending | — |

#### Step 1: The only step {#step-1}

**Commit:** `thing(scope): do it`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the thing.

**Tests:**
- [ ] Unit: the thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** the thing.
"#;

    fn diagnose(source: &str) -> Vec<Diagnostic> {
        lint(&parse(source).expect("fixture parses as a plan"))
    }

    fn codes(source: &str) -> Vec<String> {
        diagnose(source).into_iter().map(|d| d.code).collect()
    }

    fn find(source: &str, code: &str) -> Diagnostic {
        let diags = diagnose(source);
        diags
            .iter()
            .find(|d| d.code == code)
            .unwrap_or_else(|| panic!("expected a {code} diagnostic, got {diags:#?}"))
            .clone()
    }

    #[test]
    fn minimal_plan_is_clean() {
        assert_eq!(diagnose(MINIMAL), Vec::new());
    }

    #[test]
    fn a_brief_is_not_a_plan() {
        let brief =
            "## How we got here\n\nSome prose.\n\n## What I'd want decided\n\nMore prose.\n";
        assert!(parse(brief).is_err(), "a brief is not a plan");
    }

    #[test]
    fn a_program_plan_without_steps_is_not_a_plan() {
        let program =
            "## Plan Metadata {#plan-metadata}\n\n## Phases {#phases}\n\n### Phase 1 {#phase-1}\n";
        assert!(parse(program).is_err(), "a program plan carries no steps");
    }

    #[test]
    fn pl001_missing_required_section() {
        let source = MINIMAL.replace(
            "### Deliverables and Checkpoints {#deliverables}",
            "### Deliverables and Checkpoints {#delivery}",
        );
        let d = find(&source, "PL001");
        assert_eq!(d.severity, Severity::Error);
        assert!(d.message.contains("#deliverables"), "{}", d.message);
    }

    #[test]
    fn pl002_duplicate_anchor() {
        let source = MINIMAL.replace(
            "### Phase Overview {#phase-overview}",
            "### Phase Overview {#phase-overview}\n\n#### Again {#plan-metadata}",
        );
        let d = find(&source, "PL002");
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.anchor.as_deref(), Some("plan-metadata"));
    }

    #[test]
    fn pl003_anchor_charset() {
        let source = MINIMAL.replace("{#minimal-plan}", "{#Minimal_Plan}");
        let d = find(&source, "PL003");
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.line, Some(1));
    }

    #[test]
    fn pl004_heading_without_anchor() {
        let source = MINIMAL.replace(
            "### Phase Overview {#phase-overview}",
            "### Phase Overview {#phase-overview}\n\n#### Bare Heading",
        );
        let d = find(&source, "PL004");
        assert_eq!(d.severity, Severity::Warning);
        assert!(d.message.contains("Bare Heading"), "{}", d.message);
    }

    #[test]
    fn pl005_design_decision_label_in_a_plan() {
        let source = MINIMAL.replace(
            "### Phase Overview {#phase-overview}",
            "### Design Decisions {#design-decisions}\n\n#### [D01] A borrowed decision {#d01-borrowed}\n\n### Phase Overview {#phase-overview}",
        );
        let d = find(&source, "PL005");
        assert_eq!(d.severity, Severity::Error);
        assert!(d.message.contains("[P##]"), "{}", d.message);
    }

    #[test]
    fn pl006_duplicate_label() {
        let source = MINIMAL.replace(
            "### Phase Overview {#phase-overview}",
            "### Design Decisions {#design-decisions}\n\n#### [P01] First {#p01-first}\n\n#### [P01] Second {#p01-second}\n\n### Phase Overview {#phase-overview}",
        );
        let d = find(&source, "PL006");
        assert_eq!(d.severity, Severity::Error);
        assert!(d.message.contains("[P01]"), "{}", d.message);
    }

    #[test]
    fn pl007_label_is_not_two_digits() {
        let source = MINIMAL.replace(
            "### Phase Overview {#phase-overview}",
            "### Design Decisions {#design-decisions}\n\n#### [P1] One digit {#p1-one}\n\n### Phase Overview {#phase-overview}",
        );
        let d = find(&source, "PL007");
        assert_eq!(d.severity, Severity::Warning);
    }

    #[test]
    fn pl008_missing_commit() {
        let source = MINIMAL.replace("**Commit:** `thing(scope): do it`\n\n", "");
        let d = find(&source, "PL008");
        assert_eq!(d.severity, Severity::Error);
        assert_eq!(d.anchor.as_deref(), Some("step-1"));
    }

    #[test]
    fn pl009_missing_references() {
        let source = MINIMAL.replace(
            "**References:** [P01] the decision, (#phase-overview)\n\n",
            "",
        );
        assert_eq!(find(&source, "PL009").severity, Severity::Error);
    }

    #[test]
    fn pl010_missing_tasks() {
        let source = MINIMAL.replace("**Tasks:**\n- [ ] Do the thing.\n\n", "");
        assert_eq!(find(&source, "PL010").severity, Severity::Error);
    }

    #[test]
    fn pl011_missing_tests_is_a_warning() {
        // Calibration: an integration-checkpoint step legitimately carries its
        // gates in Tasks and has no Tests block, so this cannot gate.
        let source = MINIMAL.replace("**Tests:**\n- [ ] Unit: the thing works.\n\n", "");
        assert_eq!(find(&source, "PL011").severity, Severity::Warning);
    }

    #[test]
    fn pl012_missing_checkpoint() {
        let source = MINIMAL.replace("**Checkpoint:**\n- [ ] `cargo nextest run`\n", "");
        assert_eq!(find(&source, "PL012").severity, Severity::Error);
    }

    #[test]
    fn pl013_dependency_on_an_unknown_anchor() {
        let source = MINIMAL.replace(
            "#### Step 1: The only step {#step-1}\n",
            "#### Step 1: The only step {#step-1}\n\n**Depends on:** #step-9\n",
        );
        let d = find(&source, "PL013");
        assert_eq!(d.severity, Severity::Error);
        assert!(d.message.contains("#step-9"), "{}", d.message);
    }

    #[test]
    fn pl014_dependency_on_a_later_step() {
        let source = TWO_STEPS.replace(
            "#### Step 1: First {#step-1}\n",
            "#### Step 1: First {#step-1}\n\n**Depends on:** #step-2\n",
        );
        let d = find(&source, "PL014");
        assert_eq!(d.severity, Severity::Error);
        assert!(d.message.contains("later"), "{}", d.message);
    }

    #[test]
    fn pl026_unnumbered_step_heading() {
        let source = MINIMAL.replace(
            "#### Step 1: The only step {#step-1}",
            "#### Step One: The only step {#step-1}",
        );
        let d = find(&source, "PL026");
        assert_eq!(d.severity, Severity::Error);
        assert!(d.message.contains("Step N"), "{}", d.message);
        assert!(!codes(MINIMAL).contains(&"PL026".to_string()));
    }

    #[test]
    fn pl027_stepped_plan_with_no_ledger_at_all() {
        let source = MINIMAL.replace(
            "#### Step Status Ledger {#step-status-ledger}\n\n| Step | Title | Status | Commit |\n|---|---|---|---|\n| #step-1 | The only step | pending | — |\n",
            "",
        );
        let d = find(&source, "PL027");
        assert_eq!(d.severity, Severity::Error);
        assert!(!codes(MINIMAL).contains(&"PL027".to_string()));
    }

    #[test]
    fn pl015_ledger_section_with_no_table() {
        let source = MINIMAL.replace(
            "| Step | Title | Status | Commit |\n|---|---|---|---|\n| #step-1 | The only step | pending | — |\n",
            "",
        );
        assert_eq!(find(&source, "PL015").severity, Severity::Error);
    }

    #[test]
    fn pl016_ledger_and_steps_disagree() {
        let source = MINIMAL.replace(
            "| #step-1 | The only step | pending | — |",
            "| #step-2 | Some other step | pending | — |",
        );
        let codes: Vec<&str> = diagnose(&source)
            .iter()
            .filter(|d| d.code == "PL016")
            .map(|_| "PL016")
            .collect();
        assert_eq!(
            codes.len(),
            2,
            "one for the orphan step, one for the orphan row"
        );
    }

    #[test]
    fn pl017_unknown_ledger_status() {
        let source = MINIMAL.replace(
            "| #step-1 | The only step | pending | — |",
            "| #step-1 | The only step | started | — |",
        );
        let d = find(&source, "PL017");
        assert_eq!(d.severity, Severity::Error);
        assert!(d.message.contains("started"), "{}", d.message);
    }

    #[test]
    fn pl018_done_with_no_commit() {
        let source = MINIMAL.replace(
            "| #step-1 | The only step | pending | — |",
            "| #step-1 | The only step | done | — |",
        );
        assert_eq!(find(&source, "PL018").severity, Severity::Warning);
    }

    #[test]
    fn pl018_silent_when_the_commit_is_recorded() {
        let source = MINIMAL.replace(
            "| #step-1 | The only step | pending | — |",
            "| #step-1 | The only step | done | `95effa736` |",
        );
        assert!(!codes(&source).contains(&"PL018".to_string()));
    }

    #[test]
    fn pl019_references_citing_line_numbers() {
        let source = MINIMAL.replace(
            "**References:** [P01] the decision, (#phase-overview)",
            "**References:** [P01] the decision, `tugcode/src/session.ts:7071`",
        );
        let d = find(&source, "PL019");
        assert_eq!(d.severity, Severity::Warning);
    }

    #[test]
    fn pl020_banned_test_shape() {
        let source = MINIMAL.replace(
            "- [ ] Unit: the thing works.",
            "- [ ] Render the row with @testing-library/react and assert the text.",
        );
        let d = find(&source, "PL020");
        assert_eq!(d.severity, Severity::Error);
        assert!(
            d.message.contains("@testing-library/react"),
            "{}",
            d.message
        );
    }

    #[test]
    fn pl020_does_not_fire_outside_the_tests_block() {
        // A plan that names the ban in order to enforce it must lint clean.
        let source = MINIMAL.replace(
            "**Tasks:**\n- [ ] Do the thing.",
            "**Tasks:**\n- [ ] Delete the last jsdom render test and the happy-dom dependency.",
        );
        assert!(!codes(&source).contains(&"PL020".to_string()));
    }

    #[test]
    fn pl021_references_with_no_citation() {
        let source = MINIMAL.replace(
            "**References:** [P01] the decision, (#phase-overview)",
            "**References:** N/A",
        );
        assert_eq!(find(&source, "PL021").severity, Severity::Warning);
    }

    #[test]
    fn pl022_step_anchor_does_not_match_its_number() {
        let source = MINIMAL
            .replace(
                "#### Step 1: The only step {#step-1}",
                "#### Step 1: The only step {#step-one}",
            )
            .replace("| #step-1 |", "| #step-one |");
        let d = find(&source, "PL022");
        assert_eq!(d.severity, Severity::Warning);
    }

    #[test]
    fn pl024_a_plan_that_plans_no_tests_at_all() {
        // The single step's Tests block is what PL020 would have scanned;
        // dropping it must not be the cheap way past the ban.
        let source = MINIMAL.replace("**Tests:**\n- [ ] Unit: the thing works.\n\n", "");
        let d = find(&source, "PL024");
        assert_eq!(d.severity, Severity::Error);
    }

    #[test]
    fn pl024_silent_when_one_step_carries_tests() {
        // Step 2 keeps its block, so step 1 going without is PL011's warning
        // and nothing more — the integration-checkpoint shape stays legal.
        let source = TWO_STEPS.replace("**Tests:**\n- [ ] Unit: the first thing works.\n\n", "");
        assert!(!codes(&source).contains(&"PL024".to_string()));
        assert!(codes(&source).contains(&"PL011".to_string()));
    }

    #[test]
    fn a_tilde_fence_hides_its_sample_too() {
        // The same shape `pl023`'s spec needs: a plan showing sample markdown
        // reaches for the fence its sample does not itself contain.
        let source = MINIMAL.replace(
            "### Phase Overview {#phase-overview}",
            "### Phase Overview {#phase-overview}\n\n~~~markdown\n#### Step 9: A sample {#step-1}\n~~~",
        );
        let doc = parse(&source).expect("parses");
        assert_eq!(doc.steps.len(), 1, "the fenced sample declares no step");
        assert_eq!(diagnose(&source), Vec::new());
    }

    #[test]
    fn pl023_missing_review_record() {
        let source = MINIMAL.replace(
            "### Review Record {#review-record}\n\n**Round 1 — 2026-08-13, opus.** Reviewed `plan:0123456789abcdef`. Lint: 0 errors.\n\n",
            "",
        );
        assert_eq!(find(&source, "PL023").severity, Severity::Warning);
    }

    #[test]
    fn labels_are_read_from_bold_lead_ins() {
        let doc = parse(&MINIMAL.replace(
            "### Phase Overview {#phase-overview}",
            "### Specification {#specification}\n\n**Spec S01: The model** {#s01-model}\n\n**Table T01: The rules** {#t01-rules}\n\n**Risk R01: It breaks** {#r01-breaks}\n\n### Phase Overview {#phase-overview}",
        ))
        .expect("parses");
        let ids: Vec<&str> = doc.labels.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"S01"), "{ids:?}");
        assert!(ids.contains(&"T01"), "{ids:?}");
        assert!(ids.contains(&"R01"), "{ids:?}");
    }

    #[test]
    fn has_errors_ignores_warnings() {
        let warnings = vec![Diagnostic::whole_doc(
            "PL023",
            Severity::Warning,
            "no record",
        )];
        assert!(!has_errors(&warnings));
        let errors = vec![Diagnostic::whole_doc("PL001", Severity::Error, "missing")];
        assert!(has_errors(&errors));
    }

    const TWO_STEPS: &str = r#"## Two Steps {#two-steps}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | Someone |

### Review Record {#review-record}

**Round 1 — 2026-08-13, opus.** Reviewed `plan:0123456789abcdef`. Lint: 0 errors.

### Phase Overview {#phase-overview}

Some context.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | First | pending | — |
| #step-2 | Second | pending | — |

#### Step 1: First {#step-1}

**Commit:** `thing(scope): first`

**References:** [P01] the decision

**Tasks:**
- [ ] Do the first thing.

**Tests:**
- [ ] Unit: the first thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

#### Step 2: Second {#step-2}

**Depends on:** #step-1

**Commit:** `thing(scope): second`

**References:** [P01] the decision

**Tasks:**
- [ ] Do the second thing.

**Tests:**
- [ ] Unit: the second thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** the things.
"#;

    #[test]
    fn a_forward_dependency_is_clean() {
        assert_eq!(diagnose(TWO_STEPS), Vec::new());
    }

    /// The rules must stay honest against the documents people actually write.
    /// The corpus is wherever this project declared its paperwork lives, read
    /// from the config the same way every other consumer reads it — so the
    /// test follows a project that renames its directory, and skips cleanly
    /// when there is no declaration at all.
    #[test]
    fn the_real_corpus_carries_no_errors() {
        let Ok(project_root) = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
        else {
            return;
        };
        let Some(docs) = crate::config::Config::load_from_project(&project_root)
            .ok()
            .and_then(|c| c.docs_dir(&project_root))
        else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(&docs) else {
            return;
        };
        let mut linted = 0usize;
        let mut claimed = 0usize;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(source) = std::fs::read_to_string(&path) else {
                continue;
            };
            // A document whose *heading* declares the anchor claims to be a
            // plan, so the parser owes it a parse. (Prose may mention the
            // anchor — the program plan does, to say it declares none.)
            // Counting claims rather than a fixed floor keeps the walker
            // honest without pinning the test to a corpus size that landing a
            // program changes.
            if source
                .lines()
                .any(|l| l.starts_with('#') && l.trim_end().ends_with("{#execution-steps}"))
            {
                claimed += 1;
            }
            let Ok(doc) = parse(&source) else {
                continue;
            };
            linted += 1;
            let diagnostics = lint(&doc);
            let errors: Vec<&Diagnostic> = diagnostics
                .iter()
                .filter(|d| d.severity == Severity::Error)
                .collect();
            assert!(
                errors.is_empty(),
                "{} carries error diagnostics: {errors:#?}",
                path.display()
            );
        }
        // The live corpus shrinks to nothing as programs land and their plans
        // move to the archive — an empty corpus is nothing to check, not a
        // failure. What must hold is that every document *claiming* to be a
        // plan was parsed as one.
        assert_eq!(
            linted, claimed,
            "{claimed} paperwork document(s) declare {{#execution-steps}} but only {linted} parsed"
        );
    }

    // --- ledger editing ----------------------------------------------------

    /// The lines that differ between two documents, as `(line_no, before, after)`.
    fn line_diff(before: &str, after: &str) -> Vec<(usize, String, String)> {
        let a: Vec<&str> = before.lines().collect();
        let b: Vec<&str> = after.lines().collect();
        assert_eq!(a.len(), b.len(), "an edit must not add or drop a line");
        a.iter()
            .zip(b.iter())
            .enumerate()
            .filter(|(_, (x, y))| x != y)
            .map(|(i, (x, y))| (i + 1, x.to_string(), y.to_string()))
            .collect()
    }

    #[test]
    fn ledger_edit_starts_a_step_changing_exactly_one_line() {
        let out = set_ledger_status(MINIMAL, "step-1", "in progress", None)
            .expect("pending starts cleanly");
        let diff = line_diff(MINIMAL, &out);
        assert_eq!(diff.len(), 1, "exactly one line moves: {diff:?}");
        assert_eq!(diff[0].2, "| #step-1 | The only step | in progress | — |");
    }

    #[test]
    fn ledger_edit_finishes_a_step_with_a_backticked_commit() {
        let started = set_ledger_status(MINIMAL, "step-1", "in progress", None).unwrap();
        let done = set_ledger_status(&started, "step-1", "done", Some("a4477d5")).unwrap();
        let diff = line_diff(&started, &done);
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].2, "| #step-1 | The only step | done | `a4477d5` |");

        // The commit cell renders backticked and reads back through the parser.
        let row = parse(&done).unwrap().ledger_rows.remove(0);
        assert_eq!(row.status, "done");
        assert_eq!(row.commit.as_deref(), Some("a4477d5"));
    }

    #[test]
    fn ledger_edit_re_enters_an_in_progress_row_byte_identically() {
        let started = set_ledger_status(MINIMAL, "step-1", "in progress", None).unwrap();
        let again = set_ledger_status(&started, "step-1", "in progress", None)
            .expect("an interrupted run re-enters its own step");
        assert_eq!(again, started, "re-entry must not move a byte");
    }

    #[test]
    fn ledger_edit_refuses_a_document_that_is_not_a_plan() {
        let brief = "## How we got here\n\nSome prose.\n";
        assert_eq!(
            set_ledger_status(brief, "step-1", "in progress", None),
            Err(LedgerEditError::NotAPlan)
        );
    }

    #[test]
    fn ledger_edit_refuses_a_plan_with_no_ledger() {
        let source = MINIMAL.replace("#### Step Status Ledger {#step-status-ledger}", "#### Rows");
        assert_eq!(
            set_ledger_status(&source, "step-1", "in progress", None),
            Err(LedgerEditError::NoLedger)
        );
    }

    #[test]
    fn ledger_edit_refuses_an_unknown_anchor() {
        assert_eq!(
            set_ledger_status(MINIMAL, "step-9", "in progress", None),
            Err(LedgerEditError::NoRow {
                anchor: "step-9".to_string()
            })
        );
    }

    #[test]
    fn ledger_edit_refuses_moving_off_a_done_row() {
        let done = set_ledger_status(MINIMAL, "step-1", "done", Some("a4477d5")).unwrap();
        for target in ["in progress", "done"] {
            let err = set_ledger_status(&done, "step-1", target, None).unwrap_err();
            assert_eq!(
                err,
                LedgerEditError::BadTransition {
                    anchor: "step-1".to_string(),
                    from: "done".to_string(),
                    to: target.to_string(),
                }
            );
            // The message names the row's current status.
            assert!(err.to_string().contains("is 'done'"), "{err}");
        }
    }

    #[test]
    fn ledger_edit_leaves_prose_and_fenced_samples_alone() {
        let source = MINIMAL.replace(
            "#### Step 1: The only step {#step-1}",
            "Prose that mentions | #step-1 | The only step | pending | — | inline.\n\n\
             ```\n| #step-1 | The only step | pending | — |\n```\n\n\
             #### Step 1: The only step {#step-1}",
        );
        let out = set_ledger_status(&source, "step-1", "in progress", None).unwrap();
        let diff = line_diff(&source, &out);
        assert_eq!(diff.len(), 1, "only the ledger row moves: {diff:?}");
        assert!(diff[0].1.contains("pending"));
        assert!(out.contains("```\n| #step-1 | The only step | pending | — |\n```"));
    }

    // --- the content stamp -------------------------------------------------

    /// `MINIMAL` with its stamp token removed — the shape every plan written
    /// before `plan stamp` existed still carries.
    fn unstamped() -> String {
        MINIMAL.replace(" Reviewed `plan:0123456789abcdef`.", "")
    }

    /// The document `set_review_stamp` produces from [`unstamped`], whose
    /// stamp is therefore the real hash of its own extract.
    fn freshly_stamped() -> String {
        set_review_stamp(&unstamped()).expect("an unstamped round takes a stamp")
    }

    fn verdict(source: &str) -> ReviewState {
        review_state(&parse(source).expect("parses"), source)
    }

    fn stamp_of(source: &str) -> String {
        content_stamp(&parse(source).expect("parses"), source)
    }

    #[test]
    fn a_round_parses_its_number_date_model_and_stamp() {
        let doc = parse(MINIMAL).expect("parses");
        assert_eq!(
            doc.review_rounds,
            vec![ReviewRound {
                number: 1,
                date: "2026-08-13".to_string(),
                model: "opus".to_string(),
                stamp: Some("0123456789abcdef".to_string()),
                line: 11,
            }]
        );
    }

    /// The grammar the review skill actually writes: a multi-line paragraph
    /// per round, the stamp on the lead-in, and rounds appended in order.
    #[test]
    fn the_written_round_grammar_parses_both_rounds() {
        let source = MINIMAL.replace(
            "**Round 1 — 2026-08-13, opus.** Reviewed `plan:0123456789abcdef`. Lint: 0 errors.",
            "**Round 1 — 2026-08-13, opus.** Reviewed `plan:0123456789abcdef`. Lint: 0 errors, 3 warnings (2 fixed).\n\
             Oriented on: the Review Record.\n\
             Applied: sequencing — Step 4 depended on a later step, reordered.\n\
             Deferred: the migration-window question, now [Q03].\n\
             \n\
             **Round 2 — 2026-08-14, sonnet.** Reviewed `plan:FEDCBA9876543210`. Lint: 0 errors, 0 warnings.\n\
             Oriented on: the git diff since round 1.\n\
             Applied: nothing — the plan reads clean.",
        );
        let doc = parse(&source).expect("parses");
        let rounds: Vec<(usize, &str, &str, Option<&str>)> = doc
            .review_rounds
            .iter()
            .map(|r| {
                (
                    r.number,
                    r.date.as_str(),
                    r.model.as_str(),
                    r.stamp.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            rounds,
            vec![
                (1, "2026-08-13", "opus", Some("0123456789abcdef")),
                // Read case-insensitively: a stamp is a hash, not a spelling.
                (2, "2026-08-14", "sonnet", Some("fedcba9876543210")),
            ]
        );
        // The verdict follows the *newest* stamped round. Round 1's stamp is
        // history — it says what round 1 covered, not what the document is.
        assert_eq!(verdict(&source), ReviewState::Stale);
        assert!(!codes(&source).contains(&"PL025".to_string()));
    }

    #[test]
    fn a_fenced_sample_of_the_grammar_declares_no_round() {
        let source = MINIMAL.replace(
            "**Round 1 — 2026-08-13, opus.** Reviewed `plan:0123456789abcdef`. Lint: 0 errors.",
            "```\n**Round 7 — 2026-01-01, sonnet.** Reviewed `plan:aaaaaaaaaaaaaaaa`.\n```",
        );
        let doc = parse(&source).expect("parses");
        assert!(doc.review_rounds.is_empty(), "{:?}", doc.review_rounds);
        assert_eq!(verdict(&source), ReviewState::NeverReviewed);
    }

    #[test]
    fn a_freshly_stamped_plan_reads_reviewed_and_one_word_makes_it_stale() {
        let source = freshly_stamped();
        assert_eq!(verdict(&source), ReviewState::Reviewed);

        let edited = source.replace("Some context.", "Some other context.");
        assert_ne!(edited, source, "the fixture edit landed");
        assert_eq!(verdict(&edited), ReviewState::Stale);
    }

    /// The invariance the whole extract exists for: walking the ledger is
    /// progress, not content, so a step landing must not stale its own plan.
    #[test]
    fn walking_the_ledger_leaves_the_plan_reviewed() {
        let source = freshly_stamped();
        let started = set_ledger_status(&source, "step-1", "in progress", None).unwrap();
        let done = set_ledger_status(&started, "step-1", "done", Some("a4477d5")).unwrap();
        assert_ne!(done, source, "the ledger really moved");
        assert_eq!(verdict(&started), ReviewState::Reviewed);
        assert_eq!(verdict(&done), ReviewState::Reviewed);
    }

    #[test]
    fn ticking_a_task_is_invisible_but_a_new_ledger_row_is_not() {
        let source = freshly_stamped();
        let ticked = source.replace("- [ ] Do the thing.", "- [x] Do the thing.");
        assert_ne!(ticked, source, "the fixture edit landed");
        assert_eq!(stamp_of(&ticked), stamp_of(&source));

        let grown = source.replace(
            "| #step-1 | The only step | pending | — |",
            "| #step-1 | The only step | pending | — |\n| #step-2 | A new step | pending | — |",
        );
        assert_ne!(stamp_of(&grown), stamp_of(&source));
    }

    #[test]
    fn appending_a_round_does_not_move_the_stamp() {
        let source = freshly_stamped();
        let with_round = source.replace(
            "### Phase Overview {#phase-overview}",
            "**Round 2 — 2026-08-14, opus.** Lint: 0 errors.\n\n### Phase Overview {#phase-overview}",
        );
        assert_eq!(parse(&with_round).unwrap().review_rounds.len(), 2);
        assert_eq!(stamp_of(&with_round), stamp_of(&source));
        // …and the newest round now vouches for nothing, so the verdict falls
        // back to it rather than to round 1's still-correct stamp.
        assert_eq!(verdict(&with_round), ReviewState::Reviewed);
    }

    #[test]
    fn formatting_churn_is_not_content() {
        let source = freshly_stamped();
        let churned = source
            .replace("Some context.", "Some context.   ")
            .replace("### Phase Overview", "\n\n### Phase Overview");
        assert_ne!(churned, source, "the fixture edit landed");
        assert_eq!(stamp_of(&churned), stamp_of(&source));
    }

    #[test]
    fn a_record_with_no_stamp_reads_never_reviewed_and_lints_pl025() {
        let source = unstamped();
        assert_eq!(verdict(&source), ReviewState::NeverReviewed);
        let diagnostic = find(&source, "PL025");
        assert_eq!(diagnostic.severity, Severity::Warning);
        assert!(diagnostic.message.contains("round 1"), "{diagnostic:?}");
        assert_eq!(diagnostic.line, Some(11));

        // …and a stamped record does not warn.
        assert!(!codes(MINIMAL).contains(&"PL025".to_string()));
    }

    #[test]
    fn a_stamp_is_self_consistent_and_re_parses() {
        let source = freshly_stamped();
        let doc = parse(&source).expect("the stamped document is still a plan");
        let round = doc.review_rounds.last().expect("the round survived");
        assert_eq!(
            round.stamp.as_deref(),
            Some(content_stamp(&doc, &source).as_str())
        );
        assert!(
            source.contains("**Round 1 — 2026-08-13, opus.** Reviewed `plan:"),
            "the stamp lands right after the lead-in: {source}"
        );
        assert!(
            source.contains("`. Lint: 0 errors."),
            "the rest of the line is preserved"
        );
    }

    #[test]
    fn stamping_twice_refuses_and_writes_nothing() {
        let err = set_review_stamp(MINIMAL).unwrap_err();
        assert_eq!(
            err,
            StampError::AlreadyStamped {
                round: 1,
                stamp: "0123456789abcdef".to_string(),
            }
        );
        assert!(err.to_string().contains("already stamped"), "{err}");
    }

    #[test]
    fn stamping_refuses_a_document_with_no_record_and_no_round() {
        let no_record = MINIMAL.replace(
            "### Review Record {#review-record}\n\n**Round 1 — 2026-08-13, opus.** Reviewed `plan:0123456789abcdef`. Lint: 0 errors.\n\n",
            "",
        );
        assert_eq!(set_review_stamp(&no_record), Err(StampError::NoRecord));

        let no_round = MINIMAL.replace(
            "**Round 1 — 2026-08-13, opus.** Reviewed `plan:0123456789abcdef`. Lint: 0 errors.",
            "Nothing has been reviewed yet.",
        );
        assert_eq!(set_review_stamp(&no_round), Err(StampError::NoRound));

        let brief = "## How we got here\n\nSome prose.\n";
        assert_eq!(set_review_stamp(brief), Err(StampError::NotAPlan));
    }

    #[test]
    fn stamping_moves_exactly_one_line() {
        let before = unstamped();
        let after = set_review_stamp(&before).unwrap();
        let diff = line_diff(&before, &after);
        assert_eq!(
            diff.len(),
            1,
            "only the round's lead-in line moves: {diff:?}"
        );
    }
}
