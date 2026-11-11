//! The app's help documents and `GET /api/help/{name}`, which serves them to
//! the help card.
//!
//! There are exactly five documents, the guide, the getting-started walk, the
//! recipes, the glossary and the release notes, and they are named, never
//! addressed by path: a request names one of the five and anything else is refused before the filesystem is touched, so the
//! route cannot be walked out of the docs directory. The directory itself is
//! `resources::docs_dir()`, the one resolver the Operator reads through too.
//!
//! Loopback-only, like the other `/api` handlers.
//!
//! The documents' retrieval units live here too, because the Operator's `help`
//! verbs and the help card have to agree on them: a glossary entry is one
//! paragraph opening on its bold term, a guide section or a recipe is a heading
//! and the prose under it, and each carries the anchor the help card scrolls
//! to, slugged the way the card slugs it.
//!
//! A comment that owns its lines names where a recipe's gesture was read. It is
//! for whoever maintains the document, so `HelpDoc::read` drops it and neither a
//! card nor the Operator sees it.
//!
//! The release notes are the one document with no file of their own: each
//! version has a file, and `HelpDoc::read` assembles them on every read, so
//! there is no second copy to go stale.

use std::net::SocketAddr;
use std::path::Path;

use axum::extract::{ConnectInfo, Path as UrlPath};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tracing::warn;

/// One of the app's help documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HelpDoc {
    /// `features.md` — each part of the app in turn, section by section.
    Features,
    /// `getting-started.md` — the first walk through the loop, shown once
    /// after setup and kept on the Help menu.
    GettingStarted,
    /// `recipes.md` — one recipe per thing a person does, headed as they say it.
    Recipes,
    /// `glossary.md` — every word Tug uses, one paragraph per term.
    Glossary,
    /// `release-notes/` — what changed in each version, newest first, assembled
    /// from one file per version.
    ReleaseNotes,
}

impl HelpDoc {
    /// Every help document, in the order the Help menu lists them.
    pub(crate) const ALL: [HelpDoc; 5] = [
        HelpDoc::Features,
        HelpDoc::GettingStarted,
        HelpDoc::Recipes,
        HelpDoc::Glossary,
        HelpDoc::ReleaseNotes,
    ];

    /// The document a request names: its bare name, or its file name. Any
    /// other string — a path, a traversal, an unknown document — is `None`.
    pub(crate) fn from_name(name: &str) -> Option<HelpDoc> {
        HelpDoc::ALL
            .into_iter()
            .find(|doc| name == doc.name() || name == doc.file_name())
    }

    /// The name the help card and the help refs use.
    pub(crate) fn name(self) -> &'static str {
        match self {
            HelpDoc::Features => "features",
            HelpDoc::GettingStarted => "getting-started",
            HelpDoc::Recipes => "recipes",
            HelpDoc::Glossary => "glossary",
            HelpDoc::ReleaseNotes => "release-notes",
        }
    }

    /// The file under the docs directory, or for the release notes, which have
    /// none, what a link to the document spells.
    pub(crate) fn file_name(self) -> &'static str {
        match self {
            HelpDoc::Features => "features.md",
            HelpDoc::GettingStarted => "getting-started.md",
            HelpDoc::Recipes => "recipes.md",
            HelpDoc::Glossary => "glossary.md",
            HelpDoc::ReleaseNotes => "release-notes.md",
        }
    }

    /// The document's markdown, read from `docs_dir`, less its source comments.
    pub(crate) fn read(self, docs_dir: &Path) -> std::io::Result<String> {
        if self == HelpDoc::ReleaseNotes {
            return read_release_notes(docs_dir);
        }
        std::fs::read_to_string(docs_dir.join(self.file_name())).map(|raw| strip_comments(&raw))
    }
}

/// A document without the comments that own their lines, outside a code fence.
/// This is the one read every reader goes through, so a source comment reaches
/// neither the help card, nor the model, nor the embedder.
fn strip_comments(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut in_fence = false;
    let mut in_comment = false;
    for line in markdown.split_inclusive('\n') {
        let trimmed = line.trim();
        if in_comment {
            in_comment = !trimmed.ends_with("-->");
            continue;
        }
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && trimmed.starts_with("<!--") {
            in_comment = !trimmed.ends_with("-->");
            continue;
        }
        out.push_str(line);
    }
    out
}

/// `version.sh`'s seeded stub, tested for by its known text. The same two
/// strings as `SEED_MARKERS` in `scripts/release.py`.
const SEED_MARKERS: [&str; 2] = [
    "Delete this comment",
    "What changed, for someone who has been using",
];

/// The release notes from the directory the bundle copies beside the other
/// documents, or from a checkout's, which is a sibling of its `docs/`. Finding
/// neither reads as a document with no versions in it, because nothing else
/// about help depends on the notes being there.
fn read_release_notes(docs_dir: &Path) -> std::io::Result<String> {
    let bundled = docs_dir.join("release-notes");
    let dir = if bundled.is_dir() {
        bundled
    } else {
        docs_dir.join("..").join("release-notes")
    };
    let mut files = Vec::new();
    match std::fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(stem) = name.strip_suffix(".md") {
                    files.push((stem.to_string(), std::fs::read_to_string(entry.path())?));
                }
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    Ok(assemble_release_notes(files))
}

/// One document from `(file stem, contents)` pairs: a title, then each version's
/// notes, newest first, with every heading one level deeper so a version sits
/// under the title. A stem that is no version, like the README's, and a file
/// with nothing written in it yet are left out.
fn assemble_release_notes(files: Vec<(String, String)>) -> String {
    let mut versions: Vec<(Vec<u64>, String)> = files
        .into_iter()
        .filter(|(_, text)| !SEED_MARKERS.iter().any(|marker| text.contains(marker)))
        .filter_map(|(stem, text)| {
            let version = stem
                .split('.')
                .map(|part| part.parse().ok())
                .collect::<Option<Vec<u64>>>()?;
            let text = demote_headings(&strip_comments(&text));
            let written = text
                .lines()
                .any(|line| !line.trim().is_empty() && !line.starts_with("## "));
            written.then_some((version, text))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = String::from("# Release Notes\n");
    for (_, text) in versions {
        out.push('\n');
        out.push_str(text.trim());
        out.push('\n');
    }
    out
}

/// Every heading outside a code fence, one level deeper.
fn demote_headings(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut in_fence = false;
    for line in markdown.split_inclusive('\n') {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && heading(line.trim_end()).is_some_and(|(level, _)| level < 6) {
            out.push('#');
        }
        out.push_str(line);
    }
    out
}

/// The route's answer for a requested name against a docs directory, pure
/// over its inputs so the refusals are testable without a server.
fn help_response(docs_dir: Option<&Path>, name: &str) -> (StatusCode, Value) {
    let Some(doc) = HelpDoc::from_name(name) else {
        return (
            StatusCode::NOT_FOUND,
            json!({ "error": "unknown_document" }),
        );
    };
    let Some(dir) = docs_dir else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "docs_unavailable" }),
        );
    };
    match doc.read(dir) {
        Ok(markdown) => (
            StatusCode::OK,
            json!({ "name": doc.name(), "markdown": markdown }),
        ),
        Err(err) => {
            warn!(
                "help: could not read {} from {}: {err}",
                doc.file_name(),
                dir.display()
            );
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "docs_unavailable" }),
            )
        }
    }
}

/// `GET /api/help/{name}` — `{ name, markdown }` for one help document.
pub(crate) async fn get_help(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    UrlPath(name): UrlPath<String>,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("get_help: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    let result = tokio::task::spawn_blocking(move || {
        help_response(crate::resources::docs_dir().as_deref(), &name)
    })
    .await;
    match result {
        Ok((status, body)) => (status, axum::Json(body)).into_response(),
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": "internal" })),
        )
            .into_response(),
    }
}

// ── Retrieval units ──────────────────────────────────────────────────────────

/// One retrieval unit of a help document: a glossary entry, a recipe, or a feature-guide
/// section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HelpUnit {
    /// The glossary term, or the heading, as the document spells it.
    pub title: String,
    /// The slug the help card scrolls to for this unit.
    pub anchor: String,
    /// The heading level, 1 to 6, or 0 for a glossary entry.
    pub level: u8,
    /// The unit's own markdown: an entry's paragraph, or a heading
    /// and the lines under it up to the next heading of any level.
    pub text: String,
}

impl HelpDoc {
    /// The document's retrieval units, in document order.
    pub(crate) fn units(self, markdown: &str) -> Vec<HelpUnit> {
        match self {
            HelpDoc::Features | HelpDoc::GettingStarted | HelpDoc::Recipes => {
                heading_sections(markdown)
            }
            HelpDoc::Glossary => glossary_entries(markdown),
            HelpDoc::ReleaseNotes => version_sections(markdown),
        }
    }

    /// What one unit of this document is called, for a model reading results.
    pub(crate) fn unit_kind(self) -> &'static str {
        match self {
            HelpDoc::Features => "section",
            HelpDoc::GettingStarted => "section",
            HelpDoc::Recipes => "recipe",
            HelpDoc::Glossary => "entry",
            HelpDoc::ReleaseNotes => "version",
        }
    }
}

/// A heading's or a term's anchor, spelled the way the help card's
/// `helpAnchorSlug` spells it (GitHub's rule): lower case, markup and
/// punctuation dropped, whitespace runs to one hyphen.
pub(crate) fn help_anchor_slug(text: &str) -> String {
    let kept: String = text
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '`' | '*' | '_'))
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-')
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join("-")
}

/// The glossary's entries: each paragraph that opens on a bold term. The term
/// is the bold text without its closing period, so `**Join draft.**` is the
/// entry `Join draft`, anchored `join-draft`.
fn glossary_entries(markdown: &str) -> Vec<HelpUnit> {
    let mut entries = Vec::new();
    for paragraph in markdown.split("\n\n") {
        let paragraph = paragraph.trim();
        let Some(rest) = paragraph.strip_prefix("**") else {
            continue;
        };
        let Some(close) = rest.find("**") else {
            continue;
        };
        let term = rest[..close].trim().trim_end_matches('.').trim();
        if term.is_empty() {
            continue;
        }
        entries.push(HelpUnit {
            title: term.to_string(),
            anchor: help_anchor_slug(term),
            level: 0,
            text: paragraph.to_string(),
        });
    }
    entries
}

/// A markdown heading line's level and text, outside a code fence.
fn heading(line: &str) -> Option<(u8, &str)> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let text = line[hashes..].strip_prefix(' ')?.trim();
    (!text.is_empty()).then_some((hashes as u8, text))
}

/// The guide's sections and the recipes: every heading, with the lines under it up to
/// the next heading of any level. The document's opening prose belongs to its
/// title heading.
fn heading_sections(markdown: &str) -> Vec<HelpUnit> {
    let mut sections: Vec<HelpUnit> = Vec::new();
    let mut in_fence = false;
    for line in markdown.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        match (!in_fence).then(|| heading(line)).flatten() {
            Some((level, title)) => sections.push(HelpUnit {
                title: title.to_string(),
                anchor: help_anchor_slug(title),
                level,
                text: format!("{line}\n"),
            }),
            None => {
                if let Some(current) = sections.last_mut() {
                    current.text.push_str(line);
                    current.text.push('\n');
                }
            }
        }
    }
    for section in &mut sections {
        let trimmed = section.text.trim_end().len();
        section.text.truncate(trimmed);
    }
    sections
}

/// The release notes' units: one per version, holding all of its notes. A
/// heading inside a version stays inside it, because `### Fixes` says nothing
/// without the version it belongs to, and every version has one. The title holds
/// no text, so it is no unit.
fn version_sections(markdown: &str) -> Vec<HelpUnit> {
    let mut sections: Vec<HelpUnit> = Vec::new();
    for unit in heading_sections(markdown) {
        if unit.level == 1 {
            continue;
        }
        match sections.last_mut() {
            Some(version) if unit.level > 2 => {
                version.text.push_str("\n\n");
                version.text.push_str(&unit.text);
            }
            _ => sections.push(unit),
        }
    }
    sections
}

/// A section together with every deeper section under it — what reading a
/// `##` heading means when `###` headings sit inside it.
pub(crate) fn with_subsections(units: &[HelpUnit], index: usize) -> String {
    let level = units[index].level;
    let mut text = units[index].text.clone();
    for unit in units[index + 1..].iter() {
        if level == 0 || unit.level <= level {
            break;
        }
        text.push_str("\n\n");
        text.push_str(&unit.text);
    }
    text
}

/// The unit a model names: by its anchor, by its title in any case, or by a
/// leading `#` and either.
pub(crate) fn find_unit(units: &[HelpUnit], name: &str) -> Option<usize> {
    let name = name.trim().trim_start_matches('#').trim();
    let slug = help_anchor_slug(name);
    units
        .iter()
        .position(|unit| unit.anchor == slug || unit.title.eq_ignore_ascii_case(name))
}

/// The units whose title or anchor contains what a model asked for, for a
/// refusal that says what it might have meant.
pub(crate) fn near_units<'a>(units: &'a [HelpUnit], name: &str, limit: usize) -> Vec<&'a str> {
    let slug = help_anchor_slug(name);
    if slug.is_empty() {
        return Vec::new();
    }
    units
        .iter()
        .filter(|unit| unit.anchor.contains(&slug) || slug.contains(&unit.anchor))
        .take(limit)
        .map(|unit| unit.title.as_str())
        .collect()
}

/// Words a person puts around a question that no passage is about. Without
/// them `what is a split slot` would need every passage to say `what`.
const QUESTION_WORDS: &[&str] = &[
    "a", "an", "and", "are", "can", "do", "does", "for", "how", "in", "is", "it", "my", "of", "on",
    "or", "the", "to", "what", "when", "where", "which", "why", "with",
];

/// A search query's terms: lower-case words of two characters or more, less
/// the question words around them.
pub(crate) fn search_terms(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .filter(|term| term.chars().count() >= 2 && !QUESTION_WORDS.contains(term))
        .map(str::to_string)
        .collect()
}

/// Whether `haystack` holds `term`, or its singular when the term reads as a
/// plural, so `splits` finds an entry that only says `split`.
fn holds(haystack: &str, term: &str) -> bool {
    haystack.contains(term)
        || (term.len() > 3 && term.ends_with('s') && haystack.contains(&term[..term.len() - 1]))
}

/// A help search's hits: indexes into `units` with their score, best first,
/// and whether every term had to match. A unit that holds every term wins
/// outright; only when none does are the units holding any term ranked, which
/// the caller says in its note.
pub(crate) fn search_units(units: &[HelpUnit], query: &str, limit: usize) -> (Vec<usize>, bool) {
    let terms = search_terms(query);
    if terms.is_empty() {
        return (Vec::new(), true);
    }
    let scored: Vec<(usize, usize, usize)> = units
        .iter()
        .enumerate()
        .map(|(index, unit)| {
            let title = unit.title.to_lowercase();
            let text = unit.text.to_lowercase();
            let mut held = 0;
            let mut score = 0;
            for term in &terms {
                let in_title = holds(&title, term);
                if in_title || holds(&text, term) {
                    held += 1;
                }
                if in_title {
                    score += 10;
                }
                score += text.matches(term.as_str()).count().min(5);
            }
            (index, held, score)
        })
        .collect();
    let every: Vec<(usize, usize)> = scored
        .iter()
        .filter(|(_, held, _)| *held == terms.len())
        .map(|(index, _, score)| (*index, *score))
        .collect();
    let (mut hits, all_terms) = if every.is_empty() {
        let any = scored
            .iter()
            .filter(|(_, held, _)| *held > 0)
            .map(|(index, held, score)| (*index, held * 100 + score))
            .collect();
        (any, false)
    } else {
        (every, true)
    };
    hits.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    (
        hits.into_iter()
            .take(limit)
            .map(|(index, _)| index)
            .collect(),
        all_terms,
    )
}

// ── Help refs ────────────────────────────────────────────────────────────────

/// A help ref's target in its one stored spelling, or `None` when it names no
/// passage the documents have.
///
/// The target is `<doc>` or `<doc>#<anchor>`. The document is one of the
/// documents' names; the anchor is matched the way `help.read` matches a name — by anchor,
/// or by title in any case — and written back as the unit's own anchor, so a
/// model that spelled `glossary#Split` still links to `glossary#split`. A ref
/// is a promise the chip will land somewhere, which is why one that names
/// nothing is dropped rather than kept.
pub(crate) fn canonical_help_target(docs_dir: &Path, target: &str) -> Option<String> {
    let (name, anchor) = match target.split_once('#') {
        Some((name, anchor)) => (name, Some(anchor)),
        None => (target, None),
    };
    let doc = HelpDoc::from_name(name.trim())?;
    let Some(anchor) = anchor.map(str::trim).filter(|a| !a.is_empty()) else {
        return doc.read(docs_dir).ok().map(|_| doc.name().to_string());
    };
    let markdown = doc.read(docs_dir).ok()?;
    let units = doc.units(&markdown);
    let index = find_unit(&units, anchor)?;
    Some(format!("{}#{}", doc.name(), units[index].anchor))
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_resolve_bare_or_as_file_names() {
        assert_eq!(HelpDoc::from_name("features"), Some(HelpDoc::Features));
        assert_eq!(HelpDoc::from_name("recipes"), Some(HelpDoc::Recipes));
        assert_eq!(
            HelpDoc::from_name("getting-started"),
            Some(HelpDoc::GettingStarted)
        );
        assert_eq!(HelpDoc::from_name("glossary.md"), Some(HelpDoc::Glossary));
        assert_eq!(
            HelpDoc::from_name("release-notes"),
            Some(HelpDoc::ReleaseNotes)
        );
    }

    #[test]
    fn anything_but_the_documents_is_refused() {
        for name in [
            "",
            "README",
            "../CLAUDE.md",
            "docs/glossary.md",
            "/etc/passwd",
            "Glossary",
            "How Do I",
            "glossary.md/",
        ] {
            let (status, body) = help_response(Some(Path::new("/nonexistent")), name);
            assert_eq!(status, StatusCode::NOT_FOUND, "{name:?}");
            assert_eq!(body["error"], "unknown_document", "{name:?}");
        }
    }

    #[test]
    fn the_eval_set_names_passages_the_help_documents_have() {
        let docs = crate::resources::checkout_docs().expect("debug build has a checkout");
        let path = docs
            .parent()
            .unwrap()
            .join("tests/operator-eval/questions.json");
        let set: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(
            set.len() >= 20,
            "the eval set holds {} questions",
            set.len()
        );
        for item in &set {
            let anchor = item["anchor"].as_str().unwrap();
            assert_eq!(
                canonical_help_target(&docs, anchor).as_deref(),
                Some(anchor),
                "{:?} expects a passage the documents do not have, or spell another way",
                item["question"]
            );
        }
        assert!(set.iter().any(|item| {
            item["question"] == "how do I create an arc?"
                && item["anchor"] == "recipes#create-an-arc"
        }));
    }

    #[test]
    fn serves_a_document_from_the_docs_dir() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("glossary.md"), "# Tug glossary\n").unwrap();

        let (status, body) = help_response(Some(dir.path()), "glossary");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "glossary");
        assert_eq!(body["markdown"], "# Tug glossary\n");
    }

    #[test]
    fn a_comment_reaches_no_reader_of_a_document() {
        let dir = tempfile::tempdir().unwrap();
        let md = "# How do I…\n<!-- source: a.swift -->\n\n## Stop an arc\n<!-- source: b.ts\n     and c.ts -->\n\nPress stop.\n\n```\n<!-- kept -->\n```\n";
        std::fs::write(dir.path().join("recipes.md"), md).unwrap();

        let read = HelpDoc::Recipes.read(dir.path()).unwrap();
        assert_eq!(
            read,
            "# How do I…\n\n## Stop an arc\n\nPress stop.\n\n```\n<!-- kept -->\n```\n"
        );
        let units = HelpDoc::Recipes.units(&read);
        assert_eq!(units[1].title, "Stop an arc");
        assert!(!units[1].text.contains("source:"));
        let (_, body) = help_response(Some(dir.path()), "recipes");
        assert!(!body["markdown"].as_str().unwrap().contains("source:"));
    }

    #[test]
    fn missing_docs_read_as_unavailable() {
        let (status, body) = help_response(None, "features");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"], "docs_unavailable");

        let empty = tempfile::tempdir().unwrap();
        let (status, _) = help_response(Some(empty.path()), "features");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn release_notes_assemble_newest_first_under_one_title() {
        let file = |stem: &str, text: &str| (stem.to_string(), text.to_string());
        let md = assemble_release_notes(vec![
            file("0.8.9", "# Tug 0.8.9\n\nNine.\n"),
            file("README", "# Release notes\n\nHow these work.\n"),
            file(
                "0.8.10",
                "# Tug 0.8.10\n\nTen.\n\n## Fixes\n\n```\n# kept\n```\n",
            ),
            file("0.9.0", "# Tug 0.9.0\n\n<!-- Delete this comment -->\n"),
            file("0.8.11", "# Tug 0.8.11\n"),
            file("0.8.0", "# Tug 0.8.0\n\n<!-- a note -->\nFirst.\n"),
        ]);
        assert_eq!(
            md,
            "# Release Notes\n\n## Tug 0.8.10\n\nTen.\n\n### Fixes\n\n```\n# kept\n```\n\n## Tug 0.8.9\n\nNine.\n\n## Tug 0.8.0\n\nFirst.\n"
        );
    }

    #[test]
    fn a_version_is_one_release_notes_unit() {
        let md = "# Release Notes\n\n## Tug 0.8.10\n\nTen.\n\n### Fixes\n\nA fix.\n\n## Tug 0.8.9\n\nNine.\n";
        let units = HelpDoc::ReleaseNotes.units(md);
        let titles: Vec<&str> = units.iter().map(|u| u.title.as_str()).collect();
        assert_eq!(titles, ["Tug 0.8.10", "Tug 0.8.9"]);
        assert_eq!(units[0].anchor, "tug-0810");
        assert!(units[0].text.contains("A fix."));
        assert_eq!(find_unit(&units, "tug-089"), Some(1));
    }

    #[test]
    fn release_notes_read_from_the_bundle_or_beside_a_checkouts_docs() {
        let root = tempfile::tempdir().unwrap();
        let docs = root.path().join("docs");
        std::fs::create_dir(&docs).unwrap();
        let read = |docs: &Path| HelpDoc::ReleaseNotes.read(docs).unwrap();
        assert_eq!(read(&docs), "# Release Notes\n", "no notes is no versions");

        let sibling = root.path().join("release-notes");
        std::fs::create_dir(&sibling).unwrap();
        std::fs::write(sibling.join("1.0.0.md"), "# Tug 1.0.0\n\nBeside.\n").unwrap();
        assert!(read(&docs).contains("Beside."));

        let bundled = docs.join("release-notes");
        std::fs::create_dir(&bundled).unwrap();
        std::fs::write(bundled.join("1.0.0.md"), "# Tug 1.0.0\n\nBundled.\n").unwrap();
        assert!(read(&docs).contains("Bundled.") && !read(&docs).contains("Beside."));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_seed_markers_are_the_release_scripts() {
        let docs = crate::resources::checkout_docs().expect("debug build has a checkout");
        let script = std::fs::read_to_string(docs.parent().unwrap().join("scripts/release.py"));
        let script = script.unwrap();
        for marker in SEED_MARKERS {
            assert!(script.contains(marker), "{marker:?}");
        }
    }

    #[test]
    fn slugs_match_the_help_cards() {
        // The same cases the help card's `helpAnchorSlug` is tested on.
        assert_eq!(help_anchor_slug("Fit and Flow"), "fit-and-flow");
        assert_eq!(help_anchor_slug("Getting help"), "getting-help");
        assert_eq!(help_anchor_slug("Join draft."), "join-draft");
        assert_eq!(
            help_anchor_slug("Changes (tab, shade)."),
            "changes-tab-shade"
        );
        assert_eq!(help_anchor_slug("Tug-Arc trailer."), "tug-arc-trailer");
    }

    #[test]
    fn glossary_entries_are_bold_led_paragraphs() {
        let md = "# Tug glossary\n\nThe words.\n\n**Arc.** A change.\nStill the arc.\n\n**Join draft.** The message.\n";
        let entries = glossary_entries(md);
        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, ["Arc", "Join draft"]);
        assert_eq!(entries[0].text, "**Arc.** A change.\nStill the arc.");
        assert_eq!(entries[1].anchor, "join-draft");
    }

    #[test]
    fn sections_run_to_the_next_heading_and_read_with_their_children() {
        let md = "# Guide\n\nIntro.\n\n## Cards\n\nAbout cards.\n\n```\n# not a heading\n```\n\n### Masthead\n\nThe top.\n\n## Arcs\n\nArcs.\n";
        let sections = heading_sections(md);
        let titles: Vec<&str> = sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["Guide", "Cards", "Masthead", "Arcs"]);
        assert!(sections[0].text.ends_with("Intro."));
        assert!(sections[1].text.contains("# not a heading"));
        assert!(!sections[1].text.contains("The top."));
        let cards = with_subsections(&sections, 1);
        assert!(cards.contains("### Masthead") && !cards.contains("## Arcs"));
        assert_eq!(find_unit(&sections, "#masthead"), Some(2));
        assert_eq!(find_unit(&sections, "ARCS"), Some(3));
        assert_eq!(find_unit(&sections, "nothing"), None);
    }

    #[test]
    fn search_prefers_every_term_then_relaxes_to_any() {
        let md = "**Split.** A slot cut into bands.\n\n**Stack.** A slot of cards.\n\n**Band.** One region.\n";
        let units = glossary_entries(md);
        let (hits, all) = search_units(&units, "what is a split slot", 5);
        assert!(all);
        assert_eq!(hits, [0]);
        let (hits, all) = search_units(&units, "splits", 5);
        assert!(all, "a plural finds its singular");
        assert_eq!(hits, [0]);
        let (hits, all) = search_units(&units, "band zebra", 5);
        assert!(!all);
        assert_eq!(hits[0], 2, "the title match ranks first");
        let (hits, _) = search_units(&units, "the", 5);
        assert!(hits.is_empty(), "question words alone search nothing");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_shipped_documents_open_on_their_headings() {
        // The checkout's copy rather than `docs_dir()`, which a shell spawned
        // under Tug.app resolves to that bundle's resources instead.
        let dir = crate::resources::checkout_docs().expect("debug build has a checkout");
        for doc in HelpDoc::ALL {
            let markdown = doc.read(&dir).unwrap();
            assert!(
                markdown.starts_with("# "),
                "{} has no heading",
                doc.file_name()
            );
            // A comment that does not own its lines would show in the card.
            assert!(
                !markdown.contains("<!--") && !markdown.contains("-->"),
                "{} has a comment that does not own its lines",
                doc.file_name()
            );
            // One left open would swallow the document after it and leave no
            // trace in what was read, so this one looks at the file itself.
            if doc == HelpDoc::ReleaseNotes {
                continue;
            }
            let raw = std::fs::read_to_string(dir.join(doc.file_name())).unwrap();
            assert_eq!(
                raw.matches("<!--").count(),
                raw.matches("-->").count(),
                "{} has a comment left open",
                doc.file_name()
            );
        }
    }
}
