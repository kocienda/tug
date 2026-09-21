//! repo_files — resolving and repairing the paths the Operator's file verbs
//! are given.
//!
//! Every path-taking verb hands its argument here before doing any work, and
//! the module exists because of one failure shape: `git grep -e zone --
//! '%design-decisions.md'` exits 1 with empty stdout *and* empty stderr, which
//! the caller's `run_git` correctly reads as "matched nothing", so a scan that
//! never ran and a scan that ran clean are the same result. A model given that
//! result wrote a fluent, false claim that the term is absent from the file.
//!
//! So the rule here is: **a path argument that matches nothing is an error.**
//! Once an unmatched scope cannot come back as `ok, rows=0`, that result
//! acquires exactly one meaning — the file was read and the pattern is not in
//! it — which is the only thing that makes an absence claim defensible.
//!
//! Between "exact" and "nothing" sits a repair ladder, run cheapest-first and
//! only when the literal resolution returned zero:
//!
//! 1. **Literal** — the argument is a real pathspec as written. A pathspec that
//!    names 37 files (`tuglaws/`) or 502 (`*.md`) is *exact*, not ambiguous;
//!    multiplicity only becomes a question when the system is guessing.
//! 2. **LIKE strip** — `%` removed and retried. This is the observed
//!    contamination: `changes.for_path` speaks SQL LIKE and the model carried
//!    its grammar into a git pathspec in the same round. `_` is the other LIKE
//!    wildcard and is deliberately *not* stripped: it is an ordinary character
//!    in real filenames here, so stripping it would break more paths than it
//!    would repair.
//! 3. **Basename glob** — `*<basename>*`, which is what finds
//!    `tuglaws/design-decisions.md` from `design-decisions.md`.
//! 4. **Case-insensitive basename** — some file's name matches ignoring case.
//!
//! Resolution runs against git's view (`ls-files --cached --others
//! --exclude-standard`), which is both what `git grep` will actually search and
//! a cheap, ordered listing of the tree. Untracked-but-not-ignored files are
//! included so a file written minutes ago is findable.

use std::path::Path;

/// How many paths any single resolution or listing returns. Fifty is a list a
/// model can read and choose from; five hundred is a context flood.
pub const LS_MAX_PATHS: usize = 50;

/// How many near-miss names an unmatched path error offers. The error's job is
/// to let the next round name a real file, which takes a handful of names, not
/// a directory listing.
const NEAR_MISS_CAP: usize = 5;

/// Which rung of the ladder produced a candidate set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rung {
    /// The argument is a real pathspec exactly as it was written.
    Literal,
    /// It became one once SQL LIKE wildcards were stripped.
    LikeStrip,
    /// Its basename, globbed loosely, names something.
    BasenameGlob,
    /// Some file's basename equals its basename, ignoring case.
    CaseInsensitive,
}

/// The result of walking the ladder: which rung fired, and what it found.
/// `rung: None` means nothing matched at any rung.
#[derive(Debug, Clone)]
pub struct Candidates {
    pub rung: Option<Rung>,
    pub paths: Vec<String>,
}

impl Candidates {
    /// A repair rung fired — the paths are guesses, not what was asked for.
    fn repaired(&self) -> bool {
        !matches!(self.rung, None | Some(Rung::Literal))
    }
}

/// What `repo.grep` searches after resolution, and what it should say about it.
#[derive(Debug, Clone)]
pub struct ScopeResolution {
    /// The pathspecs to pass to `git grep`. One element in the ordinary case.
    pub used: Vec<String>,
    /// Set only when a repair rung fired, so the model never reads a guessed
    /// scope as the one it named.
    pub note: Option<String>,
}

/// Where a read or an outline will actually happen, and what it should say
/// about how it got there.
#[derive(Debug, Clone)]
pub struct PathResolution {
    /// The repo-relative path that was resolved to.
    pub used: String,
    /// The canonicalized absolute path, proven to lie under the project dir.
    pub absolute: std::path::PathBuf,
    /// Set only when a repair rung fired.
    pub note: Option<String>,
}

/// Resolve a path for `repo.read` / `repo.outline`.
///
/// The filesystem is asked first, not git ([P02]): the file worth asking about
/// is often minutes old and uncommitted, and a `.gitignore`d file is still a
/// file on the machine. Only when the path does not exist does the repair
/// ladder run, and only over what git can see — which is the right corpus for
/// *guessing*, even though it is the wrong one for *checking*.
///
/// A read has exactly one target, so several repair candidates is a refusal
/// listing them rather than a guess. This is the one place the verbs diverge
/// from `repo.grep`, which is multi-file by construction.
pub async fn resolve_readable_path(dir: &Path, path: &str) -> Result<PathResolution, String> {
    if dir.join(path).exists() {
        return Ok(PathResolution {
            used: path.to_string(),
            absolute: contained_path(dir, path)?,
            note: None,
        });
    }

    let candidates = path_candidates(dir, path).await?;
    match candidates.paths.as_slice() {
        [] => Err(unmatched_path_error(dir, "path", path).await),
        [only] => Ok(PathResolution {
            used: only.clone(),
            absolute: contained_path(dir, only)?,
            note: Some(format!("path {path:?} does not exist; read {only} instead")),
        }),
        several => Err(format!(
            "path {:?} does not exist, and {} files could be meant: {}. Name one of them exactly.",
            path,
            several.len(),
            several.join(", ")
        )),
    }
}

/// Prove a repo-relative path lands inside the project dir, and return where.
///
/// **Both** sides are canonicalized, and each for its own reason. The target,
/// because `path_arg` only inspects the argument's *text* — a symlink sitting
/// inside the repository and pointing outside it passes every textual check
/// and escapes. The root, because the project dir is itself commonly reached
/// through a symlink (`/u/src/tugtool` → `/Users/kocienda/Mounts/u/src/tugtool`
/// on the development machine), so canonicalizing only the target would make
/// the prefix comparison fail for every legitimate read.
pub fn contained_path(project_dir: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    let root = project_dir
        .canonicalize()
        .map_err(|err| format!("the project dir could not be resolved: {err}"))?;
    let target = project_dir
        .join(relative)
        .canonicalize()
        .map_err(|err| format!("path {relative:?} could not be resolved: {err}"))?;
    if !target.starts_with(&root) {
        return Err(format!(
            "path {relative:?} resolves outside the project dir and will not be read"
        ));
    }
    Ok(target)
}

/// How much of a file's head decides whether it is binary. Eight kilobytes is
/// the conventional sniff window and is far past any text file's first NUL.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// A NUL byte near the start means these bytes are not text.
///
/// The precedent is local and expensive: one literal NUL in
/// `tugdeck/src/lib/changeset-verb-store.ts` made 34KB of load-bearing source
/// invisible to `rg` and `git diff`. Handing a model the same bytes as
/// mojibake is that failure again with a model on the receiving end.
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .take(BINARY_SNIFF_BYTES)
        .any(|byte| *byte == b'\0')
}

// MARK: - Outline ([P04])

/// One structural line a file advertises about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineEntry {
    /// 1-based, so it feeds `repo.read`'s `around_line` directly.
    pub line: usize,
    /// `heading`, `label`, `mark`, or `decl`.
    pub kind: &'static str,
    pub text: String,
}

/// How much of a structural line an entry carries. An outline is a map, not a
/// read; a long signature is worth recognizing, not worth reproducing.
const OUTLINE_TEXT_CHARS: usize = 160;

/// The longest a bold lead may be and still be a label rather than a sentence.
const LABEL_MAX_CHARS: usize = 32;

/// The structure a file advertises, by the shape of its own lines.
///
/// Deliberately a scan and never a parse ([P04]). No AST, no language server,
/// no grammar to go stale, and no file that cannot be handled — a shape that
/// matches nothing simply yields nothing, which the verb then says out loud.
///
/// The pattern table was chosen by measuring this repository rather than by
/// taste. Two measurements decided it:
///
/// - `tuglaws/design-decisions.md` carries 20 ATX headings for 132 decisions.
///   The decision the incident asked about, D97, is a `**D97.**` bold lead
///   under a heading four lines above it — so a headings-only outline would
///   have missed exactly the thing being asked for. Bold label leads are tier
///   one because of that, not as a refinement.
/// - In `operator.rs`, declarations indented up to four spaces (119) outnumber
///   column-0 ones (94), because `impl` blocks and the test module hold most
///   of the functions. A column-0 rule would hide more than half the file.
///
/// Fence tracking is mandatory rather than a nicety: this repository's docs are
/// full of fenced diagrams, and the D97 drawing itself is inside one, where a
/// leading `#` is art rather than a heading.
pub fn outline_entries(contents: &str, extension: &str) -> Vec<OutlineEntry> {
    let family = Family::of(extension);
    if matches!(family, Family::Unknown) {
        return Vec::new();
    }
    let mut entries: Vec<OutlineEntry> = Vec::new();
    let mut fence: Option<char> = None;
    for (index, raw) in contents.lines().enumerate() {
        let trimmed = raw.trim_start();
        if let Some(marker) = fence_marker(trimmed) {
            fence = match fence {
                Some(open) if open == marker => None,
                Some(open) => Some(open),
                None => Some(marker),
            };
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let kind = match family {
            Family::Prose => prose_kind(trimmed),
            Family::Code => code_kind(raw, trimmed, extension),
            Family::Unknown => None,
        };
        if let Some(kind) = kind {
            entries.push(OutlineEntry {
                line: index + 1,
                kind,
                text: clip(trimmed, OUTLINE_TEXT_CHARS),
            });
        }
    }
    entries
}

enum Family {
    Prose,
    Code,
    Unknown,
}

impl Family {
    fn of(extension: &str) -> Family {
        match extension {
            "md" | "markdown" | "txt" => Family::Prose,
            "rs" | "ts" | "tsx" | "js" | "jsx" | "swift" | "py" | "css" => Family::Code,
            _ => Family::Unknown,
        }
    }
}

/// A triple-backtick or triple-tilde run opens or closes a fence.
fn fence_marker(trimmed: &str) -> Option<char> {
    ['`', '~']
        .into_iter()
        .find(|marker| trimmed.starts_with(&marker.to_string().repeat(3)))
}

fn prose_kind(trimmed: &str) -> Option<&'static str> {
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
        return Some("heading");
    }
    if is_label_lead(trimmed) {
        return Some("label");
    }
    None
}

/// A bold lead that is a *label* rather than emphasis.
///
/// The rule is deliberately narrow, because this repository's prose bolds
/// plenty of things that are not structure. A label opens the line, closes its
/// bold span inside 32 characters, and contains a token ending in a digit:
/// `**D97.**`, `**L26**`, `**Spec S01: Title**`, `**Step 4**`. `**Depends
/// on:**` — which opens a line in every plan step in this repository — has no
/// digit-terminated token and is correctly not structure.
fn is_label_lead(trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("**") else {
        return false;
    };
    let Some(close) = rest.find("**") else {
        return false;
    };
    let label = &rest[..close];
    if label.is_empty() || label.chars().count() > LABEL_MAX_CHARS {
        return false;
    }
    label.split_whitespace().any(|token| {
        token
            .trim_end_matches(|c: char| !c.is_alphanumeric())
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_digit())
    })
}

/// How deep a declaration may sit and still be worth listing. Four spaces
/// covers a Rust `impl` body and a TypeScript class body; eight is inside a
/// function, where the shapes are locals rather than structure.
const DECL_MAX_INDENT: usize = 4;

fn code_kind(raw: &str, trimmed: &str, extension: &str) -> Option<&'static str> {
    if is_comment(trimmed) {
        return trimmed.contains("MARK:").then_some("mark");
    }
    let indent: usize = raw
        .chars()
        .take_while(|c| c.is_whitespace())
        .map(|c| if c == '\t' { DECL_MAX_INDENT } else { 1 })
        .sum();
    if indent > DECL_MAX_INDENT {
        return None;
    }
    // CSS has no declaration keywords; its structure is the selector, which is
    // the line that opens a block.
    if extension == "css" {
        return trimmed.ends_with('{').then_some("decl");
    }
    let (keywords, modifiers) = vocabulary(extension);
    for token in trimmed.split_whitespace().take(4) {
        let word = token.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '!');
        if keywords.contains(&word) {
            return Some("decl");
        }
        if !modifiers.iter().any(|m| word.starts_with(m)) {
            return None;
        }
    }
    None
}

fn is_comment(trimmed: &str) -> bool {
    trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("/*")
}

/// The declaration keywords of each family, and the modifiers a declaration is
/// allowed to hide behind (`pub async fn`, `export default class`).
fn vocabulary(extension: &str) -> (&'static [&'static str], &'static [&'static str]) {
    match extension {
        "rs" => (
            &[
                "fn",
                "struct",
                "enum",
                "trait",
                "impl",
                "const",
                "static",
                "mod",
                "type",
                "union",
                "macro_rules!",
            ],
            &["pub", "async", "unsafe", "extern", "default"],
        ),
        "swift" => (
            &[
                "func",
                "struct",
                "class",
                "enum",
                "extension",
                "protocol",
                "actor",
                "typealias",
            ],
            &[
                "public",
                "private",
                "internal",
                "fileprivate",
                "open",
                "final",
                "static",
                "@",
            ],
        ),
        "py" => (&["def", "class"], &["async", "@"]),
        _ => (
            &[
                "function",
                "class",
                "interface",
                "type",
                "enum",
                "const",
                "namespace",
            ],
            &["export", "default", "async", "declare", "abstract"],
        ),
    }
}

fn clip(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect::<String>() + "…"
}

/// Walk the ladder. Returns the first rung that matched anything.
pub async fn path_candidates(dir: &Path, needle: &str) -> Result<Candidates, String> {
    let literal = ls_pathspec(dir, needle).await?;
    if !literal.is_empty() {
        return Ok(Candidates {
            rung: Some(Rung::Literal),
            paths: literal,
        });
    }

    let stripped = needle.replace('%', "");
    if stripped != needle && !stripped.is_empty() {
        let hits = ls_pathspec(dir, &stripped).await?;
        if !hits.is_empty() {
            return Ok(Candidates {
                rung: Some(Rung::LikeStrip),
                paths: hits,
            });
        }
    }

    let base = basename(&stripped);
    if !base.is_empty() {
        // Was a `*{base}*` pathspec handed to git; the substring match is
        // what that pattern meant, and it is now done here because git
        // expands nothing [B03]. Matched against the whole path, as git's
        // `*` crosses `/`.
        let universe = all_files(dir).await?;
        let hits: Vec<String> = universe
            .iter()
            .filter(|path| path.contains(base))
            .take(LS_MAX_PATHS)
            .cloned()
            .collect();
        if !hits.is_empty() {
            return Ok(Candidates {
                rung: Some(Rung::BasenameGlob),
                paths: hits,
            });
        }

        let lowered = base.to_lowercase();
        let hits: Vec<String> = universe
            .into_iter()
            .filter(|path| basename(path).to_lowercase() == lowered)
            .take(LS_MAX_PATHS)
            .collect();
        if !hits.is_empty() {
            return Ok(Candidates {
                rung: Some(Rung::CaseInsensitive),
                paths: hits,
            });
        }
    }

    Ok(Candidates {
        rung: None,
        paths: Vec::new(),
    })
}

/// Resolve `repo.grep`'s `path_scope`.
///
/// A literal match passes the argument through untouched — a path or a
/// directory is a scope git resolves the same way it always has. A **glob**
/// cannot be passed through any more: git no longer expands one [B03], so the
/// resolved paths go instead, which is the same set git would have matched.
/// A repair searches the candidates it found and says so, because grep is
/// multi-file by construction and matches whose provenance is visible beat a
/// refusal. Nothing at all is an error naming the argument.
pub async fn resolve_grep_scope(dir: &Path, scope: &str) -> Result<ScopeResolution, String> {
    let candidates = path_candidates(dir, scope).await?;
    if candidates.rung.is_none() {
        return Err(unmatched_path_error(dir, "path_scope", scope).await);
    }
    if !candidates.repaired() {
        if is_wildcard(scope) {
            return Ok(ScopeResolution {
                used: candidates.paths,
                note: None,
            });
        }
        return Ok(ScopeResolution {
            used: vec![scope.to_string()],
            note: None,
        });
    }
    let note = if candidates.paths.len() == 1 {
        format!(
            "path_scope {:?} matched no file; searched {} instead",
            scope, candidates.paths[0]
        )
    } else {
        format!(
            "path_scope {:?} matched no file; the scope was guessed and {} similarly-named files were searched",
            scope,
            candidates.paths.len()
        )
    };
    Ok(ScopeResolution {
        used: candidates.paths,
        note: Some(note),
    })
}

/// The message an unmatched path argument comes back as. It names the argument
/// so the model can see what it wrote, says plainly that nothing was searched,
/// and offers real names to try — the three things that turn a dead end into a
/// usable next round.
pub async fn unmatched_path_error(dir: &Path, what: &str, needle: &str) -> String {
    let near = near_misses(dir, needle).await;
    let mut message = format!(
        "{what} {needle:?} matches no file in the repository, so nothing was read or searched"
    );
    if near.is_empty() {
        message.push_str("; no similarly-named file was found either");
    } else {
        message.push_str(&format!(". Nearest names: {}", near.join(", ")));
    }
    message.push_str(
        ". Give a repo-relative path or a git glob (repo.ls resolves a name fragment), never a SQL LIKE pattern.",
    );
    message
}

/// Real paths whose names look like what was asked for, for an error message.
/// Best-effort by construction: a failure here means the error simply carries
/// no suggestions, which is still a better error than the silence it replaces.
async fn near_misses(dir: &Path, needle: &str) -> Vec<String> {
    // The stem, not the whole basename: an extension is the least distinctive
    // part of a filename and often its longest word, so matching on `markdown`
    // instead of `design` would find nothing worth suggesting.
    let base = stem(basename(&needle.replace('%', ""))).to_lowercase();
    let Some(piece) = base
        .split(|c: char| !c.is_alphanumeric())
        .filter(|p| p.chars().count() >= 3)
        .max_by_key(|p| p.chars().count())
    else {
        return Vec::new();
    };
    let Ok(files) = all_files(dir).await else {
        return Vec::new();
    };
    files
        .into_iter()
        .filter(|path| basename(path).to_lowercase().contains(piece))
        .take(NEAR_MISS_CAP)
        .collect()
}

/// Every file git can see in `dir`: tracked, plus untracked-but-not-ignored so
/// a file written minutes ago is reachable. One subprocess, because `--cached
/// --others` is a single listing rather than two.
///
/// **Uncapped**, deliberately. This is the universe a pattern is matched
/// against, and a capped universe does not return fewer answers — it answers
/// "no such file" for every file past the cap. The cap belongs on what is
/// handed back to a model, and every caller below applies it there.
pub(crate) async fn all_files(dir: &Path) -> Result<Vec<String>, String> {
    Ok(dedupe(
        crate::feeds::git::git_paths(
            dir,
            &["ls-files", "--cached", "--others", "--exclude-standard"],
        )
        .await?,
    ))
}

/// `--cached --others` lists a file that is both tracked and present twice, so
/// the run is deduped.
///
/// The records arrive from the door already exact, so nothing is trimmed here:
/// a path may legitimately begin or end with a space, and trimming one used to
/// silently rename it.
fn dedupe(paths: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for path in paths {
        if path.is_empty() || out.contains(&path) {
            continue;
        }
        out.push(path);
    }
    out
}

/// Whether `pattern` is a wildcard rather than a path.
///
/// The three bytes git's own wildmatch treats as special. A name that merely
/// *contains* one of them is therefore read as a pattern here — which is the
/// right way round for an argument a model composed, and the wrong way round
/// for a path Tug read back from git. Nothing on this side does the latter:
/// these are the Operator's arguments, and the paths Tug reads go to git
/// literally, under `GIT_LITERAL_PATHSPECS` [B03].
pub(crate) fn is_wildcard(pattern: &str) -> bool {
    pattern.contains(['*', '?', '['])
}

/// Files matching `pathspec`, resolved **here** rather than by git.
///
/// Git will no longer glob a pathspec for anybody [B03], so a surface that
/// genuinely wants one — the Operator's `path`, `path_scope` and `repo.ls`
/// `pattern`, all three documented to the model as taking a git glob — does
/// the matching against a listing read through the door and hands git the
/// literal paths that came back.
///
/// Git's own pathspec semantics, minus the magic: an exact path matches
/// itself, a directory matches everything beneath it, and a wildcard matches
/// by `glob::Pattern`, whose `*` crosses `/` exactly as git's does without
/// `:(glob)`.
pub(crate) fn match_pathspec(universe: &[String], pathspec: &str) -> Vec<String> {
    let trimmed = pathspec.strip_suffix('/').unwrap_or(pathspec);
    let under = format!("{trimmed}/");
    let glob = is_wildcard(pathspec)
        .then(|| glob::Pattern::new(pathspec).ok())
        .flatten();
    universe
        .iter()
        .filter(|path| {
            path.as_str() == trimmed
                || path.starts_with(&under)
                || glob.as_ref().is_some_and(|g| g.matches(path))
        })
        .take(LS_MAX_PATHS)
        .cloned()
        .collect()
}

/// [`match_pathspec`] against a freshly-read universe.
async fn ls_pathspec(dir: &Path, pathspec: &str) -> Result<Vec<String>, String> {
    Ok(match_pathspec(&all_files(dir).await?, pathspec))
}

/// The last path segment. Pathspecs are always `/`-separated, whatever the
/// platform's own separator is.
fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// A basename with its extension dropped. A leading dot is kept whole, so
/// `.env` stems to `.env` rather than to nothing.
fn stem(base: &str) -> &str {
    match base.rfind('.') {
        Some(0) | None => base,
        Some(cut) => &base[..cut],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basename_takes_the_last_segment() {
        assert_eq!(
            basename("tuglaws/design-decisions.md"),
            "design-decisions.md"
        );
        assert_eq!(basename("alpha.txt"), "alpha.txt");
        assert_eq!(basename(""), "");
    }

    // MARK: - Outline

    /// The real document's shape, reproduced: the target decision is a bold
    /// label under a heading, and the drawing it owns is inside a fence where
    /// a leading `#` is art. Held against a fixture rather than the live file
    /// on purpose — a test that reads `tuglaws/design-decisions.md` breaks the
    /// day someone edits it, and the replay checkpoint exercises the real file.
    #[test]
    fn a_markdown_outline_finds_the_heading_and_the_label_and_skips_the_fence() {
        let doc = "\
# Design Decisions

## Code Session & Transcript

**D97.** The session card is partitioned into six placement zones.

```
# Z0 ────────────────
│ Z1A │ Z1C │ Z2 │
```

**Depends on:** nothing at all.
";
        let entries = outline_entries(doc, "md");
        let shapes: Vec<(usize, &str, &str)> = entries
            .iter()
            .map(|e| (e.line, e.kind, e.text.as_str()))
            .collect();
        assert_eq!(
            shapes,
            vec![
                (1, "heading", "# Design Decisions"),
                (3, "heading", "## Code Session & Transcript"),
                (
                    5,
                    "label",
                    "**D97.** The session card is partitioned into six placement zones."
                ),
            ],
            "the fenced `#` is a drawing, and `**Depends on:**` is not a label"
        );
    }

    #[test]
    fn a_label_lead_needs_a_digit_terminated_token() {
        assert!(is_label_lead("**D97.** and the rest"));
        assert!(is_label_lead("**L26**"));
        assert!(is_label_lead("**Spec S01: Title**"));
        assert!(is_label_lead("**Step 4**"));
        assert!(!is_label_lead("**Depends on:** #step-1"));
        assert!(!is_label_lead("**really important**"));
        assert!(!is_label_lead("not bold at all"));
        assert!(
            !is_label_lead("**a bold run far too long to be any kind of label, number 7**"),
            "a sentence is not a label however it ends"
        );
    }

    /// Indented declarations are the majority in this codebase — `impl` blocks
    /// and test modules hold most of the functions — so four spaces is in and
    /// eight is out.
    #[test]
    fn a_rust_outline_reads_declarations_down_to_four_spaces() {
        let code = "\
// MARK: - Caps

pub const LIMIT: usize = 4;

impl Thing {
    pub async fn run(&self) -> bool {
        fn helper() -> bool { true }
        helper()
    }
}
";
        let entries = outline_entries(code, "rs");
        let shapes: Vec<(usize, &str)> = entries.iter().map(|e| (e.line, e.kind)).collect();
        assert_eq!(
            shapes,
            vec![(1, "mark"), (3, "decl"), (5, "decl"), (6, "decl")],
            "the eight-space `fn helper` is inside a function, not structure"
        );
    }

    #[test]
    fn an_unknown_extension_has_no_patterns_at_all() {
        assert!(outline_entries("# not a heading here\n", "lock").is_empty());
    }

    #[test]
    fn stem_drops_an_extension_but_never_a_leading_dot() {
        assert_eq!(stem("design-notes.md"), "design-notes");
        assert_eq!(stem("design-notes.markdown"), "design-notes");
        assert_eq!(stem("Justfile"), "Justfile");
        assert_eq!(stem(".env"), ".env");
    }

    #[test]
    fn dedupe_keeps_first_sighting_and_never_trims_a_name() {
        let records: Vec<String> = ["a.txt", "b.txt", "a.txt", " spaced.txt "]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert_eq!(
            dedupe(records),
            vec![
                "a.txt".to_string(),
                "b.txt".to_string(),
                // Kept exactly as git named it: the old read trimmed it, which
                // silently renamed a file whose name has a space on the end.
                " spaced.txt ".to_string(),
            ]
        );
        // The universe is uncapped — the cap belongs on what a rung hands
        // back, and a capped universe answers "no such file" rather than
        // "here are the first fifty".
        let many: Vec<String> = (0..LS_MAX_PATHS + 10)
            .map(|n| format!("f{n}.txt"))
            .collect();
        assert_eq!(dedupe(many.clone()).len(), LS_MAX_PATHS + 10);
        assert_eq!(match_pathspec(&many, "*.txt").len(), LS_MAX_PATHS);
    }

    /// A repair rung is what makes a result a guess; a literal match is not.
    #[test]
    fn only_a_repair_rung_counts_as_repaired() {
        let literal = Candidates {
            rung: Some(Rung::Literal),
            paths: vec!["a.txt".into()],
        };
        assert!(!literal.repaired());
        let stripped = Candidates {
            rung: Some(Rung::LikeStrip),
            paths: vec!["a.txt".into()],
        };
        assert!(stripped.repaired());
    }
}
