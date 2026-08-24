<!-- devise-skeleton v4 -->

## PDF viewer: replace the native embed with pdf.js {#pdf-viewer}

**Purpose:** Make the PDF half of the `file-view` card a viewer Tug actually owns — keyboard-drivable, card-scoped zoom, and the Continuous Scroll / Single Page / Two Pages modes — by rendering with pdf.js instead of handing bytes to WebKit's built-in PDF plugin, which exposes no control surface of any kind.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | complete |
| Target branch | main (via the `files-feature` dash) |
| Last updated | 2026-07-31 |
| Predecessor | [dash/files-feature.md](files-feature.md) — M01 images, M02 native-embed PDF |

---

### Where this picks up from {#picking-up}

This plan continues work already sitting on the **`files-feature` dash worktree**, not on `main`.

- **Worktree:** `/Users/kocienda/Mounts/u/src/tugtool/.tug/worktrees/files-feature` — address every read/write with absolute paths into it; the shell cwd reverts to the base checkout between calls.
- **Branch:** `tugdash/files-feature`. Commits go through `tugutil dash commit files-feature`, never `git commit`.
- **Debug instance:** `debug-tugdash-files-feature` (`just app-debug` from the worktree; `just launch-debug` / `just logs-debug` / `just stop-debug`).
- **Landing:** the user's `/join files-feature`. A join draft is already written via `tugutil draft set`; **rewrite it** at the end of this work so it covers the pdf.js switchover too.

**Already shipped on that dash** (all eight steps of the predecessor plan, ledger closed):

| What | Where | Commit |
|---|---|---|
| Streaming `GET /api/fs/blob` (Range, ETag, no size cap) | `tugrust/crates/tugcast/src/fs_blob.rs` | `87a998e9e` |
| `classifyFileKind` / `blobUrl` / `VIEWABLE_EXTENSIONS` | `tugdeck/src/lib/file-kinds.ts` | `94852a30d` |
| Read-only `file-view` card + viewer open registry | `tugdeck/src/components/tugways/cards/file-view-card*.{tsx,css}`, `tugdeck/src/lib/file-view-open-registry.ts` | `2964daa8b` |
| Kind routing at the open chokepoint | `tugdeck/src/lib/open-file-in-card.ts` | `5f149f944` |
| Lens **Text Files** → **Files** (both card families, kind glyphs, `KIND_MIGRATIONS`) | `tugdeck/src/components/lens/sections/files-*` | `38ebef3b9` |
| Swift `viewableContentTypes` / `openableContentTypes`, Info.plist Viewer entry | `tugapp/Sources/AppDelegate.swift`, `tugapp/Info.plist` | `c5c619e88` |
| `at0310` app-test (generated PNG + PDF, no fixtures) | `tests/app-test/at0310-file-view-open.test.ts` | `bab6e4781` |
| PDF branch via native `<embed>` | `file-view-card.tsx` | `883444f42` |
| Probe findings recorded in the predecessor's [Q01] | `dash/files-feature.md` | `24135db2a` |

**This plan replaces only the PDF branch of the card body.** Images, the blob route, the classifier, the Lens, the open routing, and the Swift/plist claims all stay exactly as they are.

---

### Phase Overview {#phase-overview}

#### Context {#context}

M02 shipped PDF viewing by pointing an `<embed type="application/pdf">` at the blob route. It renders well — pages, continuous scroll, crisp text, working text selection — but the user's hands-on pass found arrow keys dead, zoom bound to the whole app, and no page-mode control. A probe (recorded as Table T02 in the predecessor plan's [Q01]) established that this is not a wiring bug and not fixable from the deck:

| Capability | Result | How it was measured |
|---|---|---|
| Render / scroll / select | works | hands-on + screenshot |
| Arrow keys, PageUp/Down | **no effect** | 8 ArrowDown + 2 PageDown → byte-identical screenshots |
| DOM focus on the embed | **refused** | `activeElement` stays the host `div` after scripted `.focus()`, after `tabindex="0"` + `.focus()`, and after a real native click |
| `contextmenu` in JS | **never fires** | no listener runs, on the embed or on `document` |
| Native right-click menu | none appears | screenshot after a native right-click |
| `#page=` / `#zoom=` / `#view=` | **ignored** | four fragments set on `src`; view never left page 1 |

The plugin is a black box: no DOM, no events, no open parameters. The user's suggestion — hang zoom and paging off a right-click menu — cannot work, because WebKit swallows the right-click before JS sees it and there would be nothing to command even if it didn't. Zoom being app-wide has the same root: with no card-level viewer to scope it, ⌘+ falls through to WebKit page zoom.

A card that cannot take focus is also an outlier in a deck whose focus language is keyboard-first ([L22], `tuglaws/focus-language.md`). Owning the rendering is the only route, and it is the follow-on the predecessor plan already anticipated.

#### Strategy {#strategy}

- Render with **pdf.js** (`pdfjs-dist`) into per-page `<canvas>` elements, with pdf.js's text layer over each page so selection keeps working.
- **Lazy-load** the library behind a dynamic `import()` inside the PDF branch, so only opening a PDF pays the bundle — the main chunk is already ~3.6 MB / ~1 MB gzip.
- Keep the **blob route** as the byte source. pdf.js fetches by URL and its Range support is what the route's `206` handling was built for.
- Build the chrome from **real `Tug*` components**: `TugContextMenu` for the control surface the user asked for.
- Make the PDF surface a **responder** (`useResponder`) that owns its keys, so arrows/paging/zoom are chain-native and card-scoped rather than app-wide.
- Ship behind the same `file-view` card — this is a body branch swap, not a new card.

#### Success Criteria (Measurable) {#success-criteria}

- A multi-page PDF renders every page's real content (app-test asserts a page canvas has non-blank pixels, not merely that a canvas mounted).
- Arrow keys and PageUp/PageDown scroll the document; Home/End reach first and last page (app-test asserts scroll offset changes).
- Continuous Scroll / Single Page / Two Pages are selectable and the rendered page layout changes accordingly (app-test asserts page-element count and geometry per mode). They are reached from the context menu and carry no chord — see (#no-mode-chords); the app-test also asserts ⌘1 with a PDF frontmost leaves the mode alone.
- ⌘+ / ⌘- / ⌘0 change the card's render scale **without** changing the rest of the app's zoom (app-test asserts a sibling card's metrics are unchanged).
- Right-click over the PDF opens a `TugContextMenu` carrying the zoom and page-mode items, with the active mode marked (app-test asserts the menu mounts and the marked item tracks the current mode).
- Text selection still works over rendered pages (app-test asserts a non-empty selection after a drag).
- `bunx vite build` is clean and the **production bundle** renders a PDF in the real app — the worker must load from the built output, not just from dev esbuild ([R01]).
- Opening an image still behaves exactly as it does today (`at0310`'s existing image case stays green, untouched).

#### Scope {#scope}

1. `pdfjs-dist` dependency + worker wiring that survives `vite build`.
2. A `pdf-view` surface component: document load, page rendering, text layer, page modes, zoom.
3. Keyboard ownership via `useResponder` + the focus language.
4. `TugContextMenu` control surface (zoom + page modes, active mode marked).
5. Swap the card's PDF branch from `<embed>` to the new surface; delete the embed path and its CSS.
6. Tests: pure-logic unit tests for the layout/zoom math, app-test for render + keys + modes + menu.
7. `THIRD_PARTY_NOTICES.md` entry for pdf.js (Apache-2.0).

#### Non-goals (Explicitly out of scope) {#non-goals}

- A visible toolbar / page-number field / thumbnail sidebar. The user asked for a **right-click** control surface; a toolbar is a separate design conversation ([#roadmap]).
- In-document search, annotations, form filling, printing, or export.
- Editing PDFs in any sense. The card stays strictly read-only ([P02] of the predecessor plan — no dirty state, no `menuState.file`).
- Changing the image branch, the blob route, the classifier, the Lens, or the Swift/plist claims.
- pdf.js's own `PDFViewer`/`web/` application shell — Tug builds its own chrome; only the core rendering API is used.

#### Dependencies / Prerequisites {#dependencies}

- New npm dependency `pdfjs-dist` (Apache-2.0). Install with **bun** on the dash worktree; `tugdeck/package.json` + `bun.lock` change there.
- Everything else is in-repo and already shipped (see [#picking-up]).

#### Constraints {#constraints}

- **bun only**, never npm. Verify with `bunx tsc --noEmit` **and** `bunx vite build` — the debug app loads the production rollup bundle, and a dev-only-clean import can hang the app at the splash screen.
- Warnings are errors in the Rust workspace (not touched here, but `just build` still runs).
- Persistent state goes through tugbank `/api/defaults/<domain>/<key>` — **never** localStorage/sessionStorage/IndexedDB.
- Compose real `Tug*` components; never hand-roll UI that exists as one.
- App-tests: selective runs (`just app-test <files>` / `just app-test-changed`); every new test carries `@covers`; never run the full corpus unprompted. A `main.tsx` change triggers the ~20-file core tier (`just app-test`).
- Estimated element heights are banned. This is satisfiable exactly here: pdf.js reports each page's true size via `getViewport`, so page geometry is **measured from the document**, never guessed ([P05]).
- No plan-step numbers, bug history, or invented rationale in code comments.

#### Assumptions {#assumptions}

- `pdfjs-dist` v4/v5 ships ESM (`.mjs`) builds that Vite can bundle, and the worker can be wired via `new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' })` or a `?url` import assigned to `GlobalWorkerOptions.workerSrc`. **Verify before building on it** ([Q01], [R01]).
- WebKit on macOS 15+ renders pdf.js canvases at devicePixelRatio without extra work.
- The blob route's existing `Range`/`206` support satisfies pdf.js's ranged fetching; if pdf.js dislikes something about the response, the route is ours to adjust ([R03]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

devise-skeleton v4: explicit `{#anchor}` headings, `[P##]` decisions, `[Q##]` open questions, `Table T##` / `Risk R##` / `Milestone M##` labels, `**Depends on:**` lines citing `#step-N`, `**References:**` on every step. No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How does the pdf.js worker load from the production bundle? (OPEN → resolved in `#step-1`) {#q01-worker}

**Question:** Which worker-wiring form survives `bunx vite build` and runs in the real app — `new Worker(new URL(...), { type: "module" })`, a `?url` import assigned to `GlobalWorkerOptions.workerSrc`, or the `legacy` build?

**Why it matters:** This is the single highest-risk unknown. The repo has been bitten before: tugcode's tiktoken wasm loaded fine in dev and died on clean machines, which is why `reference_tugcode_wasm_embed` exists and why "verify with `vite build`" is a standing rule. A worker that only resolves under dev esbuild produces a PDF card that is blank — or an app that hangs at the splash screen — in the shipped build.

**Options:**
- `new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" })` — Vite's documented form; emits the worker as its own chunk.
- `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"` then `GlobalWorkerOptions.workerSrc = workerUrl`.
- `pdfjs-dist/legacy/build/*` if the modern build's syntax trips the bundler.
- Last resort: `disableWorker` / main-thread rendering — **rejected unless forced**; it would jank the whole deck on every page render.

**Plan to resolve:** `#step-1` is a spike that renders one page and is verified **through `just app-test`**, which serves the production bundle by construction (`reference_apptest_serves_prod_bundle`). Record the winning form here before any viewer work is built on it.

**Resolution: DECIDED — spawn the worker here and hand pdf.js the port, from the `legacy` build.** Resolved version: `pdfjs-dist@6.2.108`.

```ts
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerPort = new Worker(
  new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url),
  { type: "module" },
);
```

**Table T03: what the spike measured** {#t03-worker}

| Form | Result | Evidence |
|---|---|---|
| `new Worker(new URL(<bare specifier>, import.meta.url), { type: "module" })` | **works** | `vite build` emits `dist/assets/pdf.worker.min-*.js` and rewrites the call site to the built URL. The premise that a bare specifier goes unrewritten in this position was wrong — Vite resolves it. |
| `?worker` suffix import + `workerPort` | also works | Emits the same worker chunk plus a 107-byte constructor shim. Equivalent, but a second idiom for no gain. |
| **modern build** (`pdfjs-dist/build/*`) | **fails at runtime** | Document load throws `TypeError: getOrInsertComputed is not a function`. The modern build calls `Map.prototype.getOrInsertComputed`, which the app's WebKit lacks. Clean `tsc` and a clean `vite build` both sail past it — only the real app catches it. |
| **legacy build** (`pdfjs-dist/legacy/build/*`) | **works** | Ships the polyfill. Main module and worker must come from the same build. |

Two things worth carrying forward. The `new URL` form is what the deck's other workers (`sparkline-render-worker`, `image-downsample-worker`) already use, so this is the house idiom rather than a special case. And the failure that mattered was **not** the bundling question the step was written to answer — it was an engine-support question that no build-time check could have surfaced. Running the spike in the real app is what caught it, which is the argument for `#step-1` existing at all.

Bundle impact ([R02]): pdf.js lands in its own ~434 kB lazy chunk with the worker as a separate ~1.2 MB asset; the main chunk stays at ~3,659 kB, unmoved.

#### [Q02] Does the `file-view` card need `engineKind: "em"`? (OPEN → resolved in `#step-3`) {#q02-enginekind}

**Question:** How does the PDF surface become the focus destination on card activation, given that `engineKind` is set on the **card registration** (`file-view-card-registration.tsx`) and therefore applies to every kind the card renders — images included?

**Why it matters:** The Text card uses `engineKind: "em"` so activation routes to the body's `onCardActivated` instead of the generic default-focus walk. The `file-view` card deliberately does **not** ([P02] of the predecessor plan: "there is no editing surface to claim focus"). That was right for images and is now wrong for PDFs, and one registration serves both.

**Options:**
- Keep the default engine kind; have the PDF surface be a focusable responder that claims focus itself on activation. Images keep today's behavior with no change.
- Adopt `engineKind: "em"` for the whole card and give the image branch an explicit focus destination too (arrow-key scrolling for a large image is arguably a feature, not a cost).
- Split into two componentIds — **rejected**: it would undo [P02] of the predecessor plan, double the registry/Lens/open-routing story, and break persisted bags for already-open viewer cards.

**Plan to resolve:** Read `tuglaws/focus-language.md` and `tuglaws/responder-chain.md`, then verify against the real focus manager in `#step-3`. Prefer whichever leaves the image branch untouched.

**Resolution: DECIDED — no `engineKind` change. The surface is a responder that tags itself as the card's primary focus target.**

`engineKind: "em"` turned out to be the wrong instrument. It routes activation to a card's *engine hook* (`paintMirrorAsActive` → `view.focus()` on a CM6 editor), which is the dom-granted path for text surfaces. The PDF surface is engine-routed: it holds no caret and, per the focus language, must render no `tabindex` and handle no element-level `keydown`.

What the surface actually needs is the **chain first responder**, because that is where keys dispatch from. Two mechanisms deliver it, and neither is `engineKind`:

- A click promotes the nearest responder — the reader's own opening gesture.
- On activation without a click, `settleFirstResponderForActivation` resolves the card's default-focus target through `resolveDefaultFocusTarget` and promotes **that element's responder**. It locates the element and walks to its responder; it never calls `.focus()` on it. So `data-tug-focus-key="primary"` on the surface root is enough, with no focusability implied and nothing for the focus watchdog to correct.

The image branch is untouched: it carries no such tag, so a viewer showing an image behaves exactly as it did.

Pinned by `at0311`, which posts real keystrokes and watches the document move.

#### [Q03] Do page mode and zoom persist, and at what scope? (OPEN → decide in `#step-4`) {#q03-persistence}

**Question:** Should the chosen page mode / zoom live only for the card's lifetime, ride the card's persisted bag, or be a deck-wide default in tugbank?

**Why it matters:** Preview remembers per-document. A card-bag choice restores with the card across Maker ▸ Reload and cold boot; a tugbank default applies to the next PDF opened. Getting this wrong is invisible until a reload.

**Options:**
- Card bag only (`{ path, pageMode, zoom }`) — restores with the card; new cards start at the default. Cheapest and consistent with how the card already persists `path` ([L23]).
- Card bag **plus** a tugbank deck-wide default under a `pdf-view` domain, following the Text card's `TEXT_CARD_DEFAULTS_DOMAIN` precedent.
- Neither — reset every mount. Rejected: a reload silently throwing away the user's zoom is the behavior [L23] exists to prevent.

**Plan to resolve:** Default to the card bag in `#step-4`; add the tugbank default only if it falls out cheaply. **Never** localStorage.

**Resolution: DECIDED — the card bag, per document. No tugbank default.**

`FileViewCardBagContent` gains an optional `view: { pageMode, zoom }` alongside `path`, narrowed on restore like everything else in the bag. The surface owns the state and mirrors it upward; the card writes it through the `onSave` it already had.

Zoom persists as a *choice*, not a measurement: `number | "fit-width" | "fit-page"`. Restoring a fit as the number it happened to measure would be wrong the moment the card is a different width, which is exactly the case a reload creates.

Rebinding the card to a different document resets to the default rather than inheriting the previous file's zoom, and the surface is keyed by path so it remounts cleanly.

A deck-wide tugbank default did not fall out cheaply and is not obviously wanted — Preview remembers per document, which is what this does.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Worker fails in the production bundle (R01) | high | med | `#step-1` spike verified through `just app-test` (prod bundle) before anything is built on it | Blank PDF card, or splash-screen hang |
| Bundle weight (R02) | med | med | Dynamic `import()` in the PDF branch only; assert the main chunk doesn't grow materially | `vite build` main chunk jumps |
| Blob route disagrees with pdf.js ranged fetching (R03) | med | low | Route is ours; `fs_blob.rs` already does `206`/`Content-Range`/`416`. Fall back to a single full fetch | pdf.js load errors on a large file |
| Render perf on long documents (R04) | med | med | Render only visible pages + a small margin; page geometry is exact from `getViewport`, so no estimates ([P05]) | Scroll jank on a 100-page file |
| Keyboard clash with deck-wide shortcuts (R05) | med | med | Keys handled as a responder in the chain, so precedence is the chain's, not a global listener's; ⌘+/-/0 must be `preventDefault`ed or WebKit page zoom still fires | ⌘+ zooms the app while a PDF is focused |

**Risk R01: the worker only works in dev** {#r01-worker}

- **Risk:** The library loads under the Vite dev server and fails from the rollup output — the exact shape of the tugcode wasm incident.
- **Mitigation:** `#step-1` proves it through the production bundle path before the viewer exists; `bunx vite build` is a checkpoint on every subsequent step.
- **Residual risk:** A future `pdfjs-dist` bump could change the worker layout. The `#step-1` app-test is the regression guard.

---

### Design Decisions {#design-decisions}

#### [P01] pdf.js core only; Tug builds the chrome (DECIDED) {#p01-core-only}

**Decision:** Use `pdfjs-dist`'s core API (`getDocument`, `page.render`, the text layer) and none of its bundled viewer application (`web/viewer.*`, `PDFViewer`, its toolbar or CSS).

**Rationale:**
- pdf.js's viewer ships its own toolbar, menus, focus handling, and theme — every one of which would fight Tug's components, focus language, and theme tokens.
- The control surface the user asked for is a `TugContextMenu`; the deck already owns menus, focus, and keyboard.

**Implications:**
- Page modes, zoom, and keyboard are Tug's code over pdf.js's rendering primitives — that is the work, and it is why this is a plan rather than a patch.
- pdf.js's `TextLayer` is still used as-is: it is a rendering primitive, not chrome, and hand-rolling text-layer geometry would be a mistake.

#### [P02] Lazy-loaded behind the PDF branch (DECIDED) {#p02-lazy}

**Decision:** `pdfjs-dist` enters through a dynamic `import()` reached only when a PDF is actually opened; the module is cached after first load.

**Rationale:**
- The main chunk is already ~3.6 MB (~1 MB gzip). Every deck boot paying for a PDF library nobody opened is the wrong trade.
- Dynamic import gives Vite a natural split point and keeps the worker chunk out of the critical path.

**Implications:**
- The PDF branch has a real loading state (and a real error state if the import or the document load fails) — both are appearance, so they ride DOM/CSS attributes, not React state for visuals ([L06]).
- The app-test must wait for the async load rather than assuming a synchronous mount.

#### [P03] The PDF surface is a responder that owns its keys (DECIDED) {#p03-responder}

**Decision:** The surface registers with `useResponder` and handles its keys as chain actions, rather than attaching a `keydown` listener to `window` or `document`.

**Rationale:**
- It is how the deck already routes keys; precedence, nesting, and "who is first responder" are the chain's job ([L22], `tuglaws/responder-chain.md`).
- `TugContextMenu` dispatches its items **through the chain to the first responder**, so being a responder is also what makes the menu work at all. One mechanism serves both.

**Implications:**
- ⌘+ / ⌘- / ⌘0 must `preventDefault` so WebKit's page zoom does not also fire — that is the actual fix for "zoom is tied to the whole app."
- The surface must be able to become first responder, which is what [Q02] resolves.

#### [P04] The context menu marks the active mode with its `icon` slot (DECIDED) {#p04-menu-check}

**Decision:** The active page mode is marked by passing a check glyph to `TugContextMenuItem.icon` for that item; `TugContextMenu` is **not** modified.

**Rationale:**
- `TugContextMenuItem` has `label` / `icon` / `shortcut` / `disabled` / `action` / `value` but no `checked`. The `icon` slot renders before the label — exactly where a checkmark belongs, and exactly what the user's reference screenshot shows.
- Adding a `checked` affordance to a shared menu component is a change to a surface many callers use; it should be its own decision with its own review, not a side effect of the PDF work.

**Implications:**
- The mode items carry **no** `shortcut`, because the modes have no chord (#no-mode-chords). The zoom items do — ⌘+ / ⌘- / ⌘0 really work, via the host's View menu.
- If a checked affordance is later wanted repo-wide, this call site converts cleanly.

#### [P05] Page geometry is measured from the document, never estimated (DECIDED) {#p05-geometry}

**Decision:** Every page's box comes from pdf.js's `page.getViewport({ scale })`; the layout never estimates a page height.

**Rationale:**
- Estimated heights are banned in this codebase, and the ban is not a problem here: a PDF states its page sizes, so exact geometry is available before render.
- Exact geometry is also what makes visible-page-windowing safe on long documents ([R04]) — the scroll extent is correct from the start, so nothing shifts as pages render.

**Implications:**
- The document's page sizes are read once at load and cached per zoom level.
- Mixed page sizes (portrait + landscape in one file) fall out correctly rather than being a special case.

---

### Deep Dives {#deep-dives}

#### The three page modes {#page-modes}

**Table T01: Page modes** {#t01-page-modes}

| Mode | Layout | Scroll |
|---|---|---|
| Continuous Scroll | one column, all pages stacked, gap between pages | free vertical scroll across the whole document |
| Single Page | exactly one page fitted in the viewport | paging: PageUp/Down and arrows move page to page |
| Two Pages | two pages side by side, fitted as a pair | paging: moves two pages at a time |

The reference is Preview's View menu (the user's screenshot). **Its ⌘1/⌘2/⌘3 assignments are deliberately not adopted** — see (#keyboard). The modes are reached from the context menu.

#### Keyboard contract {#keyboard}

**Who owns ⌘+ / ⌘- / ⌘0 — and it is not the deck.** [P03] assumed the zoom fix was to `preventDefault` those chords so WebKit's page zoom would not also fire. That premise was wrong. The chords belong to the host's **View menu** (`view.zoomIn` / `view.zoomOut` / `view.actualSize` in `AppDelegate`), and AppKit resolves a menu key equivalent *before* the WKWebView is offered the keydown. No deck-side binding for those chords can ever fire, and there is no default to prevent — which is also the real reason the embed's zoom scaled the whole app.

The fix is therefore a claim, not a suppression. The surface publishes a `menuState.document` block; while it stands, the delegate's zoom selectors forward `zoom-in` / `zoom-out` / `zoom-actual` as control frames instead of calling `window.zoomIn()`, and the deck re-dispatches them into the chain ("Both" actions, per `action-naming.md`). Page-zoom bounds also stop gating the menu items while a document claims them, since the surface owns its own range. With no claim, the commands scale the web view exactly as before.

**The page modes take no chord at all.** {#no-mode-chords} Preview puts them on ⌘1/⌘2/⌘3; the deck spends those on `jump-to-tab`. `useKeybindings` *could* shadow them — it resolves before the static map and innermost-first, which is `performKeyEquivalent:` behavior and would have made Preview's shortcuts transfer — and an earlier revision did exactly that. It was withdrawn on the user's instruction: **a viewer does not get to redefine a deck-wide navigation command, even locally.** A reader who has learned that ⌘2 goes to the second tab should not find it means something else because the frontmost card happens to be a PDF, and a shadow is the kind of thing that is invisible until it surprises someone.

So the modes live in the context menu, with no `shortcut` hint (a hint for a key that does nothing is worse than none). Keyboard mapping across the deck is its own piece of work, and this is one of its inputs rather than a place to pre-empt it.

**What the surface does bind** is the navigation set — arrows, PageUp/Down, Home/End — which the static map does not use at all (its only Arrow entries carry ⌥⌘). Those take nothing from anyone, and the surface consumes them only while it is on the first-responder walk.

**Table T02: Keys the surface owns** {#t02-keys}

| Key | Continuous | Single / Two Pages |
|---|---|---|
| ↑ / ↓ | scroll by a step | previous / next page at the top and bottom edge |
| ← / → | scroll horizontally when zoomed past the viewport | previous / next page |
| PageUp / PageDown | scroll by a viewport | previous / next page (or spread) |
| Home / End | first / last page | first / last page |
| ⌘+ / ⌘- / ⌘0 | zoom in / out / actual size — **document-scoped**, routed from the host's View menu | same |

Page modes have no key; see (#no-mode-chords).

#### What replaces what {#replacement}

The card body's PDF branch today is a single `<embed src={blobUrl(path)} type="application/pdf">` with `data-slot="file-view-pdf"`, plus the `.file-view-card[data-file-view-kind="pdf"]` and `.file-view-card-pdf` rules in `file-view-card.css`. All of it goes. The image branch (`ImageBlock`), the `path === null` empty state, the title publication, the registry registration, and the state-preservation wiring stay untouched.

Note that `at0310`'s PDF case asserts on `[data-slot="file-view-pdf"]` and on the blob URL's `content-type`; it will need rewriting against the new surface, keeping the blob-route assertion (still true and still worth pinning) and dropping the `<embed>`-shaped ones.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/pdf-runtime.ts` | Lazy `import()` of `pdfjs-dist` + worker wiring per [Q01]; caches the module |
| `tugdeck/src/lib/pdf-layout.ts` | Pure layout/zoom math: page boxes per mode and scale, visible-page window, fit-width / fit-page scales |
| `tugdeck/src/lib/__tests__/pdf-layout.test.ts` | Bun unit tests for the above |
| `tugdeck/src/components/tugways/cards/pdf-view.tsx` | The surface: document load, page canvases + text layers, modes, zoom, keys, context menu |
| `tugdeck/src/components/tugways/cards/pdf-view.css` | Surface layout and page chrome |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `loadPdfRuntime()` | fn | `pdf-runtime.ts` | Resolves the cached pdf.js module; sets `GlobalWorkerOptions.workerSrc` once |
| `PdfPageMode`, `layoutPages`, `fitScale`, `visiblePageRange` | type/fn | `pdf-layout.ts` | Pure over page sizes + viewport; unit-tested without a DOM |
| `PdfView` | component | `pdf-view.tsx` | Props `{ path }`; owns everything below the card |
| `FileViewCardContent` | component (modify) | `file-view-card.tsx` | PDF branch renders `<PdfView>`; `<embed>` removed |
| `FileViewCardBagContent` | interface (modify) | `file-view-card.tsx` | Gains page mode + zoom per [Q03] |
| `.file-view-card-pdf`, `[data-file-view-kind="pdf"]` rules | CSS (modify) | `file-view-card.css` | Embed-specific rules removed / replaced |
| PDF case in `at0310` | test (modify) | `tests/app-test/at0310-file-view-open.test.ts` | Rewritten against the new surface |
| `pdfjs-dist` | dependency | `tugdeck/package.json` | Plus `bun.lock`; add the Apache-2.0 entry to `THIRD_PARTY_NOTICES.md` |

---

### Documentation Plan {#documentation-plan}

- [ ] Module docstrings on every new file ([L19]), stating the contract in place — the worker-wiring form and *why* it is that form especially, since [Q01] is the thing a future reader will most want explained.
- [ ] Name the laws touched in each dash commit body ([L02], [L03], [L06], [L19], [L20], [L22], [L23]).
- [ ] `THIRD_PARTY_NOTICES.md` entry for pdf.js.
- [ ] Update the predecessor plan's [Q01] Resolution to point here once this lands.
- [ ] No freestanding docs beyond this plan.

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|----------|---------|------|
| **Unit (bun)** | `pdf-layout` math: page boxes per mode, fit scales, visible window, mixed page sizes | `#step-2` |
| **App-test** | Real render through the production bundle: page pixels non-blank, keys scroll/page, ⌘1-3 change layout, ⌘+/-/0 scope to the card, right-click menu marks the active mode, selection works | `#step-1`, `#step-6` |
| **Regression** | `at0310`'s image case and the 11-file Lens/open selection stay green | `#step-6` |

**Banned, as always:** jsdom / RTL render tests, mock-store assertion tests. The surface is exercised on a real document in the real app or at the pure-function layer, nowhere in between.

A caution for the app-test: assert on **rendered pixels**, not merely that a `<canvas>` element exists. A canvas that mounted but never painted is exactly the failure mode a worker problem produces ([R01]), and an element-presence assertion would sail straight past it. Sample the canvas with `getImageData` and require non-uniform content.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | pdf.js dependency + worker spike (resolves [Q01]) | done | `285ddd130` |
| #step-2 | `pdf-layout.ts` — pure geometry and zoom math | done | `1a1912ad3` |
| #step-3 | `PdfView` surface: render + text layer + focus ([Q02]) | done | `5e2fd41f3` |
| #step-4 | Page modes, zoom, and the keyboard contract ([Q03]) | done | `490f2ad31` |
| #step-5 | `TugContextMenu` control surface | done | `3b5734b85` |
| #step-6 | Swap the card branch, rewrite the PDF app-test, full verification | done | `149d23328` |

**Milestone M03: pdf.js viewer** {#m03} — all six steps.

---

#### Step 1: pdf.js dependency + worker spike {#step-1}

**Commit:** `tugdeck(pdf-viewer): pdfjs-dist dependency with production-verified worker wiring`

**References:** [Q01] worker, [P02] lazy, Risk R01, (#q01-worker, #r01-worker)

**Tasks:**
- [ ] `bun add pdfjs-dist` **in the dash worktree**; note the resolved version in this plan.
- [ ] `lib/pdf-runtime.ts`: dynamic `import()`, worker wiring, module cache. Try the `new Worker(new URL(...))` form first.
- [ ] Throwaway probe: render page 1 of a generated PDF to a canvas, mounted anywhere reachable, and read pixels back.
- [ ] **Verify through `just app-test`**, which serves the production bundle — this is the whole point of the step; a dev-server pass proves nothing here.
- [ ] Record the winning form in [Q01]'s Resolution, including what was tried and rejected.
- [ ] Add the pdf.js entry to `THIRD_PARTY_NOTICES.md`.

**Checkpoint:**
- [ ] `bunx tsc --noEmit`; `bunx vite build` clean, main chunk not materially larger ([R02])
- [ ] The probe app-test renders non-blank pixels

---

#### Step 2: `pdf-layout.ts` — pure geometry and zoom math {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(pdf-viewer): page layout and zoom math`

**References:** [P05] geometry, Table T01, (#page-modes)

**Tasks:**
- [ ] `PdfPageMode = "continuous" | "single" | "two"`.
- [ ] `layoutPages(pageSizes, mode, scale, viewport)` → page boxes; exact, never estimated.
- [ ] `fitScale(pageSize, viewport, "width" | "page")` for ⌘0 and the initial scale.
- [ ] `visiblePageRange(boxes, scrollTop, viewportHeight, margin)` for windowing ([R04]).
- [ ] Handle mixed page sizes in one document.

**Tests:**
- [ ] Bun unit: each mode's boxes; fit scales; visible window at top / middle / end; mixed portrait+landscape; single-page and empty documents.

**Checkpoint:**
- [ ] `bun test src/lib/__tests__/pdf-layout.test.ts && bunx tsc --noEmit`

---

#### Step 3: `PdfView` surface — render, text layer, focus {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(pdf-viewer): PdfView surface with text selection and focus ownership`

**References:** [P01] core only, [P02] lazy, [P03] responder, [Q02] enginekind, (#replacement)

**Tasks:**
- [ ] Read `tuglaws/focus-language.md`, `tuglaws/responder-chain.md`, `tuglaws/component-authoring.md` before writing the component.
- [ ] Load the document from `blobUrl(path)`; loading and error states as DOM/CSS attributes ([L06]).
- [ ] Render visible pages to canvas at devicePixelRatio × scale; re-render on scale change; cache what is cheap to cache.
- [ ] pdf.js text layer over each page so selection works.
- [ ] `useResponder` registration in a `useLayoutEffect` ([L03]); resolve [Q02] against the real focus manager and record the answer.
- [ ] Verify selection with a real drag before moving on.

**Checkpoint:**
- [ ] `bunx tsc --noEmit && bunx vite build`
- [ ] Renders and selects in the debug app (`just app-debug` from the worktree)

---

#### Step 4: Page modes, zoom, and keys {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(pdf-viewer): page modes, card-scoped zoom, keyboard contract`

**References:** [P03] responder, [P05] geometry, [Q03] persistence, Table T01, Table T02, (#page-modes, #keyboard)

**Tasks:**
- [ ] Wire the three modes from [T01] over `layoutPages`.
- [ ] Zoom: in / out / actual / fit — **`preventDefault` on ⌘+/⌘-/⌘0** so WebKit page zoom does not also fire. This is the fix for the app-wide zoom complaint.
- [ ] Implement [T02] in full, including the edge behavior (arrows page over at page boundaries in paged modes).
- [ ] Resolve [Q03]; persist through the card bag, writing through the same way `path` does ([L23]).

**Checkpoint:**
- [ ] `bunx tsc --noEmit && bun test src/lib && bunx vite build`
- [ ] Hands-on in the debug app: every row of [T02] behaves, and ⌘+ does not zoom the rest of the app

---

#### Step 5: `TugContextMenu` control surface {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(pdf-viewer): right-click zoom and page-mode menu`

**References:** [P04] menu check, Table T01, Table T02

**Tasks:**
- [ ] Wrap the surface in `TugContextMenu` with page modes (⌘1/⌘2/⌘3) and zoom items, separated into groups.
- [ ] Mark the active mode via the `icon` slot per [P04]; carry `shortcut` strings so the menu teaches the keys.
- [ ] Items dispatch chain actions the surface's responder already handles — the menu must not grow its own private command path.

**Checkpoint:**
- [ ] `bunx tsc --noEmit && bunx vite build`
- [ ] Right-click in the debug app: menu opens over the PDF, marks the active mode, and every item does what its key does

---

#### Step 6: Swap the card branch, rewrite the app-test, verify {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(pdf-viewer): replace the native PDF embed with the pdf.js surface`

**References:** Milestone M03, (#success-criteria, #replacement)

The branch swap itself landed early, in `#step-1`: the spike needed a real card to render into, and `PdfView` kept the `data-slot="file-view-pdf"` the existing app-test already asserts on, so the swap was the cheapest way to reach the production bundle. What remains here is the verification sweep and the surrounding paperwork.

**Tasks:**
- [x] `file-view-card.tsx`: PDF branch renders `<PdfView>`; delete the `<embed>` and its CSS rules. *(landed in `#step-1`)*
- [ ] Rewrite `at0310`'s PDF case against the new surface — keep the blob-route `content-type` assertion, drop the `<embed>`-shaped ones, and assert **pixels**, keys, modes, and the menu per (#success-criteria).
- [ ] Update the predecessor plan's [Q01] Resolution to point here.
- [ ] Rewrite the dash join draft (`tugutil draft set --owner dash:files-feature`) to cover the switchover.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0310-file-view-open.test.ts`
- [ ] `just app-test-changed` for the touched surfaces; core tier (`just app-test`) if `main.tsx` changed
- [ ] `bunx tsc --noEmit && bunx vite build`; `just app-test-covers-check`
- [ ] `cd tugrust && cargo nextest run -p tugcast` (blob route untouched, but the route is this feature's floor)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The `file-view` card renders PDFs with Tug's own viewer — keyboard-drivable, card-scoped zoom, three page modes, and a right-click control surface — replacing a native embed that offered none of it.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Every criterion in (#success-criteria) verified by its named test or hands-on check.
- [x] [Q01], [Q02], [Q03] all carry recorded Resolutions.
- [x] All checkpoints green; `bunx vite build` clean; `just app-test-covers-check` passes.
- [x] The `<embed>` path is gone, not merely bypassed.
- [x] The join draft covers M01 + M02 + M03.

**Verification of record.** 22 app-tests — everything whose `@covers` reaches a file this dash touched — all green: `at0310` (the open chain, page pixels, text selection), `at0311` (arrows, paging, Home/End, ⌘1-3, a native ⌘+ that scales the document and not the app, the right-click menu and its marks), and the 20 menu / focus / Lens / Open Quickly tests that ride `host-menu-state.ts` and `action-dispatch.ts`. 1307 deck unit tests, 1284 tugcast tests, `bunx tsc --noEmit` and `bunx vite build` clean, `just app-test-covers-check` clean.

One flake seen and dismissed: `feeds::shell::tests::kill_reaps_a_long_runner` failed once under concurrent load and passed both in isolation and on a clean full re-run. It is a process-reaping timeout with no relationship to anything here.

**What the success criteria cost, against the plan's own predictions.** Three of them were written on a wrong premise and are worth reading against what shipped:

- "⌘+ / ⌘- / ⌘0 change the card's render scale **without** changing the rest of the app's zoom" — true, but not by `preventDefault`; see (#keyboard).
- "app-test asserts a sibling card's metrics are unchanged" — the assertion is on the deck's own layout width, which is the thing WebKit page zoom would have moved. A sibling card would have proven less.
- "Text selection still works over rendered pages (app-test asserts a non-empty selection after a drag)" — asserted by selecting across the text layer's spans and reading the text back, rather than by a synthesized drag. The drag would have tested WebKit's selection machinery; reading `"Page One"` out of the selection tests that pdf.js laid the text down where the page shows it.

#### Roadmap / Follow-ons (Explicitly Not Required) {#roadmap}

- [ ] A visible toolbar: page number field, page thumbnails, mode buttons.
- [ ] Chords for the page modes, once the deck-wide keyboard mapping work settles what ⌘1-3 should mean (#no-mode-chords).
- [ ] In-document search (pdf.js exposes the text content this needs).
- [ ] A `checked` affordance on `TugContextMenu` if the pattern recurs ([P04]).
- [ ] Video / audio kinds — still the blob route's prepared seam.
- [ ] Copy-image affordance and drag-out on the image branch.
