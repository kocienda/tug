# tugmark

The markdown core shared by the page and tugcast: the canonical top-level block walk over `pulldown-cmark`, the packed block metadata, per-block FNV-1a 64 content hashes over each block's source bytes, and per-block HTML from one whole-document pass.

- `tugmark-wasm` is the page's `#[wasm_bindgen]` shell over it.
- tugcast depends on it natively with the `native` feature, which carries what only tugcast links. The default features must compile to `wasm32-unknown-unknown`.

Because both sides run this one crate with one pinned `pulldown-cmark`, a block hash computed in either place is the same hash.

It is a plain `rlib`, not a WASM crate: `scripts/build-wasm.sh` builds only the crates that declare a `cdylib`, so this one has no `pkg/`.

```bash
cd tugdeck/crates
cargo test -p tugmark
cargo build --target wasm32-unknown-unknown -p tugmark
```
