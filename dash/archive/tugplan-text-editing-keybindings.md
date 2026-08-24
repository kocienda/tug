<!-- tugplan-skeleton v2 -->

## Text-Editing Keybindings — Audit and Gap-Fill {#text-editing-keybindings}

**Purpose:** Make the standard Unix-style text-editing keybindings (Ctrl-A/E/F/B/P/N/D/H/K/T/U/W, Option-F/B, Option-Delete) work uniformly across the three text-editing substrates — `tug-input`, `tug-textarea`, and `tug-text-editor`. The user-visible bug that kicks this off is **Ctrl-U does nothing** in any of the three substrates. The audit reveals that most of the bindings work today via the WKWebView's AppKit field editor (native `<input>`/`<textarea>`) or via `@codemirror/commands`'s `defaultKeymap` (which embeds `emacsStyleKeymap`); a small handful — Ctrl-U, Ctrl-W, Option-F, Option-B — are gaps everywhere. This plan fills those gaps in a way that is consolidated under [tuglaws/action-naming.md](../tuglaws/action-naming.md), substrate-local rather than chain-routed (rationale in [DM01]), and laid out so a future settings dialog for keybinding remap is one mechanical edit away.

The plan is deliberately small: one new module, four new `TUG_ACTIONS`, two substrate wirings, a tuglaws walkthrough. No global pipeline changes, no responder-chain changes, no protocol changes.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | tugplan-text-editing-keybindings |
| Last updated | 2026-05-06 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

This is a bug-driven plan; it surfaces from a user report ("Ctrl-U doesn't clear a line") rather than a parent roadmap row. The closest predecessor is the `useTextInputResponder` consolidation that landed cut/copy/paste/select-all under one hook (already shipped) and [tuglaws/action-naming.md](../tuglaws/action-naming.md) (the naming and classification doc this plan extends). The closest successor is a settings UI for keybinding remap — explicitly out of scope here, but the new `text-editing-keybindings.ts` module is laid out as the data layer such a UI would consume.

Three text-editing substrates ship in tugways:

- **`tug-input.tsx`** — wraps a native `<input>`. Consumes `useTextInputResponder` for cut/copy/paste/select-all. Has zero keydown handling beyond the global `keybinding-map.ts` capture-phase pipeline.
- **`tug-textarea.tsx`** — wraps a native `<textarea>`. Same hook, same surface as `tug-input`.
- **`tug-text-editor.tsx`** — CodeMirror 6 substrate. Carries `keymap.of([...defaultKeymap, ...historyKeymap])` plus a tug-specific `Prec.high` keymap (`tug-text-editor/keymap.ts`) for Enter / numpad-Enter / Cmd-Enter / Cmd-Up / Cmd-Down only.

The audit, indexed against the user-supplied list of bindings:

| Keystroke | tug-input | tug-textarea | tug-text-editor |
|---|---|---|---|
| Ctrl-A line start | AppKit ✅ | AppKit ✅ | `defaultKeymap` (emacsStyleKeymap) ✅ |
| Ctrl-E line end | AppKit ✅ | AppKit ✅ | `defaultKeymap` ✅ |
| Ctrl-F char fwd | AppKit ✅ | AppKit ✅ | `defaultKeymap` ✅ |
| Ctrl-B char back | AppKit ✅ | AppKit ✅ | `defaultKeymap` ✅ |
| Ctrl-P line up | n/a (single line) | AppKit ✅ | `defaultKeymap` ✅ |
| Ctrl-N line down | n/a | AppKit ✅ | `defaultKeymap` ✅ |
| Ctrl-D delete fwd | AppKit ✅ | AppKit ✅ | `defaultKeymap` ✅ |
| Ctrl-H delete back | AppKit ✅ | AppKit ✅ | `defaultKeymap` ✅ |
| Ctrl-K kill EOL | AppKit ✅ | AppKit ✅ | `defaultKeymap` ✅ |
| Ctrl-T transpose | AppKit ✅ | AppKit ✅ | `defaultKeymap` ✅ |
| **Ctrl-U erase to BOL** | ❌ | ❌ | ❌ |
| **Ctrl-W erase prev word** | ❌ | ❌ | ❌ |
| **Option-F word fwd** | ❌ (only Opt-→) | ❌ (only Opt-→) | ❌ (only Alt-→) |
| **Option-B word back** | ❌ (only Opt-←) | ❌ (only Opt-←) | ❌ (only Alt-←) |
| Option-Delete del prev word | AppKit ✅ | AppKit ✅ | `standardKeymap` (Alt-Backspace = `deleteGroupBackward`) ✅ |

The actual gaps are four bindings — Ctrl-U, Ctrl-W, Option-F, Option-B — each missing in all three substrates. Everything else fires today via platform or CM6 defaults.

A second observation: outside the gap fills, no consolidated registry exists today for "the editing keybindings." `keybinding-map.ts` is the global capture-phase map for cross-substrate semantics (Cmd-A, Cmd-W, Cmd-T, Cmd-1..9, etc.); it is structurally wrong for text-editing motions/deletions because those keys only ever target the focused text input — there is no chain dispatch story (see [DM01]). The consolidation that earns its keep here is a *substrate-local* registry: one source-of-truth file naming the mapping, consumed by each substrate's own keystroke handler.

#### Strategy {#strategy}

- **Gap-fill, not platform-replace.** Keep the platform-handled bindings (Ctrl-A/E/F/B/P/N/D/H/K/T, Option-Delete) firing through AppKit / CM6's `defaultKeymap`. Only register handlers for the four gap bindings. This avoids re-implementing AppKit's text-handling logic in JS for native inputs, and avoids fighting `defaultKeymap`'s precedence in CM6.
- **Substrate-local registry, action-named.** A single new module `tugways/text-editing-keybindings.ts` exports the `keystroke → action` mapping for the gap bindings. Each substrate consumes the module and wires its own implementation per action. The action names land in `TUG_ACTIONS` per [action-naming.md](../tuglaws/action-naming.md) so the vocabulary stays uniform with the rest of the chain.
- **Native undo-stack integration is load-bearing.** Native `<input>` / `<textarea>` deletions must push onto the WKWebView's NSUndoManager so Cmd-Z reverts them; this rules out direct `setRangeText` / synthetic-event hacks and points to `execCommand` (`"delete"` after an explicit `setSelectionRange`) as the implementation path. CM6's commands push onto the editor's own `history()` stack and need no special handling.
- **One commit per step.** Action vocabulary + registry; native wiring; CM6 wiring; tests + close-out. Each step lands a complete, useful, regression-tested slice.
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` pass on every step. Warnings are errors per the project policy. HMR drives the dev verification — no manual builds.

#### Success Criteria (Measurable) {#success-criteria}

The plan succeeds when **all** of the following hold:

- Pressing **Ctrl-U** in `tug-input`, `tug-textarea`, or `tug-text-editor` deletes from the caret backward to the start of the current line. (Verification: manual in dev server; `app-test` integration smoke for each substrate.)
- Pressing **Ctrl-W** in any of the three substrates deletes the word ending at (or immediately preceding) the caret. (Verification: same.)
- Pressing **Option-F** moves the caret forward one word; **Option-B** moves it backward one word. With Shift held, the motion extends the selection (matches Option-Arrow precedent). (Verification: same.)
- Cmd-Z reverts each new operation in each substrate. Native `<input>` / `<textarea>` use the browser/WKWebView's native undo stack; the editor uses CM6's `history()`. (Verification: manual.)
- The platform-handled bindings — Ctrl-A/E/F/B/P/N/D/H/K/T, Option-Delete — continue to fire after the wiring lands. The new keydown listener does *not* `preventDefault` for any keystroke outside the four gap bindings. (Verification: manual; an `app-test` for each substrate exercises Ctrl-A and Ctrl-K as canaries.)
- Adding or remapping a keybinding is a single edit to `text-editing-keybindings.ts`. The module is the data layer a future settings dialog will read. (Verification: code review.)
- Tuglaws cross-check passes per-step (Step 4).
- All check commands green at every commit.

#### Scope {#scope}

1. **New `TUG_ACTIONS`** — `delete-to-line-start`, `delete-word-backward`, `move-word-forward`, `move-word-backward`. With shift-extension variants resolved at the substrate level (see [DM05]), no separate "select-" actions are introduced.
2. **New module `tugways/text-editing-keybindings.ts`** — typed `EditingKeybinding[]` registry with a `matchEditingKeybinding(event)` helper modeled on `keybinding-map.ts`'s `matchKeybinding`. Restricted to the four gap actions.
3. **Native-input substrate wiring** — extend `useTextInputResponder` with a keydown listener and four action handlers, behind the existing `useOptionalResponder` registration so a non-provider mount still works.
4. **CM6 substrate wiring** — extend `tug-text-editor/keymap.ts` with the four bindings, mapped to existing `@codemirror/commands` commands (`deleteLineBoundaryBackward`, `deleteGroupBackward`, `cursorGroupForward`, `cursorGroupBackward`, plus their `select*` analogues for the Shift variants). Also register the same four `TUG_ACTIONS` on the editor's responder so a menu / settings dispatch hits the same code path.
5. **Tests** — pure-logic test for `matchEditingKeybinding`; one `app-test` per substrate exercising Ctrl-U, Ctrl-W, and a platform-handled canary (Ctrl-A or Ctrl-K) to pin the no-regression contract.
6. **Tuglaws walkthrough + close-out.**

Out of scope:

- A settings UI for keybinding remap. The module is laid out as the data layer such a UI would consume; the UI itself is a future plan.
- Promoting the platform-handled bindings (Ctrl-A/E/F/B/etc.) into `TUG_ACTIONS` for completeness. Dead names without handlers create reviewer confusion; we add only what we wire ([DM02]).
- Routing the editing keystrokes through the global `keybinding-map.ts` capture-phase pipeline. Architectural rationale in [DM01].
- Touching `tug-value-input` or `tug-prompt-entry` directly. They consume `useTextInputResponder` (or the editor) and inherit the fix transitively.
- Re-implementing AppKit's existing text-handling for Ctrl-A/E/etc. in JS. The audit confirms those work via the WKWebView; we leave them alone.

---

### Resolved Questions / Design Decisions {#design-decisions}

#### [DM01] Editing keystrokes are wired substrate-locally, not through the global `keybinding-map.ts` chain pipeline {#dm01-substrate-local}

**Decision:** The four gap bindings (Ctrl-U, Ctrl-W, Option-F, Option-B) and their action handlers are wired *inside* the substrate that owns the keystroke — `useTextInputResponder` for native `<input>` / `<textarea>`, the CM6 keymap for `tug-text-editor`. They do **not** appear in `KEYBINDINGS` in `tugways/keybinding-map.ts`. The new `tugways/text-editing-keybindings.ts` is a separate, substrate-consumed registry.

**Rationale:**

- Movement and deletion only ever target the focused text input. There is no scenario where Ctrl-W means "erase previous word" *somewhere other than* where the caret is. The chain abstraction adds nothing.
- Routing through `keybinding-map.ts` with `preventDefaultOnMatch: true` would require us to re-implement AppKit's text-handling logic in JS for native inputs, because once `preventDefault` fires the native field editor never sees the key. That would be a large amount of code that today works for free at the platform level.
- `keybinding-map.ts` is well-suited for *cross-substrate* semantics (Cmd-A select-all dispatches to whichever responder is focused; Cmd-W targets the active card; Cmd-T targets the active pane). Keeping it focused on cross-substrate semantics makes both registries easier to reason about.
- Substrate-local wiring also means the implementation can vary by substrate (`execCommand` for native; CM6 commands for the editor) without smearing the divergence across the chain.

**Alternative considered:** add the four bindings to `KEYBINDINGS` with `preventDefaultOnMatch: true`, register handlers on text-editing responders, let the chain dispatch them. **Rejected** for the reasons above; the chain machinery does no useful work here.

#### [DM02] Only gap actions earn `TUG_ACTIONS` entries; platform-handled ones do not {#dm02-only-gap-actions}

**Decision:** Add four new `TUG_ACTIONS` constants — `DELETE_TO_LINE_START`, `DELETE_WORD_BACKWARD`, `MOVE_WORD_FORWARD`, `MOVE_WORD_BACKWARD`. Do **not** add `MOVE_LINE_START`, `MOVE_LINE_END`, `MOVE_CHAR_FORWARD`, `MOVE_CHAR_BACKWARD`, `MOVE_LINE_UP`, `MOVE_LINE_DOWN`, `DELETE_CHAR_FORWARD`, `DELETE_CHAR_BACKWARD`, `DELETE_TO_LINE_END`, `TRANSPOSE_CHARS`, `DELETE_WORD_FORWARD` — the platform / `defaultKeymap` already handles those.

**Rationale:**

- [action-naming.md](../tuglaws/action-naming.md) treats action names as API. An action with no responder handler is a dead name in the vocabulary; reviewers cannot tell from the constants file whether dispatch will do anything. Dead names are worse than absent names.
- If a future settings dialog wants to remap Ctrl-A → "delete to line start," the binding entry can name the existing `DELETE_TO_LINE_START` action; we don't need a separate `MOVE_LINE_START` constant for the *current* Ctrl-A mapping because Ctrl-A's current mapping is "whatever AppKit does," handled below the chain entirely.
- If a later effort decides to take ownership of the platform-handled bindings (e.g., to present a uniform behavior across browser dev and Tug.app), this plan's structure scales: add the constants, the registry entries, and the substrate handlers in one symmetrical step. The current plan does the minimum.

**Alternative considered:** add the full vocabulary now (~14 actions) so the registry is "complete." **Rejected**; dead names harm clarity per the doc, and the future plan that would use them would also write the handlers. No information is lost.

#### [DM03] Native deletions go through `execCommand` for undo-stack integration {#dm03-execcommand-deletes}

**Decision:** In `useTextInputResponder`, the handler for `DELETE_TO_LINE_START` and `DELETE_WORD_BACKWARD` computes the target range, calls `el.setSelectionRange(targetStart, targetEnd)` on the input/textarea, then calls `document.execCommand("delete")`. The DOM mutation lands through the browser's native editing pipeline, which pushes onto the WKWebView's NSUndoManager, so Cmd-Z reverts the deletion alongside any other native edits.

**Rationale:**

- This is the [L23] invariant for native inputs: the WKWebView's NSUndoManager state is user data, and an internal implementation operation must not destroy it. Cmd-Z keeping working after a Ctrl-U / Ctrl-W deletion is the user-visible state we are obligated to preserve.
- The existing `applyPastedText` helper in the same hook documents the pattern: `setRangeText` + synthetic input event bypasses the native editing pipeline and leaves the edit invisible to NSUndoManager. The fix used there was to switch to `execCommand("insertText", false, text)`. Deletions follow the same logic: select-then-`execCommand("delete")` keeps undo working.
- The "set selection, run execCommand" pattern is symmetrical with the existing `cut` handler in the same hook (which sets up via `execCommand("copy")` then `execCommand("delete")` in the continuation), so reviewers see one shape.
- The browser's selection/range computation is already correct for the DOM-text representation; we only need to feed it the boundary indices.

**Implications:**

- Word boundaries for `DELETE_WORD_BACKWARD` come from the existing `findWordBoundaries(text, offset)` helper already used by the right-click adapter (`text-selection-adapter.ts`). One source of truth for "what is a word here."
- Line boundaries for `DELETE_TO_LINE_START` are: for `<input>`, the start of the value; for `<textarea>`, the index immediately after the last `\n` at-or-before the caret. Trivial; covered by a small helper inside the hook.

**Alternative considered:** `setRangeText("", start, end, "end")` plus a synthetic `input` event. **Rejected** because of the NSUndoManager-blindness regression history that motivated the equivalent fix in `applyPastedText`.

#### [DM04] CM6 motions/deletions reuse `@codemirror/commands` directly {#dm04-cm6-commands}

**Decision:** In `tug-text-editor`, the four gap bindings dispatch existing CodeMirror 6 commands:

- `Ctrl-U` → `deleteLineBoundaryBackward`
- `Ctrl-W` → `deleteGroupBackward`
- `Alt-F` → `cursorGroupForward` (Shift variant: `selectGroupForward`)
- `Alt-B` → `cursorGroupBackward` (Shift variant: `selectGroupBackward`)

These are added as a `Prec.high` `keymap.of([...])` entry in `tug-text-editor/keymap.ts`, layered before `defaultKeymap` so the new bindings win on those specific keys but every other binding falls through to `defaultKeymap` unchanged.

**Rationale:**

- The CM6 commands push onto CM6's own `history()` stack, so Cmd-Z reverts them naturally. No execCommand bridge needed.
- `cursorGroupForward` / `cursorGroupBackward` use CM6's word boundary definition — the same one Alt-Arrow uses today via `standardKeymap`. The user gets consistent behavior between Option-F/B and Option-Arrow.
- Re-using existing CM6 commands keeps the editor's keymap layer authoritative for "what an editing motion *means*" inside the editor; we are only adding bindings, not redefining motion semantics.

**Implications:**

- The Step 3 commit imports four additional symbols from `@codemirror/commands` (`deleteLineBoundaryBackward`, `deleteGroupBackward`, `cursorGroupForward`, `cursorGroupBackward`) plus their two `select*` analogues for Shift extension.
- The `tug-text-editor` responder also registers handlers for the four `TUG_ACTIONS` so a future menu / settings dispatch invokes the same CM6 commands programmatically. The handler body is one line each (e.g., `deleteLineBoundaryBackward(view)`).

#### [DM05] Shift-extends-selection is resolved at the substrate, not via separate actions {#dm05-shift-at-substrate}

**Decision:** No `SELECT_*` action is added for the move actions. In CM6, the keymap entry binds `Alt-F` to `cursorGroupForward` and `Shift-Alt-F` to `selectGroupForward` (two entries, one binding pair) — CM6's idiomatic way to express "the same motion with extension." For native inputs, the handler reads `event.shiftKey` at dispatch time and either calls `setSelectionRange(newOffset, newOffset)` (collapsed) or `setSelectionRange(anchorOffset, newOffset)` (extended), where `anchorOffset` is the prior `selectionStart` or `selectionEnd` depending on direction.

**Rationale:**

- Avoids action-vocabulary bloat (no `SELECT_WORD_FORWARD` / `SELECT_WORD_BACKWARD`).
- Mirrors how the AppKit field editor behaves natively for the bindings it does handle (Option-Arrow, Cmd-Arrow): the same conceptual "motion" with Shift means "extend selection."
- The substrate-local resolution costs ~3 lines per handler; cheaper than two new action constants plus handler proliferation.

**Alternative considered:** add `SELECT_WORD_FORWARD` and `SELECT_WORD_BACKWARD` constants and a parallel pair of substrate handlers. **Rejected** for vocabulary bloat per [DM02]'s principle.

#### [DM06] `text-editing-keybindings.ts` is laid out as the data layer for a future settings UI {#dm06-future-settings}

**Decision:** The new module exports the registry as a mutable `let` binding (or a small `setEditingKeybindings(next)` setter) rather than a frozen `const`. The module's docstring states explicitly that the future settings dialog edits this layer. This plan does not ship the dialog.

**Rationale:**

- Action-naming.md's enforcement section discusses the future ESLint rule banning raw string literals in action positions; it explicitly opts not to write that rule preemptively. This plan applies the same posture to the settings dialog: lay the data out so the future plan is mechanical, ship nothing speculative.
- A mutable export is a small-blast-radius affordance. If the future settings plan ends up wanting the registry to be observable (a hot-update path), the change from `let + setter` to "a tiny store with a subscribe method" is local to the module.

**Implications:**

- Tests import the registry by reference, not by re-construction, so a future override-then-reset pattern works without test plumbing changes.
- The module header notes that the substrate hooks read the registry at keystroke time (not at mount time), so a runtime remap takes effect on the next keystroke. This mirrors [L07]'s "read config at call time."

---

### Phases and Steps {#phases-and-steps}

#### Phase A — Foundation (vocabulary + registry) {#phase-a}

#### Step 1: Action vocabulary + `text-editing-keybindings.ts` {#step-1}

**Commit:** `tugways(actions): add gap-fill editing actions and keybinding registry`

**References:** [DM01] substrate-local wiring, [DM02] only gap actions earn `TUG_ACTIONS` entries, [DM05] shift-extends at substrate, [DM06] data layer for future settings UI, (#scope, #context)

**Background:** The audit pinned four bindings missing across all three substrates. This step lays down the vocabulary they dispatch through and the registry the substrates consume. No substrate is wired yet — Steps 2 and 3 do the wirings on top of this foundation.

**Artifacts:**

- `tugdeck/src/components/tugways/action-vocabulary.ts`:
  - Add `DELETE_TO_LINE_START: "delete-to-line-start"`, `DELETE_WORD_BACKWARD: "delete-word-backward"`, `MOVE_WORD_FORWARD: "move-word-forward"`, `MOVE_WORD_BACKWARD: "move-word-backward"` to `TUG_ACTIONS`.
  - Document the payload (none) and sender expectations adjacent to each constant, matching the in-file comment idiom. Sender is "the focused text-editing responder"; payload is empty (the substrate handler reads selection state from the focused element at dispatch time per [L07]).
  - Add a section header comment `// ---- Editing motion / deletion ----` to group them, mirroring the existing section structure (Clipboard, Editing, Submission, Navigation, …).
- `tugdeck/src/components/tugways/text-editing-keybindings.ts` (new):
  - Module docstring stating purpose, scope ("substrate-local; not consumed by the global keybinding-map pipeline"), and the [DM06] note that this is the data layer a future settings UI will edit.
  - `EditingKeybinding` interface: `{ key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; action: TugAction; shiftExtends?: boolean }`. `key` uses `KeyboardEvent.code` (layout-independent, mirrors `KeyBinding` in `keybinding-map.ts`). `shiftExtends` is set on the `MOVE_*` entries so the substrate handler knows "shift turns this motion into selection extension" without needing per-handler hard-coding.
  - The default registry as a mutable export (per [DM06]):
    - `{ key: "KeyU", ctrl: true, action: TUG_ACTIONS.DELETE_TO_LINE_START }`
    - `{ key: "KeyW", ctrl: true, action: TUG_ACTIONS.DELETE_WORD_BACKWARD }`
    - `{ key: "KeyF", alt: true, action: TUG_ACTIONS.MOVE_WORD_FORWARD, shiftExtends: true }`
    - `{ key: "KeyB", alt: true, action: TUG_ACTIONS.MOVE_WORD_BACKWARD, shiftExtends: true }`
  - `matchEditingKeybinding(event: KeyboardEvent): EditingKeybinding | null` — modeled byte-for-byte on `matchKeybinding` in `keybinding-map.ts`, but consults this module's registry. When a binding has `shiftExtends`, the matcher accepts the keystroke regardless of `event.shiftKey` (the substrate handler reads `shiftKey` separately to decide motion-vs-selection); for entries without `shiftExtends`, `event.shiftKey` must equal `binding.shift ?? false` exactly.
- `tugdeck/src/components/tugways/__tests__/text-editing-keybindings.test.ts` (new):
  - Pure-logic unit tests for `matchEditingKeybinding`. Modeled on `keybinding-map`'s tests if any exist; otherwise a small fresh test file. happy-dom is fine here per the rule: pure DOM-helper logic with no React renders, no focus, no event ordering.
  - One test per registry entry confirming the match.
  - Negative tests: meta-modified (e.g., Cmd-U) does not match Ctrl-U; mismatched code does not match.
  - Shift-extends test: Shift-Alt-F matches `MOVE_WORD_FORWARD` (because `shiftExtends`); Shift-Ctrl-U does *not* match `DELETE_TO_LINE_START` (no `shiftExtends`).

**Tasks:**

- [ ] Add four constants to `TUG_ACTIONS` with adjacent payload comments.
- [ ] Author `text-editing-keybindings.ts` with interface, registry, matcher.
- [ ] Author the matcher unit tests.
- [ ] Verify the existing `TugAction` derived union picks up the four new members automatically (no ad-hoc type edits required).

**Tests:**

- [ ] `matchEditingKeybinding` returns the right entry for each registry binding.
- [ ] `shiftExtends` semantics: shift+entry matches; non-shifted matches; modifier mismatch (Cmd, Ctrl on an Alt entry, etc.) rejects.
- [ ] `bun x tsc --noEmit` clean — confirms `TugAction` union pickup.

**Tuglaws cross-check:**

- **[L11]** controls emit actions; responders handle actions — the four new actions are first-class members of the chain vocabulary, ready for handler registration.
- **[action-naming.md]** the four new constants follow `<verb>-<object>[-<modifier>]`, are kebab-case, are referenced via `TUG_ACTIONS.*` constants at every (future) call site.

**Open questions / decisions:**

- *Should the registry also include the platform-handled bindings as documentation-only entries (no action attached)?* Tabled: would require a non-action shape in the registry and adds reviewer confusion. The audit table in this plan is the documentation; the registry is for live bindings only.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — green.
- [ ] `bun run audit:tokens lint` — zero violations (no token surface touched, but the project policy runs it everywhere).
- [ ] `cargo nextest run` — green.

---

#### Phase B — Substrate wiring {#phase-b}

#### Step 2: Native input wiring (`useTextInputResponder`) {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(text-input): handle Ctrl-U/W and Option-F/B with native undo`

**References:** [DM01] substrate-local wiring, [DM03] native deletions go through execCommand for undo-stack integration, [DM05] shift-extends at substrate, [DM06] registry read at keystroke time, (#strategy)

**Background:** `useTextInputResponder` already owns CUT/COPY/PASTE/SELECT_ALL action handlers, ref composition, and the right-click context menu for native `<input>` and `<textarea>`. This step extends the same hook with a keydown listener and four new action handlers. No new components touched — `tug-input`, `tug-textarea`, and `tug-value-input` consume the hook and inherit the wiring transitively.

The implementation goes through `document.execCommand("delete")` after explicitly setting the selection range, per [DM03], so the deletions push onto the WKWebView's NSUndoManager and Cmd-Z reverts them. Motion handlers call `setSelectionRange` directly with the new offsets, optionally extended when Shift is held per [DM05].

**Artifacts:**

- `tugdeck/src/components/tugways/use-text-input-responder.tsx`:
  - Import `findWordBoundaries` (already used by the existing right-click adapter) and `matchEditingKeybinding` from `text-editing-keybindings.ts`.
  - Add four new action handlers: `handleDeleteToLineStart`, `handleDeleteWordBackward`, `handleMoveWordForward`, `handleMoveWordBackward`. Each:
    - Reads `inputRef.current` and short-circuits on `disabled` or null element (defence-in-depth, matching existing handlers).
    - Computes the target offset(s) using the existing `findWordBoundaries` for word actions and a small `findLineStart(value, caret)` helper for line-start (handles `<input>` — always 0 — and `<textarea>` — index after last `\n`).
    - For deletes: calls `el.setSelectionRange(targetStart, targetEnd)` then `document.execCommand("delete")`. Returns no continuation (the dispatch is keyboard-only; no menu-blink delay applies to keystroke deletes).
    - For motions: reads `event.shiftKey` (passed in via the `ActionEvent`'s native event reference, or via a narrow `value` payload — see Implementation note below). On shift, computes the anchor (prior `selectionStart` if moving forward from a forward selection, etc.) and calls `setSelectionRange(anchor, newOffset)`. On no shift, calls `setSelectionRange(newOffset, newOffset)`.
  - Register the four new actions alongside the existing four in the `actions` map passed to `useOptionalResponder`. Order them under a `// ---- Editing motion / deletion ----` comment to match the new vocabulary section.
  - Add a `useLayoutEffect` that installs a `keydown` listener on `inputRef.current`. The listener:
    - Calls `matchEditingKeybinding(event)`. On null match, returns immediately (no `preventDefault` — preserves AppKit fall-through for Ctrl-A/E/F/B/etc.).
    - On match, calls `event.preventDefault()`, then dispatches the action. Implementation note: the simplest path is to invoke the matching handler directly (the hook already has the closures); a chain `manager.sendToTarget(responderId, ...)` dispatch would also work but adds round-trip cost for an event the hook already owns. Direct invocation is the recommended path; the chain handlers stay registered so a settings/menu dispatch from elsewhere lands the same code.
    - For `MOVE_WORD_FORWARD` / `MOVE_WORD_BACKWARD`, passes `event.shiftKey` into the handler (via a small per-handler signature extension, or via a one-shot ref the handler reads — pick the simpler form during implementation).
  - The keydown listener is gated on `disabled` (mirrors the chain handler defence-in-depth) and is uninstalled in the effect's cleanup, like the existing pointerdown listener for right-click capture.

**Implementation note — passing `shiftKey` to motion handlers:** Two paths.

Option (a): give `handleMoveWordForward` / `handleMoveWordBackward` a parameter `(shift: boolean)` and have the keydown listener call them directly with `event.shiftKey`. Chain dispatch (which has no native event) calls them with `false` — settings-driven dispatch never extends selection.

Option (b): stash `event.shiftKey` on a `lastModifiersRef` immediately before invoking the handler, and have the handler read the ref. Equivalent in effect; uglier.

Recommend Option (a). Document the chain-dispatch defaulting to `shift=false` in the handler comment.

- `tugdeck/src/components/tugways/__tests__/tug-input.test.tsx` and/or `tug-textarea.test.tsx`:
  - happy-dom is **not** suitable here per the project rule (focus + event ordering across React renders). The keydown semantics belong in `app-test`. happy-dom tests stay limited to checking that the new action handlers are wired (registry membership), not the event flow.
  - app-test additions: see [Step 4](#step-4).

**Tasks:**

- [ ] Add `findLineStart(value: string, caret: number): number` helper (3 lines).
- [ ] Author the four new action handlers.
- [ ] Author the keydown listener and install/cleanup it via `useLayoutEffect`.
- [ ] Wire the four actions into the `actions` map for `useOptionalResponder`.
- [ ] Update the hook's module docstring with a short paragraph on the new bindings (mirroring the existing "## Action handlers" section).

**Tests:**

- [ ] happy-dom: handlers present in the actions map (membership only).
- [ ] app-test smoke: see [Step 4](#step-4).

**Tuglaws cross-check:**

- **[L03]** the keydown registration uses `useLayoutEffect`, so the listener is in place before any user keystroke can reach the element after mount. Matches the existing pointerdown registration.
- **[L07]** the handlers read `inputRef.current`'s selection state at call time, never a captured-at-mount snapshot.
- **[L11]** the keystroke turns into a `TUG_ACTIONS.*` dispatch; the same actions are reachable from a future menu / settings dispatch via the responder registration.
- **[L19]** component-authoring guide — the hook gains a new responsibility (keydown handling) but stays a single source of truth for native-text-input chain participation; consumer components are not edited.
- **[L23]** the WKWebView's NSUndoManager state is user data; routing deletions through `execCommand("delete")` per [DM03] keeps Cmd-Z working across the new bindings.
- **[L24]** operations stay in the data zone (selection range writes, value mutations via the native editing pipeline) and structure zone (the keydown listener registration); no appearance-zone state introduced.

**Open questions / decisions:**

- *Should `tug-value-input`'s editing mode also pick up the new bindings?* `tug-value-input` consumes `useTextInputResponder` for clipboard semantics today; the new keydown listener is installed by the same hook, so the answer is "yes, automatically." Worth a manual verification pass.
- *Should we also short-circuit the keydown listener when the input is read-only?* The native field editor already refuses edits on read-only `<input>`; `execCommand("delete")` is a no-op. Skip the extra guard unless it surfaces in testing.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — green.
- [ ] `bun run audit:tokens lint` — zero violations.
- [ ] `cargo nextest run` — green.

---

#### Step 3: CM6 substrate wiring (`tug-text-editor`) {#step-3}

**Depends on:** #step-1

**Commit:** `tug-text-editor: bind Ctrl-U/W and Alt-F/B via @codemirror/commands`

**References:** [DM01] substrate-local wiring, [DM04] CM6 motions/deletions reuse `@codemirror/commands` directly, [DM05] shift-extends at substrate, (#strategy)

Does not depend on Step 2 — the two substrates are independent.

**Background:** `tug-text-editor` carries a `Prec.high` keymap in `tug-text-editor/keymap.ts` for Enter / numpad-Enter / Cmd-Enter / Cmd-Up / Cmd-Down. This step layers the four gap bindings onto the same surface, plus their Shift-extension variants, using existing `@codemirror/commands` commands per [DM04] / [DM05]. The editor's responder gains four new action handlers so a chain dispatch (settings UI, future menu) invokes the same commands programmatically.

**Artifacts:**

- `tugdeck/src/components/tugways/tug-text-editor.tsx`:
  - Extend the `@codemirror/commands` import line with `cursorGroupBackward`, `cursorGroupForward`, `deleteGroupBackward`, `deleteLineBoundaryBackward`, `selectGroupBackward`, `selectGroupForward`.
  - In the responder `actions` map (around line 1427 today), register handlers for the four new actions. Each is a one-liner that invokes the corresponding command on `viewRef.current` (e.g., `[TUG_ACTIONS.DELETE_TO_LINE_START]: () => { const v = viewRef.current; if (v) deleteLineBoundaryBackward(v); }`). Match the existing handler shape and the disabled-guard pattern.
- `tugdeck/src/components/tugways/tug-text-editor/keymap.ts`:
  - Extend the existing `Prec.high` keymap entry. Today the file builds an extension via `EditorView.domEventHandlers({ keydown(...) })`. The cleanest extension shape for the new bindings is a separate `keymap.of([...])` block layered alongside the existing `domEventHandlers`, both wrapped in `Prec.high`. Layout:

    ```ts
    Prec.high([
      EditorView.domEventHandlers({ keydown: ... }),  // existing — Enter family
      keymap.of([
        { key: "Ctrl-u", run: deleteLineBoundaryBackward },
        { key: "Ctrl-w", run: deleteGroupBackward },
        { key: "Alt-f", run: cursorGroupForward, shift: selectGroupForward },
        { key: "Alt-b", run: cursorGroupBackward, shift: selectGroupBackward },
      ]),
    ]);
    ```

    `keymap`'s entry shape supports a `shift:` slot for the extension command per CM6 idiom; this is exactly the [DM05] pattern.
  - Update the file's module docstring with a short paragraph noting the four new bindings and pointing at `@codemirror/commands` as the source of the implementations.
- (No new test file; tests land via app-test in Step 4.)

**Tasks:**

- [ ] Extend the `@codemirror/commands` import and the responder `actions` map.
- [ ] Refactor `tugTextEditorKeymap`'s return value to layer the new `keymap.of([...])` alongside the existing `domEventHandlers`, both inside one `Prec.high`.
- [ ] Update the keymap module docstring.

**Tests:**

- [ ] `bun x tsc --noEmit` confirms the new imports resolve and the responder action map type-checks.
- [ ] app-test smoke: see [Step 4](#step-4).

**Tuglaws cross-check:**

- **[L11]** the editor's responder registers handlers for the four new actions; chain dispatch routes through the same commands as keyboard dispatch.
- **[L19]** the substrate keeps its existing single-keymap-file structure; the file grows but its responsibilities don't fragment.
- **[L07]** the keymap reads `viewRef.current` at command-time via the `view` argument CM6 passes to the command runners; no captured-at-mount snapshot.

**Open questions / decisions:**

- *Does `Prec.high` interact correctly with the typeahead extension's `Prec.highest`?* The existing `tugCompletionExt(getCompletionProviders)` is `Prec.highest`, which already intercepts Enter / Tab / Arrows / Escape during an active session. The new bindings (Ctrl-U/W, Alt-F/B) are not in typeahead's intercept set, so they fall through to `Prec.high` cleanly. Verified by reading the completion extension's keymap during plan authoring; confirm in dev server.
- *Do the Shift variants need to set `preventDefault: true` in the keymap entry?* CM6's `keymap.of` already prevents the default for matched bindings; no extra wiring needed. Spot-check during step verification.

**Checkpoint:**

- [ ] `bun x tsc --noEmit` — exit 0.
- [ ] `bun test` — green.
- [ ] `bun run audit:tokens lint` — zero violations.
- [ ] `cargo nextest run` — green.

---

#### Phase C — Verification + close-out {#phase-c}

#### Step 4: app-test smokes + tuglaws walkthrough + plan close-out {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugways(text-editing): app-test smokes; tuglaws walkthrough; close out plan`

**References:** [DM01] substrate-local wiring, [DM02] only gap actions, [DM03] execCommand for native undo, [DM04] CM6 commands directly, [DM05] shift-extends at substrate, [DM06] data layer for future settings UI, (#success-criteria, #exit-criteria)

**Background:** The final pass: pin the new bindings with one `app-test` per substrate, walk the tuglaws against the diff, flip the plan status. app-test is the right test layer here per the project rule "use `just app-test` for app-test tests"; happy-dom is excluded for focus/selection/event-ordering work.

**Artifacts:**

- `tugapp-test/<file>.test.ts` (path per the existing app-test convention — verify the directory layout in the repo before authoring):
  - One smoke per substrate. Each smoke:
    - Mounts a small fixture containing the substrate (e.g., a `tug-input` with a known value, a `tug-textarea` with two lines of text, a `tug-text-editor` with one line plus an atom).
    - Sets the caret to a known offset.
    - Dispatches Ctrl-U; asserts the value/doc text now starts at the post-deletion shape.
    - Dispatches Ctrl-W from a fresh known state; asserts the prior word vanished.
    - Dispatches Ctrl-A as the platform-handled canary; asserts selection or motion happened (for `tug-input` / `tug-textarea`, value-mode caret moves to start; for `tug-text-editor`, `defaultKeymap`'s `selectAll` selects the doc — pick the assertion that matches each substrate's actual behavior).
    - Dispatches Cmd-Z; asserts the deletion is reverted (Ctrl-U / Ctrl-W cases). For `tug-input` / `tug-textarea`, this is the WKWebView native undo stack; for `tug-text-editor`, CM6's `history()`.
  - Each test ends with the standard `VERDICT: PASS|FAIL` line per the `just app-test` recipe convention.
- `tuglaws/` walkthrough: per-step compliance review against [tuglaws.md](../tuglaws/tuglaws.md), [action-naming.md](../tuglaws/action-naming.md), [component-authoring.md](../tuglaws/component-authoring.md), [responder-chain.md](../tuglaws/responder-chain.md). Findings either land as small fixes in this commit or are explicitly logged.
- `dash/tugplan-text-editing-keybindings.md` (this plan): Plan Metadata `Status` flips to `shipped` with the date; Phase Exit Criteria checkboxes filled.

**Tasks:**

- [ ] Author the three app-test smokes.
- [ ] Walk each tuglaws document against the Step 1–3 diff.
- [ ] Flip plan status.

**Tests:**

- [ ] `just app-test <each smoke>` — `VERDICT: PASS` line for each.
- [ ] `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` — all green.

**Tuglaws cross-check (final walkthrough):**

- **[L03]** — keydown listeners for native inputs install via `useLayoutEffect`; CM6's keymap is in place at `EditorView` construction.
- **[L06]** — not invoked. The plan operates in the data zone (selection ranges, document text); no appearance-zone state introduced or moved.
- **[L07]** — every handler reads its substrate's live state at dispatch time.
- **[L11]** — four new actions, all kebab-cased, all referenced via `TUG_ACTIONS.*` constants at every call site (matcher, keydown listener, registry, action map).
- **[L19]** — the new module + the hook + the keymap update each follow the file-structure conventions of their neighbors.
- **[L23]** — Cmd-Z continues to revert deletions in all three substrates: native inputs route through `execCommand("delete")` (NSUndoManager-integrated per [DM03]); CM6 commands push onto the editor's `history()` stack natively per [DM04]. User-visible undo state is preserved across the new bindings.
- **[L24]** — operations stay in the data zone (selection / value / document mutations) and structure zone (event registration). The plan never crosses into the appearance zone.
- **[action-naming.md]** — `<verb>-<object>[-<modifier>]` shape held; no synonyms with existing actions; `SCREAMING_SNAKE_CASE` keys derived mechanically.

**Checkpoint:**

- [ ] All check commands above exit clean.
- [ ] Phase Exit Criteria boxes ticked.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Ctrl-U, Ctrl-W, Option-F, and Option-B work uniformly across `tug-input`, `tug-textarea`, and `tug-text-editor`. The four bindings dispatch through new `TUG_ACTIONS` constants with substrate-local handlers; native deletions integrate with the WKWebView undo stack; CM6 motions reuse `@codemirror/commands` directly. The platform-handled bindings (Ctrl-A/E/F/B/P/N/D/H/K/T, Option-Delete) continue to fire via AppKit / `defaultKeymap`. The new `text-editing-keybindings.ts` module is laid out as the data layer a future settings UI will read.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Ctrl-U erases backwards to the start of the current line in all three substrates; Cmd-Z reverts.
- [ ] Ctrl-W erases the previous word in all three substrates; Cmd-Z reverts.
- [ ] Option-F / Option-B move the caret one word forward / backward in all three substrates; Shift extends the selection.
- [ ] The platform-handled bindings (Ctrl-A/E/F/B/P/N/D/H/K/T, Option-Delete) continue to fire after the wirings land. Verified manually + by app-test canaries.
- [ ] Tuglaws cross-check passes per-step.
- [ ] `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`, `just app-test` — all green at every commit.

**Acceptance tests:**

- [ ] `matchEditingKeybinding` unit tests (Step 1).
- [ ] One app-test per substrate exercising Ctrl-U + Ctrl-W + a platform-handled canary + Cmd-Z (Step 4).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Settings UI for keybinding remap.** The new `text-editing-keybindings.ts` module is the data layer; a future plan ships the dialog. That plan also decides whether the registry needs to become observable (subscribe-able store) or stays a simple mutable export.
- [ ] **Promote platform-handled bindings into `TUG_ACTIONS` for a uniform vocabulary.** Add `MOVE_LINE_START`, `MOVE_LINE_END`, `MOVE_CHAR_FORWARD`, etc., and substrate handlers that use them. Worth doing when (a) the settings UI ships and wants the full vocabulary, or (b) browser-vs-WKWebView behavior divergence becomes a problem worth taking ownership of.
- [ ] **Word-boundary tuning.** `findWordBoundaries` defines word boundaries one way; CM6's `cursorGroupForward` defines them another. Consistency between native and editor word motion may want a shared definition. Tabled until a divergence shows up in dogfooding.

| Checkpoint | Verification |
|-|-|
| Tokens lint clean | `bun run audit:tokens lint` |
| Matcher unit test | `bun test src/components/tugways/__tests__/text-editing-keybindings.test.ts` |
| Native input app-test | `just app-test <tug-input keybinding smoke>` |
| Native textarea app-test | `just app-test <tug-textarea keybinding smoke>` |
| Editor app-test | `just app-test <tug-text-editor keybinding smoke>` |
| TS clean | `bun x tsc --noEmit` |
| Rust clean | `cargo nextest run` |
