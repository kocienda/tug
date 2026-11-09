//! Markdown stripped to its plain text — the "paste as plain text" and
//! "copy as plain text" transform.
//!
//! [`strip_markdown`] walks the same `pulldown-cmark` the renderer does and
//! keeps only the words: headings lose their `#`, emphasis, strong and
//! strike unwrap, inline and fenced code unwrap, links collapse to their
//! label, images to their alt text, list markers drop, and raw HTML is
//! removed. Block boundaries become a blank line, list items one line each,
//! and a table's cells are tab-separated, one row per line.
//!
//! It parses with its own options rather than [`crate::parser_options`]:
//! smart punctuation would turn the straight quotes and `--` the user
//! copied into typographic ones, and a footnote is not text a paste
//! should rewrite.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

fn plain_options() -> Options {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts
}

/// The separator owed before the next text, if any text has been written.
#[derive(Clone, Copy)]
enum Pending {
    None,
    Cell,
    Line,
    Block,
}

struct Writer {
    out: String,
    pending: Pending,
}

impl Writer {
    fn text(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        if !self.out.is_empty() {
            self.out.push_str(match self.pending {
                Pending::None => "",
                Pending::Cell => "\t",
                Pending::Line => "\n",
                Pending::Block => "\n\n",
            });
        }
        self.pending = Pending::None;
        self.out.push_str(s);
    }

    /// A block opening straight after text (a tight list item's text, then
    /// its nested list) still owes a blank line; a separator already owed
    /// stands.
    fn open_block(&mut self) {
        if matches!(self.pending, Pending::None) {
            self.pending = Pending::Block;
        }
    }
}

/// Strip Markdown formatting from `text`, returning its plain-text content
/// with trailing whitespace trimmed.
pub fn strip_markdown(text: &str) -> String {
    let mut w = Writer {
        out: String::with_capacity(text.len()),
        pending: Pending::None,
    };
    let mut in_html_block = false;

    for event in Parser::new_ext(text, plain_options()) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph
                | Tag::Heading { .. }
                | Tag::BlockQuote(_)
                | Tag::List(_)
                | Tag::Table(_) => w.open_block(),
                Tag::CodeBlock(_) => w.open_block(),
                Tag::HtmlBlock => {
                    w.open_block();
                    in_html_block = true;
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::CodeBlock => {
                    // A fence's content ends on its own newline.
                    while w.out.ends_with('\n') {
                        w.out.pop();
                    }
                    w.pending = Pending::Block;
                }
                TagEnd::HtmlBlock => {
                    in_html_block = false;
                    w.pending = Pending::Block;
                }
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::BlockQuote(_)
                | TagEnd::List(_)
                | TagEnd::Table => w.pending = Pending::Block,
                TagEnd::Item | TagEnd::TableHead | TagEnd::TableRow => w.pending = Pending::Line,
                TagEnd::TableCell => w.pending = Pending::Cell,
                _ => {}
            },
            // Code keeps its own line breaks inside its text.
            Event::Text(s) if !in_html_block => w.text(&s),
            Event::Code(s) => w.text(&s),
            Event::SoftBreak | Event::HardBreak => {
                if !in_html_block {
                    w.out.push('\n');
                }
            }
            Event::Rule => w.pending = Pending::Block,
            // Raw HTML, inline or block, is dropped; a task box is markup.
            Event::Html(_) | Event::InlineHtml(_) | Event::TaskListMarker(_) => {}
            _ => {}
        }
    }

    let trimmed = w.out.trim_end().len();
    w.out.truncate(trimmed);
    w.out
}

#[cfg(test)]
mod tests {
    use super::strip_markdown;

    #[test]
    fn drops_heading_markers() {
        assert_eq!(strip_markdown("# Hello World"), "Hello World");
    }

    #[test]
    fn unwraps_emphasis_strong_strike_and_inline_code() {
        assert_eq!(
            strip_markdown("This is **bold**, *italic*, ~~gone~~ and `code`."),
            "This is bold, italic, gone and code."
        );
    }

    #[test]
    fn links_collapse_to_label_and_images_to_alt() {
        assert_eq!(strip_markdown("[a link](https://x.com)"), "a link");
        assert_eq!(strip_markdown("![alt text](img.png)"), "alt text");
    }

    #[test]
    fn list_items_one_per_line() {
        assert_eq!(strip_markdown("- one\n- two"), "one\ntwo");
        assert_eq!(strip_markdown("1. first\n2. second"), "first\nsecond");
        assert_eq!(strip_markdown("- one\n\n- two"), "one\ntwo");
        assert_eq!(strip_markdown("- [ ] todo\n- [x] done"), "todo\ndone");
    }

    #[test]
    fn nested_list_sits_a_blank_line_under_its_item() {
        assert_eq!(strip_markdown("- a\n  - b\n- c"), "a\n\nb\nc");
    }

    #[test]
    fn unwraps_blockquotes() {
        assert_eq!(strip_markdown("> quoted text"), "quoted text");
    }

    #[test]
    fn fenced_code_keeps_contents_without_fences() {
        assert_eq!(strip_markdown("```js\nconst x = 1;\n```"), "const x = 1;");
        assert_eq!(
            strip_markdown("```\na\n\nb\n```\n\nafter"),
            "a\n\nb\n\nafter"
        );
    }

    #[test]
    fn table_flattens_to_tab_separated_rows() {
        assert_eq!(
            strip_markdown("| a | b |\n| - | - |\n| 1 | 2 |"),
            "a\tb\n1\t2"
        );
    }

    #[test]
    fn raw_html_tags_drop_and_their_text_stays() {
        assert_eq!(
            strip_markdown("before <span>x</span> after"),
            "before x after"
        );
        assert_eq!(strip_markdown("<div>\nhidden\n</div>\n\nshown"), "shown");
    }

    #[test]
    fn blocks_are_separated_by_a_blank_line() {
        assert_eq!(
            strip_markdown("# Title\n\nA paragraph."),
            "Title\n\nA paragraph."
        );
        assert_eq!(strip_markdown("one\n\n---\n\ntwo"), "one\n\ntwo");
    }

    #[test]
    fn line_breaks_inside_a_paragraph_survive() {
        assert_eq!(strip_markdown("line one\nline two"), "line one\nline two");
    }

    #[test]
    fn punctuation_stays_as_typed() {
        assert_eq!(
            strip_markdown("\"quoted\" -- it's"),
            "\"quoted\" -- it's"
        );
    }

    #[test]
    fn plain_text_and_empty_pass_through() {
        assert_eq!(strip_markdown("just plain text"), "just plain text");
        assert_eq!(strip_markdown(""), "");
    }
}
