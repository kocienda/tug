# tugmark drift corpus

The documents the page's markdown pipeline and tugcast's native one are held equal on.

- `constructs/` — one document per markdown construct group the transcript renders.
- `hostile/` — markup the sanitizer must refuse, one document per attack family.
- `dompurify/payloads.json` — DOMPurify's own regression payloads (`test/fixtures/expect.mjs` at the pinned `dompurify` version, under its MPL-2.0 OR Apache-2.0 license), vendored by `tugdeck/scripts/import-dompurify-fixtures.ts`. They are not golden cases: DOMPurify's expected outputs assume its default config, so both sides hold every payload to the sanitizer invariant instead (`tugrust/crates/tugcast/tests/tugmark_invariant.rs`, `tugdeck/src/lib/markdown/__tests__/sanitize-invariant.test.ts`). Re-vendor them when the pin moves.
- `streams/source.md` — the text the catalog-shaped streams are filled from. The stream-json catalog redacts every delta to `{{text:len=N}}`, so a stream case replays the delta sequence of a captured turn and fills each delta with the next `N` bytes of this document.
- `highlight/fixtures.json` — one fenced-code fixture per grammar tugcast highlights. `salient` lists the tokens both highlighters slot alike, with the `tug-syn-*` slot each must land in. `diverges` pins each token the two slot differently, as `[token, tugcast's slot, the page's slot]`, where `null` means no span of its own. tugmark's `highlight.rs` and the page's `language-registry.test.ts` both read it, and each asserts its own column. Each side also asserts that the two lists name every code slot it writes, so tree-sitter and Lezer are held to one slot vocabulary, with every known fork written down. It is not part of the golden: the golden renders with highlighting off.

`golden.json` is derived: `tugrust/crates/tugcast/tests/tugmark_drift.rs` writes it from this directory and the newest catalog version, and both drift tests read it. Regenerate it with `just tugmark-golden`; review its diff like any other change, because a changed golden is a changed rendering.
