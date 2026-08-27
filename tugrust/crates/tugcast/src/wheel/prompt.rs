//! What a course hands a stage: a part, not a title.
//!
//! A stage opens on a prompt, and every character of that prompt is composed
//! from documents — the ask the course is making, the paths the document's own
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
const IMPLEMENT_ARC_CLAUSE: &str =
    " — under this arc, close one step and end your turn; the arc prompts you with the next";

/// The ask a course is making of a stage — the first clause of its prompt.
///
/// One line per stage, and the wording is the contract: each is a slash
/// command the stage's skill answers to, with the document it is about. A
/// stage whose facts are not all in hand has no ask, and the course stops
/// rather than opening on half a sentence.
pub fn stage_ask(
    stage: &str,
    document: Option<&str>,
    dash: &str,
    steps: Option<&str>,
) -> Option<String> {
    match stage {
        // The devise ask keeps a readable path because the brief is what the
        // stage opens; the *target* is the dash name, so the skill resolves
        // where to write rather than being told and cannot write anywhere else.
        "devise" => Some(format!(
            "/tugplug:dash-devise a plan for {}, honoring every [B##] decision it records 🢂 {dash}",
            document?
        )),
        "review" => Some(format!("/tugplug:dash-review {dash}")),
        // Both forms carry the one-step clause: every act the wheel takes on
        // this session — a compaction, a rotation — happens between turns, so
        // a step boundary has to be one. Only the model can end a turn, so the
        // rule lives where the model reads.
        "implement" => Some(match steps {
            // No selector on the first implement stage: the whole plan, and
            // `dash-implement`'s own setup declares `--through`.
            None => format!("/tugplug:dash-implement {dash}{IMPLEMENT_ARC_CLAUSE}"),
            Some(steps) => {
                format!("/tugplug:dash-implement {dash} Steps {steps}{IMPLEMENT_ARC_CLAUSE}")
            }
        }),
        _ => None,
    }
}

/// The stage's opening prompt.
///
/// Four clauses, each dropped when its fact is absent: the ask, where to
/// start, what moved in those files since the document was written, and — for
/// a course that stopped and is resuming — where it stopped and why. A call
/// with only an ask returns exactly that ask, which is what makes this a safe
/// replacement for a bare one.
pub fn compose(
    ask: &str,
    paths: &[String],
    commits: &[String],
    resume: Option<(&str, &str)>,
) -> String {
    let mut out = ask.to_owned();
    if !paths.is_empty() {
        out.push_str(&format!("\n\nstart there: {}", paths.join(", ")));
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASK: &str = "/tugplug:dash-review dash/foo.md";

    #[test]
    fn an_ask_with_nothing_to_add_is_exactly_the_ask() {
        // The regression guard for every stage whose document cites nothing
        // and whose repo git has never seen: the prompt must be byte-identical
        // to the bare ask the runner sent before this composition existed.
        assert_eq!(compose(ASK, &[], &[], None), ASK);
    }

    #[test]
    fn each_clause_lands_only_when_its_fact_is_there() {
        let paths = vec!["src/a.rs".to_string(), "src/b.ts".to_string()];
        let commits = vec!["abc1234 move the thing".to_string()];

        let with_paths = compose(ASK, &paths, &[], None);
        assert!(with_paths.starts_with(ASK));
        assert!(with_paths.contains("start there: src/a.rs, src/b.ts"));
        assert!(!with_paths.contains("what changed"));

        let with_commits = compose(ASK, &[], &commits, None);
        assert!(with_commits.contains("what changed in those files"));
        assert!(with_commits.contains("abc1234 move the thing"));
        assert!(!with_commits.contains("start there"));

        let resuming = compose(ASK, &[], &[], Some(("implement", "lint")));
        assert!(resuming.ends_with("this arc was stopped in implement — lint; it is resuming"));

        let everything = compose(ASK, &paths, &commits, Some(("review", "api error")));
        assert!(
            everything.find("start there").unwrap() < everything.find("what changed").unwrap(),
            "where to start comes before what moved"
        );
        assert!(everything.contains("stopped in review — api error"));
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

    /// A seated implement stage walks one step and stops, because that is
    /// where the arc gets to act. Devise and review end by rotating, so the
    /// clause would be telling them about a turn they do not get.
    #[test]
    fn the_implement_ask_tells_a_seated_stage_to_stop_at_one_step() {
        for steps in [None, Some("2-4")] {
            let ask = stage_ask("implement", None, "foo", steps).expect("an implement ask");
            assert!(ask.ends_with(IMPLEMENT_ARC_CLAUSE), "{ask}");
        }
        for stage in ["devise", "review"] {
            let ask = stage_ask(stage, Some("dash/idea.md"), "foo", None).expect("an ask");
            assert!(!ask.contains("close one step"), "{ask}");
        }
    }
}
