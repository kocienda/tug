<!-- devise-skeleton v4 -->

## Files: broaden Text Files to viewable file types {#files-feature}

**Purpose:** Tug.app becomes a macOS *viewer* of images and PDFs alongside its existing role as an *editor* of text: a streaming byte route in tugcast, a read-only `file-view` card, a kind-aware open chokepoint, the Lens **Text Files** section renamed to **Files**, and the Swift-side type gates + Info.plist registration widened to match.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-31 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug currently opens exactly one kind of file: UTF-8 text into a Text card. That assumption is enforced at four narrow chokepoints — the Swift constant `AppDelegate.editableContentTypes` (`tugapp/Sources/AppDelegate.swift`, gating ⌘O's `NSOpenPanel`, the Finder/Dock `application(_:open:)` filter via `isEditableFile`, and the `choosePath` bridge panel), the single `CFBundleDocumentTypes` entry in `tugapp/Info.plist` ("Text Document", role Editor), the frontend open chokepoint `openFileInCard()` (`tugdeck/src/lib/open-file-in-card.ts`, which unconditionally creates a `"text"` card), and the tugcast read route `GET /api/fs/read` (`tugrust/crates/tugcast/src/fs_read.rs`, which rejects non-UTF-8 content with a 422 `"binary"` error and caps at 8 MiB).

There is no reason the deck can't *display* other file types. The rendering half already exists: `ImageBlock` (`tugdeck/src/components/tugways/body-kinds/image-block.tsx`) is a finished inline image viewer (lazy-load, EXIF orientation via `image-orientation: from-image`, click-to-fullscreen portal, `data-tugx-image-status` states), and WKWebView renders PDFs natively in an `<embed>`/`<iframe>`. The genuinely missing piece is byte serving — no tugcast route serves raw file bytes. Tug should register with macOS as a **Viewer** (role Viewer, rank Alternate) of the new types, while remaining an Editor of text only.

#### Strategy {#strategy}

- Add one streaming byte route (`GET /api/fs/blob`) to tugcast; viewer cards consume it as a plain URL (`<img src>`, `<embed src>`). No base64, no buffering, no size cap.
- Add one read-only card, componentId `file-view`, whose body branches on file kind — not one card per kind. One registry entry, one seed shape, one open-registry story.
- Classify by extension in one shared TS module (`lib/file-kinds.ts`); branch inside `openFileInCard()` so every open path (⌘O, Open Recent, Open Quickly, Finder, transcript links, context menus) inherits the routing for free.
- Rename the Lens section **Text Files** → **Files**; widen its data source from `componentId === "text"` to text + `file-view`; migrate the persisted section kind via the existing `KIND_MIGRATIONS` mechanism.
- Split the Swift type gate into editable (unchanged) + viewable, union for the open panels and the OS open path; add a second Info.plist document type with role **Viewer**.
- Ship in two milestones: images first (every rendering piece exists), PDF second (the native-embed experiment).

#### Success Criteria (Measurable) {#success-criteria}

- ⌘O's panel allows selecting a `.png`; choosing one mounts a `file-view` card that renders the image (app-test asserts the mounted `<img>` reaches `naturalWidth > 0` through the real `/api/fs/blob` fetch).
- Opening the same image path twice fronts the existing `file-view` card instead of opening a second (app-test: card count unchanged after second `open-file` dispatch).
- The Lens **Files** section lists text cards and viewer cards together; a viewer row shows no unsaved dot and its close box closes the card (app-test).
- `curl` against `/api/fs/blob` returns correct `Content-Type`, honors a `Range: bytes=` request with `206` + `Content-Range`, answers a matching `If-None-Match` with `304`, and refuses a secret-filtered path with `403` (Rust unit tests).
- A file larger than 8 MiB (the `fs_read` cap) streams successfully through `/api/fs/blob` (Rust unit test with a >8 MiB temp file).
- Finder "Open With ▸ Tug" on a PNG opens it in a viewer card (manual verification; the `isOpenableFile` unit path is covered by the Swift build).
- A persisted deck whose lens state used kind `text-files` (collapse/order) hydrates into kind `files` without loss (unit test on `migrateKinds`).
- `Save…` / `Save As…` / `Revert to Saved` validate disabled while a `file-view` card is frontmost (follows from `menuState.file` being nil for non-text cards — no new code; verified manually in M01 checkpoint).

#### Scope {#scope}

1. tugcast: streaming `GET /api/fs/blob` route with Range, ETag, and a per-extension Content-Type table.
2. tugdeck: `lib/file-kinds.ts` classifier; `file-view` card (registration, body, open registry); kind branch in `openFileInCard`.
3. Lens: section rename to **Files**, widened data source, per-kind row glyphs, kind migration.
4. Swift: `viewableContentTypes` + `openableContentTypes` split; ⌘O panel and `isEditableFile`/OS-open filter widened; Info.plist "Viewable Document" Viewer entry.
5. PDF as a second milestone: classifier entry, `<embed>` body branch, `.pdf` UTI additions.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Editing** any new type. Viewer cards are strictly read-only: no dirty state, no save plumbing, no autosave, no `menuState.file` block.
- Video and audio. The blob route's Range support is deliberately the seam they would use later, but no player card ships in this phase.
- Camera RAW (NEF/CR3/DNG), PSD, and other formats WebKit's `<img>` can't reliably decode — see [P01].
- Thumbnails or previews in the Lens rows.
- Changing the drop/paste image pipeline (`tug-text-editor/drop-extension.ts`, `image-downsample.ts`) — attachments into a prompt are a different feature with different constraints (base64 into Claude context).
- pdf.js. Native WKWebView PDF rendering first; see [Q01].
- The `<input type="file">` WKWebView panel (`MainWindow.swift`) — it already has no type restriction.
- SC/TC CJK font additions, `New Text File…` changes, or any other File-menu restructuring.

#### Dependencies / Prerequisites {#dependencies}

- None external. All work is in-repo: tugcast (Rust), tugdeck (TS), tugapp (Swift), Info.plist.
- `tokio-util` is already a tugcast dependency (workspace), so `ReaderStream` is available for the streaming body.

#### Constraints {#constraints}

- Rust workspace enforces `-D warnings`; `cargo build` fails on any warning.
- tugdeck: bun only, verify with `bunx tsc --noEmit` AND `bunx vite build` (the debug app loads the production rollup bundle; a dev-only-clean import can hang the app at the splash screen).
- Frontend persistent state goes through tugbank `/api/defaults/<domain>/<key>` — never localStorage/sessionStorage/IndexedDB.
- Compose real `Tug*` components; never hand-roll UI that exists as one.
- App-tests: selective runs via `just app-test-changed`; every new test carries `@covers`; never run the full corpus.
- New app-test files take the next free `atNNNN` number in `tests/app-test/` — check the directory before naming.
- `LSMinimumSystemVersion` is 15.0, so every `UTType` static used here (`.webP`, `.heic`, `.heif`, `.avif`, `.ico`, `.bmp`, `.tiff`, `.pdf`) is available.

#### Assumptions {#assumptions}

- WebKit on macOS 15+ natively decodes all nine image formats in [Table T01] in an `<img>` element (HEIC/HEIF and AVIF included).
- WKWebView renders a PDF loaded into an `<embed>`/`<iframe>` with its built-in PDF support ([Q01] validates this in M02 before committing to it).
- The page origin serves `/api/*` in both serving modes: tugcast serves the built frontend directly, and the Vite dev server proxies `/api` to tugcast (`tugdeck/vite.config.ts` proxy config) — so a relative `/api/fs/blob?...` URL works everywhere, including app-tests (which always serve the production bundle).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Table T##` / `List L##` / `Risk R##` / `Milestone M##` stable labels, `**Depends on:**` lines citing `#step-N` anchors, and `**References:**` lines on every step. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Is WKWebView's native embedded PDF view good enough? (OPEN → resolved by M02 spike) {#q01-native-pdf}

**Question:** Does a PDF loaded into an `<embed>` inside the deck's WKWebView render with acceptable scrolling, zooming, and text selection, or does it need pdf.js?

**Why it matters:** Native rendering is zero new dependencies and zero bundle weight; pdf.js is a large vendored dependency with its own worker/wasm loading story (and the tugcode wasm-embed history shows bundled-worker loading is a real hazard).

**Options (if known):**
- Native `<embed src="/api/fs/blob?path=…">` (first choice).
- pdf.js rendering to canvas (fallback, deferred).

**Plan to resolve:** Step `#step-8` opens a real multi-page PDF in the built app and evaluates scroll/zoom/selection before the M02 commit. If native is inadequate, M02 stops after the classifier/UTI work and a follow-on plan covers pdf.js.

**Resolution:** **Native rendering is good; native *control* does not exist.** The hands-on pass plus a probe of the plugin's surface split the question cleanly in two.

Working, on real documents: page rendering, continuous scroll, and text selection.

Not available, and not reachable from the deck — measured, not assumed:

**Table T02: What WebKit's PDF plugin exposes to an embedding page** {#t02-pdf-plugin-surface}

| Capability | Result | How it was measured |
|---|---|---|
| Render / scroll / select | works | hands-on, and the `#step-8` screenshot |
| Arrow keys, PageUp/Down | **no effect** | 8 ArrowDown + 2 PageDown produced byte-identical screenshots |
| DOM focus on the embed | **refused** | `activeElement` stays the host `div` after a scripted `.focus()`, after `tabindex="0"` + `.focus()`, and after a real native click |
| `contextmenu` in JS | **never fires** | no listener runs — not on the embed, not on `document` |
| Native right-click menu | none appeared | screenshot after a native right-click |
| `#page=`, `#zoom=`, `#view=` open parameters | **ignored** | four fragments set on `src`; the view never left page 1 |

The plugin is a black box: no DOM, no events, no parameters. There is nothing to hang a menu on, and nothing to command if there were. Zoom, page navigation, and the Continuous Scroll / Single Page / Two Pages modes therefore cannot be added over it at any price — and a card that refuses focus outright is an outlier in a deck whose focus language is keyboard-first ([L22]). Zoom being app-wide is the same root cause: with no card-level viewer to scope it, ⌘+ reaches WebKit's page zoom.

Getting those capabilities means owning the rendering, which is the **pdf.js** follow-on this plan already anticipated (#roadmap). That is a plan-sized piece of work — lazy-loaded so only a PDF open pays the bundle, worker wiring verified under `vite build` (the tugcode wasm-embed history is the precedent for treating bundled workers as a hazard), canvas plus text layer, and chrome built from real `Tug*` components.

What M02 ships meanwhile is an honest read-only reader: it renders faithfully and selects text, and it cannot be driven from the keyboard.

**Superseded.** The pdf.js follow-on shipped on this same dash — see [dash/pdf-viewer-plan.md](pdf-viewer-plan.md). The `<embed>` is gone; the card renders PDFs itself, with the keyboard, the three page modes, a card-scoped zoom, and the right-click menu. One correction to the reasoning above: the app-wide zoom was **not** WebKit page zoom falling through for want of a card-level viewer. ⌘+ / ⌘- / ⌘0 are the host's View-menu key equivalents, which AppKit resolves before the web view is offered the keydown — so no deck-side viewer could have claimed them by rendering. The surface claims them explicitly instead, via a `menuState.document` block the host reads.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Native PDF embed inadequate (R01) | med | med | Spike in `#step-8` before committing UI; classifier work still lands | Scroll/zoom/selection unusable in the spike |
| Type tables drift between Rust/TS/Swift (R02) | med | med | One canonical table [T01]; unit tests on both Rust and TS tables enumerate the same extension list | Any addition of a new file kind |
| Giant image stalls WebKit decode (R03) | low | low | None — same exposure Preview has; transport streams so the app stays responsive | User report |
| Persisted lens state lost in kind rename (R04) | med | low | Existing `KIND_MIGRATIONS` mechanism + unit test | Hydration bug report |

**Risk R01: Native PDF rendering falls short** {#r01-native-pdf}

- **Risk:** The M02 embed renders but scrolls/zooms poorly inside a card.
- **Mitigation:** Spike before commit (`#step-8`); M02's classifier/UTI/plist work is independent of the render choice and still lands.
- **Residual risk:** PDF viewing quality is bounded by WebKit until a pdf.js follow-on.

**Risk R02: Three type tables drift** {#r02-table-drift}

- **Risk:** The extension/UTI/MIME table exists in TS (`file-kinds.ts`), Rust (`fs_blob.rs`), and Swift (`viewableContentTypes`); an addition to one side silently misses another (e.g. the panel allows a type the classifier routes to text, which then 422s).
- **Mitigation:** [Table T01] is the single source of truth in this plan; both the Rust and TS unit tests assert their table covers exactly T01's extension list, so adding a kind on one side fails the other side's test reminder only if touched — the real guard is the T01-enumeration tests added in `#step-1` and `#step-2`.
- **Residual risk:** Swift has no cheap table test; a Swift-side omission surfaces as a file the panel refuses that Finder-open would accept. Acceptable — both funnel to the same TS classifier.

---

### Design Decisions {#design-decisions}

#### [P01] Closed per-type allowlist, never bare `public.image` conformance (DECIDED) {#p01-closed-allowlist}

**Decision:** Every gate (Swift UTTypes, TS extensions, Rust MIME table) enumerates the exact types in [Table T01]; no gate uses a `conforms(to: .image)` umbrella test.

**Rationale:**
- Camera RAW UTIs (NEF, CR3, DNG) conform to `public.image`; a conformance test would let the panel offer files WebKit's `<img>` cannot reliably decode.
- Everything Tug claims in Launch Services, it must actually render.

**Implications:**
- Adding a format later = one row in T01 mirrored to three tables (guarded per [R02]).
- Swift's `isOpenableFile` uses `contains`-style membership over the enumerated viewable list unioned with the existing text-conformance test (text keeps `conforms(to:)` — that umbrella is correct for text).

#### [P02] One read-only `file-view` card, kind-branched body (DECIDED) {#p02-one-viewer-card}

**Decision:** A single new componentId `file-view` renders all viewable kinds; the body branches on the classified kind of its bound path.

**Rationale:**
- One registry entry, one seed shape (`{ path }`), one open-registry, one Lens-filter widening; a future kind is a branch, not a card.
- Distinct per-kind size policies aren't needed: images and PDFs both want the Text-card-like stature.

**Implications:**
- Strictly read-only: no dirty state, no autosave, no save plumbing, no `menuState.file` publication — which is exactly why the File-menu save verbs self-disable (Swift's `validateMenuItem` for `file.save`/`file.saveAs`/`file.revertToSaved`/`file.reloadFromDisk` all bail when `menuState.file` is nil, and only the Text card publishes that block via `host-menu-state.ts`).
- `engineKind` stays default (no `"em"`): there is no editing surface to claim focus; the generic default-focus walk is correct.

#### [P03] Byte serving streams; no size cap; Range + ETag (DECIDED) {#p03-streaming-blob}

**Decision:** `GET /api/fs/blob?path=` streams the file from disk (`tokio_util::io::ReaderStream` over `tokio::fs::File`, `Content-Length` from metadata) with **no size cap**, honors single-range `Range:` requests (`206` + `Content-Range`), serves an `ETag` derived from `mtime + size` and answers matching `If-None-Match` with `304`, sets `Content-Type` from the [T01] extension table plus `X-Content-Type-Options: nosniff`, and refuses unknown extensions rather than serving `application/octet-stream`.

**Rationale:**
- `fs_read`'s 8 MiB cap exists because that route buffers into a JSON string; a streaming route has constant memory, so a cap would only be an arbitrary failure for the first big TIFF.
- Range is what WKWebView's native PDF view uses to page large documents, and is the seam video/audio need later.
- ETag makes card re-mounts revalidate instead of re-pulling megabytes.
- No sniffing: the route serves only what the classifier routes, one table on both sides.

**Implications:**
- Reuses `fs_read.rs`'s shared guards verbatim: `guard_absolute_path` (absolute-only, `~` expansion, `..` rejection, secret-filter denial via `is_secret_path`), loopback-only check, regular-file check.
- Errors are HTTP-status-shaped (an `<img>` can't read a JSON error body): 403/404/400 with the shared `fs_error` JSON body for tooling, but the status code is the contract.

#### [P04] `openFileInCard()` is the single kind-routing point (DECIDED) {#p04-chokepoint-routing}

**Decision:** The kind branch lives at the top of `openFileInCard()` in `tugdeck/src/lib/open-file-in-card.ts`; the `open-file` action handler in `action-dispatch.ts` and every other producer stay untouched.

**Rationale:**
- Every real open already flows through this function (its own docstring: Control frames, transcript links, DeckCanvas chain handler, Open Quickly) — branch once, inherit everywhere.

**Implications:**
- Viewable kinds get path-keyed reuse mirroring the text path: an existing `file-view` card bound to the path is activated via `transferFocusForActivation` (same save-before-activation discipline, per the [L23] comment already in the function); otherwise a new card. The `openTarget` defaults (`reuse`/`newTab`/`new` from `TEXT_CARD_DEFAULTS_DOMAIN`) apply to viewers the same way, with `reuse` rebinding a frontmost `file-view` card (viewers are never dirty, so the dirty-guard clause is vacuous for them).
- `noteRecentDocument(path)` continues to run for **all** kinds — viewed files belong in Open Recent; replay routes back through `open-file` → this same branch.
- `line`/`endLine` are ignored for viewable kinds.

#### [P05] Lens section renamed to Files, kind `files`, migrated (DECIDED) {#p05-lens-files}

**Decision:** The section registers as `kind: "files"`, `title: "Files"`; the data source includes cards with `componentId === "text"` or `componentId === "file-view"`; the persisted-kind rename rides the existing `KIND_MIGRATIONS` map in `lens-store.ts` (`"text-files" → "files"`, joining the existing `"changeset" → "sessions"` entry).

**Rationale:**
- `KIND_MIGRATIONS` exists precisely for this: it remaps persisted `sectionOrder` and `collapsedSections` kinds on hydrate and self-heals on the next mutation.

**Implications:**
- The tugbank value key string `textFileOrder` (`LENS_KEYS.TEXT_FILE_ORDER` in `lib/lens-store/types.ts`) is **retained as-is** — renaming a stored key would need its own read-old-write-new migration for zero user value; the TS symbol may rename, the stored string does not. The order list now holds both text and viewer card ids (it is keyed by card id already, so nothing else changes).
- The filter store key changes implicitly (`lens-filter-store.ts` keys by section kind) — transient by design, nothing to migrate.
- Viewer rows: per-kind glyph, never an unsaved dot, same close box (the `CLOSE_TAB`-by-identity chain send is card-generic), same `SlotPicker`, same reorder.
- The section focus group id changes (`sectionFocusGroup(kind)` = `lens-section-files`) — no persistence attaches to it.

#### [P06] Swift gate split + Viewer registration (DECIDED) {#p06-swift-viewer}

**Decision:** `AppDelegate` grows `viewableContentTypes` (the [T01] beat-1 UTTypes) and `openableContentTypes` (editable ∪ viewable). ⌘O's panel (`openFileInEditor`) and the OS-open filter (renamed `isEditableFile` → `isOpenableFile`, checking editable-conformance OR viewable-membership) take the union; the `choosePath` kind=`file` bridge panel **keeps** `editableContentTypes` (its callers choose files into text contexts). Info.plist adds a second `CFBundleDocumentTypes` dict: `CFBundleTypeName` "Viewable Document", `CFBundleTypeRole` **Viewer**, `LSHandlerRank` Alternate, `LSItemContentTypes` = the T01 UTI list.

**Rationale:**
- Role Viewer + rank Alternate is the honest macOS claim: Tug appears in "Open With" without contesting Preview as default.
- The bridge chooser feeds TugFileChooser fields that expect text paths; widening it is a separate decision for whoever needs it.

**Implications:**
- Doc-comment tripwires updated: the `editableContentTypes` comment in `AppDelegate.swift` and the "A file picker only edits text" comment at the `choosePath` panel.
- Info.plist is hand-maintained (referenced verbatim by both configs in `Tug.xcodeproj/project.pbxproj`; no `GENERATE_INFOPLIST_FILE`) — a direct edit, no codegen.
- Launch Services picks up the new claim on the next build+launch of the app bundle.

#### [P07] SVG stays text (DECIDED) {#p07-svg-text}

**Decision:** `.svg` is not in the viewable table; it continues to open in the Text card.

**Rationale:**
- SVG conforms to text; Tug is an editor of SVG source, and that is its behavior today (it passes the existing `conforms(to: .text)` gate).

**Implications:**
- None; explicitly a no-change.

#### [P08] `file-view` open registry mirrors the text one (DECIDED) {#p08-viewer-registry}

**Decision:** A new module `lib/file-view-open-registry.ts` mirrors the shape of `lib/text-card-open-registry.ts` with a reduced entry interface: `{ getPath(): string | null; openFile(path: string): void }`, plus `registerOpenFileViewCard` / `unregisterOpenFileViewCard` / `getOpenFileViewCard` / `findFileViewCardByPath` / `subscribeOpenFileViewCards` / `getOpenFileViewCardsVersion`.

**Rationale:**
- The text registry's extra surface (dirty, unsaved mark, reveal) is meaningless for a read-only viewer; a shared generic registry would force nullable methods on the text side. The repo already has the per-card-family registry precedent (`diff-card-open-registry.ts` is the descriptor-keyed mirror).

**Implications:**
- The Lens data source subscribes to both registries' versions; `openFileInCard` consults `findFileViewCardByPath` for viewable kinds.
- `openFile(path)` (the `reuse` open-target's rebind of a mounted card) MUST write the new path through to the card's persisted state bag, not only to local component state. Maker ▸ Reload and a cold boot both re-resume a card from its persisted bag; a rebind that lives only in memory restores the *previous* file after reload. This is the same [L23] discipline the Text card's `openFile` follows.

---

#### [P09] AVIF's `UTType` is constructed, not a static (DECIDED) {#p09-avif-uttype}

**Decision:** Swift builds the AVIF type as `UTType("public.avif")` (falling back to `UTType(filenameExtension: "avif")`), compacted into `viewableContentTypes` — every other type in [Table T01] uses its `UTType` static.

**Rationale:**
- UniformTypeIdentifiers publishes statics for `png`/`jpeg`/`gif`/`webP`/`heic`/`heif`/`tiff`/`bmp`/`ico`/`pdf`, but there is no `UTType.avif` static to reference; naming one would fail to compile on the step's first build.
- Both constructors are failable (`UTType?`), so the list is assembled with `compactMap` — an OS that doesn't know the identifier simply drops AVIF from the panel filter instead of crashing.

**Implications:**
- `viewableContentTypes` is built as an expression, not a bare array literal.
- The Info.plist entry is unaffected: `LSItemContentTypes` takes the identifier string `public.avif` directly.

---

### Deep Dives {#deep-dives}

#### The canonical type table {#type-table}

**Table T01: Viewable file types** {#t01-viewable-types}

| Kind | Extensions | UTI (Swift `UTType`) | MIME (`Content-Type`) | Milestone |
|---|---|---|---|---|
| PNG | `png` | `public.png` (`.png`) | `image/png` | M01 |
| JPEG | `jpg`, `jpeg`, `jfif` | `public.jpeg` (`.jpeg`) | `image/jpeg` | M01 |
| GIF | `gif` | `com.compuserve.gif` (`.gif`) | `image/gif` | M01 |
| WebP | `webp` | `org.webmproject.webp` (`.webP`) | `image/webp` | M01 |
| HEIC/HEIF | `heic`, `heif` | `public.heic` (`.heic`), `public.heif` (`.heif`) | `image/heic`, `image/heif` | M01 |
| AVIF | `avif` | `public.avif` (no `UTType` static — construct it, see [P09]) | `image/avif` | M01 |
| TIFF | `tiff`, `tif` | `public.tiff` (`.tiff`) | `image/tiff` | M01 |
| BMP | `bmp` | `com.microsoft.bmp` (`.bmp`) | `image/bmp` | M01 |
| ICO | `ico` | `com.microsoft.ico` (`.ico`) | `image/vnd.microsoft.icon` | M01 |
| PDF | `pdf` | `com.adobe.pdf` (`.pdf`) | `application/pdf` | M02 |

Swift statics: `.png`, `.jpeg`, `.gif`, `.webP`, `.heic`, `.heif`, `.tiff`, `.bmp`, `.ico`, `.pdf` all exist as `UTType` static properties. **`avif` does not** — see [P09] for how it is constructed. The Info.plist `LSItemContentTypes` entries use the plain identifier strings in this column regardless, since a plist has no notion of a Swift static.

Extension matching is case-insensitive on the basename's final `.`-suffix. Anything not in this table classifies as `text` and takes today's path unchanged (with `/api/fs/read`'s 422 `"binary"` as the existing backstop for true binaries).

#### End-to-end open flow after this plan {#open-flow}

1. A path arrives at the `open-file` action (Control frame from Swift ⌘O / Open Recent / Finder-open, `dispatchAction` from transcript links, Open Quickly, Lens recents menu, DeckCanvas context menu) → `openFileInCard(store, path, …)`.
2. `noteRecentDocument(path)` (all kinds).
3. `classifyFileKind(path)` from `lib/file-kinds.ts` → `"text" | "image" | "pdf"`.
4. `text` → today's code path, byte-for-byte.
5. viewable → `findFileViewCardByPath(path)`: hit → `transferFocusForActivation` + `activateCard`; miss → `openTarget` semantics (`reuse` rebinds the frontmost non-dirty — always non-dirty — `file-view` card via its entry's `openFile(path)`; `newTab` adds to the frontmost `file-view` card's pane; `new`/fallback → save-outgoing-focus then `store.addCard("file-view", { path })`).
6. `FileViewCardContent` reads its seed path, classifies again for the body branch, and renders `<ImageBlock src={blobUrl(path)}>` (image) or `<embed src={blobUrl(path)} type="application/pdf">` (pdf), where `blobUrl(path)` = `/api/fs/blob?path=<encodeURIComponent>`. Load/error states ride `ImageBlock`'s existing `data-tugx-image-status` machinery; the card title is `basename(path)` published the same way the Text card titles itself.
7. The Lens **Files** section lists the card (both registries feed the data source), glyphed by kind.

#### fs_blob response contract {#fs-blob-contract}

**Spec S01: `GET /api/fs/blob?path=<abs>`** {#s01-fs-blob}

- Loopback-only (403 otherwise), path through `guard_absolute_path` (shared with `fs_read`: absolute or `~`-anchored, no `..`, secret-filter denial → 403 `"denied"`).
- Extension not in [T01] → 404 `"not_found"`-shaped refusal (the route serves only classifier-routed types; deliberate per [P03]).
- Not found → 404; not a regular file → 400 `"bad_path"`; permission → 403.
- Success: `200`, `Content-Type` per T01, `Content-Length`, `ETag: "<mtime_ms>-<size>"`, `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache` (revalidate-always; ETag does the work), streaming body.
- `If-None-Match` matching the ETag → `304` with no body.
- `Range: bytes=a-b` (single range) → `206`, `Content-Range: bytes a-b/total`, bounded stream; syntactically invalid or unsatisfiable → `416` with `Content-Range: bytes */total`. Multi-range requests are answered with the full `200` body (permitted by RFC 9110; keeps the implementation single-range).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `file-view` card existence + seed `{ path }` | structure | deck store (`addCard` initial-content channel, same as Text card seed) | [L02] |
| viewer open registry (path per card) | external module store | `file-view-open-registry.ts` + `useSyncExternalStore` in the data source | [L02] |
| image load/error state | appearance | `ImageBlock`'s existing `data-tugx-image-status` attribute + CSS | [L06] |
| Files-section rows | external | existing `LensTextFilesDataSource` pattern, widened; notifies from `useLayoutEffect` | [L02], [L03] |
| registry registration timing | — | `useLayoutEffect` registration in the card body (mirror `TextCardContent`'s register/unregister) | [L03] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/fs_blob.rs` | Streaming byte route per Spec S01; MIME table per T01 |
| `tugdeck/src/lib/file-kinds.ts` | `FileKind` union + `classifyFileKind(path)` + `blobUrl(path)`; extension table per T01 |
| `tugdeck/src/lib/file-view-open-registry.ts` | Viewer open registry per [P08] |
| `tugdeck/src/components/tugways/cards/file-view-card.tsx` | `FileViewCardContent` body (kind branch: ImageBlock / PDF embed) |
| `tugdeck/src/components/tugways/cards/file-view-card-registration.tsx` | `registerFileViewCard()` |
| `tugdeck/src/components/tugways/cards/file-view-card.css` | Card body layout (centered/fitted image surface) |
| `tests/app-test/atNNNN-file-view-open.test.ts` | App-test for the open→render→reuse→Lens flow (pick next free number) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `get_fs_blob` | async fn | `fs_blob.rs` | Handler; registered in `server.rs` `build_app` beside `/api/fs/read`; `mod fs_blob;` beside the existing `mod fs_read;` declaration |
| `mime_for_extension` | fn | `fs_blob.rs` | T01 table; unit test enumerates T01's extension list |
| `FileKind`, `classifyFileKind`, `blobUrl`, `VIEWABLE_EXTENSIONS` | type/fn/const | `file-kinds.ts` | Unit test enumerates T01's extension list (guards [R02]) |
| `openFileInCard` | fn (modify) | `lib/open-file-in-card.ts` | Kind branch per [P04]; extract/mirror `findFrontmostTextCard` for `file-view` |
| `TextFilesRow` → widened row type with `kind: "text-open" \| "view-open"` | type (modify) | `lens/sections/text-files-data-source.ts` (renamed `files-data-source.ts`) | `buildTextFilesRows` → `buildFilesRows`; filter widens per [P05] |
| `registerTextFilesSection` → `registerFilesSection` | fn (rename+modify) | `lens/sections/text-files-section.tsx` (renamed `files-section.tsx`) | `SECTION_KIND = "files"`, `title: "Files"`; update `main.tsx` call |
| `KIND_MIGRATIONS` | const (modify) | `lib/lens-store/lens-store.ts` | add `"text-files": "files"` |
| `viewableContentTypes`, `openableContentTypes` | static let | `tugapp/Sources/AppDelegate.swift` | Per [P06]; `isEditableFile` → `isOpenableFile` |
| `CFBundleDocumentTypes` +1 dict | plist | `tugapp/Info.plist` | "Viewable Document", role Viewer, per [P06] |

File renames use `tugutil file mv` (a repo hook blocks bare `rm`/ad-hoc paths); update the `@covers` lines of any app-tests that point at the renamed section files (`grep -rn "text-files-section" tests/app-test/`).

---

### Documentation Plan {#documentation-plan}

- [ ] Module docstrings on every new TS file ([L19] authoring) and the `fs_blob.rs` module header, stating the contract (Spec S01) in place.
- [ ] Refresh the two Swift doc-comment tripwires per [P06]: the `editableContentTypes` comment (now describing the editor/viewer split) and the `choosePath` panel's text-only note.
- [ ] No freestanding docs — the plan itself and the module docs are the record.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | fs_blob: content-type, streaming >8 MiB, Range, ETag/304, guards (secret, `..`, non-loopback, unknown extension) | `#step-1` |
| **Unit (TS, bun)** | classifier table completeness vs T01; data-source row building over both card kinds; `migrateKinds` for the section rename | `#step-2`, `#step-5` |
| **App-test** | The real flow: dispatch `open-file` with a temp PNG → `file-view` card mounts → `<img>` decodes via real `/api/fs/blob` → second open reuses → Lens Files row present, no unsaved dot | `#step-7` |
| **Drift prevention** | Rust + TS table tests both enumerate T01's extension list ([R02]) | `#step-1`, `#step-2` |

#### What stays out of tests {#test-non-goals}

- jsdom render tests of `FileViewCardContent` — banned pattern; the app-test drives the real card on real bytes.
- Wall-clock/perf assertions — out of scope for this feature.
- Swift `isOpenableFile` unit tests — tugapp has no unit-test target for AppDelegate; covered by build + the manual Finder-open check in the M01 exit criteria.
- pdf.js behavior — deferred with [Q01].

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Committing is the user's act on this repo (or `tugutil dash commit` when run as a dash recipe) — the step's `**Commit:**` line is the message for that landing.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | tugcast `/api/fs/blob` streaming route | done | `87a998e9e` |
| #step-2 | `file-kinds.ts` classifier | done | `94852a30d` |
| #step-3 | `file-view` card + open registry | done | `2964daa8b` |
| #step-4 | Kind routing in `openFileInCard` | done | `5f149f944` |
| #step-5 | Lens: Text Files → Files | done | `38ebef3b9` |
| #step-6 | Swift gates + Info.plist Viewer entry | done | `c5c619e88` |
| #step-7 | M01 integration checkpoint (app-test) | done | `bab6e4781` |
| #step-8 | M02: PDF | done | `883444f42` |

**Milestone M01: Images** {#m01-images} — steps 1–7. **Milestone M02: PDF** {#m02-pdf} — step 8.

#### Step 1: tugcast `/api/fs/blob` streaming route {#step-1}

**Commit:** `tugcast(files-feature): streaming /api/fs/blob route with Range + ETag`

**References:** [P03] streaming blob, Spec S01, Table T01, Risk R02, (#fs-blob-contract, #type-table)

**Artifacts:**
- `tugrust/crates/tugcast/src/fs_blob.rs`; `mod fs_blob;` declaration beside `mod fs_read;`; route registered in `server.rs` `build_app` beside `/api/fs/read`.

**Tasks:**
- [ ] Implement `get_fs_blob` per Spec S01, reusing `fs_read::guard_absolute_path`, `fs_error`, `mtime_ms` (they are `pub(crate)`), and the loopback check pattern.
- [ ] `mime_for_extension(ext: &str) -> Option<&'static str>` covering exactly T01's M01+M02 rows (ship the `pdf` row now; the frontend gates M02).
- [ ] Streaming body: `tokio::fs::File` + `tokio_util::io::ReaderStream` + `axum::body::Body::from_stream`; Range via seek + `.take(len)`.
- [ ] ETag `"<mtime_ms>-<size>"`, `If-None-Match` → 304; `Accept-Ranges`, `nosniff`, `Cache-Control: no-cache` headers.

**Tests:**
- [ ] Unit: table test asserting `mime_for_extension` accepts exactly T01's extension list (drift guard [R02]).
- [ ] Unit: 200 with correct Content-Type/Length/ETag; >8 MiB temp file streams fully; Range `bytes=0-99` → 206 with correct slice; unsatisfiable range → 416; If-None-Match → 304; unknown extension → 404; secret path (`/tmp/server.pem`) → 403; directory → 400. (Handler logic factored like `fs_read::read_file` so tests run it synchronously where possible; Range/stream tests may use the async handler with a test `Router`.)

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` (all green, zero warnings)

---

#### Step 2: `file-kinds.ts` classifier {#step-2}

**Commit:** `tugdeck(files-feature): file-kind classifier + blob URL helper`

**References:** [P01] closed allowlist, [P07] SVG stays text, Table T01, Risk R02, (#type-table, #open-flow)

**Artifacts:**
- `tugdeck/src/lib/file-kinds.ts`: `type FileKind = "text" | "image" | "pdf"`, `classifyFileKind(path: string): FileKind`, `blobUrl(path: string): string`, exported `VIEWABLE_EXTENSIONS` map.

**Tasks:**
- [ ] Case-insensitive final-suffix matching; no dot / unknown suffix → `"text"`; `"pdf"` classified but note M02 gates its card body.
- [ ] `blobUrl` = `` `/api/fs/blob?path=${encodeURIComponent(path)}` ``.

**Tests:**
- [ ] Bun unit test: every T01 extension (upper/lower case) classifies to its kind; `x.svg`, `x.rs`, `x`, `x.PNG.bak` classify `"text"`; table keys exactly equal T01's list ([R02]).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/file-kinds.test.ts && bunx tsc --noEmit`

---

#### Step 3: `file-view` card + open registry {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(files-feature): read-only file-view card + open registry`

**References:** [P02] one viewer card, [P08] viewer registry, Spec S01, (#open-flow, #state-zone-mapping)

**Artifacts:**
- `file-view-open-registry.ts`, `file-view-card.tsx`, `file-view-card-registration.tsx`, `file-view-card.css`; `registerFileViewCard()` called in `main.tsx` beside `registerTextCard()`.

**Tasks:**
- [ ] Registration: `componentId: "file-view"`, `defaultMeta: { title: "File", icon: "FileText", closable: true }`, `category: { label: "Files", icon: "FileText" }`, sizePolicy `min 800×400 / preferred 800×1200` (matching the Text card's registration and its rationale); **no** `engineKind: "em"` per [P02].
- [ ] Body: read the seed `{ path }` the same way `TextCardContent` coerces its persisted bag (a plain object with a string `path`); classify; image → compose `ImageBlock` (`body-kinds/image-block.tsx`, props `{ src, alt }`) with `src = blobUrl(path)`, `alt = basename(path)`; pdf kind → a "PDF opens in M02" placeholder until `#step-8` replaces it (or land steps together and skip the placeholder).
- [ ] Publish the card title as `basename(path)` the way the Text card does (its `cardTitleStore` path — follow `text-card.tsx`'s title publication).
- [ ] Register/unregister into the viewer open registry from a `useLayoutEffect` (mirror `TextCardContent`'s register/unregister sequencing); entry `{ getPath, openFile }` where `openFile(path)` rebinds the card to a new path in place (for the `reuse` open-target). Per [P08], the rebind must **persist** the new path to the card's state bag — a memory-only rebind restores the previous file after Maker ▸ Reload or a cold boot ([L23]). Follow how `TextCardContent`'s own `openFile` writes through.
- [ ] No responder-chain save/cut/paste registration — read-only surface, no editing substrate; COPY of the image is out of scope (the fullscreen overlay's affordances suffice).

**Tests:**
- [ ] Covered by the `#step-7` app-test (no jsdom render tests per #test-non-goals).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 4: Kind routing in `openFileInCard` {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(files-feature): route viewable kinds to file-view cards in openFileInCard`

**References:** [P04] chokepoint routing, [P08] viewer registry, (#open-flow)

**Artifacts:**
- Modified `lib/open-file-in-card.ts`; no changes to `action-dispatch.ts`, `deck-canvas.tsx`, or `open-quickly-overlay.tsx` (they all delegate here).

**Tasks:**
- [ ] Branch after `noteRecentDocument(path)`: `"text"` → existing code unchanged; viewable → the mirrored flow per (#open-flow) item 5 — `findFileViewCardByPath` reuse with `transferFocusForActivation`, then `openTarget` semantics against the frontmost `file-view` card (generalize or duplicate `findFrontmostTextCard` with the componentId as an argument), falling through to save-outgoing-focus + `addCard("file-view", { path })` (preserve the [L23] save-before-activation comment's discipline on the fall-through path).
- [ ] Ignore `line`/`endLine` for viewable kinds.

**Tests:**
- [ ] Reuse-by-path and card-creation asserted end-to-end in `#step-7`'s app-test.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src/lib`

---

#### Step 5: Lens — Text Files becomes Files {#step-5}

**Depends on:** #step-3

**Commit:** `tugdeck(files-feature): Lens Files section lists text + viewer cards; kind migration`

**References:** [P05] lens files, [P08] viewer registry, Risk R04, (#state-zone-mapping)

**Artifacts:**
- `files-section.tsx` / `files-data-source.ts` / `files-section.css` (renamed via `tugutil file mv` from the `text-files-*` trio); `KIND_MIGRATIONS` entry in `lens-store.ts`; updated `main.tsx` registration call; updated `@covers` lines in any app-tests referencing the old paths.

**Tasks:**
- [ ] `SECTION_KIND = "files"`, `title: "Files"`; add `"text-files": "files"` to `KIND_MIGRATIONS`.
- [ ] Data source: include `componentId === "file-view"` cards; row gains a `kind` discriminator (`"text-open"` / `"view-open"`); viewer rows resolve path/title from the viewer registry, `unsaved` always false; subscribe to both registries' versions in the hook.
- [ ] Row rendering: per-kind glyph (keep `FileText` for text rows; `Image`/`FileImage` from lucide for viewer rows), no unsaved dot for viewers; close box, SlotPicker, hover path, disambiguators, and reorder unchanged (order store is card-id-keyed; keep the stored key string `textFileOrder` per [P05]).
- [ ] Collapsed summary counts both kinds ("N open").
- [ ] Keep the header recents menu as-is (it dispatches `open-file`, which now routes by kind for free).

**Tests:**
- [ ] Bun unit: `buildFilesRows` over a deck snapshot containing text + file-view cards (injected resolvers, following the existing `text-files-data-source.test.ts` pattern); disambiguators across mixed kinds.
- [ ] Bun unit: `migrateKinds(["text-files"])` → `["files"]` (extend the existing lens-store tests).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/lens && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-covers-check` (renamed files still resolve from `@covers` declarations)

---

#### Step 6: Swift gates + Info.plist Viewer entry {#step-6}

**Commit:** `tugapp(files-feature): viewable content types + macOS Viewer registration`

**References:** [P01] closed allowlist, [P06] swift viewer, [P09] avif uttype, Table T01, (#type-table, #p09-avif-uttype)

**Artifacts:**
- Modified `tugapp/Sources/AppDelegate.swift`, `tugapp/Info.plist`.

**Tasks:**
- [ ] Add `viewableContentTypes` — the nine M01 statics `[.png, .jpeg, .gif, .webP, .heic, .heif, .tiff, .bmp, .ico]` plus AVIF built per [P09] as `UTType("public.avif") ?? UTType(filenameExtension: "avif")`, compacted so a failed construction drops rather than crashes — and `static let openableContentTypes = editableContentTypes + viewableContentTypes`, with the doc comment updated to describe the editor/viewer split (no bug-history in comments).
- [ ] `openFileInEditor`'s panel: `allowedContentTypes = AppDelegate.openableContentTypes`.
- [ ] Rename `isEditableFile` → `isOpenableFile`: regular file AND (conforms to an editable type OR conforms to a viewable type — per-type `conforms(to:)` over the enumerated viewable list is membership-equivalent for these leaf UTIs and handles subtype UTIs of e.g. `public.jpeg` correctly); update `openFilesFromOS`'s call and its doc comment ("Non-text" → "unsupported").
- [ ] `choosePath` kind=`file` keeps `editableContentTypes`; refresh its "file picker only edits text" comment to state the constraint (text contexts only) rather than the old rationale.
- [ ] Info.plist: append the "Viewable Document" `CFBundleDocumentTypes` dict per [P06] with the ten M01 UTI strings from T01 (hold `com.adobe.pdf` for `#step-8`).

**Tests:**
- [ ] Swift compiles warning-free; behavior is exercised in `#step-7`'s manual checks (no AppDelegate unit target, per #test-non-goals).

**Checkpoint:**
- [ ] `just build` (or the repo's app build recipe) succeeds
- [ ] `plutil -lint tugapp/Info.plist`

---

#### Step 7: M01 integration checkpoint — app-test + manual sweep {#step-7}

**Depends on:** #step-1, #step-4, #step-5, #step-6

**Commit:** `tests(files-feature): app-test for image open, reuse, and Lens Files listing`

**References:** [P02], [P03], [P04], [P05], Milestone M01, (#success-criteria, #open-flow)

**Artifacts:**
- `tests/app-test/atNNNN-file-view-open.test.ts` (next free number) with `@covers tugdeck/src/lib/open-file-in-card.ts`, `@covers tugdeck/src/components/tugways/cards/file-view-card.tsx`, `@covers tugdeck/src/components/lens/sections/files-section.tsx`.

**Tasks:**
- [ ] App-test: write a real PNG to a temp dir (a few-KB valid PNG generated in the test, not a fixture blob checked into the repo); launch; open it with `await app.dispatchControlAction("open-file", { path })` — the harness verb (`tests/app-test/_harness/index.ts`) that wraps `window.__tug.dispatchControlAction` and settles after the transition, as `at0154-settings-singleton.test.ts` does; **not** a raw `evalJS` of `dispatchAction`, which is a module import and unreachable from the page global. Wait for the `file-view` card's `<img>` to reach `naturalWidth > 0` (real `/api/fs/blob` fetch through the production bundle); dispatch the same open again and assert the deck's card count is unchanged and the same card is frontmost; assert the Lens Files section shows the row with no `lens-text-file-unsaved` mark; close via the row's close box and assert the card unmounts.
- [ ] Manual sweep (report results, user lands the commit): ⌘O offers and opens a PNG and an HEIC; Finder "Open With ▸ Tug" on a PNG opens a viewer card; Save…/Save As…/Revert validate disabled while the viewer is frontmost; Open Recent replays the image.

**Tests:**
- [ ] The app-test above.

**Checkpoint:**
- [ ] `just app-test tests/app-test/atNNNN-file-view-open.test.ts`
- [ ] `just app-test-changed` for the touched surfaces
- [ ] `cd tugrust && cargo nextest run -p tugcast`; `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 8: M02 — PDF {#step-8}

**Depends on:** #step-7

**Commit:** `tug(files-feature): PDF viewing via native WKWebView embed`

**References:** [Q01] native pdf, [P02], [P06], Table T01, Risk R01, Milestone M02, (#fs-blob-contract)

**Artifacts:**
- PDF branch in `file-view-card.tsx`; `.pdf`/`com.adobe.pdf` additions to `viewableContentTypes` and Info.plist; classifier already ships `"pdf"` from `#step-2`; fs_blob already serves `application/pdf` from `#step-1`.

**Tasks:**
- [ ] **Spike first ([Q01]):** point the card body's pdf branch at `<embed src={blobUrl(path)} type="application/pdf">` sized to the card, open a real multi-page PDF in the built app, and judge scroll/zoom/text-selection. Record the verdict in this plan's [Q01] Resolution line.
- [ ] If adequate: keep the embed, add `.pdf` to `viewableContentTypes`, add `com.adobe.pdf` to the Info.plist Viewer dict, and extend the app-test with a PDF open asserting the `<embed>` mounts and its blob URL returns 200 with `application/pdf` (fetch HEAD via `evalJS`).
- [ ] If inadequate: land only the Swift/plist **omission** (leave `.pdf` out so the panel never offers what we can't render), set [Q01] to DEFERRED with the observed shortcomings, and stop — pdf.js is a follow-on plan.

**Tests:**
- [ ] Extended app-test PDF case (adequate path only); Rust/TS table tests already cover the `pdf` rows.

**Checkpoint:**
- [ ] `just app-test tests/app-test/atNNNN-file-view-open.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`; app build succeeds; `plutil -lint tugapp/Info.plist`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Tug.app opens, renders, and lists images (M01) and PDFs (M02, native-embed permitting) as read-only viewer cards, registered with macOS as a Viewer of those types, with the Lens **Files** section presenting text and viewer cards uniformly.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every criterion in (#success-criteria) verified by its named test or manual check.
- [ ] All unit + app-test checkpoints green; `bunx vite build` clean; Rust workspace warning-free; `just app-test-covers-check` passes.
- [ ] [Q01] carries a recorded Resolution (DECIDED or DEFERRED with rationale).

**Acceptance tests:**
- [ ] `atNNNN-file-view-open.test.ts` (image open / blob fetch / reuse / Lens row / close; + PDF case if [Q01] lands adequate).
- [ ] `fs_blob` unit suite (streaming, Range, ETag, guards, T01 table).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] pdf.js viewer if [Q01] resolves DEFERRED.
- [ ] Video/audio kinds (blob route's Range support is the prepared seam).
- [ ] Copy-image affordance on the viewer card; drag-out of the image.
- [ ] Widening the `choosePath` bridge chooser for callers that want viewable picks.

| Checkpoint | Verification |
|------------|--------------|
| Blob route contract | `cargo nextest run -p tugcast` |
| Classifier/table drift | bun table tests mirroring T01 ([R02]) |
| End-to-end open | `just app-test tests/app-test/atNNNN-file-view-open.test.ts` |
| Bundle integrity | `bunx vite build` |
| Viewer registration | `plutil -lint` + manual Finder "Open With" |
