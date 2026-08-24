<!-- devise-skeleton v4 -->

> # ⚠ SUPERSEDED — kept for history
>
> This plan built the focus engine (steps 1–5: FocusManager, registry, authored Tab walk, scope stack, keybinding registry) and a **first, web-convention pass** at component keyboard support (steps 6–18), then the keyboard model was reconceived. The governing model now lives in **[`tugplan-keyboard-model.md`](../tugplan-keyboard-model.md)** (`[P15]` + the Keyboard Behavior Matrix + `[Q04]`, restated clean there). This document is retained as the **historical record** — how we reasoned to that model, and every superseded decision and why. **Do not execute from here.** The engine substrate it built is a dependency of the successor plan; the component-behavior steps (6, 13–18) are redone there.

## Keyboard Access, Focus, and the Key-View Engine {#keyboard-access}

**Purpose:** Replace the app's tangled mix of borrowed-Radix focus, suppressed browser focus, and ad-hoc first-responder conventions with one app-owned focus engine — a "key view" (the single keyboard target) marked by one focus ring on keyboard focus, an explicit app-authored Tab order with two modes (`standard` / `accessibility`), a single crisp focus-ring primitive, and a color contract where **accent (orange) = selection** and **action (blue) = focus**.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-02 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Focus, first-responder, and keyboard access in tugdeck are spread across three conflated axes that no part of the code names as distinct: the **responder chain's first responder** (action-routing target), **DOM focus** (`document.activeElement`, the keyboard target), and **visible focus indication** (a scatter of `:focus` / `:focus-visible` / `:focus-within` rules with no shared token). On top of that, ~14 components delegate focus management to Radix (`RovingFocus`, `FocusScope`, focus guards), while `data-tug-focus="refuse"` and `internal/safari-focus-shift.ts` patch around the parts of Radix we don't want. Inter-control Tab order is whatever the DOM emits — not under app control. The focus ring is rendered three different ways (indigo `accentCool`, the `link` color, the `accent` color) at three different widths/offsets. Selection currently wears the **action/blue** color (`--tug7-surface-selection-primary-normal-selected-rest`), so "selected" and "keyboard-target" are visually indistinguishable, and there is no coherent accessibility story.

This phase names the three axes, builds an app-owned **focus engine** (a "key view" with an explicit, mode-aware Tab walk integrated with the responder chain), establishes a single focus-ring primitive, and re-targets the color contract so **accent = selection** and **action = focus**. The default-button grep-and-poke stack is retired in favor of a chain-dispatched default action. Accessibility mode is built in-app now, with ARIA structured so a later OS/VoiceOver integration is additive rather than a rewrite.

#### Strategy {#strategy}

> **The governing keyboard model is [[P15]](#p15-keyboard-model) + the [Keyboard Behavior Matrix](#keyboard-matrix).** It was settled after steps 6–18 shipped and supersedes the piecemeal conception in the bullets below (one ring that *moves*, arrow-selects, etc.). Read [P15] first: **Tab** picks the component, **arrows** move a cursor within it, **Space** selects / **Enter** acts-or-descends / **Escape** ascends — over a stack of nested scopes. The bullets here remain accurate for the engine substrate (the FocusManager, the authored Tab walk, the scope stack); where they describe ring/selection *behavior*, [P15] governs.

- **Name the axes, then build the engine.** Introduce a `FocusManager` co-located with the responder chain that owns the **key view** (the single keyboard-target element) and an explicit focusable registry — *before* changing any Tab behavior, so the foundation lands without a visible regression.
- **Model floating-surface focus traps on CFRunLoop modes.** The FocusManager holds a **stack of focus modes (scopes)**; the Tab walk only services focusables registered in the currently-active mode. Opening a sheet/alert/popover/menu/completion pushes a trapped mode; dismissing pops it. This subsumes the old default-button LIFO scoping. See [CFRunLoop mode model](#cfrunloop-model).
- **App-owned Tab walk, not native tabindex.** Intercept Tab / Shift-Tab as `focus-next` / `focus-previous` chain actions and advance the key view via the registry, honoring authored **order/group** and per-component **policy** (`accept` / `skip`). Text editors declare a transient "I consume Tab now" state (open completion / typeahead) that takes precedence.
- **Tame Radix, don't replace it.** Disable Radix focus management per primitive and drive focus from the FocusManager; modal trapping becomes a FocusManager scope, so there is one trap implementation.
- **One focus ring.** A single `--tugx-focus-ring` token (action/blue, one width, one offset, `outline`-based) painting **one ring on the keyboard-active control** — shown on keyboard focus, never on a mouse click. It is the live **commit-key** affordance — the keyboard-active control it marks gets first claim on Return / Escape / ⌘. ([P12]); there is **no** separate always-on marker (`filled+action` carries the standing default-button identity). Delete every per-component ring rule.
- **Flip the color contract.** Re-point selection/selected/highlighted surfaces from blue to accent/orange across list rows, menus, popovers, and tab bars; reserve action/blue for focus. Validate with the token contrast audit.
- **Audit last.** Reclassify every first-responder / `refuse` site against the named axes once the engine exists, and finish with the accessibility-mode ARIA pass and the dual mode toggle (in-app setting + Swift host menu).

#### Success Criteria (Measurable) {#success-criteria}

- Pressing Tab / Shift-Tab moves the key view through an **app-authored order** (not DOM order); reordering a group in the focusable registry changes Tab order with no DOM move. (app-test: `just app-test` focus-walk scenario asserts visit order)
- The keyboard-active control shows **one blue focus ring** on keyboard focus and **no ring on a mouse click**; the ring is the live Return target. (app-test asserts no ring after a click, a ring after a Tab)
- Opening a floating surface **traps** Tab within it; Tab from the last focusable cycles to the first; dismissing restores the prior key view. (app-test: open menu, Tab past end, assert wrap; close, assert key-view restored)
- A selected-and-focused list row renders **orange fill + blue ring** simultaneously and distinguishably. (app-test/visual: assert both tokens resolve on the row)
- `bun run audit:tokens pairings` passes after the selection→accent recolor with zero new contrast failures.
- No reference to `pushDefaultButton` / `peekDefaultButton` / `peekDefaultButtonInScope` / a `defaultButton` prop remains; Enter-outside-text still presses the active scope's default. (grep returns nothing; app-test dialog Enter still confirms)
- `data-keyboard-access` toggles `standard` ↔ `accessibility`; in `accessibility` mode every interactive affordance marked `skip` becomes Tab-reachable. (app-test asserts a `skip` control is unreachable in standard, reachable in accessibility)
- A component-registered keybinding fires only while that component is in context and is gone after it unmounts; an in-context binding overrides a global one; the static global shortcuts still fire. (app-test mounts/unmounts a component and asserts binding activation and precedence)
- From a focused list inside a sheet, Return fires the sheet's **default action** without moving focus to OK; Escape/⌘. fires cancel; a focused text editor still gets Return for submit/newline. (app-test asserts scope-routed commit keys with editor precedence intact)
- A primary CTA button stays blue (default-action affordance); UI selection is orange; text/character selection stays blue. (app-test/visual asserts the three roles resolve distinctly)
- `bunx tsc --noEmit` and `bun test` are clean; the workspace builds with `-D warnings`.

#### Scope {#scope}

1. A `FocusManager` (key view + focusable registry + focus-mode stack) co-located with the responder chain, plus a `useFocusable` hook.
2. A Tab / Shift-Tab pipeline stage dispatching `focus-next` / `focus-previous`, with editor Tab-consume precedence.
3. Floating-surface focus traps modeled on CFRunLoop modes.
4. Keyboard-access mode state (`standard` / `accessibility`), persisted via tugbank defaults, plus an in-app setting and a Swift host menu item.
5. A single `--tugx-focus-ring` focus-ring primitive — one ring on the keyboard-active control, shown on keyboard focus and never on a click; deletion of all per-component ring rules.
6. Color re-target: selection → accent/orange; focus → action/blue; rolled across list rows, menus, popovers, tab bars (option/radio already accent).
7. Radix focus-management taming across the focus-sensitive components.
8. Semantic commit keys (Return/Escape/⌘.) → scope `default-action` / `cancel-action`, independent of the key view; default-button stack retired.
9. First-responder / `refuse` audit and reclassification (split `refuse` into its two real meanings).
10. Accessibility-mode ARIA pass (interactive affordances only), AT-ready.
11. Dynamic, context-scoped keybinding registry: components attach/detach key→action bindings as they mount/unmount, resolved by responder/focus context.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Full screen-reader / VoiceOver / OS-accessibility-tree integration (foundation only; additive later phase).
- Making **non-interactive** content (transcript prose, static text blocks) keyboard-landable — accessibility mode covers interactive affordances only ([P09]).
- Changing the responder chain's action-dispatch semantics, action vocabulary, or `useResponder` registration model (the focus engine is a sibling, not a rewrite).
- New theme palettes or a re-derivation of the OKLCH color space; only the selection/focus token *assignments* change.
- Touch / pointer-gesture accessibility.

#### Dependencies / Prerequisites {#dependencies}

- Responder chain (`responder-chain.ts`, `responder-chain-provider.tsx`, `use-responder.tsx`) — the FocusManager rides the same provider and capture-phase listeners.
- tugbank DEFAULTS feed + `/api/defaults/<domain>/<key>` PUT (`src/settings-api.ts`) for mode persistence.
- Token audit tooling (`bun run audit:tokens pairings`) for the recolor.
- Theme CSS files `styles/themes/brio.css`, `styles/themes/harmony.css` (hand-authored; no generation script).
- Swift host (Tug.app) for the menu-item toggle (small additive change; one step).

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** across the Rust workspace; tugdeck must keep `bunx tsc --noEmit` clean.
- Engine is always WebKit (WKWebView host) — `outline` follows `border-radius`; no cross-engine focus shims needed, but WebKit contentEditable/focus quirks are real.
- Tuglaws: [L02] external state via `useSyncExternalStore`; [L06]/[L24] appearance via CSS/DOM; [L03] registrations events depend on use `useLayoutEffect`; [L11] controls emit actions, responders own state; [L20] token sovereignty.
- No `localStorage` / `sessionStorage` / IndexedDB — mode state goes through tugbank defaults.
- AskUserQuestion ≤4 options per question (if any settings UI surfaces choices).
- No plan numbers, bug-history, or enumerations in code/comments.

#### Assumptions {#assumptions}

- `standard` is the default mode; `accessibility` is opt-in and changes behavior comprehensively ([P08]).
- Tab order is **group-level authored** (named groups + ordinals), not merely per-component `skip` ([P02]).
- Floating surfaces (menus, completion, popovers, sheets, alerts) **trap** focus and exit only on dismiss ([P03]).
- There is one focus ring (1px, action/blue) on the keyboard-active control; no separate always-on marker — `filled+action` carries the default-button identity ([P05]).
- A `selected`/`focused` element legibly carries both colors at once; this is the motivating win of the split.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case. Plan-local decisions use `[P##]`; global decisions (if cited) use `[D##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Tier-1 key-view marker visual weight (SUPERSEDED) {#q01-tier1-weight}

**Question (historical):** What weight should the always-on key-view hairline carry across both themes?

**Superseded by the revised [P05].** The two-tier model — an always-on hairline plus a louder ring — was retired during [#step-9]. Working through the actual interaction model showed the always-on marker was answering a question nothing asks: a focus ring already persists on the focused control until focus moves, so "where am I at rest" is answered by the ring itself, and "what does Return do" is answered by `filled+action`. So there is **one ring**, on the keyboard-active control, and **no separate marker** — which dissolves this question entirely. Step 6 briefly shipped the hairline (then a 1px faint action-tint); the `--tugx-focus-ring-hairline-*` tokens and the `[data-key-view]` hairline rule were removed when the model collapsed to one ring. See revised [P05] and [P12].

#### [Q02] Editor Tab-consume handshake shape (OPEN) {#q02-editor-tab-handshake}

**Question:** How does a text editor tell the FocusManager "I'm consuming Tab right now" — a registry flag toggled on completion-open/close, or a per-dispatch veto where the editor's `focus-next` handler returns "handled" when a completion is open?

**Why it matters:** Determines whether the precedence lives in the FocusManager (flag) or in the editor's chain handler (veto). The veto keeps the editor self-contained and reuses the existing continuation/handled protocol; the flag centralizes precedence but adds editor→manager coupling.

**Options (if known):**
- Editor registers `consumesTab(): boolean` on its focusable record (flag).
- Editor handles `focus-next`/`focus-previous` as a chain action and returns handled when a completion/typeahead popup is open (veto), falling through otherwise.

**Plan to resolve:** Spike both against `tug-text-editor/completion-extension.ts` and `keymap.ts` in [#step-3]; prefer the veto if it cleanly replaces the `Prec.highest` Tab keymap ownership.

**Resolution:** OPEN → resolve in [#step-3].

#### [Q03] `accessibility` mode signal source (OPEN) {#q03-a11y-signal}

**Question:** Beyond the in-app setting and Swift menu item, should `accessibility` mode also auto-engage from an OS signal piped through the host (e.g., VoiceOver running)?

**Why it matters:** Auto-engage is a better default for real AT users, but there is no web media query for it and it requires a host→web channel. Guessing wrong adds a channel we don't use or omits one AT users expect.

**Options (if known):**
- In-app setting + Swift menu toggle only (this phase).
- Add a reserved host→web signal channel now, consume later.

**Plan to resolve:** Ship the explicit toggle in [#step-28]; reserve a channel name but defer auto-engage to the AT-integration follow-on.

**Resolution:** DEFERRED — explicit toggle this phase; OS auto-engage in the AT follow-on (see [#roadmap]).

---

#### [Q04] Text-editing key capture under [P15] (RESOLVED) {#q04-text-editing-capture}

**Question:** When the key view is a text-editing component (`TugInput`, the prompt editor, code / markdown editors), it wants nearly every key the [P15] model reserves — printables and **Space** type, **arrows** move the caret, **Enter** is newline-or-submit, **Tab** may indent or accept a completion. How do the model's keys (Tab/arrows/Space/Enter/Escape) and typing coexist, and how does the user always get *out*?

**Why it matters:** [P15] is clean for widgets but editors invert it — most "navigation" keys become "typing." Get the precedence wrong and either the user can't type (model eats the keys) or can't leave (editor eats Tab/Escape). This also drives the [P13] interplay (a pending inline dialog vs. the prompt still holding the caret).

**Resolution.** A text editor is a **`none`-container leaf** ([P15]) — you *focus* it, you never *descend* into it — that declares a **key-capture set** (the generalization of [Q02]'s `consumesTab` to the whole keyboard). While it is the key view, keys in the set are editing; every other key falls through to the [P15] engine as navigation. The set:

| Key | In the editor | Falls through to [P15]? |
|---|---|---|
| printables, **Space** | type the character (Space is *not* "select" here) | no — captured |
| ←→↑↓, Home/End, Opt/⌘+arrows | caret / word / line movement — **always caret, never escape-at-boundary** | no — captured |
| **Enter** | single-line = submit (the model's "act"); **multi-line = the same Enter-vs-Shift+Enter submit/newline preference prompt-entry uses, applied library-wide to every multi-line editor** | editor policy |
| **Tab / ⇧Tab** | — | **yes → leave to next/prev component**, *unless* a completion is open → Tab accepts it (transient capture) |
| **Escape** | — | **yes → ascend / blur**, *unless* a completion/typeahead is open → Escape closes that first; the *next* Escape ascends |

So **Tab and Escape stay reliable "get out" keys at rest**, borrowed only transiently by an open completion. The editor never becomes a descend target.

**[P13] coexistence split** — when an editor (the prompt) holds the caret while an inline dialog is the *logical* key view: typing + Space → the prompt; plain arrows → the prompt caret; **Enter → the dialog's default-action** (per [P13], the pending scope claims the commit keys, not a prompt submit); **Escape → cancel the dialog**; the dialog's **wizard accelerators (`1`–`9`, `←`/`→` Back/Next)** pick its options — *distinct keys*, so plain arrows stay caret. The dialog borrows only commit keys + accelerators; typing and the caret stay with the prompt.

**Folds into:** [P15] (text editors named as `none`-leaves with a key-capture set), [Q02] (`consumesTab` becomes one transient entry in that set), [#step-30] (the engine's per-component key-capture declaration), and the editor-touching steps. The multi-line Enter preference reuses the existing prompt-entry submit setting — no new per-editor knob.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Taming Radix breaks focus trapping / arrow nav in a primitive | high | med | Tame one component at a time behind app-test coverage; FocusManager supplies the trap | any primitive loses Escape/arrow/Tab behavior |
| App-owned Tab walk misses a native a11y semantic | med | med | Mirror native order semantics in the walk; accessibility-mode app-tests assert reachability | AT user reports an unreachable control |
| Selection→accent recolor fails contrast pairings | med | low | Run `audit:tokens pairings` in the recolor step; adjust tone/intensity, not the role | audit reports a new failure |
| Tab interception double-handles editor Tab (completion + walk) | med | med | Single precedence rule resolved in [Q02]; app-test both states | completion accept stops working |
| Mode state races boot (DEFAULTS feed arrives late) | low | med | Default `standard` until feed resolves; apply via `data-keyboard-access` on first paint like theme | flash of wrong mode |
| Dynamic keybinding shadows a global shortcut unexpectedly | med | low | Documented precedence (innermost-in-context → global); dev-warn on same-scope duplicate chords; registry queryable for conflict inspection | a known global stops firing in some context |
| Return ambiguous between editor submit and scope default-action | med | med | Text-context precedence: editor claims Return only when its key view owns it ([P12]/[Q02]); app-test both paths | editor submit or sheet default-action stops working |
| Selection recolor sweeps in text-selection or CTA blue | high | low | [P06]/Step 7 explicitly exclude `selection … plain` and keep `control-filled-action` CTA blue; app-test asserts text selection + CTA stay blue | text highlight or CTA turns orange |

**Risk R01: Radix taming regressions** {#r01-radix-taming}

- **Risk:** Disabling Radix focus management in a primitive removes a behavior (focus trap, roving arrows, Escape close) the FocusManager hasn't yet supplied.
- **Mitigation:** Per-component, behind app-test coverage; the FocusManager's mode scopes ([#cfrunloop-model]) provide trapping before Radix's is removed; arrows stay component-local.
- **Residual risk:** Subtle WebKit focus-restore timing in portaled surfaces may still need `safari-focus-shift`-style patches.
- **⚠ Watch — `data-key-view-kbd` ring flag vs. chain re-seed (latent since [#step-9]).** The focus ring on engine-driven keyboard focus rides `data-key-view-kbd`, which `FocusManager.setKeyView(id, keyboard=true)` stamps from the Tab walk. But `focusKeyView()` calls `el.focus()`, whose `focusin` runs the provider's promotion path → if the focused element is a responder, the chain re-seeds the key view via `setKeyView(id, /*keyboard*/false)`, **clearing `-kbd` and dropping the ring on landing.** It does **not** bite today because every engine-walked focusable so far carries `data-tug-focus="refuse"` (buttons, `TugCheckbox`, the toggles) and `refuse` makes `promoteOnFocusIn` bail before any re-seed. **The first time a *non-`refuse`* focusable that is also a responder is engine-walked** (a roving composite or a text editor, later steps), the ring can blink off — fix it then, against a real app-test: make the chain re-seed preserve the current keyboard modality when the key-view id is unchanged (or have `focusKeyView` suppress the loop). Do not fix speculatively; just don't rediscover it.

**Risk R02: Tab overload regressions** {#r02-tab-overload}

- **Risk:** Global Tab interception steals Tab from text-editing/completion.
- **Mitigation:** Editor consume-precedence ([Q02], the `data-tug-tab-consume` flag). `Shift+Tab` is pure `focus-previous`; permission-mode cycling does **not** ride Tab — it moved to `⇧⌘P` (see [P04]'s GUI deviation), so there is no Tab/cycle contention to reconcile.
- **Residual risk:** Future editor sub-modes must remember to declare Tab consumption.

---

### Design Decisions {#design-decisions}

#### [P01] One app-owned FocusManager, co-located with the responder chain (DECIDED) {#p01-focus-manager}

**Decision:** Introduce a `FocusManager` that owns the **key view** (single keyboard-target element id), an explicit **focusable registry**, and a **focus-mode stack**. It lives alongside `ResponderChainManager` and rides `ResponderChainProvider`'s existing document capture-phase listeners — not a parallel provider.

**Rationale:**
- The key view is conceptually a sibling of first responder; both are promoted off the same DOM-walk and capture-phase listeners already installed in `responder-chain-provider.tsx`.
- Reusing the provider avoids a second set of document listeners and ordering hazards with the chain's capture-phase pipeline.
- An app-owned walk is the only way to decouple Tab order from DOM order, switch order by mode without re-render, and fold editor Tab-consumption into one rule (per the chosen "app-intercepted focus walk").

**Implications:**
- New `useFocusable` hook (sibling to `useResponder`) registers via `useLayoutEffect` ([L03]) and writes `data-tug-focusable` + ordering metadata.
- The manager stamps `data-key-view` on exactly one element at a time (structure zone) as internal plumbing for the Tab walk and to seed focus; when it moves the key view by keyboard it adds `data-key-view-kbd`, which is the **sole** focus-ring trigger ([P05] revised in [#step-10]). The browser's own `:focus-visible` outline is suppressed, because WebKit grants `:focus-visible` to native controls even on a mouse click (it would ring a clicked control) and withholds it from a programmatic `.focus()`.

#### [P02] Tab order is group-level authored, not DOM-derived (DECIDED) {#p02-authored-order}

**Decision:** Standard-mode Tab order is determined by **named focus groups + ordinals** declared at registration, not by DOM position or native `tabindex`.

**Rationale:**
- The requirement is explicit app control of order; DOM order couples order to layout.
- Group-level authoring ("prompt → toolbar → transcript") matches how the app reasons about regions and survives layout changes.

**Implications:**
- `useFocusable({ group, order, policy })`; the walk sorts by (group order, item order) within the active focus mode.
- Composite widgets (list, radio, option, tab bar) register as a **single** focus stop; arrows move within via component-local roving.

#### [P03] Floating-surface focus traps modeled on CFRunLoop modes (DECIDED) {#p03-cfrunloop-traps}

**Decision:** The FocusManager holds a **stack of focus modes (scopes)**. The Tab walk services only focusables registered in the **currently-active mode**. Opening a floating surface pushes a trapped mode; dismissing pops it.

**Rationale:**
- Mirrors CFRunLoop: a run loop runs in exactly one mode; only sources registered for that mode are serviced; modes nest as a stack. (<https://developer.apple.com/documentation/corefoundation/cfrunloop?language=objc>)
- Gives trapping, nesting, and "default action belongs to the active scope" for free — and subsumes the old default-button LIFO `peekDefaultButtonInScope` scoping.

**Implications:**
- `pushFocusMode(scopeId, { trapped })` / `popFocusMode(scopeId)` via `useLayoutEffect` on surface open/close.
- `default-action` ([P07]) resolves against the active mode, replacing pane-scoped default-button peeking.

#### [P04] App-intercepted Tab via `focus-next` / `focus-previous` chain actions (DECIDED) {#p04-tab-actions}

**Decision:** Tab / Shift-Tab are intercepted in the keyboard pipeline and dispatched as `focus-next` / `focus-previous`. The walk starts at the key view; a text editor advertising a Tab-consuming sub-state handles them first ([Q02]).

**Rationale:**
- Single code path for inter-control movement and editor precedence; no per-component Tab wiring.
- Replaces the editor's `Prec.highest` Tab keymap *as the owner* of Tab.

**Implications:**
- New `TUG_ACTIONS.FOCUS_NEXT` / `FOCUS_PREVIOUS`; new pipeline stage in `responder-chain-provider.tsx`.
- The focus-walk stage owns Tab / Shift-Tab. Both are symmetric — forward / reverse focus navigation, the universal GUI convention.

**GUI deviation from the Claude Code TUI (amended after [#step-3]):** the Claude Code terminal cycles the permission mode on `⇧⇥`. In a GUI, `⇧⇥` must move focus to the previous control, so Tug **does not** put permission cycling on `⇧⇥`. The earlier "fold the dev card's `⇧⇥` into the focus walk, consumed only when a dev card claims it" approach was wrong: a dev card's `card-content` responder *always* claims `cycle-permission-mode`, so `⇧⇥` inside a dev card would never reach `focus-previous` — silently flipping the permission mode instead of navigating focus. The cycle now lives on **`⇧⌘P`** (a static key-card-scoped keybinding, mnemonic for the chip's `/PERMISSIONS` caption, forward-only); the `PermissionModeChip` + sheet and the `/permissions` command remain the pick-a-mode affordances. `Shift+Tab` is pure `focus-previous` everywhere.

#### [P05] One focus ring on the keyboard-active control (DECIDED; revised in [#step-9], [#step-10]; **partly superseded by [P15]**) {#p05-focus-ring}

> **Superseded in part by [P15].** The ring marks the **component** (the key view) and is correct as below — but [P15] forbids it ever *moving onto a sub-item*: a deferred component's current item gets the **movement-cursor (hover)** look, not the ring, and the immediate container gets `data-key-within`. The roving-ring-onto-member behavior shipped in steps 13–17 is retired.

**Decision:** A single `--tugx-focus-ring` token set (color = action/blue, **1px**, one offset, `outline`-based, clipping to `border-radius`) painting **one ring on the keyboard-active control** — the control the keyboard is currently driving. It shows on **keyboard** focus and **never on a mouse click**. There is **no** separate always-on key-view marker. The ring is the live **commit-key** affordance — the keyboard-active control it marks gets first claim on Return / Escape / ⌘. ([P12]); `filled+action` is the standing *identity* of the primary/default button (the ring's home base), not the live signal.

**One trigger: `[data-key-view-kbd]`** — the focus engine's own signal that it moved the key view by keyboard (the Tab walk, surface entry, default-seed on open, arrow-roving within a group). A pointer-reached key view carries `data-key-view` *without* `-kbd`, so a click never rings. The browser's default focus outline is **suppressed** (`:focus-visible { outline: none }`, authored before the key-view-kbd rule so the engine ring wins on equal specificity).

**`:focus-visible` is deliberately NOT a trigger (revised in [#step-10]).** It was the original second trigger ("for native and Radix-managed controls"), but it is unreliable in both directions for the engine's purpose: WebKit *withholds* it from a programmatic `.focus()` (the reason `data-key-view-kbd` exists), and — discovered taming TugCheckbox — WebKit *grants* it to native form controls (`<button>` checkbox/switch/radio, `<input>`, `<a>`) on a plain mouse **click**, painting a ring on a clicked control. Keeping it would split native vs. custom controls (a leaked implementation detail users can't see the logic of) and make the ring *lie* — marking a control WebKit merely focused rather than the one the engine routes the commit keys to. So the ring is driven by the app-owned `data-key-view-kbd` alone: modality-accurate, native-agnostic, and truthful to [P12]. **Cost:** the ring's coverage equals the engine's — an element rings on keyboard focus only when it is a registered focusable or a responder the engine tracks as key view; the audit/ARIA steps ([#step-27]/[#step-28]) close the long tail (links, arbitrary focusable content), and mid-migration an un-tamed control is ring-less on keyboard until its step lands (a useful "not yet tamed" signal, not a regression).

**Ring modality is a configurable policy (UNDER EVALUATION).** The "never on a mouse click" rule above is the **default** (`keyboard`), but it is now a switchable app-wide policy so both behaviors can be vetted in the real app before the rule is fixed:
- `keyboard` (default) — the ring paints on keyboard-driven key-view changes only, exactly as the decision states.
- `pointer` — the ring **also** follows pointer-driven key-view changes, so a click that lands on a registered focusable rings it. The motivation: consistency for the user, who doesn't distinguish native vs. custom controls and clicks into text inputs constantly — with `keyboard`, clicking a control then pressing Return acts on a control that wears no ring.

The two policies differ **only** in ring painting — the key view, Tab walk, responder routing, and roving are identical in both. Mechanism: a single boolean (`FocusManager.ringFollowsPointer`) widens the one ring-paint gate (`data-key-view-kbd` is set on `keyViewKeyboard || ringFollowsPointer`); no `:focus-visible` revival — both policies stay pure-engine. The policy rides a `focus-ring-modality-store` (tugbank `dev.tugtool.app` / `focusRingModality`, seeded from the drop, no `localStorage`), is pushed into the manager by the responder-chain provider, and is switched from a **Settings** tab in the dev panel (`⌥⌘/`). When the decision is made, the losing policy and its toggle are removed (or the toggle is promoted to a real setting).

**Rationale:**
- Crisp 1px border, not a fuzzy bloated glow; `outline` is layout-free and follows radius on WebKit.
- **The two-tier model (this decision's original form) was retired.** A focus ring already persists on the focused control until focus moves, so there is no "at rest" gap for an always-on marker to fill — "where am I" is the ring, "what does Return do" is the ring (and the default button's fill). The marker answered a question nothing asked; one ring is simpler and conventional. (See [Q01], superseded.)
- **One signal, not the browser's guess.** Folding the ring onto `data-key-view-kbd` makes "the keyboard is here" a single app-owned fact rather than a per-element-type WebKit heuristic — consistent across native and custom controls, and identical to the commit-key routing target ([P12]).

**Implications:**
- Delete per-component ring rules (indigo `accentCool` on checkbox/option-group/input, `link`-colored `--tugx-dialog-button-focus-ring` / `--tugx-idialog-focus-ring`, cue `accent`). Done in [#step-6].
- `--tugx-focus-ring-{color,width,offset}` authored in both `brio.css` and `harmony.css`; the short-lived `--tugx-focus-ring-hairline-*` tokens were removed when the model collapsed to one ring.
- `focus-ring.css` suppresses the UA outline (`:focus-visible { outline: none }`) and paints the ring on `[data-key-view-kbd]` only; the `:focus-visible` trigger was retired in [#step-10].
- Every keyboard focus move must flow through the engine so it sets `keyboard=true` (the Tab walk, surface entry, and — added in the roving steps — component-local arrow-roving). A keyboard-reachable affordance must be a registered focusable or a tracked responder to ring.
- The engine seeds the key view (hence the ring) to a surface's declared default button on open ([P07]); the ring is the Tab anchor from there.

#### [P06] Color contract: accent = selection, action = keyboard-active (DECIDED; **extended by [P15]**) {#p06-color-contract}

> **Extended by [P15].** This contract stands (accent = selection, action/blue = the keyboard-active axis / ring). [P15] adds a **third** visual state between them — the **movement cursor**, painted as **mouse-hover** — so a deferred component now shows up to three at once: ring (component focused), hover (current item), accent (selected item).

**Decision:** **accent/orange = selection** (the chosen item). **action/blue = the keyboard-active axis** — the surface the keyboard is currently empowering, expressed two ways: the **focus ring** (typing/arrows land here) and the **default-action affordance** (the CTA button Return fires, see [P12]). Re-point **UI-selection** surfaces (`selected`, `highlighted`, and the menus' *selection* usage of the shared `control-filled-action`) from blue to accent/orange across list rows, menus, popovers, and tab bars (option/radio already accent). **Text/character selection stays blue** — the `surface-selection-primary … plain` tokens are out of scope (see below).

**Rationale:**
- Today blue does double duty (UI selection *and* action), so selected ≠ focused is invisible. Moving UI selection to orange makes a selected-and-focused element legible, while blue gains a single sharp meaning — *the keyboard acts on this* — whether via focus (typing/arrows) or as the Return target ([P12]). This is why the CTA button stays blue.
- **Text selection is a different concept and must not move.** `surface-selection-primary-normal-plain-rest` (blue) / `-plain-inactive` (yellow) are the OS character-highlight, consumed by `tug-code-view.css`, `tug-markdown-view.css`, `tug-text-editor.css`, and `tug-pane.css`'s `::highlight(card-selection)`. WebKit substitutes the OS color on focused fields; recoloring it would be wrong and fights [L12].

**Implications:**
- Edit `--tug7-surface-selection-primary-normal-selected-*` and the menus' *selection* highlight; introduce an accent-based selection token for menus/lists rather than blanket-recoloring `control-filled-action`.
- **`control-filled-action` is shared** (CTA fill + menu transient): keep it blue for the CTA/activation use ([P12]); route the menu *selection* use to the accent selection token.
- Leave `surface-selection-primary-normal-plain-*` (text selection) at its current values.
- `bun run audit:tokens pairings` must pass; adjust tone/intensity within the role, not the role assignment ([L20]).

#### [P07] Default button retired for a chain-dispatched `default-action` (DECIDED) {#p07-default-action}

**Decision:** Remove the default-button element stack (`pushDefaultButton` / `popDefaultButton` / `peekDefaultButton` / `peekDefaultButtonInScope` and the `defaultButton` prop). The active focus mode declares a **default action**; Return resolves to it through the keyboard-active control per the activation model ([P12]). A surface **seeds its key view (and thus the focus ring) to its declared default button on open** — so the ring is on the default, the default is the Tab anchor, and Return fires it until the keyboard moves elsewhere.

**Rationale:**
- The grep-and-poke stack is exactly what the project wants retired; scoping already falls out of the focus-mode stack ([P03]).
- Aligns the "primary action of the active surface" with the chain instead of a side-channel element registry.
- The default button **must carry the focus ring** (it is the live Return target on open) — the ring, not `filled+action` alone, is the definitive Return affordance ([P05]/[P12]).

**Implications:**
- New `TUG_ACTIONS.DEFAULT_ACTION`; modal scaffolds (`TugConfirmPopover`, `TugAlert`, sheets) declare their default on the focus mode **and** seed the key view to the default button when they open (`focusFirstInMode` / an explicit default-seed), so the ring lands there. Wired as the dialog/sheet surfaces are tamed.
- Pipeline Stage 2 dispatches `default-action` instead of clicking a peeked element.
- **Extended by [P12]:** Return resolves through the keyboard-active control; the **blue CTA keeps `control-…-filled-action`** as its default-button *identity*; non-modal default/cancel are pane-scoped via the chain walk from the first responder (correcting the "scoping falls out of the mode stack for free" overstatement, which holds only for modal scopes).

#### [P08] `standard` default; `accessibility` opt-in and comprehensive (DECIDED) {#p08-modes}

**Decision:** `standard` is the default keyboard-access mode; `accessibility` is opt-in and changes behavior comprehensively (ignores `skip`, asserts full interactive ARIA, makes every interactive affordance reachable/activatable). Mode is app state on `data-keyboard-access`, persisted via tugbank defaults, toggled by both an in-app setting and a Swift host menu item.

**Rationale:**
- Matches the request: easy keyboard use for most users, with a comprehensive mode for AT needs.
- Both toggle surfaces because the host menu is discoverable and the in-app setting is persistent.

**Implications:**
- tugbank default `dev.tugtool.app` / `keyboardAccess` (Value::String); read on boot like theme; `useSyncExternalStore` for React consumers, `data-keyboard-access` for CSS ([L02]/[L24]).
- The focus walk takes mode as a policy input; `skip` is honored in standard, ignored in accessibility.

#### [P09] Accessibility mode covers interactive affordances only (DECIDED) {#p09-interactive-only}

**Decision:** "Every element controllable/activatable" means every **interactive** element and affordance — not non-interactive content (transcript prose, static blocks).

**Rationale:**
- Bounds the audit; reading-navigation of static content is a separate AT concern (live regions / virtual cursor) belonging to the OS-integration follow-on.

**Implications:**
- The registry and ARIA pass enumerate interactive affordances; static content is excluded.

#### [P10] `refuse` splits into its two real meanings (DECIDED) {#p10-refuse-split}

**Decision:** The current `data-tug-focus="refuse"` bundle is split into its two independent concerns: **(a)** don't-steal-first-responder-on-click (chain promotion) and **(b)** focus-walk policy (`skip` vs `accept`). They are configured separately and mapped onto the focus engine during the audit.

**Rationale:**
- The two were fused because they happened to co-occur on button-class controls, but they are different axes; the new engine needs them separable (a control can be click-inert for first responder yet still Tab-reachable, and vice versa).

**Implications:**
- The audit ([#step-27]) reclassifies all 28 `data-tug-focus` sites; `TugIconButton` and friends keep no-steal-on-click but gain explicit focus policy.

#### [P11] Dynamic, context-scoped keybinding registry (DECIDED) {#p11-dynamic-keybindings}

**Decision:** Add a **dynamic keybinding registry** alongside the static `KEYBINDINGS` map. Components register key→action bindings at mount via `useKeybindings(...)` and unregister at unmount. A binding is **active only while its owning scope is in context** — on the walk path from the key view / first responder up through `parentId`, or in the currently-active focus mode. Stage 1 resolves dynamic in-context bindings **innermost-first**, then falls back to the static global map. All entries cite `TUG_ACTIONS.*` constants (never raw strings) and dispatch through the chain exactly as static bindings do.

**Rationale:**
- The requirement is that commands attach/detach from action-handling as components come and go; a static array cannot express that. A registry tied to `useLayoutEffect` mount/unmount can, with the timing guarantee responders already rely on ([L03]).
- Context-scoping is the keyboard analog of the responder chain (Cocoa's `performKeyEquivalent:` walking the chain): the same chord can mean different things depending on what the user is working with — no global dispatcher table.
- Composes with the CFRunLoop focus-mode model ([P03]): a floating surface's accelerators live only while its mode is current.
- Leaves action-naming.md intact — the registry changes *when/where a key is live*, not how actions are *named*; entries still reference `TUG_ACTIONS.*`.

**Implications:**
- New `use-keybindings.tsx` hook + a registry on the manager keyed by scope id and focus mode.
- Stage 1 consults the dynamic registry (in-context walk) before the static `KEYBINDINGS` fallback; precedence is innermost-in-context → … → outermost → global.
- The static map remains the **global base layer** (app-wide shortcuts like ⌘W); it is not migrated wholesale — dynamic bindings layer above it.
- The registry is queryable, enabling a later "active shortcuts" help surface / command palette and feeding accessibility discoverability.
- A duplicate chord at the same scope is a dev-mode warning (otherwise the last registration shadows silently).

---

#### [P12] Semantic commit keys; the keyboard-active control owns the commit keys (DECIDED; revised in [#step-9]; **refined by [P15]**) {#p12-semantic-keys}

> **Refined by [P15].** The claim-first rule stands. [P15] settles the per-key semantics into the five-key model: **Space** = select/toggle (in place), **Enter** (Return *and* numpad) = act / **descend** a container, **Escape** = **ascend** one scope level (cancel at a modal scope). "Ascend" and "cancel" are unified.

**Decision:** **Return**, **Escape**, **⌘.** are *semantic commit keys*. The unifying rule: **the keyboard-active control (the one wearing the focus ring) gets first claim on all three.** What "unclaimed" delegates to differs per key, but the claim-first half is identical.

- **Return.** A control that *claims* it handles it — a **button** (including the default) **activates**; a **multiline editor** inserts a **newline**. Unclaimed — a checkbox, radio, list, single-line field — it **delegates to the active scope's declared default action**. (So arrow-navigating a list and pressing Return still submits, via delegation — the Cocoa default-button behavior — while a Tab to *Cancel* makes Return fire Cancel.)
- **Escape / ⌘. (symmetric with Return on the claim half).** A control that *claims* it handles it — a **text editor dismisses its open completion**, a self-managing surface backs out its own transient state. Unclaimed, Escape/⌘. **delegate to the cancel ladder** (G2): the **top focus-mode's cancelAction** first (an open menu/popover/sheet dismisses, no commit), then drag-cancel, then the originating pane's cancelAction. The claim-first order is load-bearing: an editor with an open completion inside a sheet dismisses the *completion* on the first Escape and closes the *sheet* on the second — because the keyboard-active control gets first crack before the ladder.
- **Space activates the keyboard-active control** — the universal "operate this" (toggle a checkbox, select a radio, open a popup button, click a button). Space always belongs to the keyboard-active control and never delegates. Return never substitutes for Space on a non-button control.
- **The ring is the definitive commit-key affordance.** A surface **seeds the ring to its declared default button on open** ([P07]), so the default is the Tab anchor and Return fires it until the keyboard moves. **Once you Tab, you have taken control of the commit keys** — to fire the default by keyboard you Tab (back) to it. The **mouse never moves the ring off the default** (mouse focus is not keyboard-active), so no amount of clicking can disarm it. `filled+action` is the default button's *standing identity* (the ring's home base), **not** the live signal — that is the ring.

**Worked example (popup button + Escape).** Tab to a `TugPopupButton` → ring on it. **Return** (button claims) opens its menu, which pushes a **trapped focus mode** carrying a `cancelAction`. **Arrows** move the highlight (no commit — the popup's value changes only on Return/Space on an item). **Escape** → cancel ladder → the menu mode's `cancelAction` dismisses it with **no commit**; focus returns to the popup button (ring intact), the prior value unchanged. The keyboard-active surface (the open menu) is also the top mode, so claim and ladder converge — no conflict.

**Rationale:**
- A user arrow-navigating a list inside a sheet must be able to press Return to submit without moving focus to "OK." Delegation (a non-claiming control sends Return to the scope default) delivers exactly that, while a focused button claiming Return delivers the equally-universal "Enter on a focused button activates *it*." One model covers both.
- Tying Return to the ring makes it predictable — Return acts where your eyes already are (the ring), or, for non-actionable controls, at the surface's one declared default. The mouse-can't-disarm rule prevents clicking around from ever silently re-routing Return.
- Keeping blue on CTA buttons preserves the learned "this is the primary action" signal and unifies blue under one idea — *the keyboard is engaged with this control* — whether via the ring or as the Return target. Orange stays purely about content choice.
- Dovetails with the CFRunLoop focus-mode stack ([P03]): a mode already scopes Tab; extending it to carry `defaultAction` + `cancelAction` makes the delegation/cancel resolution work against the current mode for free, and removes the need for any default-button element stack.

**Implications:**
- A scope **declares** `defaultAction` / `cancelAction` by registering ordinary chain-action handlers (`DEFAULT_ACTION` / `CANCEL_ACTION`) on its responder. For a non-modal scope that responder is the **pane's card / card-content responder**, not the pane chrome ([L09]) — "pane declares" is shorthand for "the card of that pane declares."
- **Delegation origin is the scope anchor, never the key view (G1, load-bearing).** *When the key view does not claim the key* (G5 delegation path), the commit key resolves via `sendToTarget(anchorId, …)` — `anchorId` is the **active modal mode's anchor responder** (modal) or the **originating pane's card responder** (non-modal). It is **never** `sendToFirstResponder`. The key view (or keydown event target) is used *only* to pick the **originating pane** — exactly as today's `peekDefaultButtonInScope` walks the first responder's `.tug-pane`. After that, resolution is at the pane/mode scope, not the leaf responder. Dispatching from the key view would reintroduce the historical cross-pane `Return` bug (a `Return` in pane A pressing pane B's default). (A *claiming* control — a focused button activating on Return — handles the key itself and never reaches this path.)
- **Cancel ladder (G2).** `Escape`/`⌘.` resolve in priority order: (1) top focus-mode `cancelAction` (an open popover/sheet/menu cancels first); (2) **drag-cancel** — `card-drag-coordinator.ts`'s document-level Escape listener stays *outside* the mode stack and keeps winning over card-level cancel; (3) the originating pane's `cancelAction` — e.g. the dev-card in-flight **interrupt** (`codeSessionStore.interrupt()`), which becomes the pane card's `cancelAction` when no modal mode is active. The fold of the old `CANCEL_DIALOG` binding must preserve this ladder, not flatten it.
- **Return precedence migrates the editor's existing defer (G3).** `keymap.ts` already takes `returnAction: "submit" | "newline"` + a `peekDefaultButton` callback and defers `Return` to the default button when configured `submit`. Migrate that `peekDefaultButton` defer to a `default-action` dispatch (origin = the editor's pane scope), preserving `returnAction` / `numpadEnterAction` / forced-`Cmd-Enter`. An editor configured `newline` keeps `Return`; one configured `submit`-with-defer falls through to the scope `default-action`. This is one mechanism, not a parallel precedence.
- **Claim precedence (G5, the activation model's core).** Resolution is two-step: first, does the **keyboard-active control claim the key**? A **button** claims `Return` (activates itself) and `Space` (also activates); a **multiline editor / text surface** claims `Return` (newline/submit per `returnAction`) and `Escape` (dismiss completion); a **checkbox / radio / list / segmented control** claims `Space`/arrows (operate locally) but **not** `Return`. If the key view claims the key, it handles it. **Otherwise** the key **delegates** to the scope action per G1 (Return → `default-action`; Escape → the cancel ladder). This is the single rule behind "a focused button activates on Return, but arrow-navigating a list and pressing Return submits." `Space` is always the claim of the keyboard-active control and never delegates.
- **Empty cases (G4).** No active scope, or a scope that declares no default/cancel → silent no-op, suppress the macOS beep. An unfocused `Return` resolves against the **deck's focused pane** (global fallback in gallery/standalone, matching today's `peekDefaultButton` fallback).
- **Scoping (resolves F4):** modal scopes own these via the mode stack; a non-modal pane resolves default/cancel via the scope-anchored dispatch above — not the global base mode.
- New actions `TUG_ACTIONS.DEFAULT_ACTION` and `CANCEL_ACTION`; the existing Escape/⌘. → `CANCEL_DIALOG` bindings fold into `cancel-action` (preserving the G2 ladder). The CTA button keeps `control-…-filled-action` (blue) as its standing identity and registers itself as its scope's default-action handler; the surface seeds the focus ring to it on open ([P05]/[P07]) so the ring — not the fill — is the live Return affordance.
- Supersedes [P07]'s element-stack mechanism: there is no default-button registry; the scope declares an action, the blue CTA is its standing identity, and the focus ring on it is the live Return target.

---

#### [P13] Inline dialogs are non-trapped focus scopes (DECIDED) {#p13-inline-dialogs}

**Decision:** Inline, in-transcript dialogs — `TugInlineDialog` and its consumers `PermissionDialog` (`chrome/dev-permission-dialog.tsx`) and `QuestionDialog` (`chrome/dev-question-dialog.tsx`) — are **non-modal** affordances handled distinctly from floating surfaces. While one is pending it pushes a **non-trapped focus mode** ([P03] `trapped: false`) that **carries `defaultAction` / `cancelAction`** ([P12]) and hosts its wizard accelerators as **mode-local keybindings** ([P11]). It does **not** call `useFocusTrap` and does **not** trap Tab: the prompt entry keeps the key view and inter-control Tab is unaffected. `Return` / `Escape` / `⌘.` resolve against the dialog's mode because it is top-of-stack, so the user answers the dialog from the prompt without focus moving.

**Rationale:**
- These render inline in the transcript flow, not as overlays, and the prompt entry holds DOM focus while a request is pending — so a focus *trap* (which steals focus and cycles Tab within a surface) is exactly wrong for them. The CFRunLoop model already has the right tool: a **non-trapped mode** unions the base focusables (prompt keeps the key view, Tab flows normally) while still being the *current* scope, so commit keys and mode-local accelerators resolve to the dialog.
- It replaces all three pillars these dialogs lean on today — the default-button stack (`pushDefaultButton`/`peekDefaultButton`, Enter→click in Stage 2, the editor's `peekDefaultButton` Enter-defer), the document-level capture listener for `←`/`→`/`⌘.`, and the prompt entry's `CANCEL_DIALOG` — with one coherent scope, exactly as [P07]/[P12]/[P11] retire those pillars elsewhere. Without this decision an implementer might wrongly reach for `useFocusTrap` (steals the prompt's focus) or leave them stranded on the deleted default-button stack.
- A pending dialog's `default-action` must win over the prompt's own `submit`; being the top mode delivers that precedence for free (it is the inline analog of a modal mode owning default-action).

**Implications:**
- `TugInlineDialog` (or its chrome consumers) pushes a non-trapped mode while pending and declares `DEFAULT_ACTION` (confirm / Next / submit the highlighted option) + `CANCEL_ACTION` (cancel ≡ `popInteractive()`) on it. Folded into [#step-26]'s commit-key work, with `chrome/dev-permission-dialog.tsx` added alongside `chrome/dev-question-dialog.tsx`.
- The wizard accelerators (`←`/`→` Back/Next, `1`–`9` option select, `⌘.` cancel) become mode-local `useKeybindings` registered while the dialog is pending, deactivating on pop. Folded into [#step-5].
- The dialog's buttons (`TugDialogButton` / `TugPushButton`) take no-steal-on-click + an explicit Tab policy from the `refuse` split ([P10], [#step-27]); the `options` radio group is a single roving focus stop (the `tug-option-group` pattern, [P02]).
- Distinct from a floating surface: no `useFocusTrap`, no `data-key-view` move to the dialog, no Tab cycling within it. The mode is a *scope*, not a *trap*. The session's `pushInteractive`/`popInteractive` stack (the request queue) stays the source of truth for *which* dialog is pending; the focus mode is pushed/popped in lockstep with it.

#### [P14] `role="action"` controls keep the blue "active" on/selected tone (DECIDED) {#p14-action-role-blue}

**Decision:** The accent-vs-blue contract ([P06]) governs **generic UI selection** — the chosen item in lists, menus, trees/tables, and the default/accent-role toggles, radios, and options — which is now orange. It does **not** override the **role-based control tone system**: a control carrying `role="action"` (mapped by `ROLE_TOKEN_MAP` to the `active` token suffix) keeps its **blue** on/selected fill — switches, checkboxes, radios, and choice-mode `TugDialogButton` (which defaults to `role="action"`). Blue there reads as the **active-role** semantic, a sibling of the focus ring and the `filled-action` CTA, not as generic selection. `role="danger"` likewise keeps red; `role="accent"` / default is orange.

**Rationale:**
- The role tone system is a deliberate, systematic mapping (role → token suffix) shared across checkbox/switch/radio/option/choice. Recoloring `action`→orange would erase the action-vs-accent distinction on these controls and diverge them from the rest of the role family for no contract win: these are *role-typed controls*, not the generic "selected item in a collection" surfaces [P06] set out to disambiguate.
- The genuine selected-vs-focused legibility problem [P06] names is already solved where it bites — list rows, menus, trees/tables now paint orange and take the blue focus ring, so a selected-and-focused row reads as both (pinned by `at0111`).
- An action-role choice that is *selected and focused* shows blue fill + blue ring, but that pairing is rare, role-scoped, and acceptable as the action semantic; making every action-role on-state orange is a larger redesign than the contract requires. (Revisit per-control if it proves confusing in practice.)

**Implications:**
- No recolor of `toggle-primary-…-active`, the `tug-dialog-button` `action`/default selection fills, or `ROLE_TOKEN_MAP` in this phase. The Step 8 sweep treats these as the intended active-role tone, not blue-as-selection remnants.
- Blue's "single sharp meaning" from [P06] is scoped to *generic* surfaces + the keyboard-active axis; role-typed control tones (action/blue, danger/red, accent/orange) are an orthogonal, pre-existing axis that stands.

---

#### [P15] The Tug keyboard model — Focus / Move / Act over hierarchical scopes (DECIDED; GOVERNING) {#p15-keyboard-model}

**Status — GOVERNING.** This is the keyboard-interaction model for the whole component library. It **supersedes the conflicting parts** of [P05] (the ring marks the *component* and never moves onto a sub-item — retiring the roving-ring shipped in steps 13–17), [P06] (adds the *movement-cursor* visual), and [P12] (refines the commit keys into the five-key model below). [P01]–[P04], [P07]–[P11], and [P13] stand — this builds on them (the FocusManager, the authored Tab walk, the focus-mode/scope stack, the keybinding registry). Building steps 6–18 under a piecemeal, web-convention conception revealed that conception to be wrong for Tug; this replaces it.

**The model — five keys, any depth.** Three tiers — *which component*, *where within it*, *act on it* — extended with *descend / ascend* so containers nest arbitrarily:

| Key | Tier | Meaning |
|---|---|---|
| `Tab` / `⇧Tab` | **focus** | move the ring between components **at the current scope level** |
| arrows · `Home` · `End` · `PgUp/Dn` · `Opt`+arrows | **move** | move the cursor **within** the focused component (its primary axis) |
| `Space` | **act — select** | select / toggle the current item — never changes level |
| `Enter` (Return **and** numpad — identical, no distinction) | **act — activate / descend** | act; if the current item is a container **with navigable content**, **descend** (push a scope); else a plain act |
| `Escape` | **ascend / cancel** | pop one scope level (ascend); at a modal scope, cancel it |

**Rules:**
- **Move vs act split.** *Live* components (TugSlider, TugTabBar) commit as you move — moving *is* acting. *Deferred* components (radio, choice, option, list, accordion) move a **hover cursor** and commit only on Space/Enter.
- **Descend is always Enter, never automatic.** Space selects in place; Enter descends when there's navigable content inside, otherwise acts.
- **Tab-into** a component lands its cursor on its **selected** item (not reset to first).
- **Space / Enter** get **split code paths but one mapped "act"** for now; the split is the seam where Enter already means *descend* and where the two may diverge per component later if experience demands it.
- **Scopes — one stack, `trapped` per container** ([P03]/[P13]). Non-trapped containers (accordion content, inline dialogs): `Escape` ascends, `Tab` can exit. Trapped containers (sheets, alerts): `Escape` cancels, `Tab` is contained. The stack is now also driven by Enter-descend / Escape-ascend.
- **Logical key view ≠ DOM focus.** A pushed scope can be the active key target while DOM focus stays elsewhere — an inline Permission/Question dialog is operable (arrows pick, Enter answers, Escape cancels) while the prompt keeps the caret.
- **Text editors invert the model (see [Q04]).** A text editor is a `none`-leaf that declares a **key-capture set**: while it is the key view, printables + Space type, arrows are the caret (always — never escape-at-boundary), Enter is submit/newline (multi-line follows the prompt-entry Enter-vs-Shift+Enter preference, library-wide), and **Tab / Escape stay navigation at rest** — captured only transiently by an open completion. `consumesTab` ([Q02]) is one entry in that set.

**Two container flavors** (each component declares which it is):
- **Item container** (list, accordion, radio, option, choice, tab bar, menu): children are *items*, navigated with **arrows**; one is the cursor.
- **Component container** (dialog, popover, sheet, a descended sub-form): children are *components*, navigated with **Tab**; arrows are unused there — Tab is the move, Enter/Escape are the depth.

**Visual states — three, named:**
- **key view** — the active component, wearing the focus ring ([P05] token). The ring marks the **component**; it **never** moves onto a sub-item. *(Retires the roving-ring-onto-member behavior in steps 13–17.)*
- **`data-key-within`** — the **immediate** container of the key view (only one level rendered), a *quiet* "contains active" mark: the engine's visible `:focus-within`.
- **movement cursor** — the current item inside a *deferred* component, painted with the **mouse-hover** treatment (keyboard-current == hover). Distinct from the ring and from **selected** (committed `data-selected`, [P06] accent).
- **key path** — the root→leaf chain of scopes; only the key view and its immediate `data-key-within` render.

**Naming:** active = **key view** (`data-key-view` / `-kbd`, exists); immediate container = **`data-key-within`** (new); chain = **key path**. Extends the engine vocabulary and the CSS `:focus-within` mental model. (Public alias `focus-active` / `focus-container` was considered; `key view` / `key-within` chosen to match the existing engine and CSS.)

**Rationale:**
- One rule everywhere beats per-component web conventions. Every component answers only: *what is my move, what is my act, am I a container.*
- Separating move from act (hover, then Space/Enter) is the deliberate Tug departure from native — consistent across the library, and the precondition for nesting, since it frees **Enter** to also mean *descend*.
- Nesting reuses the existing scope stack; **ascend unifies with cancel**; the logical-key-view decoupling already exists, so inline dialogs fall out for free.

**Implications — rework (tracked in the ledger):**
- Ring stays on the component; sub-items get the hover cursor (undo the ring-moves-to-member of steps 13–17).
- Arrow-selects (radio / choice) → arrow-moves-cursor + Space/Enter-selects.
- New shared engine pieces, built once before the per-component redo: the **movement-cursor / hover** state, **`data-key-within`** rendering, **Enter-descend / Escape-ascend** on the scope stack, and the **live-vs-deferred + Space/Enter** act dispatch.
- Steps **6, 13–18** are superseded and redone; **9–12** (button / checkbox / switch / slider) are reviewed — largely consistent already as leaves + a live value control — touch-ups only.

#### Keyboard Behavior Matrix {#keyboard-matrix}

Each component's declaration against [P15]. **Container?** = item / component / none. **Move** = arrows · Home/End · Pg · Opt+arrows. **Act** = Space / Enter (one "act" for now; Enter additionally descends a container). **Commit** = live (on move) or deferred (on Space/Enter).

| Component | Container? | Move | Act (Space / Enter) | Commit |
|---|---|---|---|---|
| internal/tug-button · TugPushButton | none | — | press / activate | — |
| TugCheckbox | none | — | toggle checked | — |
| TugSwitch | none | — | toggle on/off | — |
| TugSlider | none | move value; Home/End = min/max; Pg/Opt = larger step | — *(no act; value commits live)* | **live** |
| TugTabBar | item | move cursor over tabs; Home/End | *(current tab already switched)* | **live** — switches as you move |
| TugRadioGroup | item | move hover over radios; Home/End | check current radio | deferred |
| TugChoiceGroup | item | move hover over segments | select current segment | deferred |
| TugOptionGroup | item | move hover over options | toggle current option | deferred |
| TugAccordion | item **+ descend** | move hover over headers; Home/End | Space toggles expand; **Enter expands + descends** into content | deferred |
| TugListView | item **+ descend** | move hover over rows; Pg = page; Home/End; scrolls into view | Space selects row; **Enter descends** into row content (else activates) | deferred |
| TugContextMenu · internal/tug-popup-menu | item *(trapped scope)* | move hover over items; Home/End | activate current item; Escape closes | deferred |
| TugInput · editor | none *(key-capture leaf, [Q04])* | arrows = caret (always); printables + Space type; `consumesTab` while completing | Enter = submit (single-line) / prompt Enter-pref (multi-line); Tab/Escape navigate at rest | live (caret) |
| TugTooltip | none *(passive)* | — *(not a focus stop; opens on trigger focus)* | — | — |
| TugPopover | component *(scope)* | — *(Tab cycles inner components)* | inner act; Enter = scope default-action; Escape ascends / closes | per inner |
| TugSheet | component *(trapped scope)* | — *(Tab contained)* | inner act; Enter = default-action; Escape cancels | per inner |
| TugAlert | component *(trapped scope)* | — *(Tab contained)* | inner act; Enter = default; Escape cancels | per inner |
| TugPermissionDialog · TugQuestionDialog | component *(non-trapped scope; logical key view ≠ DOM focus)* | arrows pick the option (Question) while the prompt keeps the caret | Enter = confirm / Next / submit highlighted; Escape = cancel (`popInteractive`) | deferred |

**Notes on the tricky rows:**
- **TugTabBar / TugSlider are *live*:** moving commits, so "Act" is a no-op (the current value/tab is already chosen). They use only the focus + move tiers.
- **TugAccordion / TugListView are the *descend* cases:** Space acts in place (expand / select), Enter descends into the revealed content when it has navigable components — the content becomes a non-trapped child scope; Escape ascends.
- **Menus** are item containers living in a trapped scope: arrows move the item cursor, Enter activates, Escape closes (= ascend the menu's scope).
- **Inline dialogs** are the model's sharpest test: a non-trapped scope that is the *logical* key view while DOM focus and the caret stay on the prompt ([P13]); the model accommodates it because the key view is projected, not DOM-bound.

---

### Deep Dives (Optional) {#deep-dives}

#### The three axes, named {#three-axes}

| Axis | Owner after this plan | DOM signal | Visual |
|---|---|---|---|
| **Responder scope** (action routing) | `ResponderChainManager` (unchanged) | `data-responder-id`, `data-first-responder` | none directly |
| **Key view** (keyboard target) | `FocusManager` (new) | `data-key-view` (one at a time; `-kbd` when keyboard-reached) | one focus ring, on keyboard focus |
| **Selection** (chosen content) | components (CSS) | `aria-selected` / `data-selected` | accent/orange |

The key insight: first responder (chain) and key view (focus) usually agree but are independent — a focus-refusing control click keeps the key view put while routing an action. Naming them separately is what untangles the mess.

#### CFRunLoop mode model for focus traps {#cfrunloop-model}

A CFRunLoop runs in exactly one mode; only sources/timers registered for that mode are serviced; `kCFRunLoopCommonModes` is a pseudo-mode that aggregates several. We adopt the same shape:

- The FocusManager holds a **mode stack**. The top mode is "current."
- Each focusable registers into one or more modes (default: the base mode). A floating surface's contents register into the mode it pushes.
- The Tab walk enumerates only focusables in the current mode → natural trapping; Tab past the last wraps to the first **within the mode**.
- Pop on dismiss restores the prior mode and the prior key view.
- `default-action` resolves against the current mode (replacing `peekDefaultButtonInScope`).

This gives nesting (a popover inside a sheet pushes a mode atop the sheet's), and it means "trap" is not special-cased per surface — it is the default consequence of opening a mode.

#### Affected components inventory {#affected-inventory}

- **Radix-focus components to tame (~14):** radio-group, accordion, switch, popover, slider, checkbox, context-menu, tab-bar, sheet, alert, tooltip, label, internal/tug-button, internal/tug-popup-menu.
- **Hand-rolled roving / keyboard groups to tame (engine registration, not Radix):** choice-group, option-group, list-view — each registers as a single focus stop and keeps its component-local arrow/row navigation (the `tug-group-utils` roving pattern), paralleling tab-bar's taming ([#step-16]–[#step-18]).
- **Per-component focus-ring rules to delete:** checkbox, option-group, input, dialog-button, inline-dialog, cue, tab-bar, choice-group, list-row, textarea, value-input, code-view, markdown-view, slider, menu, prompt-entry, split-pane, hue-strip, popover.
- **Selection-token recolor sites:** list-row, menu, editor-context-menu, list-view (the `selected`/`highlighted` surfaces → accent). **Excluded from recolor:** `surface-selection-primary-normal-plain-*` (text/character selection: code-view, markdown-view, text-editor, `::highlight(card-selection)`) stays blue; `control-…-filled-action` stays blue for the CTA/activation use ([P06], [P12]). `control-filled-action` is *shared* (CTA fill + menu transient) — only the menu *selection* use moves to the accent token.
- **Commit-key sites (default-action / cancel-action):** `internal/tug-button.tsx`, `responder-chain-provider.tsx` (Stage 2), `responder-chain.ts` (stack), `tug-text-editor.tsx` + `tug-text-editor/keymap.ts` (`peekDefaultButton` submit-Enter defer — G3), `cards/gallery-default-button.tsx`, and the inline dialogs `chrome/dev-question-dialog.tsx` + `chrome/dev-permission-dialog.tsx` (non-trapped focus scopes per [P13]: declare default/cancel on a pushed non-trapped mode, retiring their default-button + document-listener handling). **Escape-ladder consumers to reconcile (G2):** `card-drag-coordinator.ts` (document-level drag-cancel Escape listener, kept), `cards/dev-card.tsx` (in-flight interrupt → pane card `cancelAction`), and the `keybinding-map.ts` Escape/⌘. → `CANCEL_DIALOG` entries (fold into `cancel-action`).

#### Dynamic keybinding resolution {#keybinding-registry}

**Two layers, one pipeline.** Stage 1 (capture-phase keydown) resolves a chord in this order:

1. **Dynamic, in-context** — walk from the key view / first responder up through `parentId`; at each node, match the event against bindings that node (or the active focus mode) registered. Innermost match wins. This is the keyboard analog of the action walk.
2. **Static global** — fall back to `KEYBINDINGS` (`matchKeybinding`) for app-wide shortcuts.

The matched binding dispatches its `TUG_ACTIONS.*` action through the chain exactly as today (`sendToFirstResponderForContinuation`, honoring `preventDefaultOnMatch`, continuations, and the existing `scope: "first-responder" | "key-card"` *dispatch routing*).

**Activation context vs. dispatch routing** — two axes that must not be conflated:

- *Activation context* (new): is this binding live right now? Yes iff its scope is on the in-context walk path or its focus mode is current.
- *Dispatch routing* (existing `scope` field): once live and matched, where does the action walk from — `first-responder` (default) or `key-card`?

A dynamic binding is "live in context, then routed like any other action."

**API:**

```ts
useKeybindings([
  { key: "KeyB", meta: true, action: TUG_ACTIONS.TOGGLE_BOLD, preventDefaultOnMatch: true },
]);
```

- Registered against the calling component's responder scope (from `ResponderParentContext`) via `useLayoutEffect` ([L03]); cleanup unregisters.
- A mode-local variant registers into the active focus mode so the binding dies when the surface closes ([P03]).

**Manager surface:** `registerKeybinding(scopeId, binding)` / `unregisterKeybinding(scopeId, binding)`; `resolveKeybinding(event)` (in-context walk, then global); `activeKeybindings(scopeId?)` for the discoverability surface.

---

### Specification {#specification}

#### Terminology and Naming {#terminology}

- **Key view** — the single element (or none) that receives keystrokes; carries `data-key-view`.
- **Focusable** — an element registered via `useFocusable` with a group, order, and policy.
- **Focus mode (scope)** — a stack entry; only its focusables participate in the Tab walk while it is current.
- **Focus ring** — one blue ring on the keyboard-active control, shown on keyboard focus only (never on a click); the live commit-key affordance (the marked control gets first claim on Return / Escape / ⌘.).
- **`policy`** — `accept` (in the standard-mode walk) | `skip` (pointer-focusable, excluded from standard walk, included in accessibility).

#### Modes / Policies {#modes-policies}

| `data-keyboard-access` | Walk includes `skip`? | ARIA assertion | Default |
|---|---|---|---|
| `standard` | no | baseline | ✔ |
| `accessibility` | yes | full interactive ARIA | opt-in |

#### Public API Surface {#public-api}

- `useFocusable({ id, group, order, policy?, consumesTab? })` → `{ focusableRef }`.
- `FocusManager`: `setKeyView(id)`, `keyView()`, `focusNext()`, `focusPrevious()`, `pushFocusMode(scopeId, opts)`, `popFocusMode(scopeId)`, `registerFocusable(record)`, `unregisterFocusable(id)`, `setDefaultAction(scopeId, action)`, `resolveDefaultAction()`.
- New actions: `TUG_ACTIONS.FOCUS_NEXT`, `FOCUS_PREVIOUS`, `DEFAULT_ACTION`, `CANCEL_ACTION`.
- Scopes declare `defaultAction` / `cancelAction` (Return / Escape·⌘. targets) on their focus mode or pane. See [P12].
- `useKeybindings(bindings)` → registers/unregisters context-scoped bindings; manager `registerKeybinding` / `unregisterKeybinding` / `resolveKeybinding` / `activeKeybindings`. See [#keybinding-registry].

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Key-view id (which element is keyboard target) | structure | FocusManager registry; `useLayoutEffect` registration; stamps `data-key-view` | [L24], [L03] |
| Focus-mode stack (CFRunLoop scopes) | structure | FocusManager; `useLayoutEffect` push/pop on surface open/close | [L24], [L03] |
| Focusable records (group/order/policy/consumesTab) | structure | `useFocusable` + `useLayoutEffect`; `data-tug-focusable` attr | [L24], [L03] |
| Keyboard-access mode (`standard`/`accessibility`) | structure | tugbank DEFAULTS feed → `useSyncExternalStore`; `data-keyboard-access` on root | [L02], [L24] |
| Focus-ring rendering | appearance | CSS `[data-key-view-kbd]` only (UA `:focus-visible` outline suppressed); `--tugx-focus-ring` token | [L06], [L24] |
| Selection color (accent/orange) | appearance | CSS tokens on `[data-selected]`/`[aria-selected]` | [L06], [L20] |
| Default / cancel action of active scope (Return / Escape·⌘. targets) | structure | FocusManager per mode/pane; declared at mount; dispatched as a chain action | [L11], [L24] |

---

### Compatibility / Migration / Rollout (Optional) {#rollout}

- **Migration:** the FocusManager lands inert (registry + key view, no Tab interception) in [#step-1]; Tab behavior flips in [#step-3]. Selection recolor and ring deletion are visible but non-breaking. Default-button retirement is a hard cutover gated by app-tests.
- **Rollback:** each step is a separate commit with a falsifiable checkpoint; the Tab interception stage can be disabled by removing the keybinding entries without reverting the registry.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/focus-manager.ts` | `FocusManager`: key view, focusable registry, focus-mode stack, default-action resolution |
| `tugdeck/src/components/tugways/use-focusable.tsx` | `useFocusable` hook (sibling to `useResponder`) |
| `tugdeck/src/components/tugways/use-focus-trap.tsx` | `useFocusTrap` hook: push/pop a trapped focus mode for a floating surface + `FocusModeScope` provider ([#step-4]) |
| `tugdeck/src/components/tugways/__tests__/focus-walk.test.ts` | pure-logic bun:test for walk ordering / mode trapping / policy filtering / key-view capture-restore |
| `tugdeck/styles/focus-ring.css` (or token block in theme files) | `--tugx-focus-ring` primitive; ring on `[data-key-view-kbd]`, UA `:focus-visible` outline suppressed |
| `tugdeck/src/components/tugways/use-keybindings.tsx` | `useKeybindings` hook + dynamic, context-scoped keybinding registration |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `FocusManager` | class | `focus-manager.ts` | new |
| `useFocusable` | hook | `use-focusable.tsx` | new |
| `FOCUS_NEXT` / `FOCUS_PREVIOUS` / `DEFAULT_ACTION` / `CANCEL_ACTION` | const | `action-vocabulary.ts` | new actions |
| `⇧⌘P` → `cycle-permission-mode` (key-card) | entry | `keybinding-map.ts` | Tab/Shift-Tab owned by the focus-walk stage, not this map; `⇧⇥` no longer cycles ([P04] GUI deviation) |
| Stage for `focus-next`/`focus-previous`/`default-action` | code | `responder-chain-provider.tsx` | replaces Stage 2 default-button click |
| `pushDefaultButton`/`popDefaultButton`/`peekDefaultButton*` | removal | `responder-chain.ts` | deleted |
| `--tugx-focus-ring-*`, `--tug7-surface-selection-*` reassignments | tokens | `brio.css` / `harmony.css` | recolor + ring |
| `data-keyboard-access` read/write | code | `settings-api.ts`, `main.tsx` | mode persistence |
| `useKeybindings` | hook | `use-keybindings.tsx` | dynamic context-scoped bindings |
| `registerKeybinding`/`unregisterKeybinding`/`resolveKeybinding`/`activeKeybindings` | methods | `focus-manager.ts` / `responder-chain.ts` | dynamic keybinding registry + in-context resolution |

---

### Documentation Plan {#documentation-plan}

- [ ] New tuglaw: `tuglaws/focus-engine.md` — the three axes, the key view, the CFRunLoop mode model, the two modes, the focus-ring primitive. (Important doc → tuglaws/, per project policy.)
- [ ] Update `tuglaws/responder-chain.md` — replace the "default button stack" section with the `default-action` model; cross-link the focus engine; note key view vs first responder.
- [ ] Update `tuglaws/token-naming.md` / `tuglaws/theme-engine.md` — record accent=selection / action=focus and the `--tugx-focus-ring` alias.
- [ ] Update `tuglaws/action-naming.md` — document the dynamic keybinding registry (register/unregister in context, still cite `TUG_ACTIONS.*`; activation-context vs. dispatch-routing) and the semantic commit keys `default-action` / `cancel-action` (Return / Escape·⌘. routed to scope, with text-context precedence).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun:test, pure-logic)** | Focus-walk ordering, mode trapping/wrap, policy filtering, default-action resolution | `focus-walk.test.ts` |
| **Integration (app-test, real app)** | Tab navigation, trap+restore, focus-ring presence, selection+focus colors, default-action via Enter, mode toggle | `just app-test` |
| **Contract (token audit)** | Contrast pairings after recolor | `bun run audit:tokens pairings` |

#### What stays out of tests {#test-non-goals}

- No fake-DOM / jsdom render tests (happy-dom is deleted; banned pattern) — behavior is proven by real-app app-tests.
- No mock-store call-count tests for the FocusManager (banned pattern); the walk's *logic* is tested pure, its *behavior* in the real app.
- No screen-reader / VoiceOver assertions (out of scope this phase).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugdeck has HMR — no manual builds. App-tests run via `just app-test <file>` and end with a greppable `VERDICT: PASS|FAIL`.

#### Step Status Ledger {#step-status-ledger}

> **[P15] rework (governing).** The keyboard model was settled *after* steps 6–18 shipped, and it supersedes the piecemeal conception they were built on. Steps marked **`done → rework`** below are superseded by [P15] and the [Keyboard Behavior Matrix](#keyboard-matrix): their *engine wiring* (registration, the Tab walk, scopes) stays, but their *behavior* changes (ring stays on the component; arrows move a hover cursor, not selection; Space selects / Enter descends). The new `#step-30`–`#step-35` rows carry the redo: build the shared engine pieces once, then re-declare each component against the matrix. Steps 9–12 (button / checkbox / switch / slider) are **kept** — leaves and a live value control are already consistent with [P15] — pending a light review in `#step-35`. Steps 19–29 are authored against [P15] from the start.

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | FocusManager core + registry + useFocusable (inert) | done | ce7d8256 |
| #step-2 | Keyboard-access mode state + persistence | done | 80da10a4 |
| #step-3 | Tab pipeline: focus-next/previous + editor precedence | done | 188a976e |
| #step-4 | Floating-surface focus traps (CFRunLoop modes) | done | 662bca98 |
| #step-5 | Dynamic context-scoped keybinding registry | done | 03a08ab5 |
| #step-6 | Focus-ring primitive + two-tier indication; delete per-component rings | done → rework | 1575f73f |
| #step-7 | Recolor UI-selection → accent/orange | done | 889a5e1d |
| #step-8 | Confine blue to the keyboard-active axis | done | 8a2a2ec4 |
| #step-9 | Tame internal/tug-button (base control focus) | done | 7ca484af |
| #step-10 | Tame TugCheckbox | done | (dash kbd-taming) |
| #step-11 | Tame TugSwitch | done | (dash kbd-taming) |
| #step-12 | Tame TugSlider | done | (dash kbd-taming) |
| #step-13 | Tame TugTabBar (roving) | done → rework | (dash kbd-taming) |
| #step-14 | Tame TugRadioGroup (roving) | done → rework | (dash kbd-taming) |
| #step-15 | Tame TugAccordion (roving) | done → rework | (dash kbd-roving) |
| #step-16 | Tame TugChoiceGroup (roving) | done → rework | (dash kbd-roving) |
| #step-17 | Tame TugOptionGroup (roving, multi-select) | done → rework | (dash kbd-roving) |
| #step-18 | Tame TugListView (roving rows) | done → rework | (dash kbd-listview) |
| #step-19 | Tame TugTooltip | pending | — |
| #step-20 | Tame TugPopover (FocusScope → engine trap) | pending | — |
| #step-21 | Tame TugContextMenu (+ editor context menu) | pending | — |
| #step-22 | Tame internal/tug-popup-menu | pending | — |
| #step-23 | Tame TugSheet (modal trap + restore) | pending | — |
| #step-24 | Tame TugAlert (modal dialog) | pending | — |
| #step-25 | Radix-taming integration checkpoint | pending | — |
| #step-26 | Semantic commit keys + scope default/cancel actions | pending | — |
| #step-27 | First-responder + refuse audit & reclassification | pending | — |
| #step-28 | Accessibility-mode ARIA pass + dual mode toggle | pending | — |
| #step-29 | Integration checkpoint | pending | — |
| #step-30 | [P15] engine foundation: movement-cursor (hover) state, `data-key-within` rendering, Enter-descend / Escape-ascend on the scope stack, live-vs-deferred + Space/Enter act dispatch, and the per-component **key-capture set** ([Q04]; `consumesTab` becomes one entry) | pending | — |
| #step-31 | Redo deferred item-groups vs [P15] — TugRadioGroup, TugChoiceGroup, TugOptionGroup (arrows move hover; Space/Enter act; ring stays on the group) | pending | — |
| #step-32 | Redo live components vs [P15] — TugTabBar (move = switch live) + TugSlider review (ring on the component, never a sub-item) | pending | — |
| #step-33 | Redo TugAccordion vs [P15] — item container + Enter-descend into expanded content | pending | — |
| #step-34 | Redo TugListView vs [P15] — item container, hover-cursor rows, Space selects, Enter descends/activates | pending | — |
| #step-35 | Review leaves + ring primitive vs [P15] — TugButton/Checkbox/Switch confirmation, [#step-6] ring extension (movement-cursor + `data-key-within` visuals) | pending | — |

#### Step 1: FocusManager core + registry + `useFocusable` (inert) {#step-1}

**Commit:** `focus(engine): FocusManager, focusable registry, useFocusable — inert`

**References:** [P01] FocusManager, [P02] authored order, [P03] CFRunLoop traps, Spec (#public-api, #state-zone-mapping), (#three-axes, #cfrunloop-model)

**Artifacts:**
- `focus-manager.ts`, `use-focusable.tsx`; wiring into `responder-chain-provider.tsx`; `data-tug-focusable` / `data-key-view` attributes. No Tab interception yet.

**Tasks:**
- [ ] Implement `FocusManager` (key view, registry, focus-mode stack, default-action map) with no document Tab listener.
- [ ] `useFocusable({ id, group, order, policy?, consumesTab? })` registering via `useLayoutEffect` ([L03]); stamp `data-tug-focusable`. Tolerant pattern — silent no-op outside a provider, stable mount identity, like `useOptionalResponder` ([L26]).
- [ ] Manager stamps `data-key-view` on the current key view (seed from first responder / focusin).
- [ ] Expose via the existing provider context (sibling to `useResponderChain`).

**Tests:**
- [ ] `focus-walk.test.ts`: registry sorts by (group order, item order); mode filtering; wrap math; default-action resolution — pure-logic.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `bun test` green.
- [ ] App still behaves as before (no Tab change); `data-key-view` present on the focused element in the running app.

#### Step 2: Keyboard-access mode state + persistence {#step-2}

**Depends on:** #step-1

**Commit:** `focus(mode): keyboard-access standard|accessibility state + tugbank persistence`

**References:** [P08] modes, Spec (#modes-policies), State Zone Mapping (#state-zone-mapping), [L02]

**Artifacts:**
- `data-keyboard-access` on the root; tugbank default `dev.tugtool.app`/`keyboardAccess`; read-on-boot; store + `useSyncExternalStore`.

**Tasks:**
- [ ] Add read/write to `settings-api.ts` (PUT `/api/defaults/dev.tugtool.app/keyboardAccess`).
- [ ] Apply `data-keyboard-access` before first visible paint (like theme), default `standard`.
- [ ] Provide a store/hook so the FocusManager walk reads the current mode.

**Tests:**
- [ ] Unit: mode reducer/store defaults to `standard`; toggling updates the attr.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; toggling the default flips `data-keyboard-access` in the running app.

#### Step 3: Tab pipeline — `focus-next` / `focus-previous` + editor precedence {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `focus(tab): intercept Tab/Shift-Tab as focus-next/previous chain actions`

**References:** [P04] Tab actions, [Q02] editor handshake, Risk R02, (#affected-inventory)

**Artifacts:**
- `FOCUS_NEXT`/`FOCUS_PREVIOUS` actions; new pipeline stage; Tab/Shift-Tab in `keybinding-map.ts`; editor Tab-consume precedence; reconcile `⇧⇥`.

**Tasks:**
- [ ] Add actions to `action-vocabulary.ts`; bindings to `keybinding-map.ts`.
- [ ] Pipeline stage dispatches focus-next/previous; FocusManager advances key view honoring mode + policy ([P02]/[P08]).
- [ ] Resolve [Q02]: editor consumes Tab when completion/typeahead open; replace the `Prec.highest` Tab ownership in `tug-text-editor/completion-extension.ts` accordingly.
- [ ] Reconcile dev-card `⇧⇥ cycle-permission-mode` into the precedence model.

**Tests:**
- [ ] `focus-walk.test.ts`: next/previous honor group order, skip policy, mode default.
- [ ] app-test: Tab visits app-authored order; Tab in editor with open completion accepts the completion (does not move focus).

**Checkpoint:**
- [ ] `just app-test` focus-walk scenario `VERDICT: PASS`; completion accept still works.

#### Step 4: Floating-surface focus traps (CFRunLoop modes) {#step-4}

**Depends on:** #step-3

**Commit:** `focus(trap): push/pop focus modes for menus, popovers, sheets, alerts, completion`

**References:** [P03] CFRunLoop traps, (#cfrunloop-model), Risk R01

**Artifacts:**
- `pushFocusMode`/`popFocusMode` capture/restore the key view; `FocusModeContext` + mode-aware `useFocusable`; `useFocusTrap` hook; `data-focus-mode` DOM projection; wired into `TugSheet`.

**Tasks:**
- [x] Push a trapped mode on open; pop on close; restore prior key view. Wired into `TugSheet` (covers `TugAlertSheet`, which composes it). The popup-class surfaces (`TugPopover`, `TugContextMenu`, `internal/tug-popup-menu`) and the Radix `TugAlert` push/pop land in their taming steps [#step-20]–[#step-24], which replace Radix `FocusScope` with `useFocusTrap` — wiring them here, alongside the still-active `FocusScope`, would be churn those steps rework. The completion popup uses the key-consume model ([#step-3] `data-tug-tab-consume`), not a mode trap.
- [x] Tab/Shift-Tab wrap within the active mode — the trapped walk + wrap is the mechanism, pinned in `focus-walk.test.ts`. Becomes app-observable per surface as its contents register as focusables (taming); `useFocusable` now registers into the surrounding `FocusModeContext`.

**Tests:**
- [x] app-test (`at0106`): opening the permission sheet (a `TugSheet`) pushes `data-focus-mode`; Escape pops it and restores the key view to the card. Pure-logic `focus-walk.test.ts` pins capture/restore, nested LIFO restore, buried-pop no-op, and `focusFirstInMode`. The menu-specific "Tab past last → wraps" assertion lands with menu taming, when items become focusables in the pushed mode.

**Checkpoint:**
- [x] `just app-test at0106-sheet-focus-trap` `VERDICT: PASS`; `tsc` clean; `bun test` green; sheet/completion regression suite (at0100/at0103/at0104/at0105) green.

#### Step 5: Dynamic context-scoped keybinding registry {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `focus(keys): dynamic context-scoped keybinding registry (useKeybindings)`

**References:** [P11] dynamic keybindings, Spec (#keybinding-registry), (#cfrunloop-model)

**Artifacts:**
- `use-keybindings.tsx`; a dynamic keybinding registry on the manager keyed by scope id and focus mode; Stage 1 resolves in-context bindings before the static `KEYBINDINGS` fallback.

**Tasks:**
- [x] Add the keybinding registry on `ResponderChainManager` (`registerKeybinding` returns an unregister thunk / `resolveKeybinding` / `activeKeybindings`) keyed by scope id (responder id or focus-mode id) via live `KeybindingSource` getters. `keyBindingMatchesEvent` extracted from `matchKeybinding` so static + dynamic share one match rule.
- [x] `useKeybindings([...])` registering via `useLayoutEffect` ([L03]); entries cite `TUG_ACTIONS.*` constants; cleanup unregisters; live-read source so handler/chord changes need no re-register. Tolerant pattern (no-op outside a provider / with no scope, like `useOptionalResponder` — [L26]).
- [x] Stage 1 resolution: `responder-chain-provider` resolves dynamic in-context bindings (active focus mode as innermost `extraScopes`, then the first-responder walk, innermost-first) before `matchKeybinding`; the matched binding flows through the one existing dispatch path (`preventDefaultOnMatch`, `scope` routing, continuation).
- [x] Mode-local bindings (`useKeybindings(..., { mode: true })`) register under the surrounding `FocusModeContext` id and resolve only while that mode is current ([P03]). This is the mechanism the inline dialogs' wizard accelerators use ([P13]): `PermissionDialog` / `QuestionDialog` register `←`/`→`, `1`–`9`, `⌘.` as mode-local bindings — that wiring lands with [#step-26]; the mechanism is in place here.
- [x] Dev-mode warn (`warnDuplicateChords`) on a duplicate chord at the same scope.

**Tests:**
- [x] `keybinding-registry.test.ts` (11): innermost-in-context beats ancestor; off-walk doesn't match; modifier match is exact; focus-mode (extraScopes) wins and is reachable when DOM focus is elsewhere (inline-dialog case); unregister removes it; live source; `activeKeybindings`; dispatch-routing `scope` preserved.
- [x] app-test `at0107`: ⇧⌘Y (gallery `Dynamic Keybinding` panel) fires only when the panel's responder is in context — count stays 0 with focus elsewhere, bumps after the panel is clicked into first responder. "Gone after unmount" is the unit-tested unregister (the hook cleanup calls exactly it); "static global still fires" is the still-green static-chord suite (at0085 ⇧⌘C, at0105 ⇧⌘P, at0043 ⌘A/⌘C) after the dynamic layer was added.

**Checkpoint:**
- [x] `just app-test at0107-dynamic-keybinding` `VERDICT: PASS`; `bunx tsc --noEmit` clean; `bun test` 3389 pass; static-chord + trap regression suite green.

---

#### Step 6: Focus-ring primitive + two-tier indication; delete per-component rings {#step-6}

> **Model revised in [#step-9].** This step shipped the original two-tier
> treatment (always-on hairline + keyboard ring). Working through the activation
> model showed the always-on marker was redundant, so the model collapsed to
> **one ring on the keyboard-active control** (1px, keyboard-focus only). The
> per-component-ring deletions and the `--tugx-focus-ring-{color,width,offset}`
> primitive below all stand; the `[data-key-view]` hairline rule and the
> `--tugx-focus-ring-hairline-*` tokens were removed. **[#step-10] further retired
> the `:focus-visible` ring trigger** (WebKit paints it on native controls even on
> a mouse click): the ring is now driven by `[data-key-view-kbd]` alone, with the
> UA `:focus-visible` outline suppressed. See revised [P05]/[P12] and superseded
> [Q01]. The done-record below is left as the historical account.

**Depends on:** #step-1

**Commit:** `focus(ring): single --tugx-focus-ring primitive + two-tier key-view marker`

**References:** [P05] focus ring, [Q01] tier-1 weight, (#affected-inventory)

**Artifacts:**
- `--tugx-focus-ring` tokens in both themes; Tier-1 `[data-key-view]` 1px hairline; Tier-2 `:focus-visible` blue ring; deletion of all per-component ring rules.

**Tasks:**
- [x] Author `--tugx-focus-ring-{color,width,offset}` (color = action/blue) in `brio.css` + `harmony.css`. Added `--tugx-focus-ring-{color,width,offset}` plus `--tugx-focus-ring-hairline-{color,width}`; color/hairline reference the per-theme `tone-…-active` (blue) tokens so each theme tunes weight via its own values.
- [x] Add the shared mechanism (single selector/attribute) and Tier-1 hairline on `[data-key-view]`. New `styles/focus-ring.css` (imported in `globals.css`): Tier-1 `[data-key-view]` hairline + Tier-2 `:focus-visible` ring, equal-specificity, Tier-2 authored last so it wins on overlap.
- [x] Delete per-component ring rules (indigo `accentCool`, `link`-colored dialog/inline-dialog rings, cue accent, etc.). Removed the scattered focus *rings* on checkbox, switch, accordion, option-group, choice-group, cue, link, markdown-view copy, dialog-button, inline-dialog, input/textarea (`data-focus-style="ring"`), text-editor (outline lines), slider thumb, attachment-strip; dropped the now-orphan `--tugx-{cue-focus-outline,dialog-button-focus-ring,idialog-focus-ring}` tokens. Field border/bg affordances, drag/error/match outlines, list-row reveal, popover/in-sheet-tab/sash `outline:none` suppressions, and selection accents (Step 7) were kept by design. Dev-chrome (`dev-thinking-block`) and body-kind block focus rings are outside the focus-engine inventory and left for their own taming.
- [x] Resolve [Q01] by eye against both themes; lock the token. Locked the faint action-tinted hairline (option 2): Tier-1 reads `--tug7-surface-tone-primary-normal-active-rest` (faint blue, a:15), Tier-2 the solid `tone-border-active` blue. Each theme's own active-tone value supplies the per-theme weight, so no per-theme override was needed.

**Tests:**
- [x] app-test: focus-ring behavior in the real WKWebView. *(Originally `at0109-focus-ring-tiers`: click→1px hairline, Tab→2px ring. Rewritten as `at0109-focus-ring` for the revised one-ring model — click→no ring, keyboard→1px ring — when the two tiers collapsed in [#step-9].)*

**Checkpoint:**
- [x] `bun run audit:tokens pairings` passes; no per-component `outline:`/`focus-ring` rule remains (grep). `audit:tokens pairings` EXIT=0; `tsc --noEmit` clean; grep confirms no scattered focus-ring outline remains in the product tugways CSS and the three deleted tokens have zero references.

#### Step 7: Recolor UI-selection → accent/orange {#step-7}

**Depends on:** #step-6

**Commit:** `theme(selection): accent (orange) becomes the color of UI selection`

**References:** [P06] color contract, [P12] semantic keys, [L12], [L20], (#affected-inventory)

**Artifacts:**
- UI-selection surfaces (`selected`, `highlighted`) re-pointed to accent; an accent selection token for menus/lists. **Text/character selection (`selection … plain`) stays blue.** Shared `control-filled-action` keeps blue for CTA/activation; the menu *selection* use moves to the accent token.

**Tasks:**
- [x] Re-point `selected`/`highlighted` selection surfaces to accent in both themes; roll to list-row, menu, editor-context-menu, list-view (option/radio already accent). Recolored `selection-primary-normal-selected-{rest,hover}`, the `control-…-normal-{selected-*,highlighted}` surfaces+borders (tree/table row selection via `control-primary-normal-highlighted`), keeping selection foregrounds neutral. list-row (`selected`) and code/data tree+table (`highlighted`) auto-update; option/radio use the role-injected `segment` accent already; tab-bar active underline was already accent.
- [x] Leave `surface-selection-primary-normal-plain-*` (text/character selection: code-view, markdown-view, text-editor, `::highlight(card-selection)`) at its current blue ([L12]). Untouched — verified blue (oklch hue 230) by app-test.
- [x] Where `control-filled-action` is shared (CTA fill + menu transient), move the menu *selection* usage to the accent selection token and keep CTA/activation blue ([P12]). Re-pointed the menu item `[data-highlighted]`/hover, sub-trigger-open (tug-menu.css), completion-menu hover, and editor-context-menu highlight from `filled-action-hover` → `selection-primary-normal-selected-rest` + `selection-text-…-selected-rest`; moved the activation double-blink (tug-menu-item-blink.ts, internal/tug-popup-menu.tsx) to `selection-…-selected-hover` so the flash stays in the selection hue. `filled-action` stays blue for CTA/activation and the menu trigger open-state keeps `outlined-action-active`. Updated the `@tug-pairings`/`@tug-renders-on` annotations to match.

**Tests:**
- [x] app-test: a selected list row resolves the accent token; an editor text selection stays blue. `at0110-selection-accent` — `selection-primary-normal-selected-rest` and the `--tugx-list-row-selected-bg` alias resolve to orange (oklch hue 55); `selection-primary-normal-plain-rest` stays blue (hue 230). PASS.

**Checkpoint:**
- [x] `bun run audit:tokens pairings` clean; selected rows orange, text selection blue in the running app. `audit:tokens pairings` EXIT=0 (new selection pairing resolves); `tsc --noEmit` clean; hues verified orange/blue by app-test.

#### Step 8: Confine blue to the keyboard-active axis {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `theme(focus): blue = keyboard-active (focus ring + default-action), not selection`

**References:** [P06] color contract, [P12] semantic keys, [P05] focus ring

**Artifacts:**
- Blue removed from *selection* usages (now orange); blue retained for the focus ring and the default-action (CTA) affordance.

**Tasks:**
- [x] Sweep for blue-as-*selection* remnants; ensure blue surfaces are only the focus ring and the `filled-action` CTA/default-action. Swept every blue token in both themes: generic UI selection (`selection-primary-selected`, `control-normal-selected/highlighted`, menus, tree/table) is orange from [#step-7]; the remaining blues are the focus ring (`tone-active`), the `filled-action`/outlined/ghost/tinted action controls, focused-field borders, links, syntax/ANSI, drag-drop/inspector/snap overlays, and text/character selection — including editor atoms (`getAtomsInRange` scopes them to the character-selection range, so blue is correct per [L12]). No generic blue-as-selection remnant remained. The `role="action"` control tone (blue `active` for switches/checkboxes/radios/choice `TugDialogButton`) is retained by design — see [P14].
- [x] Verify a selected-and-focused row reads orange fill + blue ring; a default CTA button stays blue. Verified by token resolution: `--tugx-list-row-selected-bg` (selected fill) = orange, `--tugx-focus-ring-color` (ring) = blue, `filled-action-rest` (CTA) = blue, with the selection/focus hues >100° apart.

**Tests:**
- [x] app-test: selected+focused row carries both tokens distinguishably; the CTA button remains blue. `at0111-blue-keyboard-active` — selected fill orange (hue ~55), focus ring + CTA blue (hue ~230), |Δhue| > 100. PASS.

**Checkpoint:**
- [x] `bun run audit:tokens pairings` clean; visual check both themes. `audit:tokens pairings` EXIT=0; `tsc --noEmit` clean. No theme recolor was needed ([#step-7] already moved generic selection to orange; [P14] keeps role=action blue), so this step is the sweep confirmation + `at0111` + the new [P14] decision.

> **Steps 9–25 — Radix taming, one primitive per step.** Each disables the
> primitive's borrowed Radix focus management and drives focus from the engine, behind
> its own commit and app-test checkpoint so a regression is isolated to one primitive.
> Risk-ordered: simple controls first, roving composites next, non-modal traps, then
> modal surfaces. Common references for all: [P01] FocusManager, Risk R01,
> (#affected-inventory). `internal/tug-label` (Radix Label — `htmlFor` association only,
> no focus management) carries no taming work and is covered by the ARIA step ([#step-28]).

#### Step 9: Tame internal/tug-button (base control focus) {#step-9}

**Depends on:** #step-3

**Commit:** `focus(radix): internal/tug-button — engine-driven focus, Slot preserved`

**References:** [P01] FocusManager, [P10] refuse split, Risk R01, (#affected-inventory)

**Artifacts:**
- The base button (underlying push/popup/icon buttons) registers as a focusable and maps its `data-tug-focus` bundle to explicit no-steal-on-click + focus policy; Radix `Slot` (`asChild`) pass-through retained.

**Tasks:**
- [x] Register the base button as a focusable; split `data-tug-focus` into no-steal-on-click + explicit policy ([P10]). `TugButton` now calls `useFocusable` and registers when a surrounding surface authors it into a focus group (`focusGroup`/`focusOrder`/`focusPolicy`); `useFocusable` gained a `register` flag so an un-authored button stays a native focus stop and never makes the engine walk non-empty for its siblings (the end-state model: a control joins the walk when its surface authors a group, [P02]). The `data-tug-focus` bundle split into the explicit `stealsFocusOnClick` (default `false` → emits `data-tug-focus="refuse"`, the no-steal half) and the walk `focusPolicy` (`accept`/`skip`). Removed the legacy `.tug-button:focus-visible { outline: none }` suppression so focus indication is the app-owned single ring on keyboard focus ([P05] revised). Also in this step the focus model collapsed from two tiers to **one ring on the keyboard-active control** (1px, keyboard-focus only; engine marks `data-key-view-kbd` so its programmatic Tab focus rings reliably) — the always-on hairline and the `--tugx-focus-ring-hairline-*` tokens were removed and [P05]/[P12]/[Q01] revised. `at0109` was rewritten to the one-ring behavior.
- [x] Confirm `asChild`/Slot composition and disabled handling unaffected. `focusableRef` merges into the existing `setRefs` (Slot/`asChild` ref forwarding intact); `disabled`/`effectiveDisabled` and the confirmation lifecycle untouched; new focus props are destructured so they never leak to the DOM via `...rest`. Full unit suite (3389) green.

**Tests:**
- [x] app-test: a button click does not move the key view; the button is reachable per its policy; the ring shows on keyboard focus. `at0112-button-focus` (gallery `Focus Walk` panel: Alpha/Beta `accept`, Gamma `skip`) — engine Tab walks Alpha→Beta and wraps, never landing on Gamma in standard mode; the key view paints an outline on keyboard focus; clicking a refusing button while the key view sits on Beta leaves it on Beta. PASS.

**Checkpoint:**
- [x] `just app-test` button scenario `VERDICT: PASS`; `bunx tsc --noEmit` clean. `at0112` PASS; `tsc --noEmit` clean; `audit:tokens pairings` EXIT 0; full `bun test` (3389) green.

---

#### Step 10: Tame TugCheckbox {#step-10}

**Depends on:** #step-3, #step-9

**Commit:** `focus(radix): TugCheckbox — engine focus + ring, Space local`

**References:** [P01] FocusManager, [P05] focus ring, Risk R01, (#affected-inventory)

**Artifacts:**
- Radix checkbox focus deferred to the engine; Space toggles locally; Radix toggle semantics intact.

**Tasks:**
- [x] Register focusable; key view + ring from the engine; keep Radix checked/indeterminate semantics. `TugCheckbox` gained `focusGroup`/`focusOrder`/`focusPolicy` and calls `useFocusable` (registers only when authored into a group, `register: focusGroup !== undefined`); `focusableRef` merges into a `setRefs` forwarded to `CheckboxPrimitive.Root`. Keeps `data-tug-focus="refuse"` (click dispatches `toggle` without moving the key view). Space toggles natively; Return delegates to the scope default ([P12]). Upholds [L03] (registration in `useLayoutEffect` via `useFocusable`), [L06] (ring is CSS/DOM, not React state), [P01]/[P02].
- [x] **[P05] revised — `:focus-visible` ring trigger retired.** Taming the checkbox surfaced that WebKit grants `:focus-visible` to native form-control `<button>`s on a plain mouse click, so the primitive's `:focus-visible` trigger painted a ring on click. `focus-ring.css` now suppresses the UA `:focus-visible` outline and paints the ring on `[data-key-view-kbd]` alone — modality-accurate, native-agnostic, and truthful to the commit-key model. See revised [P05].

**Tests:**
- [x] app-test: Tab reaches it; Space toggles; ring shows on keyboard focus only. `at0113-checkbox-focus` (gallery `Focus Walk` panel, two checkboxes authored into one group): a fresh mouse click toggles (`data-state` flips) with **no** ring (outline 0, no `data-key-view-kbd`); Tab lands the key view and paints the ring (outline > 0, `data-key-view-kbd`); Space toggles; a second Tab walks to the next stop. PASS.

**Checkpoint:**
- [x] `just app-test` checkbox scenario `VERDICT: PASS`. `at0113` PASS; ring regressions `at0109`/`at0112` still PASS after the primitive change; `tsc --noEmit` clean.

---

#### Step 11: Tame TugSwitch {#step-11}

**Depends on:** #step-3, #step-9

**Commit:** `focus(radix): TugSwitch — engine focus + ring`

**References:** [P01] FocusManager, [P05] focus ring, Risk R01, (#affected-inventory)

**Artifacts:**
- Radix switch focus deferred to the engine; Space/Enter toggle local.

**Tasks:**
- [x] Register focusable; engine ring/key view; keep Radix toggle semantics. `TugSwitch` gained `focusGroup`/`focusOrder`/`focusPolicy` and the same `useFocusable` + `setRefs` wiring as the checkbox, forwarded to `SwitchPrimitive.Root`; keeps `data-tug-focus="refuse"`. Space/Enter toggle natively; the ring is the engine's `[data-key-view-kbd]` (the [P05] revision from [#step-10] applies). Upholds [L03], [L06], [P01]/[P02].

**Tests:**
- [x] app-test: Tab reaches it; Space toggles; ring on keyboard focus. `at0114-switch-focus` (gallery `Focus Walk`, two switches in one group): click toggles with no ring; Tab rings (outline > 0, `data-key-view-kbd`); Space toggles; Tab walks to the next stop. PASS.

**Checkpoint:**
- [x] `just app-test` switch scenario `VERDICT: PASS`. `at0114` PASS; `tsc --noEmit` clean.

---

#### Step 12: Tame TugSlider {#step-12}

**Depends on:** #step-3, #step-9

**Commit:** `focus(radix): TugSlider — engine focus; arrow-step local, drag continuous`

**References:** [P01] FocusManager, [P05] focus ring, Risk R01, (#affected-inventory)

**Artifacts:**
- Radix slider focus deferred to engine; arrow-key steps stay discrete, pointer drag stays continuous (the existing phase contract is unchanged).

**Tasks:**
- [x] Register the thumb as a single focusable; arrows step locally; engine owns ring/key view. `TugSlider` gained `focusGroup`/`focusOrder`/`focusPolicy` and calls `useFocusable`; the returned `focusableRef` is attached to `SliderPrimitive.Thumb` (the keyboard target), not the wrapper. The Root keeps `data-tug-focus="refuse"`. Removed `.tug-slider-thumb { outline: none }` so the engine ring (`[data-key-view-kbd]`) paints on the thumb — the global `:focus-visible { outline: none }` from [#step-10] handles UA suppression. Arrow-step / drag phase logic untouched. Upholds [L03], [L06], [P01]/[P02].

**Tests:**
- [x] app-test: Tab reaches the thumb; arrows step; ring on keyboard focus; drag unaffected. `at0115-slider-focus` (gallery `Focus Walk`, one slider min 0/max 100/step 5): no ring at rest; Tab lands the key view on the thumb and rings (outline > 0, `data-key-view-kbd`); ArrowRight steps `aria-valuenow` by one step. PASS.

**Checkpoint:**
- [x] `just app-test` slider scenario `VERDICT: PASS`. `at0115` PASS; `tsc --noEmit` clean.

---

#### Step 13: Tame TugTabBar (roving) {#step-13}

**Depends on:** #step-3

**Commit:** `focus(radix): TugTabBar — single focus stop, arrows local`

**References:** [P01] FocusManager, [P02] authored order, Risk R01, (#affected-inventory)

**Artifacts:**
- The custom `tabIndex` roving becomes a single focus stop in the walk; arrows move within; the engine owns Tab between stops.
- **New shared roving primitive** (foundation for the roving steps that follow): `FocusManager.refreshKeyViewProjection(keyboard?)` re-projects the current key view onto the DOM element that now carries its `data-tug-focusable` (`setKeyView` early-returns on an unchanged id, so it can't chase a moved element); `useRovingFocusable` registers one focusable for a group and exposes `setRovedElement(el, keyboard?)`, which moves `data-tug-focusable` (and, when the group holds the key view, the ring) onto the roved member. Appearance-zone DOM only ([L06]/[L22]); registration in `useLayoutEffect` ([L03]).

**Tasks:**
- [x] Register the tab bar as one focusable; keep component-local arrow roving; remove reliance on native inter-control Tab. The tab bar had no arrow roving (every tab was `tabIndex=0`); added it — roving `tabIndex` (active/focused member `0`, others `-1`), Arrow/Home/End move the cursor over the visible tabs and the engine ring follows via `useRovingFocusable.setRovedElement(el, true)`. `TugTabBar` gained `focusGroup`/`focusOrder`/`focusPolicy`; a pointer interaction marks the next move pointer-driven so a click doesn't ring. Tabs keep `data-tug-focus="refuse"`. Upholds [L03], [L06], [L11] (the bar stays a control), [P01]/[P02].

**Tests:**
- [x] app-test: Tab enters/exits the bar as one stop; arrows move between tabs; ring on keyboard focus. `at0116-tab-bar-focus` (gallery demo authored into one focus group): no ring at rest; Tab lands the key view on the active tab and rings it (only it has `tabIndex=0`); ArrowRight roves to the next tab, the ring follows and clears from the first, and the roving `tabIndex` moves with it. PASS. (The test waits on `document.hasFocus()` before Tab — this heavier card needs the focus hand-off confirmed, not a fixed delay.)

**Checkpoint:**
- [x] `just app-test` tab-bar scenario `VERDICT: PASS`. `at0116` PASS; `at0112` (button-focus engine regression) still PASS; `tsc --noEmit` clean; `bun test` (3389) green.

---

#### Step 14: Tame TugRadioGroup (roving) {#step-14}

**Depends on:** #step-3

**Commit:** `focus(radix): TugRadioGroup — disable Radix roving, arrows local`

**References:** [P01] FocusManager, [P02] authored order, Risk R01, (#affected-inventory)

**Artifacts:**
- **Radix `RadioGroupPrimitive` removed entirely** (decision revised from "disable Radix roving" to a full hand-roll): its `RovingFocusGroup` can't be disabled and would fight the engine for focus/`tabIndex`; its native-form `BubbleInput` is unused (selection flows through the chain, [L11], not HTML forms — verified no consumer wraps a group in a `<form>`). The group is now a hand-rolled single-select (the TugChoiceGroup shape): one engine roving stop via `useRovingFocusable`, hand-authored ARIA (`role="radiogroup"`/`role="radio"`/`aria-checked`), roving `tabIndex`, arrows rove-and-select. Value/state machinery was already ours (`internalValue` mirror + `handleValueChange` + state preservation) and is retained.

**Tasks:**
- [x] Replace the Radix roving layer with manual roving; the group registers as one focusable; arrows select-and-move locally; keep value semantics. Removed `RadioGroupPrimitive`; `TugRadioGroup` gained `focusGroup`/`focusOrder`/`focusPolicy` and registers via `useRovingFocusable`; arrow/Home/End rove over the enabled items (DOM-query order) and select (focus = selection); a layout effect keeps the cursor on the checked-or-first-enabled item and projects the ring. `TugRadioItem` is a `TugButton` carrying `role="radio"` + `aria-checked` + a `value` attribute (Radix's contract, which the at0030 state-preservation test reads off the checked item) + `data-state` (the CSS keys on `[data-state="checked"]`) + roving `tabIndex`; clicking selects without stealing the key view (`data-tug-focus="refuse"`). Widened `TugButton`'s `role` type to `TugButtonRole | (string & {})` to match its documented ARIA-role pass-through (formerly only reachable via a Radix Slot merge). Upholds [L03], [L06], [L11], [L20], [P01]/[P02].

**Tests:**
- [x] app-test: Tab treats the group as one stop; arrows move/select; ring on keyboard focus. `at0117-radio-group-focus` (gallery `Focus Walk`, three items, `a` checked): no ring at rest; Tab lands the key view on the checked item and rings it (only it has `tabIndex=0`); ArrowDown roves to `b`, the ring follows and clears from `a`, and selection follows (`b` → `data-state="checked"`, `a` unchecked). PASS.

**Checkpoint:**
- [x] `just app-test` radio-group scenario `VERDICT: PASS`. `at0117` PASS; radio-consumer regression all green: `at0090` permissions-rules-editor, `at0093` buckets, `at0094` scope-routing PASS; `at0030` virtual-focus state preservation PASS (after restoring the item's `value` attribute the test reads). `at0092` workspace-dirs surfaced a **pre-existing** failure (verified failing on the pre-code base) — diagnosed as a stale test expectation: the file chooser's close-normalizer commits the canonical `alphabet` (no trailing slash) but the test asserted `alphabet/`; fixed the test to the canonical form (menu *labels* keep their display slash). `tsc --noEmit` clean; `bun test` (3389) green.

---

#### Step 15: Tame TugAccordion (roving) {#step-15}

**Depends on:** #step-3

**Commit:** `focus(radix): TugAccordion — disable Radix roving, header focus local`

**References:** [P01] FocusManager, [P02] authored order, Risk R01, (#affected-inventory)

**Artifacts:**
- Radix accordion's built-in roving replaced by manual roving (option-group pattern; no public knob to disable Radix roving); headers reachable via the walk; arrows move between headers locally; expand/collapse semantics retained.

**Tasks:**
- [x] Replace the Radix roving layer with manual roving; register accordion headers per the authored order; arrows local; keep expand/collapse semantics.

**Tests:**
- [x] app-test: headers reachable; arrows move; expand/collapse via Space/Enter; ring on keyboard focus. (`at0120-accordion-focus`)

**Checkpoint:**
- [x] `just app-test` accordion scenario `VERDICT: PASS`.

**Done-note:** Radix accordion turned out to use a `Collection` + a root-level `onKeyDown` (composed via `composeEventHandlers`), **not** `RovingFocusGroup` — so every header was a `tabIndex=0` Tab stop and the arrow handler is replaceable. `TugAccordion` gained `focusGroup`/`focusOrder`/`focusPolicy`; when set it registers one engine stop (`useRovingFocusable`), threads a roving cursor to each `TugAccordionItem` trigger via a small `AccordionFocusContext` (cursor header `tabIndex=0`, rest `-1`, `data-tug-focus="refuse"`, `data-accordion-value` for DOM-query roving), and supplies its own Up/Down/Home/End handler whose `preventDefault()` skips Radix's composed handler. Space/Enter are never intercepted, so expand/collapse stays Radix's. All gated on `focusGroup` — existing consumers (permission editors, diff sheet) are byte-unchanged.

---

#### Step 16: Tame TugChoiceGroup (roving) {#step-16}

**Depends on:** #step-3

**Commit:** `focus(radix): TugChoiceGroup — single focus stop, arrows local`

**References:** [P01] FocusManager, [P02] authored order, Risk R01, (#affected-inventory)

**Artifacts:**
- The hand-rolled `tabIndex` roving (`tug-group-utils`) becomes a single focus stop in the walk; arrows move/select within; the engine owns Tab between stops; single-select value semantics retained.

**Tasks:**
- [x] Register the group as one focusable; keep component-local arrow roving (`tug-group-utils`); remove reliance on native inter-control Tab; keep single-select value semantics.

**Tests:**
- [x] app-test: Tab enters/exits the group as one stop; arrows move/select; ring on keyboard focus. (`at0118-choice-group-focus`)

**Checkpoint:**
- [x] `just app-test` choice-group scenario `VERDICT: PASS`.

**Done-note:** `TugChoiceGroup` gained `focusGroup`/`focusOrder`/`focusPolicy`; `useRovingFocusable` registers the group as one stop and a layout effect projects the engine ring onto the selected segment (focus = selection), with a `lastKeyboardRef` picking the ring modality (arrows follow, click clears). Added `data-choice-value` for addressability and a gallery `Focus Walk` panel.

---

#### Step 17: Tame TugOptionGroup (roving, multi-select) {#step-17}

**Depends on:** #step-3

**Commit:** `focus(radix): TugOptionGroup — single focus stop, Space toggles member`

**References:** [P01] FocusManager, [P02] authored order, Risk R01, (#affected-inventory)

**Artifacts:**
- The canonical roving `tabIndex` pattern (the one TugRadioGroup / TugAccordion borrow) becomes a single focus stop; arrows move within; Space/Enter toggles the active member; multi-select value semantics retained.

**Tasks:**
- [x] Register the group as one focusable; keep component-local arrow roving; Space toggles the active member; remove reliance on native Tab; keep multi-select semantics.

**Tests:**
- [x] app-test: Tab treats the group as one stop; arrows move; Space toggles a member; ring on keyboard focus. (`at0119-option-group-focus`)

**Checkpoint:**
- [x] `just app-test` option-group scenario `VERDICT: PASS`.

**Done-note:** `TugOptionGroup` gained `focusGroup`/`focusOrder`/`focusPolicy`; `useRovingFocusable` registers the group as one stop and a layout effect projects the engine ring onto the focused item (focus is separate from selection — Space/Enter toggles), with a `lastKeyboardRef` picking the ring modality. Added `data-option-value` for addressability and a gallery `Focus Walk` panel.

---

#### Step 18: Tame TugListView (roving rows) {#step-18}

**Depends on:** #step-3

**Commit:** `focus(list): TugListView — ring on the focused component, selection on the row`

**References:** [P01] FocusManager, [P02] authored order, [P05] ring, Risk R01, (#affected-inventory)

**Artifacts:**
- Under the focus engine, `TugListView` rows are never individual Tab stops (`tabIndex=-1`); the list contributes exactly one stop (or zero, when an owning input is the stop). The ring lives on the focused **component**; **selection** lives on the **row** (existing `selectionRequired` / `data-selected`). No roving-ring-onto-a-row, so windowing is not a ring problem.

**Design note (resolved).** Organizing principle: **focus ring on the focused component, selection on the row.** This dissolves the seed's three complications:
- **Focus ≠ ring decoupling → gone.** Ring on the component = `useFocusable` on the container (the ordinary fixed-focusable path), *not* `useRovingFocusable`. No ring is ever projected onto a moving/virtualized row.
- **Virtualization → not a ring problem.** Selection is *data* (`selectedIndex`), not DOM focus; a selected row that scrolls out and remounts re-renders with `data-selected` for free. The ring never chases an unmounted row.
- **The pattern already exists.** `dev-card` (recent-projects picker) and `model-picker-sheet` already do "type in the input, Arrow moves the list's selection, `scrollToIndex` into view" at the form level. The principle is the model the pickers already use.

Three tamed shapes (everything else follows):
1. **Input + list pickers** (model/effort/memory/rewind/resume sheets, dev-card recent, permission-rules): the **input** is the focused component → ring on the input (the persistent text-entry destination, [feedback_persistent_text_entry]). The list contributes **zero** Tab stops (container *and* rows `tabIndex=-1`). Selection shows on the row; the form's existing Arrow handler moves `selectedIndex` + `scrollToIndex` — net change is mostly the tabIndex flip.
2. **Non-selection surfaces** (read-only sheets `interactive={false}`: help/agents/skills; transcript `pageByEntry`): the container is **one** engine stop via `useFocusable` → ring on the container. **Scroll only** — Arrow/Page scroll, **no row cursor** (no selection ⇒ no cursor). `pageByEntry` Page nav and the cell `Enter`/`Space` → `onSelect` paths are untouched.
3. **Nested in-transcript body-kind blocks** (file/diff/path-list/search-result/todo) — **deferred** to a follow-on (nested list-inside-a-list stops + a selection model they lack). Unregistered, unchanged.

Out of scope: nested blocks; full `listbox`/`option` + `aria-activedescendant` ARIA (the [#step-28] accessibility pass). Selection rendering, `scrollToIndex`, `selectionRequired`, `onSelectionChange` already exist and are reused.

**API — participation declared at the point of usage (DECIDED, diverges from the 15–17 components).** `TugListView` imports **nothing** from the focus engine. Unlike the simpler controls (which take `focusGroup` and call `useFocusable` internally), the list is a heavyweight, scroll-sensitive primitive, so the surface declares participation and hands the list a binding through three **dumb passthrough props**:
- `containerRef?: (el) => void` — the surface's own `useFocusable(...).focusableRef`, composed onto the scroll container (stamps `data-tug-focusable` so the engine resolves it as the stop / key view).
- `containerTabIndex?: number` (default `0`) — `-1` for an input-subordinate list that adds no stop.
- `rowsFocusable?: boolean` (default `true`) — `false` flips cell wrappers to `tabIndex=-1` so the list is one stop, not one-per-row.

The two shapes are then expressed entirely at the call site: **container stop** = surface `useFocusable` → `containerRef={focusableRef} containerTabIndex={0} rowsFocusable={false}` (ring on the container via [P05]); **input-subordinate** = `containerTabIndex={-1} rowsFocusable={false}` (no `containerRef`, no registration). No new keyboard handler in either shape — container-stop is native scroll on a focused container; subordinate's Arrow→selection is the owning input/form's job. Default (no props) is **byte-identical** to today. CSS: `.tug-list-view:not([data-key-view-kbd])` keeps the historical `outline: none`, yielding so the ring paints when the engine makes the container the key view.

**Why call-site, not in-component (the 15–17 pattern):** baking `useFocusable` into `TugListView`'s render subscribes this 2300-line virtualized component to the focus contexts and adds an effect to its delicate before-first-paint scroll-restore sequence — risk for zero benefit on the >90% of lists that aren't focus stops. The call-site model keeps the component dumb and the cost where it's used. (This raises a consistency question for the simpler components — see the open note below.)

**Scope of this step (capability + gallery proof).** The primitive gains the passthrough props and both shapes are proven end-to-end in the gallery. **Real consumer adoption rides surface taming**: the read-only sheets and pickers live inside `TugSheet` (still Radix-`FocusScope`-trapped until [#step-23]); a surface registers its list once the surface itself is engine-managed. Nested body-kind blocks stay a deferred follow-on.

**Open — consistency follow-up (for the user to decide):** the simpler controls ([#step-10]–[#step-17]) take `focusGroup` and call `useFocusable` internally; this step's call-site model is cleaner (no engine import in the component). Decide whether to migrate the simpler controls to the same call-site model for uniformity, or keep the list view as the deliberate exception.

**Tasks:**
- [x] Add three dumb passthrough props to `TugListView` (`containerRef` / `containerTabIndex` / `rowsFocusable`); no focus-engine import. Compose `containerRef` onto the scroll container; rows `-1` when `rowsFocusable={false}`. Default byte-identical to today.
- [x] Gallery proof card (`gallery-list-view-focus`): the card (surface) calls `useFocusable` and hands the binding to a container-stop list and an input-subordinate list.
- [x] Leave real sheet/picker consumers and nested body-kind blocks for their own taming steps (noted above).

**Tests:**
- [x] app-test: container-stop list — Tab lands one stop with the ring on the container; rows `tabIndex=-1`. (`at0121-list-view-container-focus`)
- [x] app-test: input-subordinate list — contributes no Tab stop (container + rows `-1`, no registration); selection on the row. (`at0122-list-view-subordinate-focus`)
- [x] regress: untamed `TugListView` (`at0060-list-view-content-settled`) byte-unchanged. (Note: `at0069-outer-transcript-first-paint` fails `923` on **pristine `main`** independent of this step — a pre-existing transcript scroll-restore issue, unchanged by these dumb props; flagged for separate investigation.)

**Checkpoint:**
- [x] `just app-test` list-view scenarios `VERDICT: PASS` (at0121, at0122, at0060).

**Done-note:** `TugListView` stays focus-engine-agnostic; participation is declared by the surface via `useFocusable` + three passthrough props. Proven in `gallery-list-view-focus`. The earlier in-component attempt was reverted after confirming (a) it offered no benefit for the fragile component and (b) the scroll-restore failure I chased was pre-existing on `main`, not caused by the change.

---

#### Step 19: Tame TugTooltip {#step-19}

**Depends on:** #step-3

**Commit:** `focus(radix): TugTooltip — focus-trigger only, no focus capture`

**References:** [P01] FocusManager, Risk R01, (#affected-inventory)

**Artifacts:**
- Tooltip opens on trigger focus/hover without capturing the key view; no FocusScope to remove (radix-tooltip), just confirm it never steals focus.

**Tasks:**
- [ ] Confirm the tooltip never moves the key view; the trigger keeps its ring/key view from the engine.

**Tests:**
- [ ] app-test: focusing a tooltip trigger shows the tooltip and the trigger's ring; key view stays on the trigger.

**Checkpoint:**
- [ ] `just app-test` tooltip scenario `VERDICT: PASS`.

---

#### Step 20: Tame TugPopover (FocusScope → engine trap) {#step-20}

**Depends on:** #step-3, #step-4

**Commit:** `focus(radix): TugPopover — replace FocusScope with engine focus mode`

**References:** [P01] FocusManager, [P03] traps, Risk R01, (#affected-inventory, #cfrunloop-model)

**Artifacts:**
- Radix `FocusScope` (`onOpenAutoFocus`/`onCloseAutoFocus`) replaced by a pushed focus mode; Tab traps within; key view restored on close.

**Tasks:**
- [ ] Push a focus mode on open, pop on close; engine sets initial focus and restores the opener's key view.

**Tests:**
- [ ] app-test: Tab cycles within the open popover; dismiss restores the opener's key view.

**Checkpoint:**
- [ ] `just app-test` popover scenario `VERDICT: PASS`.

---

#### Step 21: Tame TugContextMenu (+ editor context menu) {#step-21}

**Depends on:** #step-3, #step-4

**Commit:** `focus(radix): TugContextMenu — engine focus mode + chain Escape`

**References:** [P01] FocusManager, [P03] traps, Risk R01, (#affected-inventory, #cfrunloop-model)

**Artifacts:**
- Radix `FocusScope` replaced by a pushed focus mode; Escape close via the chain; key view restored on close.
- `tug-editor-context-menu` (hand-rolled portal + own `keydown`, shares `tug-menu.css`) brought under the same engine focus mode rather than its own ad-hoc handling: push/pop on open/close, arrows local, Escape via the chain, key view restored.

**Tasks:**
- [ ] Push/pop the focus mode; arrows move items locally; Escape dismisses via the chain; restore key view.
- [ ] Route `tug-editor-context-menu` through the same focus mode (drop its ad-hoc `keydown` ownership where the engine now covers it); confirm parity with the Radix context menu.

**Tests:**
- [ ] app-test: Tab/arrows stay within the menu; Escape closes; key view restored.
- [ ] app-test: the editor context menu opens under the engine focus mode — arrows move, Escape closes, key view restored to the editor.

**Checkpoint:**
- [ ] `just app-test` context-menu scenario `VERDICT: PASS` (covers both the Radix and editor context menus).

---

#### Step 22: Tame internal/tug-popup-menu {#step-22}

**Depends on:** #step-3, #step-4

**Commit:** `focus(radix): internal/tug-popup-menu — engine focus mode for the shared menu surface`

**References:** [P01] FocusManager, [P03] traps, Risk R01, (#affected-inventory, #cfrunloop-model)

**Artifacts:**
- The shared dropdown surface (used by the popup button and friends): Radix `FocusScope` replaced by a pushed focus mode; restore on close.

**Tasks:**
- [ ] Push/pop the focus mode; arrows local; Escape via chain; restore key view to the trigger.

**Tests:**
- [ ] app-test: open via a popup button → Tab/arrows trapped; dismiss restores the trigger's key view.

**Checkpoint:**
- [ ] `just app-test` popup-menu scenario `VERDICT: PASS`.

---

#### Step 23: Tame TugSheet (modal trap + restore) {#step-23}

**Depends on:** #step-3, #step-4

**Commit:** `focus(radix): TugSheet — engine modal focus mode + restore`

**References:** [P01] FocusManager, [P03] traps, Risk R01, (#affected-inventory, #cfrunloop-model)

**Artifacts:**
- Radix `react-focus-scope` (`onOpenAutoFocus`) replaced by an engine modal focus mode; initial focus and restore owned by the engine; pane-modal scoping preserved.

**Tasks:**
- [ ] Push a modal focus mode on open; engine sets initial focus; pop and restore on close.

**Tests:**
- [ ] app-test: Tab traps within the sheet; close restores the prior key view; peer panes unaffected.

**Checkpoint:**
- [ ] `just app-test` sheet scenario `VERDICT: PASS`.

---

#### Step 24: Tame TugAlert (modal dialog) {#step-24}

**Depends on:** #step-3, #step-4

**Commit:** `focus(radix): TugAlert — engine modal focus mode`

**References:** [P01] FocusManager, [P03] traps, Risk R01, (#affected-inventory, #cfrunloop-model)

**Artifacts:**
- Radix `alert-dialog` FocusScope replaced by an engine modal focus mode; default-action wiring deferred to [#step-26].

**Tasks:**
- [ ] Push/pop a modal focus mode; engine initial focus + restore; keep alert semantics.

**Tests:**
- [ ] app-test: Tab traps within the alert; close restores the prior key view.

**Checkpoint:**
- [ ] `just app-test` alert scenario `VERDICT: PASS`.

---

#### Step 25: Radix-taming integration checkpoint {#step-25}

**Depends on:** #step-9, #step-10, #step-11, #step-12, #step-13, #step-14, #step-15, #step-16, #step-17, #step-18, #step-19, #step-20, #step-21, #step-22, #step-23, #step-24

**Commit:** `N/A (verification only)`

**References:** [P01] FocusManager, [P03] traps, Risk R01, (#affected-inventory)

**Tasks:**
- [ ] Verify every tamed primitive runs under the engine (no Radix `RovingFocus`/`FocusScope`/guards still driving focus).
- [ ] Re-evaluate `internal/safari-focus-shift.ts`; delete if the engine made it obsolete, or document why it remains.
- [ ] Confirm `internal/tug-label` and `tug-pane-banner` carry no orphaned focus behavior (deferred to [#step-27]/[#step-28]).

**Tests:**
- [ ] Full `just app-test` primitive suite green across all tamed components.

**Checkpoint:**
- [ ] `just app-test` Radix-taming suite `VERDICT: PASS`; `bunx tsc --noEmit` clean; no Radix focus regressions.

---

#### Step 26: Semantic commit keys + scope default/cancel actions {#step-26}

**Depends on:** #step-3, #step-4

**Commit:** `focus(keys): semantic commit keys (Return/Escape/⌘.) → scope default/cancel actions`

**References:** [P12] semantic keys, [P07] default-action (superseded), [P03] traps, [P13] inline dialogs, [Q02] text-context precedence, (#affected-inventory, #cfrunloop-model)

**Artifacts:**
- `DEFAULT_ACTION` + `CANCEL_ACTION` actions; each focus mode (and each non-modal pane's card responder) declares `defaultAction` + `cancelAction` by registering those handlers; a pipeline stage routes Return → default and Escape/⌘. → cancel **via `sendToTarget` to the active scope anchor** (text-context precedence first); deletion of `pushDefaultButton`/`popDefaultButton`/`peekDefaultButton*` and the `defaultButton` prop.

**Tasks:**
- [ ] Add `DEFAULT_ACTION` / `CANCEL_ACTION`; modes (`TugSheet`, `TugAlert`, `TugConfirmPopover`) and non-modal **pane card responders** (`[L09]`: the card, not the pane chrome) declare default/cancel by registering the handlers.
- [ ] **G1 — dispatch origin:** route Return/Escape/⌘. via `sendToTarget(anchorId, …)` where `anchorId` is the active modal mode's anchor (modal) or the originating pane's card responder (non-modal); **never `sendToFirstResponder`**. The key view / event target selects only the originating pane (via its `.tug-pane`, like `peekDefaultButtonInScope`); resolution is at the pane/mode scope, not the leaf responder ([P12], resolves F4 + cross-pane regression).
- [ ] **G2 — cancel ladder:** preserve priority `top focus-mode cancelAction → drag-cancel (card-drag-coordinator's Escape listener, kept outside the mode stack) → originating-pane cancelAction`; confirm the dev-card interrupt (`codeSessionStore.interrupt()`) becomes the pane card's `cancelAction` when no modal mode is active.
- [ ] **G3 — editor Return defer:** migrate `keymap.ts`'s existing `peekDefaultButton` defer to a `default-action` dispatch (origin = editor's pane scope), preserving `returnAction`/`numpadEnterAction`/forced-`Cmd-Enter`. `newline` editors keep Return; `submit`-with-defer editors fall through to scope `default-action`. One mechanism, not a parallel precedence ([Q02]).
- [ ] **G4 — empty cases:** no active scope / no declared action → silent no-op, suppress the beep; unfocused Return resolves against the deck's focused pane (global fallback in gallery/standalone).
- [ ] **G5 — inline dialogs ([P13]):** `PermissionDialog` (`chrome/dev-permission-dialog.tsx`) and `QuestionDialog` (`chrome/dev-question-dialog.tsx`) push a **non-trapped** focus mode while pending and declare `DEFAULT_ACTION` (confirm / Next / submit the highlighted option) + `CANCEL_ACTION` (`popInteractive()`) on it. Because the mode is top-of-stack, Return/Escape/⌘. resolve to the dialog while the prompt entry keeps the key view (no trap, Tab unaffected) — and a pending dialog's default-action takes precedence over the prompt's `submit` via G3. Retires their reliance on the default-button stack + Stage-2 Enter→click.
- [ ] Fold the existing Escape/⌘. → `CANCEL_DIALOG` bindings into `cancel-action` (preserving the G2 ladder); keep the CTA button's blue `control-…-filled-action` as its default-action affordance ([P12]).
- [ ] Delete the default-button stack API + `defaultButton` prop; update `tug-text-editor`/`keymap.ts` submit-Enter defer and `gallery-default-button.tsx`, `dev-question-dialog.tsx`, `dev-permission-dialog.tsx`.

**Tests:**
- [ ] app-test: arrow-navigate a list in a sheet, press Return → the sheet's default action fires (focus need not move to OK); Escape/⌘. cancels; **cross-pane Return in pane A does not fire pane B's default** (G1).
- [ ] app-test: Return in a focused text editor still submits/newlines per its config (G3 precedence holds).
- [ ] app-test: **Escape ladder** — Escape dismisses an open popover first; with a drag in progress Escape cancels the drag (not the card); with neither, Escape fires the pane's cancel/interrupt (G2).
- [ ] app-test (G5): with a `QuestionDialog` / `PermissionDialog` pending and the prompt entry focused, Return confirms/advances the dialog (not a prompt submit) and Escape cancels it (`popInteractive`), with the key view never leaving the prompt.

**Checkpoint:**
- [ ] grep for `pushDefaultButton|peekDefaultButton|defaultButton` returns nothing; grep confirms commit-key dispatch uses `sendToTarget`, not `sendToFirstResponder`; `just app-test` commit-keys scenario `VERDICT: PASS`.

#### Step 27: First-responder + `refuse` audit & reclassification {#step-27}

**Depends on:** #step-1, #step-3

**Commit:** `focus(audit): reclassify first-responder & split data-tug-focus refuse`

**References:** [P10] refuse split, [P01] FocusManager, (#three-axes)

**Artifacts:**
- Every `useResponder`/`makeFirstResponder`/`focusResponder`/`data-tug-focus="refuse"` site reclassified against the three axes; `refuse` split into no-steal-on-click vs focus `skip`.

**Tasks:**
- [ ] Enumerate the 28 `data-tug-focus` sites; assign each (a) chain no-steal-on-click and (b) focus policy independently.
- [ ] Audit `makeFirstResponder`/`focusResponder` calls; confirm none substitute for the engine's key-view promotion.

**Tests:**
- [ ] app-test: a no-steal-on-click control that is also Tab-skipped is reachable by pointer, absent from standard Tab order.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `just app-test` audit scenario `VERDICT: PASS`.

#### Step 28: Accessibility-mode ARIA pass + dual mode toggle {#step-28}

**Depends on:** #step-2, #step-3, #step-27

**Commit:** `a11y(mode): interactive ARIA pass + in-app setting & Swift menu toggle`

**References:** [P08] modes, [P09] interactive-only, [Q03] signal source (deferred), (#modes-policies)

**Artifacts:**
- ARIA roles/states on interactive affordances; `accessibility` mode ignores `skip`; in-app setting UI + Swift host menu item (additive); reserved host→web channel name (unused).

**Tasks:**
- [ ] Assert interactive ARIA roles/states across the affordances enumerated in [#step-27] (AT-ready foundation).
- [ ] In `accessibility` mode, include `skip` focusables in the walk.
- [ ] Add the in-app settings toggle (use existing Tug components) and a Swift menu item wired to the `keyboardAccess` default.

**Tests:**
- [ ] app-test: a `skip` control is unreachable by Tab in `standard`, reachable in `accessibility`.

**Checkpoint:**
- [ ] `just app-test` mode scenario `VERDICT: PASS`; toggle works from both surfaces.

#### Step 29: Integration Checkpoint {#step-29}

**Depends on:** #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-25, #step-26, #step-27, #step-28

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), all [P01]–[P11]

**Tasks:**
- [ ] Verify Tab order, traps, the focus ring (default-seeded on open; ring follows the keyboard-active control; no ring on click), Return/Space activation per the [P12] claim/delegate model, selection vs focus colors, and both modes work together.

**Tests:**
- [ ] Full `just app-test` focus suite green; `bun run audit:tokens pairings` clean; `bunx tsc --noEmit` + `bun test` green.

**Checkpoint:**
- [ ] All success criteria in [#success-criteria] satisfied.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** An app-owned focus engine with a single keyboard key view ringed on keyboard focus, app-authored two-mode Tab navigation with CFRunLoop-style floating-surface traps, a dynamic context-scoped keybinding registry, a single crisp focus-ring primitive (the ring marks the control that owns the commit keys), the accent=selection / action=focus color contract, a retired default-button stack, and an audited first-responder/refuse model — Radix tamed, accessibility mode in-app and AT-ready.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every criterion in [#success-criteria] verified.
- [ ] No per-component focus-ring rule, no default-button stack API, no blue-as-selection token remains (grep).
- [ ] A context-scoped keybinding activates only in context and detaches on unmount; in-context overrides global; static globals still fire (app-test).
- [ ] Return/Escape/⌘. resolve to the active scope's default/cancel action independent of the key view, with editor precedence intact (app-test).
- [ ] Blue = keyboard-active only (focus ring + CTA default-action); UI selection orange; text selection unchanged-blue (audit + app-test).
- [ ] `bunx tsc --noEmit`, `bun test`, `bun run audit:tokens pairings`, and the `just app-test` focus suite are all green.
- [ ] `tuglaws/focus-engine.md` written; `responder-chain.md` / `token-naming.md` updated.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] OS/VoiceOver accessibility-tree integration and auto-engage of `accessibility` mode from a host signal ([Q03]).
- [ ] Keyboard-navigation of non-interactive content (reading cursor) — out of scope per [P09].
- [ ] Per-theme / per-mode focus-ring weight tuning (e.g. a heavier ring in `accessibility` mode) if 1px proves hard to spot on busy surfaces.

| Checkpoint | Verification |
|------------|--------------|
| Tab order is app-authored | app-test asserts visit order independent of DOM order |
| Focus ring on keyboard focus | app-test asserts no ring after a click, one ring after a Tab; ring follows the keyboard-active control |
| Traps work | app-test wrap + restore on a floating surface |
| Selection ≠ focus | app-test selected+focused row carries accent fill + blue ring |
| Default-button retired | grep clean; Enter still confirms the active dialog |
| Two modes | app-test `skip` reachability differs by `data-keyboard-access` |
