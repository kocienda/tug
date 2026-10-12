//! tugmark-wasm — the page's `#[wasm_bindgen]` shell over `tugmark`.
//!
//! Every function here forwards to the shared crate, which tugcast also
//! links natively, so the page and tugcast lex, hash and render with one
//! implementation. The exported JS surface is unchanged by the split.
//!
//! # API
//!
//! - [`lex_blocks`] — lex markdown into packed binary block metadata (4 × u32 per block)
//! - [`lex_block_hashes`] — FNV-1a 64-bit content hash per block (2 × u32 per block;
//!   block ordering matches [`lex_blocks`] exactly)
//! - [`parse_to_html`] — parse a single fragment to an HTML string (no cross-block linking)
//! - [`parse_blocks_to_html`] — parse a whole document in one pass and emit per-block HTML
//!   so cross-block features (notably footnote ref ↔ definition linking) work correctly.

use wasm_bindgen::prelude::*;

/// Lex markdown into packed binary block metadata.
/// Returns Vec<u32> — 4 words per block. JS receives a Uint32Array.
#[wasm_bindgen]
pub fn lex_blocks(text: &str) -> Vec<u32> {
    tugmark::lex_blocks(text)
}

/// Parse a markdown fragment to HTML, with no cross-block linking.
#[wasm_bindgen]
pub fn parse_to_html(text: &str) -> String {
    tugmark::parse_to_html(text)
}

/// Parse a whole markdown document in one pass and emit one HTML string
/// per top-level block, in [`lex_blocks`]'s order.
#[wasm_bindgen]
pub fn parse_blocks_to_html(text: &str) -> Box<[JsValue]> {
    tugmark::parse_blocks_to_html(text)
        .iter()
        .map(|html| JsValue::from_str(html))
        .collect::<Vec<_>>()
        .into_boxed_slice()
}

/// FNV-1a 64-bit content hash per top-level block, 2 words per block
/// (low, high), in [`lex_blocks`]'s order.
#[wasm_bindgen]
pub fn lex_block_hashes(text: &str) -> Vec<u32> {
    tugmark::collect_block_hashes(text)
}
