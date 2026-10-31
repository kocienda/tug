//! Cutting a markdown document into the sections a reader would name.

use std::collections::HashSet;

/// What the text before a document's first heading is addressed by.
const PREAMBLE_SLUG: &str = "top";

/// What a heading with no letters or digits in it is addressed by.
const BARE_SLUG: &str = "section";

/// One heading and the text under it, up to the next heading of any level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    /// The headings above and including this one, joined by ` > `. Empty for the
    /// text before the first heading.
    pub heading_path: String,
    /// Unique within the document.
    pub slug: String,
    /// The 1-based line of the heading, or of the first line of text ahead of
    /// any heading.
    pub line: usize,
    /// The section's text, its heading line included.
    pub text: String,
}

/// A document's sections, cut at ATX headings outside code fences, with the text
/// before the first heading as a section of its own when there is any.
pub fn markdown_sections(text: &str) -> Vec<Section> {
    let mut cutter = Cutter::default();
    let mut fence = None;
    let mut offset = 0;
    for (index, line) in text.split_inclusive('\n').enumerate() {
        fence = next_fence(fence, line);
        if fence.is_none()
            && let Some((level, title)) = atx_heading(line)
        {
            cutter.close(text, offset);
            cutter.open(level, title, index + 1, offset);
        }
        offset += line.len();
    }
    cutter.close(text, offset);
    cutter.sections
}

#[derive(Default)]
struct Cutter {
    sections: Vec<Section>,
    slugs: HashSet<String>,
    /// The open headings, outermost first.
    headings: Vec<(usize, String)>,
    /// Where the section being read starts, and its line.
    start: usize,
    line: usize,
}

impl Cutter {
    fn open(&mut self, level: usize, title: &str, line: usize, start: usize) {
        self.headings.retain(|(open, _)| *open < level);
        self.headings.push((level, title.to_string()));
        self.line = line;
        self.start = start;
    }

    /// End the section being read at `end`.
    fn close(&mut self, text: &str, end: usize) {
        let body = &text[self.start..end];
        let Some(title) = self.headings.last().map(|(_, title)| title.clone()) else {
            self.close_preamble(body);
            return;
        };
        let slug = self.unique_slug(&slug_of(&title));
        let heading_path = self
            .headings
            .iter()
            .map(|(_, title)| title.as_str())
            .collect::<Vec<_>>()
            .join(" > ");
        self.sections.push(Section {
            heading_path,
            slug,
            line: self.line,
            text: body.trim_end().to_string(),
        });
    }

    fn close_preamble(&mut self, body: &str) {
        let Some(blank) = body.lines().position(|line| !line.trim().is_empty()) else {
            return;
        };
        let slug = self.unique_slug(PREAMBLE_SLUG);
        self.sections.push(Section {
            heading_path: String::new(),
            slug,
            line: blank + 1,
            text: body.trim().to_string(),
        });
    }

    fn unique_slug(&mut self, wanted: &str) -> String {
        let wanted = if wanted.is_empty() { BARE_SLUG } else { wanted };
        let mut slug = wanted.to_string();
        let mut suffix = 0;
        while !self.slugs.insert(slug.clone()) {
            suffix += 1;
            slug = format!("{wanted}-{suffix}");
        }
        slug
    }
}

/// A heading's address, by GitHub's rule: lower case, markup and punctuation dropped,
/// whitespace runs to one hyphen.
fn slug_of(title: &str) -> String {
    let kept: String = title
        .to_lowercase()
        .chars()
        .filter(|c| *c != '_')
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-')
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join("-")
}

/// A line with its indent of up to three spaces removed, or `None` when it is
/// indented past that and so is not a heading or a fence.
fn unindented(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches(' ');
    (line.len() - trimmed.len() <= 3).then_some(trimmed)
}

/// The fence open after `line`, given the fence open before it: a fence's character
/// and length, closed only by a line of at least as many of that character.
fn next_fence(open: Option<(char, usize)>, line: &str) -> Option<(char, usize)> {
    let Some(trimmed) = unindented(line) else {
        return open;
    };
    let marker = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'));
    let run = marker.map_or(0, |c| trimmed.chars().take_while(|x| *x == c).count());
    match (open, marker) {
        (None, Some(c)) if run >= 3 => {
            // A backtick fence's info string has no backticks, which is what tells it
            // from inline code at the start of a line.
            let info = &trimmed[run..];
            (c == '~' || !info.contains('`')).then_some((c, run))
        }
        (Some((c, length)), Some(closing))
            if closing == c && run >= length && trimmed[run..].trim().is_empty() =>
        {
            None
        }
        (open, _) => open,
    }
}

/// A line's heading level and title, when it is an ATX heading: up to six `#`s, then
/// a space or the end of the line, with any closing run of `#`s not part of the title.
fn atx_heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = unindented(line)?;
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t', '\r', '\n']) {
        return None;
    }
    let rest = rest.trim();
    let unclosed = rest.trim_end_matches('#');
    let title = if unclosed.is_empty() || unclosed.ends_with([' ', '\t']) {
        unclosed.trim_end()
    } else {
        rest
    };
    Some((level, title))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slugs(sections: &[Section]) -> Vec<&str> {
        sections.iter().map(|s| s.slug.as_str()).collect()
    }

    #[test]
    fn a_document_is_cut_at_its_headings_with_true_lines_and_paths() {
        let sections = markdown_sections(
            "\nIntro words.\n\n# Title\n\nOpening.\n\n## First part\n\nOne.\n\n### Deep\n\nTwo.\n\n## Second part ##\n\nThree.\n",
        );
        let shape: Vec<(&str, &str, usize)> = sections
            .iter()
            .map(|s| (s.heading_path.as_str(), s.slug.as_str(), s.line))
            .collect();
        assert_eq!(
            shape,
            [
                ("", "top", 2),
                ("Title", "title", 4),
                ("Title > First part", "first-part", 8),
                ("Title > First part > Deep", "deep", 12),
                ("Title > Second part", "second-part", 16),
            ]
        );
        assert_eq!(sections[0].text, "Intro words.");
        assert_eq!(sections[2].text, "## First part\n\nOne.");
        assert_eq!(sections[4].text, "## Second part ##\n\nThree.");
    }

    #[test]
    fn a_heading_in_a_fence_is_not_a_heading() {
        let sections = markdown_sections(
            "# Real\n\n```bash\n# a comment\n~~~\n```\n\n~~~~\n## also not\n```\n~~~\n~~~~\n\n## Next\n",
        );
        assert_eq!(slugs(&sections), ["real", "next"]);
        assert_eq!(sections[1].line, 14);
        assert!(sections[0].text.contains("# a comment"));
    }

    #[test]
    fn an_unclosed_fence_runs_to_the_end_of_the_document() {
        let sections = markdown_sections("# Real\n\n```\n## held\n");
        assert_eq!(slugs(&sections), ["real"]);
    }

    #[test]
    fn inline_code_at_the_start_of_a_line_opens_no_fence() {
        let sections = markdown_sections("# A\n\n```x``` is inline.\n\n## B\n");
        assert_eq!(slugs(&sections), ["a", "b"]);
    }

    #[test]
    fn what_only_looks_like_a_heading_is_text() {
        let sections = markdown_sections("#hashtag\n\n####### seven\n\n    # indented\n\n# Real\n");
        assert_eq!(slugs(&sections), ["top", "real"]);
        assert_eq!(sections[0].line, 1);
    }

    #[test]
    fn repeated_headings_get_unique_slugs() {
        let sections = markdown_sections("# Notes\n\n# Notes\n\n# Notes-1\n\n# Notes\n\n# !!!\n");
        assert_eq!(
            slugs(&sections),
            ["notes", "notes-1", "notes-1-1", "notes-2", "section"]
        );
    }

    #[test]
    fn a_blank_document_has_no_sections() {
        assert!(markdown_sections("").is_empty());
        assert!(markdown_sections("\n  \n").is_empty());
    }

    #[test]
    fn a_heading_a_lower_level_follows_closes_what_it_passes() {
        let sections = markdown_sections("# A\n\n### B\n\n## C\n\n# D\n");
        let paths: Vec<&str> = sections.iter().map(|s| s.heading_path.as_str()).collect();
        assert_eq!(paths, ["A", "A > B", "A > C", "D"]);
    }

    #[test]
    fn carriage_returns_are_read_past() {
        let sections = markdown_sections("# A\r\n\r\ntext\r\n## B\r\n");
        assert_eq!(slugs(&sections), ["a", "b"]);
        assert_eq!(sections[1].heading_path, "A > B");
    }
}
