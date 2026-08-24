# Keyboard Focus Mode (KBF) — design brief

*Status: brief for discussion, not yet a plan. Grounds in [tuglaws/focus-language.md](../tuglaws/focus-language.md), and revisits the decisions landed by `53233fdc6` (universal arrow traversal) and archived at [dash/archive/arrow-traversal.md](archive/arrow-traversal.md). Four questions in this brief were DECIDED by the owner at authoring; the seven at the end were resolved 2026-08-10 and are recorded with their groundings. Every question in this brief is now decided.*

---

## The problem

The arrow-traversal work made arrows move keyboard focus everywhere in the app. What it did **not** do is give the app a mode. Whether an arrow moves a caret or moves a ring is recomputed on every keydown from ambient DOM state, and the most load-bearing input to that computation is *whether the focused text field happens to be empty*. That is a modal behavior encoded as a content predicate. It cannot be learned, it changes under the user's hands mid-typing, and it has made at least one surface — Open Quickly — worse than it was before the feature existed.

This brief proposes replacing the ambient computation with an explicit, named, user-controlled mode: **keyboard-focus mode**, *KBF mode*.

---

## Diagnosis

### There is no mode — there are three ambient mechanisms

All three live in the document-capture keyboard ladder in `responder-chain-provider.tsx`:

1. **The release policy** (`arrow-release.ts`). A DOM-focused text surface gives an arrow back to the spatial plane either explicitly, via `data-tug-arrow-release`, or **automatically when it is an empty single-line input inside the key view** (`resolveArrowRelease`, the `subject.value !== ""` gate).
2. **The boundary latch** (`tug-text-editor/keymap.ts`). A non-empty editor releases a vertical arrow on the *second discrete press* at the document edge, with no visual affordance by design.
3. **The liveliness net** (`arrowFallbackListener`). Any arrow that survives every earlier stage unclaimed walks the current mode's linear order, wrapping.

Each is defensible on its own. Together they mean the app has a navigation mode whose engagement condition is "the field you are in is empty, or you pressed the arrow twice, or nothing else wanted the key." No user can form a model of that, and no author can predict which of the three will catch a given press.

### Open Quickly, traced

This is the sharpest instance and it is not a matter of taste — the mechanism is exact.

`TugCompletionPopup` handles ↑/↓ in a React `onKeyDown` on its `TugInput` (`tug-completion-popup.tsx:270`), moving the highlighted row. But the document-capture pipeline runs first. On open the query is `""`, the field is the seeded key view (`useSeedKeyView`, `tug-completion-popup.tsx:249`), and its type is `text` — so `resolveArrowRelease` returns `"released"`. The popup declares no spatial order and the field carries no cursor handle, so `moveKeyViewSpatial` declines in *every* case (`focus-manager.ts:1766`) and the press falls to the net, `arrowFallbackListener`, which walks the trapped mode's linear order, consumes the key, and fires `stopImmediatePropagation()`. The popup's own handler never runs.

Two outcomes, both wrong:

- With a directory switcher present (≥2 root candidates, `open-quickly-overlay.tsx:417`), the mode holds two stops, so **↓ moves the ring onto the switcher button** instead of selecting the first file.
- With one candidate there is a single stop, the net's `moveKeyViewLinear` wraps the mode onto itself, the key is consumed, and **↓ does nothing at all**.

Type one character and it starts working. Delete back to empty and it breaks again. The state where the machinery steals the arrows — freshly opened, empty query, full result list — is the *only* state a fast open-quickly gesture ever passes through.

### The axiom that caused the rest

`focus-language.md:103` — *"A text editor never wears a focus ring, in any state. The blinking caret is a full carrier of keyboard focus... A ring beside a live caret is an illegal state, not a redundancy."*

Follow the consequences:

- If an editor cannot wear a ring, then landing the key view on an editor stop must **grant the caret** — hence `dom-granted` text stops and the explicit claim at `focus-language.md:101` that *"there is no parked state."*
- If arrows can land the key view *in* an editor, they must be able to get back *out* — hence the boundary latch, the empty-input release, `data-tug-arrow-release`, and the `onArrowExit` / `onTabWhenEmpty` host handoffs.
- If the exit is a handoff rather than a walk, the host needs doors to receive it — hence `enterAt` and `enterToward` in `use-cycle-mode.tsx`.

Every one of those mechanisms is compensation purchased to cover a missing state. Restoring the parked ring gives most of them no subject at all. This is why the first of the owner's directives is not a cosmetic reversal: it is a large net **deletion**.

---

## The design

### D1 — The mode bit is derived, not raw

```
kbfEngaged = manuallyEngaged || anyAutoEngagingSurfaceIsActive
```

`manuallyEngaged` is a single engine-owned boolean. Auto-engagement is *implied by surface presence*, never latched. A sheet closing therefore can never strand the app in a mode the user did not ask for, and there is no second source of truth to desync ([L02] read through `useSyncExternalStore`, [L22] the mode is engine structure and is never mirrored in React state).

**Scope: deck-global.** The *position* of the keyboard stays per-card — the key-window model in `focus-language.md` ("Per-card key-window model") is correct and untouched. What is global is *how a keystroke is interpreted*, because the user is in one mode at a time regardless of which card is front.

**Projection: one attribute.** `data-kbf` on the deck root, written by the same projection pass that writes every other focus mark ([L06]). Every ring rule in `focus-ring.css` gains that attribute as a gate. No component reads the mode in React.

### D2 — Mode OFF: the keyboard belongs to a text surface, or to no one

- **No focus ring is painted anywhere.** DECIDED. The caret and the entry wash are the only focus marks in the app.
- Text surfaces own **all four arrows** unconditionally. No emptiness predicate, no boundary latch, no release attribute, no repeat gating.
- Arrows never move focus. There is nothing to move — no ring is on screen.
- `Tab` means what the focused surface says it means (indent, completion).
- Accelerators, chords, menus, and the responder chain are **completely unaffected**. ⌘F, ⌘S, Escape-to-dismiss, ⌘. — all identical in both modes. KBF governs *movement*, not *commands*.

### D3 — Mode ON: the keyboard belongs to the engine

- Rings paint. The ring **is** the keyboard's position.
- `Tab`/`⇧Tab` walk the linear order; arrows walk the spatial plane with the liveliness net beneath it. Both mechanisms survive intact — they were never the problem.
- `Space` commits the ringed member; `Return` fires the scope's default.
- Lists rove their cursor, descends work, seams resolve — all unchanged from today.
- A text stop is **parked** (D4): ringed, blurred, no caret.

The clean statement of the division, and the invariant worth pinning:

> **Every engine-routed stop is reachable only in KBF mode. In mode OFF the keyboard is either in a text surface or nowhere.**

This is what makes auto-engagement derivable rather than arbitrary: a surface auto-engages exactly when it has no text surface for the keyboard to rest in, or when its content is navigable furniture rather than a document.

### D4 — The parked text stop: the ring returns

A text stop whose editor is not being typed into wears a **ring on its input area, with no caret and no DOM grant**. This state existed before `53233fdc6` and was deleted (`focus-language.md:123` records it: *"used to park the keyboard on the input-area wrapper with the editor blurred"*). It comes back.

Ring and caret are no longer mutually exclusive: while KBF is engaged and the caret is live in a stop, the stop wears **both** — the ring says *this is where the keyboard's position is*, the caret says *and you are typing in it*. Rings exist if and only if KBF is engaged, which keeps the rule to one sentence.

This repeals two paragraphs of `focus-language.md` outright (the "never wears a focus ring" rule and the "three carriers" framing) and inverts a falsification-checked app-test (at0345).

### D5 — Entering and exiting

| Gesture | Effect |
|---|---|
| `⌥⇥` | Toggle `manuallyEngaged`. On entry, seed the ring on the card's commit-home ([P10] semantics, the existing `useCycleMode.toggle`). |
| `⌥⇥` again | Clear `manuallyEngaged`; the caret returns to the card's resting destination. |
| `Escape` | Clears `manuallyEngaged` — **but only as a rung on the existing Escape ladder**, below every dismissable surface. Inside a sheet, Escape closes the sheet. |
| Printable character on a parked text stop | Clears `manuallyEngaged`, grants the caret, and **types the character**. DECIDED — this is the ergonomic path that keeps "arrow to the field, then type" from costing a deliberate Escape. |
| `Return` on a parked text stop | Grants the caret without typing anything (the existing Return-descend). |
| Pointerdown anywhere | Clears `manuallyEngaged` — the existing "using the mouse exits cycling" rule in `use-cycle-mode.tsx:326`, generalized. |

**The mode cue is the rings themselves.** DECIDED — no deck-edge tint, no status glyph. Rings appearing and disappearing *is* the signal.

### D6 — The typing descend

Typing on a parked stop clears `manuallyEngaged`, but the derived bit may still be ON because an auto-engaging surface is up. Those two cases behave identically at the keyboard — the caret owns the arrows either way — and differ only in what `Escape` does:

- **Manual KBF, no surface**: Escape's KBF rung is gone (manual is already cleared); Escape falls through to whatever the ladder holds next.
- **Auto-engaged surface**: Escape dismisses the surface, in one press. A rename sheet still closes with a single Escape while its field holds the caret, which is the behavior we have today and must not regress.

`⌥⇥` from a typing descend re-engages manually and returns the keyboard to the ring.

### D7 — List-attached fields: the exemption mechanism

One new declared contract replaces three ad-hoc ones. A text field may declare an **attached list**; while the caret is in that field, `↑`/`↓` drive the attached list's cursor and never leave the field, in **both** modes, regardless of whether the field is empty.

This single rule:

- fixes Open Quickly (↓ selects the next result, always, from the first keystroke to the last);
- covers every `TugFilterField` in the Lens and the session picker (↓ from the filter reaches the rows, which is what the empty-release was buying);
- retires `filterFieldDidRequestAdvance` and the automatic empty-input release in `arrow-release.ts`. (The question dialog's bespoke `arrowRelease` prop is already gone — `session-question-dialog.tsx:1048` records its removal — so there is nothing left to delete there.)

It is also the reason Open Quickly needs no special-casing beyond *not* being an auto-engaging surface: it opens in mode OFF with the caret in the field, and its arrows work because the field is list-attached. `⌥⇥` still reaches its directory switcher for the rare case that wants it.

---

## Auto-engagement inventory

Verified by sweep of `tugdeck/src` on 2026-08-10. Every surface below is a place where KBF is ON without the user asking for it.

### Class A — surfaces that push a focus trap (engaged while up)

Auto-engagement here is *derived from the trap*, not a per-surface list to maintain: any `useFocusTrap` push is the auto-engager (`trapped` defaults to `true` in the hook — no call site passes it explicitly). The enumeration below is what that resolves to today.

| Surface | Site |
|---|---|
| `TugSheet` (all sheets) | `tug-sheet.tsx:900` — passive shade excluded (`shadePassive`), correctly: the commit route keeps the caret in the message editor below the shade |
| `TugAlert` | `tug-alert.tsx:379` |
| `TugPopover` / `TugConfirmPopover` | `tug-popover.tsx:745` |
| `TugContextMenu` | `tug-context-menu.tsx:211` |
| `TugEditorContextMenu` | `tug-editor-context-menu.tsx:275` |
| `TugPopupMenu` (internal, backs `TugPopupButton`) | `internal/tug-popup-menu.tsx:300` |
| Session **question** dialog | `chrome/session-question-dialog.tsx:1587` |
| Session **permission** dialog | `chrome/session-permission-dialog.tsx:903` |
| App-test **ask** dialog | `chrome/session-app-test-ask-dialog.tsx:227` |
| Settings ▸ Keyboard **chord capture** | `cards/settings-keymap-body.tsx:284` — the sanctioned trap; owns every chord while armed, so KBF's own `⌥⇥` must be capturable there too |
| `TugCompletionPopup` | `tug-completion-popup.tsx:224` — **EXEMPT**, see below |

Sheets reached through `TugSheet` (each seeds a key view, so each is a live KBF surface today): help, skills, agents, hooks, memory, usage, resume, rewind, ai-config, rename-session, compaction-progress, permission-rules-editor, text-card save sheets, the Choose Session picker, the attachment preview, `TugAlertSheet`, and the gallery sheets.

### Class B — cards whose content is navigable furniture (engaged while the card is the key card)

These need a per-card decision; the recommendation column is the proposal, not a finding.

| Card | `componentId` | Recommendation |
|---|---|---|
| Lens | `LENS_CARD_ID` | **auto-engage** — sections, bands, filters, lists; no resting document |
| Jots | `JOTS_CARD_ID` | **auto-engage** at the list level; a jot opened for editing is a typing descend |
| Settings (+ general / keymap / session-card / text-card bodies) | `settings` | **auto-engage** |
| Keyboard | `keyboard` | **auto-engage** |
| About | `about` | **auto-engage** (or no stops at all) |
| Gazette | `GAZETTE_CARD_ID` | **auto-engage** |
| Pulse | *(via gallery/registration sweep)* | **auto-engage** |
| Devtools | `devtools` | **auto-engage** |
| Diff | `diff` | open — mostly a reading surface |
| Session | `session` | **OFF at rest** — the prompt entry is the resting destination; `⌥⇥` is how you leave it. This is exactly today's `useCycleMode` behavior, promoted to the general mechanism |
| Text | `text` | **OFF at rest** — a document |
| File view | `file-view` | **OFF at rest** — a document |
| Hello world | `hello` | n/a |
| Gallery cards | `gallery-*` | follow their subject; `gallery-cycle-demo` becomes a KBF demo |

### Class C — global

- **Accessibility keyboard-access mode.** When `keyboardAccessStore.getMode() === "accessibility"` ([P10], `focus-language.md` "Accessibility: focus-follows"), KBF is **permanently engaged**. A VoiceOver user must always have real focus on real widgets; a mode that hides rings and refuses engine navigation would break the assistive path entirely. This is non-negotiable and belongs in the derivation itself.

### Exempt — never auto-engage

- **Open Quickly / `TugCompletionPopup`** and any future list-attached-field HUD. It pushes a trap for its Escape ladder and its scoping, so the derivation cannot simply be "trap ⇒ engage" — the trap needs a flag (`kbf: false` or equivalent) for typing-first surfaces.
- **The session card at rest**, the text card, the file-view card — documents, whose resting destination is a caret.
- **The ⌘F find bar** — a text field with its own `Return`; seeded with the caret in mode OFF.

---

## What this deletes

- `arrow-release.ts`'s automatic empty-input rule, and very likely the module.
- The `data-tug-arrow-release` substrate channel and its one CM6 producer.
- The **boundary latch** in `tug-text-editor/keymap.ts` (arm/disarm state, repeat gating, edge predicates) — a mode key makes a two-press seam unnecessary.
- The "empty text field spends `Tab` on movement" rule and its `onTabWhenEmpty` handoff.
- `onArrowExit` and the host-handoff contract.
- `enterAt` / `enterToward` in `use-cycle-mode.tsx` — both exist only to receive handoffs from a text surface.
- The repeat-gating scattered across `arrowNavListener` and `arrowFallbackListener`.

`useCycleMode` itself is not deleted — it is **promoted**. Its trapped-mode push, commit disposition, resting-focus landing, and mouse-exit rule are the KBF mechanism; what changes is that it becomes engine-general and deck-global rather than a per-card opt-in with two consumers.

What survives untouched: the spatial plane, `rowGridOrder`, seams, the liveliness net, cursor handles, descended row scopes (`handleListKey`, at0277/at0282), the one-writer `place()` primitive, the gesture interpreter, the projection/watchdog/steal-ledger machinery, and the entire [D122] container/element split.

---

## Doctrine surgery

`tuglaws/focus-language.md` is the law and moves in the same phase. Sections affected:

- **"Motion: two planes, explicit commit"** — gains the mode division as its opening premise. The two planes become *what KBF mode does*, not what the app does ambiently.
- **"Arrow ownership"** — the boundary latch paragraph is deleted.
- **"In a text editor, plain arrows are caret keys and nothing else"** — survives, and gets *stronger*: in mode OFF it is unconditional. The Cmd-Up/Cmd-Down history rule is unaffected and stays.
- **"An empty text field spends `Tab` on movement"** and its arrow sibling — both deleted.
- **"An editor's stop carries the editor's focus contract, so landing on it grants the caret"** — deleted; replaced by the parked stop.
- **"A text editor never wears a focus ring, in any state"** and **"And 'the editor' here means the box, not the DOM node"** — deleted. The three-in-a-row failure history recorded there should be *kept* as a note explaining why the rule existed and why the mode makes it unnecessary, so nobody re-derives it.
- **"Three carriers, and the third is the wash"** — rewritten. The wash keeps its job (this composite control is the live one); the ring's absence in mode OFF is now the rule rather than an editor-specific exception.
- **"Crossing out of a text surface is always a discrete press"** — deleted with the latch.
- **The contract table** — gains `data-kbf` as the gate on every ring row.
- **"Authoring contract"** — gains the list-attached-field contract and the `kbf: false` trap flag.

A sweep of the other laws for statements this invalidates is part of the phase — `list-view-usage.md` was amended by `53233fdc6` and will need it again.

---

## Test impact

- **at0345** (no editor ever draws a ring) is falsification-checked and **inverts**: it becomes the assertion that a parked stop *does* ring and a mode-OFF editor does *not*.
- **at0341** (Lens cross-section arrows), **at0342** (picker arrow traversal), **at0343** (prompt arrow latch + history) all rewrite — at0343 keeps its Cmd-history half.
- **at0248 / at0277 / at0282** (list cursor keys, row accessories, row arrow/escape) should stay green with KBF force-engaged at test start; if they don't, the mode division has leaked into the descend machinery.
- **New:** a mode-division suite (OFF: arrows never move the ring, no rings paint, no ring in a text surface; ON: rings paint, arrows move them), an Open Quickly suite (↓ selects the first result on an empty query — the regression this whole brief starts from), a parked-stop suite (ring + no caret; printable character types and lands), and an Escape-ladder suite (one Escape closes a sheet from a caret inside it).
- Unit: `arrow-release.test.ts` and `keymap-editor-release.test.ts` are deleted with their subjects; the mode derivation gets its own.

---

## Risks

1. **The parked text stop is where the real implementation risk lives**, and it is why it was removed the first time. Parking is *less* dangerous than granting (no `.focus()` write, so no exposure to WebKit's blur-on-re-focus hazard, `focus-language.md` "Grants are idempotent"), but the transitions **into** typing — printable character, Return, click — are grants, and each must be idempotent and IME-safe.
2. **Escape ladder precedence** is the most likely source of a bad regression. Getting the rung order wrong makes Escape stop closing something, which users notice immediately. Wants explicit test coverage before it ships.
3. **Mode OFF hides every ring**, so any surface that today depends on a resting ring to explain itself will look wrong. The `persistentDefaultRing` treatment on a recommended-default button is the case to check: it is a *promise about Return*, not a focus mark, and it should almost certainly survive in mode OFF.
4. **Auto-engagement derived from the trap** means any future trap silently becomes a KBF surface. That is the intended behavior, but the `kbf: false` escape hatch must exist from day one or the next typing-first HUD reproduces the Open Quickly bug exactly.

---

## Open questions — all resolved 2026-08-10

1. **`Tab` in mode OFF.** DECIDED — **(a)**: with a live caret, `Tab` belongs to the text surface unconditionally (indent/completion — the empty-`Tab` handoff is deleted); in the *nowhere* state (an active card with no caret — a diff card, transcript prose after a stray click, a disabled entry), `Tab` engages KBF and takes one step. Symmetric with `⌥⇥`, and the most-tried key always produces a visible landing. Note the never-fall-through corollary: today's `focusWalkListener` yields to the native DOM tab walk when the engine walk is empty (`responder-chain-provider.tsx:424`); under D2 that fallback goes — a `Tab` the engine cannot spend is consumed, never handed to WebKit.
2. **Does `manuallyEngaged` persist across card activation?** DECIDED — **yes**. It is a deck-global bit and a pointerdown clears it anyway (D5), so the question only bites for keyboard-driven card switches (⌘L and friends), where persisting is the friendlier answer. (`CYCLE_FOCUS_MODE`'s `routing: "key-card"` survives — the toggle still needs the key card to seed the ring — but the bit it flips is the engine's, not the card's.)
3. **`persistentDefaultRing` in mode OFF** — DECIDED — **yes, it paints**: it is a promise about `Return`, not a focus position. The exposure is smaller than the brief feared: every current `persistentDefaultRing` site but two is a Class-A auto-engaging surface (sheets, alerts, dialogs), where rings paint anyway. The residual mode-OFF surfaces are the session card's entry (which already uses the shell's own hand-painted `data-tug-entry-default` promotion, not the engine ring) and the session-history view — a visual check on those two, not a design fork.
4. **Auto-engaged surfaces and `⌥⇥`.** DECIDED — inside a forced mode it **returns the keyboard from a typing descend to the ring** (the D6 re-engage gesture, made uniform). It never disengages a forced mode.
5. **The Jots card.** DECIDED — **auto-engage at the list level; an open jot is a typing descend.** Escape after typing ascends back to the ring on the jot's row — exactly today's behavior (the jot editor already lives in a non-trapped descend scope with blur-commit, `jots-card.tsx:457`).
6. **The diff card.** DECIDED — **OFF at rest.** The card registers no focus stops at all today (its one control is the header Refresh button) and has no keyboard handling of its own — there is no furniture to navigate, and auto-engaging a surface with nothing to ring violates the empty-group rule in `focus-language.md`. Revisit only if it grows hunk navigation.
7. **`⌥⇥` discoverability.** DECIDED — **menu item with a decorative chord.** A "Keyboard Focus" menu item fires the toggle, with ⌥⇥ shown as display-only text — *not* registered as an AppKit key equivalent, preserving the reason it was kept out of the menus (`command-registry.ts:1775`: a real key equivalent is scanned above every surface that wants a modified Tab, the Settings chord capture among them). Mechanically: `menuItemId` on the registry entry without `menuEligible` on the chord, plus Swift-side rendering of the shortcut glyph as title text.
