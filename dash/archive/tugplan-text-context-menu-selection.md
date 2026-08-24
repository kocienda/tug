# Right-Click / Secondary-Click Context Menu Must Preserve the Text Selection {#ctx-menu-selection}

A right-click (or macOS Control-click / trackpad two-finger tap) on selected text in **any**
tugways text surface must open the context menu **without dropping the selection**, so Cut /
Copy / Paste / Select All operate on what the user actually had selected. Today this is broken
across multiple surfaces, and it has resisted one-off fixes because the surfaces use **four
different selection implementations**, each of which loses the selection by a **different
mechanism**. This plan treats it as one feature, diagnoses each implementation, and fixes them
behind one shared contract.

### Status {#status}

- **Status:** active — investigation mostly complete (two root causes proven), fix + per-surface
  verification pending.
- **Surface:** tugdeck / tugways (TypeScript/React).
- **Build/test:** `bunx tsc --noEmit`; `bun test`. Real behavior is browser/native pointer +
  selection timing — **not reproducible in the unattended test harness** (the prior batch C
  lesson). Verification is a hands-on pass per surface on a live `just app-debug` build, guided
  by dev-log instrumentation (see [#investigation]).

### The feature contract {#contract}

One rule, every text surface:

1. A **secondary-click** (the gesture that opens a context menu) over a **ranged selection**
   must leave that selection intact (in the surface's authoritative selection model, not just
   visually).
2. A secondary-click over a **collapsed caret / empty area** positions the caret at the click
   (so Paste targets where you clicked); custom UX may expand to the clicked word.
3. The menu's **Cut / Copy enablement** reflects the real post-click selection.
4. **Copy / Cut** act on that selection and actually place text on the clipboard.
5. This holds for **all secondary-click gestures**: right mouse button (`button === 2`),
   Control-click (`button === 0` + `ctrlKey`), and trackpad two-finger tap (`button === 0`).

### The surfaces and their selection models {#surfaces}

All route through the shared hook `useTextSurfaceContextMenu`, which orchestrates a per-surface
`TextSelectionAdapter`: `capturePreRightClick()` at pointerdown → `prepareSelectionForRightClick()`
at contextmenu (restore snapshot + classify + JS-commit) → `hasSelection` drives the menu.

| # | Surface(s) | Consumer | Adapter | Selection model |
|---|---|---|---|---|
| 1 | TugInput, TugTextarea, TugValueInput | `use-text-input-responder.tsx` | `createNativeInputAdapter` | native `<input>/<textarea>` `selectionStart/End` |
| 2 | code/markdown editor, prompt (TugPromptEntry → TugTextEditor) | `tug-text-editor.tsx` | `createCMSelectionAdapter` | CodeMirror 6 `view.state.selection` |
| 3 | TugMarkdownView, dev-card transcript | `tug-markdown-view.tsx`, `dev-card-transcript.tsx` | `HighlightSelectionAdapter` | DOM `window.getSelection()` over a boundary el |
| 4 | tug-prompt-input *(legacy?)* | `tug-prompt-input.tsx` | `createEngineAdapter` | TugTextEngine flat offsets — **confirm if still live** |

### Root causes {#root-causes}

Two distinct defects, both proven from dev-log evidence in the prior session:

#### [P01] The capture gate misses button-0 secondary-clicks (affects #1, #3, #4) {#p01-gate}

The hook captures the pre-click selection only on `event.button === 2`:

```ts
const onPointerDown = useCallback((event) => {
  if (event.button !== 2) return;   // ← skips Control-click / trackpad (button 0)
  adapter?.capturePreRightClick();
}, [adapter]);
```

On macOS the common secondary-click gestures are **button 0** (Control-click, trackpad
two-finger tap — confirmed: `hook.onPointerDown {"button":0,"ctrlKey":true}`). So
`capturePreRightClick` never runs, `prepareSelectionForRightClick` has no snapshot to restore,
and the browser's mousedown caret-placement collapse stands. This breaks the native-input and
highlight/DOM pipelines (and the engine pipeline, if live), all of which depend on
**capture → restore**.

**Fix:** capture on **every** pointerdown. The snapshot is only ever *consumed* by a following
`contextmenu`, so capturing on an ordinary click is harmless (the next pointerdown overwrites it,
and it is never read unless a context menu follows). One change in the shared hook fixes every
capture/restore-based surface at once.

#### [P02] CodeMirror re-clobbers the selection with its own pointer handler (affects #2) {#p02-cm6}

For the CM6 editor, capture+restore is **not enough**. Even after `prepareSelectionForRightClick`
restores the range at contextmenu time, CodeMirror's **own built-in pointer selection** fires a
`select.pointer` transaction on **mouseup** (~60ms later) that moves the caret to the click point
and collapses the selection. Proven by a stack-trace probe:

```
SELECTION CLOBBERED before:"0-11" after:"5-5" userEvents:["select.pointer"]
  select@…  up@…   ← CodeMirror's pointer (mouse) handler, on mouse-UP
```

The capture/restore pipeline was designed to beat *WebKit's tentative smart-click revert*, not
*CM6's own pointer handler re-firing after the restore*. So restore-after is the wrong shape for
CM6 — the clobber must be **prevented**, not undone.

**Fix:** in a CM6 `EditorView.domEventHandlers.mousedown` that runs **before** CM6's built-in
handling, return `true` (suppressing CM6's pointer selection) when the click is a secondary-click
**and** there is a ranged selection. The OS `contextmenu` still fires, so the menu opens; the
range is never collapsed, so Copy/Cut just work. (Proven to work: `cmText:"hello world"`,
`execReturned:true`, no `SELECTION CLOBBERED`.) Only guard when a range exists — a plain-caret
secondary-click still positions the caret (Paste-at-click).

#### [P03] Per-surface clobber mechanisms must each be confirmed, not assumed {#p03-confirm}

The two fixes above are proven for CM6 (#2) and strongly implied for native (#1). But the
highlight/DOM (#3) and engine (#4) surfaces have their **own** selection models and may have
their own self-clobber (like CM6 did) on top of the gate issue. **We do not assume** — each
surface is confirmed empirically via instrumentation (next section) before we declare it fixed.
This is the discipline that was missing: localize each clobber with evidence, then kill it.

### Verification is self-running via app-tests + native gestures {#self-test}

The whole feature is verifiable **without manual reproduction**. The app-test harness
(`tests/app-test/_harness`) drives the real WKWebView and injects **trusted, OS-level** input —
the same way the entire suite already does:

- **`app.nativeRightClick(point)` / `app.nativeClick(point, { button })`** — real secondary-click
  events (`isTrusted: true`), so the *native* clobber reproduces (synthetic `dispatchEvent` is
  untrusted and would not). `app.getElementScreenBounds(selector)` resolves the target.
- **`app.getSelection(cardId)` / `getFormControlValue` / `evalJS("el.selectionStart…")`** — read
  the surface's selection back after the click.
- **`app.evalJS("…tugDevLogStore snapshot…")`** — read the `rclk` probe entries straight out of
  the page to see capture/restore/classify and the clobber-catcher trace.

So each surface gets a `tests/app-test/atXXXX-<surface>-rightclick-selection.test.ts` that: seeds
text, sets/drag-selects a range, `nativeRightClick`s on it, and asserts the selection survived
(plus reads the `rclk` trace). Run with `just app-test <file>`; check the trailing `VERDICT:`
line. This is the verification mechanism for every step below — **I run it, not the user.**

The one limitation that *does* still apply: clipboard *content* assertions (`did Copy place
text`) can be blocked by the unattended-focus / WebKit clipboard restriction. We sidestep it —
the defect is the **selection drop**, which is read directly; copy itself was never broken, so a
surviving selection is the pass condition.

### Investigation method — instrument, reproduce, read the trace {#investigation}

The technique that worked: **dev-log probes + a stack-trace "clobber catcher,"** now read by the
app-test via `evalJS` rather than pasted by hand. For each surface:

- **Hook probes** (`useTextSurfaceContextMenu`): `onPointerDown` (button, ctrlKey,
  adapter present), `onContextMenu` + after-prepare (adapter present, classification, hasSelection
  before/after). Tells us whether capture runs for the user's gesture and whether restore yields a
  range.
- **Clobber catcher** (per selection model): log the moment a ranged selection becomes collapsed,
  with a stack trace, so the *exact* clobbering code is named:
  - CM6: `EditorView.updateListener` on `selectionSet` ranged→collapsed (proven).
  - Native input: a `selectionchange` listener on the element, or log in the copy handler's
    read, comparing to the snapshot.
  - Highlight/DOM: a `document` `selectionchange` listener scoped to the boundary.
- **Copy-handler probe**: the selection the copy path actually reads at execute time.

All probes log via `tugDevLogStore.{info,warn}("rclk", …)` (viewable in TugDevPanel, `Opt-Cmd-/`,
Log tab, filter `rclk`) — never `console.*`. They are **temporary**, stripped before the final
commit. The user reproduces the gesture on each surface and shares the `rclk` lines; the trace
decides the fix. No fix lands for a surface without a clean trace showing the clobber gone.

### Fix design — one contract, per-surface mechanism {#fix-design}

- **Shared hook** ([P01]): capture on every pointerdown. Fixes the capture/restore surfaces
  (native, highlight, engine) for all gestures in one place.
- **CM6 editor** ([P02]): add the `mousedown` domEventHandler that suppresses CM6's pointer
  selection for a secondary-click over a range. Prevent, don't restore.
- **Any other surface that self-clobbers** ([P03]): if instrumentation shows a surface re-collapses
  after restore (as CM6 does), give it the equivalent *prevent-the-collapse* mechanism for its
  model; otherwise the shared capture/restore fix suffices.
- **Document the principle** in `tuglaws/` (component-authoring): "a secondary-click that opens a
  context menu must not collapse a ranged selection; capture on every pointerdown, and where the
  editor has its own pointer-selection, suppress it for secondary-clicks over a range." So new text
  surfaces inherit the contract and this doesn't regress.

### Execution steps {#steps}

Each step lands a **self-running app-test** (native right-click → assert selection survives +
read the `rclk` trace), confirmed green via `just app-test` — I run it, not the user. Commit per
step; strip that surface's probes as it's confirmed.

| Step | Scope | Fix | App-test (native right-click → selection survives) |
|---|---|---|---|
| S0 | Baseline harness | Write the first app-test against the **current (buggy)** native input; run it; confirm it **FAILS** (reproduces the drop) and the `rclk` trace shows `button:0, capturedHere:false`. Proves the harness reproduces the bug before any fix. | TugInput |
| S1 | Instrumentation | Hook probes + per-model clobber catchers (temporary) — done. | (tooling) |
| S2 | Shared hook ([P01]) | Capture on every pointerdown. | TugInput, TugTextarea, TugValueInput |
| S3 | CM6 ([P02]) | `mousedown` domEventHandler suppresses CM6 pointer-select for secondary-click+range. | code/markdown editor, prompt |
| S4 | Highlight/DOM ([P03]) | Confirm trace; gate fix (S2) may suffice, or add a prevent step if it self-clobbers. | TugMarkdownView, transcript |
| S5 | Engine (#4) | Confirm tug-prompt-input is live; if so, trace + fix. If dead, note and skip. | tug-prompt-input (if live) |
| S6 | Cleanup + law | Strip all `rclk` probes; add the principle to tuglaws/component-authoring; keep the per-surface app-tests as regressions. | full re-sweep |

### Non-goals {#non-goals}

- Rewriting the adapter architecture — the `TextSelectionAdapter` abstraction is sound; the bugs
  are in the gate and in CM6's missing prevention, not the abstraction.
- The keyboard-model plan (`tugplan-keyboard-model.md`) — this is a separate, pre-existing bug
  surfaced during that work; it is tracked here on its own.
