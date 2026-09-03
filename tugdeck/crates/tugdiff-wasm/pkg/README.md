# tugdiff-wasm

`imara-diff` bindings compiled to WebAssembly for use in tugdeck. Powers the
`DiffBlock` body kind in the Dev assistant renderer (see
[tuglaws/wasm-crates.md](../../../tuglaws/wasm-crates.md)).

## Why a WASM crate?

- `imara-diff` is the fastest known Rust diff library — 10–30× faster than the
  `similar` crate on Linux-kernel-scale inputs, with histogram + Myers
  algorithms that are stable on pathological input.
- Diffing is the one renderer-stage workload where the speed/correctness win is
  large enough to justify a WASM crate. Other parsers (ANSI, JSON tree, inline
  math) stay in JS — see
  [tuglaws/wasm-crates.md](../../../tuglaws/wasm-crates.md#when-a-wasm-crate-is-the-right-answer).

## API

Both functions return JS arrays of structured hunks. The shape:

```ts
type DiffHunk = {
    before_start: number;   // 1-based line number in `before` (0 if hunk has no removed lines)
    before_count: number;
    after_start: number;    // 1-based line number in `after`  (0 if hunk has no added lines)
    after_count: number;
    header: string;         // text after the closing `@@` (often empty)
    lines: DiffLine[];
};

type DiffLine = {
    kind: "context" | "add" | "remove";
    content: string;        // line text without trailing newline; the leading +/-/space marker is stripped
    before_lineno: number | null;
    after_lineno: number | null;
};
```

### `parse_unified_diff(text: string): DiffHunk[]`

Parses an existing unified-diff string (e.g. output of `git diff` or a
`tool_use` block from the assistant). Skips `---` / `+++` file headers and
`\ No newline at end of file` markers.

### `two_text_diff(before: string, after: string): DiffHunk[]`

Computes a diff between two text inputs using the Histogram algorithm with
indentation-aware postprocessing for human-readable output.

## Build

The crate ships built artifacts under `pkg/` so consumers do not need
`wasm-pack` installed. To rebuild:

```sh
just wasm
```

(see the project root `Justfile`). This invokes `wasm-pack build --target web
--release` for both `tugmark-wasm` and `tugdiff-wasm`, emitting `pkg/` into
each crate directory.

## Tests

```sh
cd tugdeck/crates/tugdiff-wasm
cargo test
```

The tests run as native Rust unit tests against the plain-Rust core
(`compute_two_text_hunks`, `parse_unified_diff_text`); the `#[wasm_bindgen]`
shells are thin wrappers and are exercised through tugdeck integration once
loaded by Vite.
