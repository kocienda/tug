# Dev Mode: Source-Direct Serving

## Problem

Dev mode hot reload is broken. Editing `tugdeck/styles/tokens.css` does not
trigger a live reload in the Mac app, even with Developer Mode enabled and
the source tree set.

The root cause is an architecture gap:

1. Tugcast's file watcher monitors `tugdeck/dist/` (the build output directory)
2. CSS, HTML, and fonts live in `tugdeck/styles/` and `tugdeck/` (the source)
3. A separate script (`watch-assets.ts`) is supposed to copy source files into
   `dist/` so the watcher sees them, but the Mac app never starts it
4. Even if it did, the copy-to-dist architecture is needless indirection for
   files that require no transformation

Six of the eight file types in `dist/` are straight copies of source files.
Only `app.js` (and shiki language chunks) require a build step. The `dist/`
directory exists primarily as a flat staging area for `ServeDir`, not because
the files need processing.

### The duplication problem

The same URL-to-source mapping is currently hardcoded in three separate places:

1. **`watch-assets.ts`** — `FILE_MAPPINGS` array (TypeScript)
2. **`build.rs`** — `fs::copy` calls (Rust)
3. **Any new dev server code** would be a third copy

Adding a CSS file today means updating all three. This is fragile and will drift.

## Proposal

Eliminate `dist/` as the serving directory in dev mode. Instead, have tugcast
serve source files directly from their edit locations. This makes hot reload
work immediately when any source file is saved, with no intermediate copy step.

Centralize the URL-to-source mapping in a single manifest file that all
consumers read: dev serving, production builds, and file watching.

### Current architecture

```
Edit: tugdeck/styles/tokens.css
  |
  v (watch-assets.ts copies -- NOT RUNNING)
  |
Serve: tugdeck/dist/tokens.css
  |
  v (file watcher detects change)
  |
SSE reload → browser reloads
```

### Proposed architecture

```
Edit: tugdeck/styles/tokens.css
  |
  v (file watcher detects change directly)
  |
Serve: tugdeck/styles/tokens.css (mapped via assets.toml)
  |
SSE reload → browser reloads
```

## Design

### The asset manifest: `tugdeck/assets.toml`

A single file that declares how URL paths map to source file locations.
All paths are relative to the `tugdeck/` directory.

```toml
# tugdeck/assets.toml
#
# Asset manifest: maps URL paths to source file locations.
# All source paths are relative to the tugdeck/ directory.
#
# Three consumers read this file:
#   1. tugcast dev mode — serves source files at their URL paths
#   2. tugcast build.rs — copies source files into the embed directory
#   3. tugcast file watcher — derives watch paths from source entries

[files]
"index.html" = "index.html"
"tokens.css" = "styles/tokens.css"
"cards.css" = "styles/cards.css"
"cards-chrome.css" = "styles/cards-chrome.css"
"dock.css" = "styles/dock.css"
"app.css" = "node_modules/@xterm/xterm/css/xterm.css"

[dirs]
"fonts" = { src = "styles/fonts", pattern = "*.woff2" }

# JS build output — files that require compilation live here.
# In dev mode this is a fallback: any request not matched by [files]
# or [dirs] is served from this directory.
[build]
fallback = "dist"
```

Keys in `[files]` are URL path segments (without leading `/`). Values are
source paths relative to `tugdeck/`. Adding a new CSS file means adding one
line. The format is self-documenting and obvious.

### Three consumers, one source of truth

**Consumer 1: Dev serving (tugcast `dev.rs`)**

At startup, tugcast reads `assets.toml` and builds a `HashMap<String, PathBuf>`
from the `[files]` section. The axum handler:

1. Checks the file map — if the URL matches, serves from the source path
2. Checks the `[dirs]` entries — if the URL matches a directory prefix,
   serves the file from that source directory
3. Falls back to `[build].fallback` (i.e. `dist/`) for JS files

`index.html` gets the reload script injected as before.

**Consumer 2: Production build (`build.rs`)**

`build.rs` reads `assets.toml` and replaces its current hardcoded `fs::copy`
calls with a loop over the manifest entries. For each `[files]` entry, it
copies `tugdeck/{src}` to `$OUT_DIR/tugdeck/{key}`. For `[dirs]`, it copies
matching files. For JS, it still runs `bun build` to produce `app.js` in
`$OUT_DIR`. This eliminates the second copy of the mapping.

`build.rs` also declares `cargo:rerun-if-changed` for `assets.toml` so
manifest changes trigger a rebuild.

**Consumer 3: File watcher (tugcast `dev.rs`)**

The watcher derives its watch set from the manifest. It collects the unique
parent directories from all `[files]` source paths, adds the `[dirs]` source
directories, and adds the `[build].fallback` directory. For the current
manifest, this produces:

- `tugdeck/` (for `index.html`)
- `tugdeck/styles/` (for CSS files)
- `tugdeck/styles/fonts/` (for fonts)
- `tugdeck/dist/` (for JS build output)

The existing extension filter (`.html`, `.css`, `.js`) and 300ms debounce
remain unchanged.

### CLI change

Replace the `--dev <dist-path>` flag with `--dev <source-tree>`:

```
# Before
tugcast --dev /u/src/tugtool/tugdeck/dist

# After
tugcast --dev /u/src/tugtool
```

The `--dev` flag now points to the repo root (the source tree), not a build
output directory. Tugcast reads `{source-tree}/tugdeck/assets.toml` at
startup and derives everything from it.

### Mac app changes

`ProcessManager` passes the source tree path directly as `--dev`:

```swift
// TugConfig: remove tugdeckDistRel constant

// ProcessManager.start():
self.devPath = devMode ? sourceTree : nil
// args: ["--dev", sourceTree]    (was: ["--dev", sourceTree + "/tugdeck/dist"])
```

Optionally, `ProcessManager` can also spawn `bun build --watch` as a second
managed process so that JS changes also hot-reload. Without this, only CSS
and HTML changes are live — JS changes require a manual `bun run build` or
a terminal running `bun build --watch` in `tugdeck/`.

### Delete watch-assets.ts

With source-direct serving and the asset manifest, `watch-assets.ts` is
unnecessary. Remove:

- `tugdeck/scripts/watch-assets.ts`
- `tugdeck/scripts/dev.ts` (rewrite to just run `bun build --watch`)
- `package.json` `"dev:assets"` script

The `"dev"` script becomes simply:

```json
"dev": "bun build src/main.ts --outfile=dist/app.js --watch"
```

### Simplify dist/

After this change, `dist/` contains only JS build output:

- `app.js` — the bundled TypeScript
- `*.js` — shiki language grammar chunks
- `*.js.map` — source maps

No more CSS, HTML, or font copies.

## Evolution

The manifest is designed to grow with the project:

- **New CSS file**: Add one line to `[files]`. Dev serving, production build,
  and file watching all pick it up automatically.
- **New asset directory** (e.g. images): Add a `[dirs]` entry.
- **Rename or restructure**: Change the source path in the manifest. One edit,
  all consumers updated.
- **New consumer**: Any tool that needs the asset layout reads `assets.toml`
  instead of guessing or hardcoding.

The manifest is a simple, flat data file with no logic. It can be validated
at build time (does every source path exist?) and at dev startup (warn if
a referenced file is missing).

## Files to change

| File | Change |
|------|--------|
| `tugdeck/assets.toml` | **New** — asset manifest |
| `tugcode/crates/tugcast/src/dev.rs` | Read manifest; route mapper; watch source dirs |
| `tugcode/crates/tugcast/src/server.rs` | Wire new dev route mapper (replaces `ServeDir::new`) |
| `tugcode/crates/tugcast/src/cli.rs` | Update `--dev` help text (source tree, not dist) |
| `tugcode/crates/tugcast/build.rs` | Read manifest instead of hardcoded copies |
| `tugapp/Sources/ProcessManager.swift` | Pass source tree directly as `--dev` value |
| `tugapp/Sources/TugConfig.swift` | Remove `tugdeckDistRel` constant |
| `tugdeck/scripts/watch-assets.ts` | **Delete** |
| `tugdeck/scripts/dev.ts` | Rewrite to just `bun build --watch` |
| `tugdeck/package.json` | Remove `dev:assets` script, simplify `dev` script |

## What this does not change

- **Production serving**: `rust-embed` continues to embed a flat directory
  from `$OUT_DIR/tugdeck/`. The source of what gets copied changes (manifest
  instead of hardcoded), but the output format is identical.
- **Release/CI builds**: `bun build` still outputs to `dist/`. The release
  workflow runs `bun install` + `cargo build` as before.
- **index.html**: No changes to the HTML file or its `<link>`/`<script>` paths.
  The URL paths stay flat; only the server-side mapping changes.
