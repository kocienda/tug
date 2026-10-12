//! The native block renderer: the page's `parseMarkdownToSanitizedBlocks`
//! with `DEFAULT_BLOCK_TRANSFORMERS`, run in tugcast.
//!
//! Block walk, per-block HTML and hashes come from the same functions the
//! WASM build exports, so a block's hash is the hash the page computes for
//! it. Sanitization is ammonia from the shared allow-list, and the
//! transformers are byte-identical ports.

use crate::highlight::highlight_fences;
use crate::sanitize::sanitize;
use crate::transform::apply_default_transformers;
use crate::{fnv1a64, for_each_top_level_block, parse_blocks_to_html, TopLevelBlock, TopLevelBlockKind};

/// One rendered top-level block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderedBlock {
    /// FNV-1a 64 over the block's source byte range.
    pub hash: u64,
    /// The page's block `type`: "heading" … "other", or a transformer's
    /// "tug-math-display" / "tug-mermaid".
    pub kind: String,
    /// UTF-16 offsets into the source, as JS string indices.
    pub start_char: u32,
    pub end_char: u32,
    pub depth: u8,
    pub item_count: u16,
    pub row_count: u16,
    /// Sanitized HTML, transformers applied, fences highlighted when asked.
    pub html: String,
}

/// Whether fenced code is highlighted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Highlight {
    /// Fences are left as the sanitizer emits them. What the drift golden
    /// holds.
    Off,
    /// Fences in a language with a grammar here are highlighted natively
    /// and stamped `data-tug-highlighted`.
    On,
}

/// The page's block type name for a lexed block's kind.
fn kind_name(kind: Option<TopLevelBlockKind>) -> &'static str {
    match kind {
        Some(TopLevelBlockKind::Heading) => "heading",
        Some(TopLevelBlockKind::Paragraph) => "paragraph",
        Some(TopLevelBlockKind::Code) => "code",
        Some(TopLevelBlockKind::BlockQuote) => "blockquote",
        Some(TopLevelBlockKind::List) => "list",
        Some(TopLevelBlockKind::Table) => "table",
        Some(TopLevelBlockKind::Html) => "html",
        Some(TopLevelBlockKind::Other) => "other",
        None => "hr",
    }
}

/// `buildByteToCharMap`: index `i` holds the UTF-16 index of the character
/// that UTF-8 byte `i` belongs to, and the last entry is the text's UTF-16
/// length.
pub fn byte_to_utf16_map(text: &str) -> Vec<u32> {
    let mut map = vec![0u32; text.len() + 1];
    let mut utf16 = 0u32;
    for (byte, ch) in text.char_indices() {
        for slot in &mut map[byte..byte + ch.len_utf8()] {
            *slot = utf16;
        }
        utf16 += ch.len_utf16() as u32;
    }
    map[text.len()] = utf16;
    map
}

/// FNV-1a 64 over `text`'s UTF-8 bytes: the hash a rendered message's
/// source is identified by.
pub fn text_hash(text: &str) -> u64 {
    fnv1a64(text.as_bytes())
}

/// Render `text` to its sanitized, transformed top-level blocks.
pub fn render_blocks(text: &str, highlight: Highlight) -> Vec<RenderedBlock> {
    render_blocks_with(text, |_| highlight == Highlight::On)
}

/// [`render_blocks`], highlighting only the blocks `highlight` accepts by
/// hash. A caller that sends HTML only for hashes it has not sent before
/// highlights only those; every other block carries its unhighlighted
/// HTML, which has the same text.
pub fn render_blocks_with(text: &str, highlight: impl Fn(u64) -> bool) -> Vec<RenderedBlock> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut metas: Vec<TopLevelBlock> = Vec::new();
    for_each_top_level_block(text, |block| metas.push(*block));
    if metas.is_empty() {
        return Vec::new();
    }
    let htmls = parse_blocks_to_html(text);
    let map = byte_to_utf16_map(text);
    let bytes = text.as_bytes();
    metas
        .iter()
        .enumerate()
        .map(|(i, meta)| {
            let mut kind = kind_name(meta.kind).to_string();
            let mut html = sanitize(htmls.get(i).map_or("", String::as_str));
            apply_default_transformers(&mut kind, &mut html);
            let hash = fnv1a64(&bytes[meta.start..meta.end]);
            // A fence nests in a list or a quote as well as standing alone.
            if highlight(hash) {
                if let Some(highlighted) = highlight_fences(&html) {
                    html = highlighted;
                }
            }
            RenderedBlock {
                hash,
                kind,
                start_char: map[meta.start],
                end_char: map[meta.end],
                depth: meta.depth,
                item_count: meta.item_count,
                row_count: meta.row_count,
                html,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_for_emoji_and_cjk() {
        let text = "😀 one\n\n漢字 two\n\nthree";
        let blocks = render_blocks(text, Highlight::Off);
        assert_eq!(blocks.len(), 3);
        let utf16: Vec<u16> = text.encode_utf16().collect();
        let slice = |b: &RenderedBlock| String::from_utf16(&utf16[b.start_char as usize..b.end_char as usize]).unwrap();
        assert_eq!(slice(&blocks[0]), "😀 one\n");
        assert_eq!(slice(&blocks[1]), "漢字 two\n");
        assert_eq!(slice(&blocks[2]), "three");
        assert_eq!(blocks[0].start_char, 0);
        assert_eq!(blocks[1].start_char, 8); // 😀 is two code units
        assert_eq!(blocks[2].end_char as usize, utf16.len());
    }

    #[test]
    fn the_map_points_continuation_bytes_at_their_character() {
        let map = byte_to_utf16_map("a😀b");
        assert_eq!(map, vec![0, 1, 1, 1, 1, 3, 4]);
    }

    #[test]
    fn blocks_carry_the_shared_hashes_kinds_and_counts() {
        let text = "# Title\n\n- a\n- b\n\n| x |\n|---|\n| 1 |\n\n---\n";
        let blocks = render_blocks(text, Highlight::Off);
        let hashes: Vec<u64> = crate::collect_block_hashes(text)
            .chunks(2)
            .map(|w| (w[0] as u64) | ((w[1] as u64) << 32))
            .collect();
        assert_eq!(blocks.iter().map(|b| b.hash).collect::<Vec<_>>(), hashes);
        let kinds: Vec<&str> = blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["heading", "list", "table", "hr"]);
        assert_eq!(blocks[0].depth, 1);
        assert_eq!(blocks[1].item_count, 2);
        assert_eq!(blocks[2].row_count, 1);
        assert_eq!(blocks[0].html, "<h1>Title</h1>\n");
    }

    #[test]
    fn fenced_math_and_mermaid_are_transformed() {
        let blocks = render_blocks("```math\nx^2\n```\n\n```mermaid\nA-->B\n```\n", Highlight::Off);
        assert_eq!(blocks[0].kind, "tug-math-display");
        assert!(blocks[0].html.contains(">x^2</div>"), "{}", blocks[0].html);
        assert_eq!(blocks[1].kind, "tug-mermaid");
        assert!(blocks[1].html.contains(">A-->B</div>"), "{}", blocks[1].html);
    }

    #[test]
    fn raw_html_is_sanitized_per_block() {
        let blocks = render_blocks("para\n\n<script>alert(1)</script>\n", Highlight::Off);
        assert!(blocks.iter().all(|b| !b.html.contains("script")));
    }

    #[test]
    fn text_hash_is_fnv_over_utf8() {
        assert_eq!(text_hash("a"), 0xaf63_dc4c_8601_ec8c);
    }
}
