# tuggraphics-wasm

The page's `#[wasm_bindgen]` shell over [`tuggraphics`](../tuggraphics/README.md). It is lazy-loaded through `tugdeck/src/lib/lazy/load-tuggraphics.ts` on the first chart, never by `main.tsx` (see [tuglaws/wasm-crates.md](../../../tuglaws/wasm-crates.md)).

- `render_program(source, id_prefix)` — validates and renders a layer 0 program in deck mode.
- `compile_round(source, opts_json, table_json)` — one round of the measure protocol: the deck calls it with the measurements it has, and it answers with the texts it still needs, the finished chart, or every error.
- `validate(source, layers)` — every error in a source, for a door taking `"chart"` (a fence: chart specs only) or `"any"` (a tool's output: a layer 0 program too).
- `find_text(source, layers)` — the text transcript Find counts: a chart's table text, a drawing's nothing, an invalid source's own text.

Each returns a plain object tagged by `status`. The work lives in plain functions tested natively; the exports only serialize.

```bash
cd tugdeck/crates
cargo test -p tuggraphics-wasm
just wasm        # rebuilds pkg/, which is committed with its source
```
