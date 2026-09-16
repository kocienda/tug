//! What an arc hands a stage: a part, not a title.
//!
//! A stage opens on a prompt, and every character of that prompt is composed
//! from documents — the ask the arc is making, the paths the document's own
//! findings cite, and what git says has moved in those paths since the document
//! was written. Nothing here is a sentence a model wrote about the work; a
//! summary would be a claim nobody could check, and it would drift from the
//! documents the moment they changed.
//!
//! The composition is split so the wording is testable: [`compose`] is pure
//! over facts already gathered, and the gathering — file existence, two git
//! reads — happens in the caller's blocking pass. Every clause is omitted
//! rather than emptied when its fact is absent, so a document citing nothing
//! and a repo git has never seen produce exactly the bare ask.

use std::path::Path;

/// How many cited paths a stage is handed. A document naming more than this
/// is naming a subsystem rather than a starting point, and a longer list makes
/// a worse opening than a shorter one.
pub const CITED_PATHS_CAP: usize = 12;

/// How many "what moved" lines a stage is handed.
pub const COMMITS_CAP: usize = 20;

/// The repo-relative paths a document cites, in first-seen order.
///
/// A finding that names a file names it in backticks, so the extraction is
/// mechanical: every backticked token holding a `/` or ending in a source
/// extension, kept only if it resolves to a file that exists under the project
/// root. The existence check is what keeps prose out — `` `arc/stage` `` reads
/// like a path and is not one.
pub fn cited_paths(document_source: &str, project_root: &Path, cap: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in backticked(document_source) {
        if out.len() >= cap {
            break;
        }
        let token = token.trim();
        if token.is_empty() || !looks_like_a_path(token) {
            continue;
        }
        if out.iter().any(|seen| seen == token) {
            continue;
        }
        if project_root.join(token).is_file() {
            out.push(token.to_owned());
        }
    }
    out
}

/// Every backtick-delimited run in `source`. Fences are not special: a fenced
/// block opens and closes with runs of backticks, so the spans it yields are
/// code rather than paths and the checks above drop them.
fn backticked(source: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let Some(end) = source[start..].find('`').map(|n| start + n) else {
            break;
        };
        out.push(&source[start..end]);
        i = end + 1;
    }
    out
}

/// Whether a token is shaped like a path worth checking on disk.
fn looks_like_a_path(token: &str) -> bool {
    if token.contains(char::is_whitespace) {
        return false;
    }
    token.contains('/')
        || matches!(
            token.rsplit_once('.').map(|(_, ext)| ext),
            Some(
                "rs" | "ts"
                    | "tsx"
                    | "js"
                    | "jsx"
                    | "swift"
                    | "md"
                    | "toml"
                    | "css"
                    | "json"
                    | "sh"
            )
        )
}

/// What every implement ask tells a seated stage about its own pacing.
///
/// The ask leads with the one step this turn owes — "implement Step N and
/// end the turn" — and only then names what remains of the arc, so the
/// unit of work and the selection's declared end cannot be read as one
/// assignment. The remainder is not decoration: the selection's end is
/// what arms the join, the stage must never re-ask how far it reaches,
/// and after a rotation this line is the only place the fresh session
/// re-learns it. What the ask no longer says is that the arc prompts the
/// next step — that is the skill's fact and the `step done` directive's,
/// each delivered where it is read. The wording is deliberately short,
/// and it is no longer the only thing holding the boundary up: the step
/// verbs say it again at the moment they move a row, and the PreToolUse
/// gate refuses a repo write or a `arc step start` from a turn that has
/// already closed a step. A stage rolled through the old sentence and the
/// skill's on the wheel machinery's first live run, which is what the
/// machinery is for.
fn implement_ask(arc: &str, steps: Option<&str>) -> String {
    let Some(steps) = steps else {
        // No selector on the first implement stage: the whole plan, and
        // `arc-implement`'s own setup declares `--through`.
        return format!("/tugplug:arc-implement {arc} implement one step and end the turn");
    };
    let next = steps.split('-').next().unwrap_or(steps);
    let last = steps.rsplit('-').next().unwrap_or(steps);
    if next == last {
        format!(
            "/tugplug:arc-implement {arc} implement Step {next} and end the turn; it is the arc's last step"
        )
    } else {
        format!(
            "/tugplug:arc-implement {arc} implement Step {next} and end the turn; Steps {steps} remain on this arc"
        )
    }
}

/// The ask an arc is making of a stage — the first clause of its prompt.
///
/// One line per stage, and the wording is the contract: each is a slash
/// command the stage's skill answers to, with the document it is about. A
/// stage whose facts are not all in hand has no ask, and the arc stops
/// rather than opening on half a sentence.
pub fn stage_ask(
    stage: &str,
    document: Option<&str>,
    arc: &str,
    steps: Option<&str>,
) -> Option<String> {
    match stage {
        // The devise ask keeps a readable path because the brief is what the
        // stage opens; the *target* is the arc name, so the skill resolves
        // where to write rather than being told and cannot write anywhere else.
        "devise" => Some(format!(
            "/tugplug:arc-devise a plan for {}, honoring every [B##] decision it records 🢂 {arc}",
            document?
        )),
        "review" => Some(format!("/tugplug:arc-review {arc}")),
        // The audit opens on the arc, and resolves the plan and the branch's
        // diff from it — the same one-name rule every stage after devise
        // follows ([P10]).
        "audit" => Some(format!("/tugplug:arc-audit {arc}")),
        // Both forms carry the one-step ask: every act the wheel takes on
        // this session — a compaction, a rotation — happens between turns, so
        // a step boundary has to be one. Only the model can end a turn, so the
        // rule lives where the model reads.
        "implement" => Some(implement_ask(arc, steps)),
        _ => None,
    }
}

/// The re-ask, when an asked implement turn ends with no step closed
/// (Spec S03).
///
/// The horizon is two *asks*, not two turn ends: a stage that ended a turn on
/// a question, a snag, or a report is answered in one turn, and this is the
/// turn it is answered in. The wording names the open step rather than the
/// range's start, because the thing that did not happen is that step closing.
///
/// The second asked turn ending with no close is the stop, and there is no
/// third ask.
pub fn still_open_ask(arc: &str, step: usize, through: usize) -> String {
    if step == through {
        format!(
            "/tugplug:arc-implement {arc} Step {step} is still open: finish it, close it, and end the turn; it is the arc's last step"
        )
    } else {
        format!(
            "/tugplug:arc-implement {arc} Step {step} is still open: finish it, close it, and end the turn; Steps {step}-{through} remain on this arc"
        )
    }
}

/// Where a stage is, as one line it can read instead of asking.
///
/// Every stage skill used to open by *probing* for its own coordinates —
/// `printenv TUG_ARC`, `arc bind --dry-run`, `arc status --json` — four
/// commands to learn four facts the runner held all along and had just
/// finished acting on. A probe is also the weaker answer: it reads the
/// records a second time, after the dispatch, so it can disagree with what
/// the dispatch decided. This clause is the dispatch's own reading, handed
/// down, and the doctor ran against those same records immediately before it
/// — so `bound` is a fact the runner checked rather than a word the prompt
/// asserts.
///
/// The step coordinates are the implement stage's alone; every other stage
/// walks no ledger, so the clause ends at the stage word.
pub fn where_clause(
    worktree: &Path,
    session: &str,
    stage: &str,
    steps: Option<(usize, usize)>,
) -> String {
    let mut out = format!(
        "where: worktree {} · session {session} bound · stage {stage}",
        worktree.display()
    );
    if let Some((from, through)) = steps {
        out.push_str(&format!(" · Step {from} in hand, through {through}"));
    }
    out
}

/// The stage's opening prompt.
///
/// Six clauses, each dropped when its fact is absent: the ask, where the
/// stage is ([`where_clause`]), the paths the document cites, what moved in
/// those files since the document was written, and — for an arc that stopped
/// and is resuming — where it stopped and why, and what its worktree is
/// holding uncommitted. A call with only an ask returns exactly that ask,
/// which is what makes this a safe replacement for a bare one.
///
/// The `where` clause comes second because it is what the stage reads *before*
/// it reads anything else: the ask says what to do, and the line under it says
/// from where. A stage that finds no `where` line is not under a wheel, and
/// its skill says so and stops.
///
/// The paths clause **names what the list is** rather than telling the model
/// what to do with it: they are the files the document cites, and where to
/// begin is the stage's own judgement.
///
/// The resume clause's fact is the arc's **last stop**, not its current one:
/// every act that picks a stopped arc back up clears `stopped` before the
/// prompt is composed, so a caller reading that field would drop the clause on
/// exactly the prompts it exists for. `ArcRecord::last_stop` is what keeps it
/// for the generation, and it is what the continue act reads.
///
/// The dirty clause is the one fact a resumed stage cannot learn from its own
/// transcript, and after a stop's terminate it is the fact most likely to be
/// true: the bytes an interrupted step had written are still on disk with
/// nobody to explain them. It says they are the arc's own rather than
/// somebody else's, which is the difference between work to pick up and a
/// tree to be suspicious of. Passed only on a resume — a fresh rotation into a
/// clean stage has no stop to explain and the clause would read as an
/// accusation.
pub fn compose(
    ask: &str,
    place: Option<&str>,
    paths: &[String],
    commits: &[String],
    resume: Option<(&str, &str)>,
    dirty: Option<&str>,
) -> String {
    let mut out = ask.to_owned();
    if let Some(place) = place {
        out.push_str(&format!("\n\n{place}"));
    }
    if !paths.is_empty() {
        out.push_str(&format!("\n\ncitations: {}", paths.join(", ")));
    }
    if !commits.is_empty() {
        out.push_str(&format!(
            "\n\nwhat changed in those files since this document was written:\n{}",
            commits.join("\n")
        ));
    }
    if let Some((stage, reason)) = resume {
        out.push_str(&format!(
            "\n\nthis arc was stopped in {stage} — {reason}; it is resuming"
        ));
    }
    if let Some(dirty) = dirty {
        out.push_str(&format!(
            "\n\nthe arc's worktree has uncommitted changes — they are this arc's own, from the \
             step it was stopped in: {dirty}"
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASK: &str = "/tugplug:arc-review arc/foo.md";

    #[test]
    fn an_ask_with_nothing_to_add_is_exactly_the_ask() {
        // The regression guard for every stage whose document cites nothing
        // and whose repo git has never seen: the prompt must be byte-identical
        // to the bare ask the runner sent before this composition existed.
        assert_eq!(compose(ASK, None, &[], &[], None, None), ASK);
    }

    #[test]
    fn each_clause_lands_only_when_its_fact_is_there() {
        let paths = vec!["src/a.rs".to_string(), "src/b.ts".to_string()];
        let commits = vec!["abc1234 move the thing".to_string()];

        let with_paths = compose(ASK, None, &paths, &[], None, None);
        assert!(with_paths.starts_with(ASK));
        assert!(with_paths.contains("citations: src/a.rs, src/b.ts"));
        assert!(!with_paths.contains("what changed"));

        let with_commits = compose(ASK, None, &[], &commits, None, None);
        assert!(with_commits.contains("what changed in those files"));
        assert!(with_commits.contains("abc1234 move the thing"));
        assert!(!with_commits.contains("citations:"));

        let resuming = compose(ASK, None, &[], &[], Some(("implement", "lint")), None);
        assert!(resuming.ends_with("this arc was stopped in implement — lint; it is resuming"));

        let everything = compose(
            ASK,
            None,
            &paths,
            &commits,
            Some(("review", "api error")),
            None,
        );
        assert!(
            everything.find("citations:").unwrap() < everything.find("what changed").unwrap(),
            "the citations come before what moved in them"
        );
        assert!(everything.contains("stopped in review — api error"));
    }

    /// **A resume over a dirty tree says so, and says whose it is** ([P08]).
    /// A stop terminates the claude mid-edit and the bytes stay on disk, so a
    /// rotated session inherits changes nothing has explained to it. The
    /// clause says they are the arc's own, which is the difference between
    /// work to pick up and a tree to be suspicious of.
    #[test]
    fn a_resume_over_a_dirty_tree_says_so() {
        let composed = compose(
            ASK,
            None,
            &[],
            &[],
            Some(("implement", "stopped by user")),
            Some("src/a.rs, src/b.ts"),
        );
        assert!(
            composed.ends_with(
                "the arc's worktree has uncommitted changes — they are this arc's own, from the \
                 step it was stopped in: src/a.rs, src/b.ts"
            ),
            "{composed}",
        );
        assert!(
            composed.find("it is resuming").unwrap() < composed.find("uncommitted").unwrap(),
            "the stop comes first and the tree explains it: {composed}",
        );
    }

    /// And a resume over a clean one says nothing about it. There is nothing
    /// to hand over, and a clause reporting an empty list is a sentence the
    /// reader has to finish before learning it meant nothing.
    #[test]
    fn a_clean_resume_says_nothing_about_the_tree() {
        let composed = compose(ASK, None, &[], &[], Some(("implement", "lint")), None);
        assert!(!composed.contains("uncommitted"), "{composed}");
        assert!(composed.ends_with("it is resuming"), "{composed}");
    }

    #[test]
    fn cited_paths_finds_real_files_and_ignores_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "").unwrap();
        std::fs::write(root.join("src/b.ts"), "").unwrap();
        std::fs::write(root.join("notes.md"), "").unwrap();

        let source = "\
[F01] `src/a.rs` holds it, and `src/b.ts` reads it.
[F02] `src/a.rs` again — the same file, cited twice.
[F03] `src/gone.rs` was deleted, and `arc/stage` is prose that reads like a path.
[F04] `notes.md` is a file; `a bare phrase` is not.
";
        assert_eq!(
            cited_paths(source, root, CITED_PATHS_CAP),
            vec![
                "src/a.rs".to_string(),
                "src/b.ts".to_string(),
                "notes.md".to_string()
            ],
            "first-seen order, deduplicated, and only what is on disk"
        );
    }

    #[test]
    fn cited_paths_respects_its_cap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        let mut source = String::new();
        for n in 0..20 {
            let name = format!("src/f{n}.rs");
            std::fs::write(root.join(&name), "").unwrap();
            source.push_str(&format!("`{name}` "));
        }
        assert_eq!(cited_paths(&source, root, 3).len(), 3);
        assert_eq!(cited_paths(&source, root, 0).len(), 0);
    }

    /// The `where` clause is a stage's coordinates, handed down rather than
    /// probed for. Four facts on one line: the worktree it works in, the
    /// session it is seated on and that the arc is bound to it, the stage it
    /// is, and — for the one stage that walks a ledger — the step in hand and
    /// the run's declared end.
    #[test]
    fn the_where_clause_hands_a_stage_its_coordinates() {
        let worktree = Path::new("/repo/.tug/worktrees/demo");
        assert_eq!(
            where_clause(worktree, "s-1", "implement", Some((4, 9))),
            "where: worktree /repo/.tug/worktrees/demo · session s-1 bound · stage implement · Step 4 in hand, through 9"
        );
        // Devise, review and audit walk no ledger, so the clause has no step
        // coordinates to give and ends at the stage word rather than inventing
        // a pair.
        assert_eq!(
            where_clause(worktree, "s-1", "devise", None),
            "where: worktree /repo/.tug/worktrees/demo · session s-1 bound · stage devise"
        );

        // In a composed prompt it sits directly under the ask, above the
        // citations: what to do, then from where, then what to read.
        let place = where_clause(worktree, "s-1", "review", None);
        let composed = compose(ASK, Some(&place), &["src/a.rs".to_string()], &[], None, None);
        assert!(composed.starts_with(ASK));
        assert!(
            composed.find("where:").unwrap() < composed.find("citations:").unwrap(),
            "{composed}"
        );
    }

    /// A seated implement stage walks one step and stops, because that is
    /// where the arc gets to act. The ask leads with that one step and then
    /// names the arc's remainder — or, on the arc's last step, says it is
    /// the last. Devise and review end by rotating, so the clause would be
    /// telling them about a turn they do not get.
    #[test]
    fn the_implement_ask_tells_a_seated_stage_to_stop_at_one_step() {
        assert_eq!(
            stage_ask("implement", None, "foo", Some("2-4")).expect("an implement ask"),
            "/tugplug:arc-implement foo implement Step 2 and end the turn; Steps 2-4 remain on this arc"
        );
        assert_eq!(
            stage_ask("implement", None, "foo", Some("4-4")).expect("an implement ask"),
            "/tugplug:arc-implement foo implement Step 4 and end the turn; it is the arc's last step"
        );
        assert_eq!(
            stage_ask("implement", None, "foo", None).expect("an implement ask"),
            "/tugplug:arc-implement foo implement one step and end the turn"
        );
        for stage in ["devise", "review"] {
            let ask = stage_ask(stage, Some("arc/idea.md"), "foo", None).expect("an ask");
            assert!(!ask.contains("end the turn"), "{ask}");
        }
    }

    /// The re-ask names the step that did not close, and then says the same
    /// thing about the remainder that the opening ask does — so a stage
    /// reading it learns nothing new about how far the run reaches, only that
    /// this one step is still open.
    #[test]
    fn the_still_open_ask_names_the_step_and_the_remainder() {
        assert_eq!(
            still_open_ask("foo", 2, 4),
            "/tugplug:arc-implement foo Step 2 is still open: finish it, close it, and end the turn; Steps 2-4 remain on this arc"
        );
        assert_eq!(
            still_open_ask("foo", 4, 4),
            "/tugplug:arc-implement foo Step 4 is still open: finish it, close it, and end the turn; it is the arc's last step"
        );
    }
}
