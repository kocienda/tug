# WASM Crates in tugdeck

*Where Rust-compiled-to-WASM lives in this repo, the workspace shape, the build pipeline, and how to add a new one. Read this before creating a new WASM crate or changing how an existing one builds.*

---

## When a WASM crate is the right answer

Tugdeck is a JS/TypeScript app. Most parsing, formatting, and rendering work stays in JS — adding a WASM crate has real costs (build complexity, async init, an extra crate to maintain, a few hundred KB of bundle weight). A WASM crate earns its place only when **a clear speed-or-correctness win justifies those costs**:

- **Markdown lexing / parsing.** `tugmark-wasm` wraps `pulldown-cmark`. Block-level lex is hot during streaming render; pulldown-cmark is the fastest correct CommonMark+GFM lexer available.
- **Diff computation.** `tugdiff-wasm` wraps `imara-diff`. 10–30× faster than JS alternatives on large inputs; pathological-input safe via histogram + Myers heuristics.

If a candidate workload doesn't have that profile (ANSI parsing, JSON-tree rendering, KaTeX, Mermaid), it stays in JS.

---

## Workspace shape

All WASM crates live as members of a virtual Cargo workspace at `tugdeck/crates/Cargo.toml`. One `Cargo.lock` at `tugdeck/crates/Cargo.lock`. The release profile (`opt-level = 3`, `lto = true`) lives at the workspace root; member-level profiles are ignored in a virtual workspace.

| Crate | Wraps | Exports | Lazy-loaded? |
|---|---|---|---|
| `tugmark-wasm` | `pulldown-cmark` | `lex_blocks`, `parse_to_html`, `parse_blocks_to_html` | No — Session card boot dependency |
| `tugdiff-wasm` | `imara-diff` | `parse_unified_diff`, `two_text_diff` | Yes — first `DiffBlock` mount |

```
tugdeck/crates/
├── Cargo.toml          # virtual workspace; lists members; owns the release profile
├── Cargo.lock          # workspace-wide lock; the only Cargo.lock in tugdeck
├── tugmark-wasm/
│   ├── .gitignore      # one line: "target/"
│   ├── Cargo.toml      # [package] only — no [profile], no [workspace]
│   ├── src/lib.rs
│   └── pkg/            # built artifacts, checked in
│       ├── .gitignore  # empty after build-wasm.sh runs (see below)
│       ├── package.json
│       ├── <name>_bg.wasm
│       ├── <name>_bg.wasm.d.ts
│       ├── <name>.d.ts
│       └── <name>.js
└── tugdiff-wasm/       # same shape
```

**`Cargo.toml` shape per crate** (canonical):

```toml
[package]
name = "<name>"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
# ... the wrapped Rust crate, plus serde + serde-wasm-bindgen if returning structured JS values

# `[profile.release]` lives at the workspace root.
```

The `cdylib` target is what wasm-pack consumes; the `rlib` target lets `cargo test` link plain-Rust unit tests against the crate's non-`#[wasm_bindgen]` core. Both are needed.

**Why standalone, not part of the tugrust workspace?** WASM crates compile to `wasm32-unknown-unknown`, pull a different dependency cluster (wasm-bindgen, serde-wasm-bindgen), and would slow every native `cargo build` if folded into `tugrust/`. Keeping them in their own workspace under `tugdeck/crates/` puts them next to their consumer and out of the native test path.

---

## Build pipeline

### Single driver script + recipe

`scripts/build-wasm.sh` owns the build. It:

1. Globs `tugdeck/crates/*/Cargo.toml` to auto-discover crates.
2. Runs `wasm-pack build --target web --release` on each.
3. Empties each crate's `pkg/.gitignore` so the auto-generated `**` doesn't fight our policy of tracking the built artifacts.

The Justfile recipe is one line:

```just
wasm:
    scripts/build-wasm.sh
```

`just app` depends on `wasm`, so anything that rebuilds the Mac app rebuilds the WASM artifacts first.

### Why the artifacts are checked in

`pkg/` is committed so that:
- A clean `bun run dev` works without requiring contributors to install `wasm-pack`.
- The Tug.app build phase doesn't need a Rust toolchain at codesign time.
- HMR doesn't pause for a multi-second Rust rebuild on a file the developer didn't touch.

The cost: every `just wasm` produces fresh `pkg/` bytes (compiler-version-dependent), and `git status` will show them dirty. Re-add normally (no `-f` needed) when you want the new bytes committed; otherwise `git restore tugdeck/crates/*/pkg/` discards them.

### Vite watcher exclusion

`tugdeck/vite.config.ts` excludes every crate's `pkg/` from Vite's file watcher with one glob:

```ts
watch: {
  ignored: ["**/palette-engine.ts", "**/tugdeck/crates/*/pkg/**"],
},
```

New crates auto-fall under this pattern.

---

## Lazy-loading convention

Every WASM crate that isn't a boot dependency goes through the generic `wasmInit` helper at `tugdeck/src/lib/lazy/wasm-init.ts`. The helper owns the singleton-promise plumbing (one fetch + init shared across callers, reset-on-rejection, test injection hooks). Per-crate loaders declare only the **shape of the engine** and the **dynamic import literal**.

Reference: `tugdeck/src/lib/lazy/load-tugdiff-wasm.ts` is ~25 lines.

```ts
import { wasmInit } from "./wasm-init";

const loader = wasmInit<MyEngine, typeof import("../../../crates/my-wasm/pkg/my_wasm.js")>(
  () => import("../../../crates/my-wasm/pkg/my_wasm.js"),
  (mod) => ({ /* typed wrapper around mod's exports */ }),
);

export const loadMyWasm = loader.load;
export const resetMyWasmForTests = loader.reset;
export const injectMyWasmForTests = loader.inject;
```

`tugmark-wasm` is the exception: it's a boot dependency, statically imported and initialized in `main.tsx`. New crates default to lazy.

---

## Tests

WASM crates test their **plain-Rust core**, not the `#[wasm_bindgen]` shells:

```sh
cd tugdeck/crates
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Pattern: write the work as a regular Rust function (e.g. `parse_unified_diff_text(&str) -> Vec<DiffHunk>`), test it with native unit tests, and write the `#[wasm_bindgen]` export as a thin shell that calls it and serializes the result. This keeps the tests fast (no wasm runtime) and the test surface honest (the algorithm, not the FFI).

`-D warnings` is enforced by clippy on every workspace check.

---

## Adding a new WASM crate (3 steps)

1. **Drop the crate.** Create `tugdeck/crates/<name>/` with `Cargo.toml` (canonical shape above), `src/lib.rs`, `README.md`, `.gitignore` (one line: `target/`). Append `<name>` to the `members` list in `tugdeck/crates/Cargo.toml`.
2. **Wire the consumer.** For lazy crates, add `tugdeck/src/lib/lazy/load-<name>.ts` (~25 lines via `wasmInit`). For boot crates, follow `main.tsx`'s `tugmark-wasm` import pattern.
3. **Document.** Update this file's "The crates" table.

The build script and Vite watcher pick up the new crate automatically. `cargo test --workspace` and `cargo clippy --workspace -- -D warnings` cover it. No Justfile edit. No watcher list edit. No per-crate `Cargo.lock`. No `git add -f`.

---

## Files in scope

| File | Role |
|---|---|
| `tugdeck/crates/Cargo.toml` | Virtual workspace; member list; `[profile.release]`. |
| `tugdeck/crates/Cargo.lock` | Workspace-wide lock — the only Cargo.lock in tugdeck. |
| `tugdeck/crates/<name>/Cargo.toml` | Per-crate manifest. `cdylib + rlib`, `wasm-bindgen`, deps. No profile. |
| `tugdeck/crates/<name>/src/lib.rs` | Plain Rust core + `#[wasm_bindgen]` export shells. |
| `tugdeck/crates/<name>/pkg/` | wasm-pack output. Tracked normally; `pkg/.gitignore` is empty. |
| `tugdeck/crates/<name>/README.md` | Per-crate API shape and build/test pointer. |
| `scripts/build-wasm.sh` | Driver: globs members, runs wasm-pack, normalizes `pkg/.gitignore`. |
| `Justfile` `wasm` recipe | One-liner shelling to the script. |
| `Justfile` `app` recipe | Depends on `wasm`; ensures Tug.app builds always include current WASM. |
| `tugdeck/vite.config.ts` | One glob entry: `**/tugdeck/crates/*/pkg/**`. |
| `tugdeck/src/lib/lazy/wasm-init.ts` | Generic singleton-promise helper for lazy crates. |
| `tugdeck/src/lib/lazy/load-<name>.ts` | Per-crate loader, ~25 lines via `wasmInit`. |

---

## Cross-references

- [`tugdeck/crates/tugmark-wasm/`](../tugdeck/crates/tugmark-wasm/) — reference implementation #1 (boot dependency, statically imported).
- [`tugdeck/crates/tugdiff-wasm/README.md`](../tugdeck/crates/tugdiff-wasm/README.md) — reference implementation #2 (lazy-loaded; serde-wasm-bindgen for structured returns).
- [`scripts/build-wasm.sh`](../scripts/build-wasm.sh) — the build driver (heavy comments explaining each step).
- [`tugdeck/src/lib/lazy/wasm-init.ts`](../tugdeck/src/lib/lazy/wasm-init.ts) — the lazy-loader helper.
- [`Justfile`](../Justfile) `wasm` recipe.
