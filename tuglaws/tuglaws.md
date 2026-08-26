# Tuglaws

*Invariants for the tugways system. Violating any law requires updating the design first — never silently diverge.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` references within this file. For named patterns the laws imply but don't spell out, see [recipes.md](recipes.md) (`[R#]`).*

---

## Rendering Discipline

### L01. One `root.render()`, at mount, ever. {#l01}

State changes flow through subscribable stores or direct DOM manipulation. Never re-render the root from external code. [D40, D42]

### L02. External state enters React through `useSyncExternalStore` only. {#l02}

No `useState` + manual sync. No `useEffect` copying external values into React state. [D40, D68]

### L03. Use `useLayoutEffect` for registrations that events depend on. {#l03}

Responder nodes, selection boundaries, and any setup that keyboard/pointer handlers require must be complete before events fire. [D41]

### L04. Never measure child DOM inline after triggering child `setState` from a parent effect. {#l04}

The child's DOM is stale until its own commit. Use a child-driven ready callback via `useLayoutEffect`. [D78]

### L05. Never use `requestAnimationFrame` for operations that depend on React state commits. {#l05}

RAF timing relative to React's commit cycle is a browser implementation detail, not a contract. Use the ready-callback pattern (L04). [D79]

---

## State and Mutation Zones

### L24. State is partitioned into three zones: appearance, local data, and structure. {#l24}

Every piece of state belongs to exactly one zone, and the zone determines its mechanism. *Appearance* (visible-only state with no non-rendering consumer): CSS and DOM mutation, never React. *Local data* (component-scoped state that does not coordinate outside the component): `useState` and `useRef`. *Structure* (what components exist, subscriptions to external stores, responder registration, event routing): `useSyncExternalStore`, `useLayoutEffect` at mount, props and composition. L06 enforces the appearance zone; L02 and L07 govern the structure zone's entry points; L08 and L22 govern the boundaries between zones. This law names the architecture those laws collectively produce.

### L06. Ephemeral appearance state goes through CSS and DOM, never React state. {#l06}

State whose only consumer is rendering and whose only purpose is to look a certain way — hover highlights, focus rings, active-press feedback, `data-state` toggles — belongs in the DOM. Class toggles, attribute changes, and style mutations that don't affect React's subtree are free. Use them.

This law does not apply to semantic data that happens to have a visual representation. Data is state that non-rendering code reads and acts on; rendering is a downstream consequence of the data, not the reason it exists. Examples: a form field's current value, the selected item in a list, a card's title, a user's zoom level. Data flows through React's render cycle because that is how controlled components and derived UI work — that is the contract, not an L06 violation.

The test: *does any non-rendering consumer depend on this state?* If yes, it is data and may live in React. If no — if the only thing that reads it is the renderer itself — it is appearance and belongs in the DOM. Get this test wrong in either direction and things break: data pushed into DOM refs becomes invisible to the code that cares about it; ephemeral visual state pushed through React triggers unnecessary re-renders and subtree invalidations. [D01, D03, D84, D13]

### L07. Every action handler must access current state through refs or stable singletons, never stale closures. {#l07}

`useResponder` registers actions once at mount. If a handler reads a value that changes over time, it must go through a ref. [D09, D11]

### L22. When external state drives direct DOM updates, observe the store directly — don't round-trip through React's render cycle. {#l22}

If a store update produces DOM writes (not React state changes), subscribe via the store's observer API in a `useLayoutEffect` and update the DOM in the callback. Do not use `useSyncExternalStore` to pull the value into React and then escape via `useEffect` to write to the DOM — that injects React's scheduling (re-render → paint → effect) between the data change and the DOM update, causing frame delays and stale-closure bugs. `useSyncExternalStore` (L02) is for state that React components *render*. Store observers are for state that drives *direct DOM mutations* (L06).

### L08. Live preview in mutation transactions is appearance-zone only; commit crosses zone boundaries. {#l08}

A *mutation transaction* is the specific UX pattern where the user begins an interaction that *drafts* a change, sees the draft rendered live against the target, and then either commits the draft (persisting it) or cancels it (rolling back). The defining feature is that the draft value is not yet a committed value — it exists only long enough to be previewed, and the user may discard it. Examples: scrubbing a hue onto a mock card, dragging to reposition a draggable element, dragging an opacity slider in a style inspector.

During the draft phase, all preview mutations are CSS/DOM — the draft is not React state because it may never be committed. The commit handler may write to stores or React state; cancel rolls back via DOM. Never mix preview with state changes.

This law does not apply to continuous controls whose every intermediate value *is* a committed value. Such interactions are not mutation transactions: there is no draft-vs-commit distinction, only a stream of atomic commits. Their values flow through React state normally, the same as any other data. Examples: a volume slider, a font-size stepper, a choice group, a color picker used as a setting editor rather than as a preview tool. The phase system (`begin` / `change` / `commit` / `discrete` / `cancel`) enables mutation-tx usage where needed — it does not require it, and the presence of phased dispatches does not by itself turn a value picker into a mutation transaction.

The test: *can the user end the interaction with a result that was never committed?* If yes, it is a mutation transaction and L08 applies — preview belongs in the DOM. If no — if releasing, committing, or disconnecting always leaves the last seen value as the committed value — it is not a mutation transaction and L08 does not apply. [D64, D65]

### L23. Internal implementation operations must never lose, destroy, or cease to apply user-visible state. {#l23}

Selection, focus, scroll position (outer and inner regions), form-control values, and content payloads are user data — the user put them there. A re-lex, re-parse, DOM rebuild, tab switch, pane activation, cross-pane move, app cmd-tab cycle, or cold boot must preserve these invariants. The framework provides two complementary mechanisms, and the right choice depends on whether the live DOM survives the transition:

- **In-session: minimal mutation.** `CardHost` portals into the host pane's DOM and is never remounted across cross-pane moves, tab switches, or pane activation changes. Because the DOM stays up, browser-native state (focused element, selection, scroll positions, native input values) is preserved without any save/restore. See [pane-model.md](pane-model.md) and [lifecycle-delegates.md](lifecycle-delegates.md).
- **Cross-session: the [A9] protocol.** When the DOM does come down — cold boot from disk, tab deactivation (`display: none`), app cmd-tab cycle, card destruction-then-restore — `useComponentStatePreservation` and `useCardStatePreservation` capture user-visible state into a `CardStateBag` at the will-phase save moment and reapply it on restore. See [card-state-model.md](card-state-model.md) for the per-axis contract and [state-preservation.md](state-preservation.md) for the protocol.

"Save and restore" is the right answer when the state genuinely goes away, the wrong answer when it never had to leave. Choosing save/restore where minimal mutation would have worked relies on a captured snapshot that may be stale; choosing minimal mutation where the DOM is being torn down loses user state outright. Pick the mechanism that matches the transition class. Minimal mutation depends on stable React-reconciliation identity through the transition — see [L26]. [D49, D50]

### L26. Mount identity must be stable across logical transitions. {#l26}

When a UI element represents the same logical entity before and after a state transition, all three React-reconciliation identity inputs — **key**, **component type**, and **renderer reference** — must be byte-identical across the transition. Any difference in any of the three triggers an unmount/remount that destroys scroll position, focus, selection, in-flight animations, observable subscriptions, and every other piece of DOM- or instance-resident state the wrapper held. The failure mode is invisible from a code read: nothing *looks* like a teardown, because the source on either side of the transition describes the same visual.

The three identity inputs, in the order they bite:

- **Key.** The `key` prop reconciled in list rendering. Derive it from a stable identifier that is minted *before the transition class is known* and survives unchanged through it (a `turnKey` that lives across both the in-flight phase and the committed phase, for example) — not from a value that encodes the *current* phase (`"streaming-…"` vs `"committed-…"`).
- **Component type.** The function or class reference React reconciles against. Don't split "before" and "after" into two components and swap which one the parent renders; write one component that branches internally on phase. Two components in the render tree are two component types, even when their inner JSX is identical.
- **Renderer reference.** When a parent dispatches by key into a renderer map (`cellRenderers[kind]`, `componentsByVariant[v]`, etc.), distinct lambda identities count as distinct component types under reconciliation — exactly as if the source had named two components. A single `useCallback`-stable reference shared by every kind that should reconcile as the same element is the only correct shape. Distinct lambdas defined inline in JSX, or two arrow functions registered against two keys in a `Record<string, ...>`, are the common traps.

Any two of the three may be stabilized in isolation and the third will still trigger a remount. Audit all three together, or not at all.

The test: *does the user perceive this as the same thing across the transition?* If yes — the row is logically continuous, even though its content evolved — none of the three inputs may change. If no — a new entity has appeared and the old one is gone — a remount is correct.

This law is the React-reconciliation complement to [L23]. L23 governs what to do when teardown is unavoidable (capture and replay). L26 says: when the entity is logically continuous, don't tear down in the first place — keep React's identity inputs stable and the browser and React preserve everything attached to that mount for free, without any save/restore code, capture window, or restore-paint ordering to get wrong. Preserved mount identity is upstream of preserved state. [D49]

---

## Lifecycle & Resource Ownership

### L27. Every acquisition returns its release; the shorter-lived party calls it on teardown. {#l27}

A *resource* is anything whose acquisition wires one object's lifetime into another's: a feed callback registered on the long-lived `TugConnection`, an event listener, a timer or reconnect/backoff timeout, an observer, a `requestAnimationFrame` loop, a store subscription, a tugcast/WebSocket handle, an `AbortController`. Acquiring one is a debt. The debt is paid by releasing it, and the code that acquired it owns the debt.

No registration API may return `void`. Registration returns an unregister closure — the shape `onDisconnectState` and `useSyncExternalStore`'s `subscribe` already establish. The party whose lifetime is **shorter than the resource owner's** captures that closure and invokes it in its `dispose()` / cleanup path. A per-card store that subscribes to the app-lifetime connection and outlives its own `dispose()` is, by definition, a leak.

**Every leak is a bug — plain and simple, true now and true forever.** There is no "acceptable" number of leaked callbacks and no "future improvement" deferral for a leak; a comment claiming either is wrong and must be deleted, not honored.

**Inert is not released.** A `_disposed` flag (or any guard) that makes a stale callback early-return stops it from *doing* anything, but the callback — and everything its closure captures — is still wired in and still retained. Guarding a dead registration is belt-and-suspenders on top of disposal, never a substitute for it.

**Fix the class, not the instance.** When you find one caller leaking a given registration API, audit *every* caller of that API and fix the whole pattern in one pass; a leak found is a leak class found.

The test: *when this object is disposed, is every lifetime it wired into something longer-lived now unwired?* Walk each acquisition — listener, timer, subscription, observer, frame callback — and confirm a matching release runs on teardown. If any acquisition has no releasing counterpart, it leaks. [D109]

### L28. A control acts on a lifecycle by subscribing to its published state, never by reaching into it. {#l28}

A *lifecycle* — the deck's card lifecycle, a prompt entry's route, the Dev session's turn — is a **source**: it owns its timing and publishes its state as one derived projection. Everything that cares is a **delegate**: it subscribes to that projection and supplies its own component-specific response. A control must never reach *forward* into a live lifecycle to drive it, and must never re-derive the lifecycle's state from raw signals next to the source's own derivation — either fork is the coupling this law exists to forbid.

Concretely, for the turn lifecycle: `CodeSessionStore`'s phase machine is the source; `deriveLifecycleSnapshot` (→ `submitButtonMode`) and `canSubmit` are its published faces ([turn-lifecycle.md](turn-lifecycle.md)). The Z5 submit button, the Z4B Mode / Model / Effort chips, the Permission Mode menu, and the ⌃⌥⌘P / slash entry points are all delegates of that one projection — each disables or declines against the *same* `canSubmit`, so they cannot disagree about whether a turn is live. A setting that instead sent its change straight into the running turn (a live control-request, a process respawn) is a source→delegate inversion: it couples chrome to the turn and races it. The fix is never a lock bolted on top; it is to restore the direction — the setter's response to a live turn is *decline, and let the published idle state re-enable me* ([L07] reads that state live; [L02] renders it). [D01, D13]

---

## Component Architecture

### L19. Every component follows the component authoring guide. {#l19}

File structure, module docstring, props interface, `data-slot`, `@tug-pairings`, `@tug-renders-on`, and CSS organization are not suggestions — they are the contract. A component that deviates from [component-authoring.md](component-authoring.md) is incomplete. [D05, D06]

### L09. TugPane composes chrome and owns geometry; Cards never set their own position, size, or z-order. {#l09}

TugPane handles drag, resize, stacking, title bar, tabs, accessory, and content region. Cards supply content identity only. See [pane-model.md](pane-model.md) for the full Deck → Pane → Card model, and [lifecycle-delegates.md](lifecycle-delegates.md) for the deck-level `TugCardDelegate` event pipe through which Pane geometry events (`cardWillMove`, `cardDidMove`, `cardWillResize`, `cardDidResize`) reach cards. [D15, D31, L25]

### L10. One responsibility per layer. {#l10}

DeckManager owns the layout tree. DeckCanvas maps state to Panes. TugPane owns geometry and chrome. CardHost bridges per-card context to the registered content factory. Card content owns domain logic. Don't reach across layers. [D05, D15]

### L11. Controls emit actions; responders own state that actions operate on. {#l11}

A *control* translates a user gesture into a typed intent and dispatches it into the chain — the state that handlers will modify lives elsewhere (a parent, a store, a separate component). A *responder* owns persistent semantic state that actions mutate over time and registers handlers for the actions that mutate it. Responders have a stable identity in the chain so the first-responder promotion mechanism can address them.

The distinction is conceptual, not categorical: it is about *who owns the state an action changes*, not about what kind of widget the component happens to be. The test is, "does this component own the state that this action is going to mutate?" If no, the component is an emitter — it can dispatch the action but another node owns the state, so another node is the responder. If yes, the component must register as a responder because it is the only code that knows how to perform the action on its own state.

Most interactive widgets are controls: their state lives in a parent that passes it back in via props. When such a widget interacts with the user, it dispatches an action whose handler — somewhere up the chain — updates the parent's state, which flows back down. The widget itself holds no authoritative state. Push buttons, sliders, checkboxes, switches, radio groups, choice groups, tab bars, accordions, and popup menus are all examples of this shape.

A component that owns its own state is a responder for the actions that mutate that state. A component that owns a caret, a selection, an undo stack, and a content document is a responder for `cut` / `copy` / `paste` / `selectAll` / `undo` / `redo` — those actions operate directly on state that lives inside the component and nowhere else. A component that owns **a deck pane** (title bar, tabs, close state) and its cards is a responder for `close` / `find` / `toggleMenu`. A component that owns a layout tree is a responder for `cycleCard` / `resetLayout`. Text editors, cards, and canvases are examples of this shape.

A single component may be both an emitter and a responder for the same action. A text editor with a context menu dispatches `cut` when the user clicks the menu item; the chain's innermost-first walk routes that dispatch right back to the editor, which handles it on its own selection. Components that own state close the loop on themselves. [D08, D61, D62, D63]

The full chain mechanism — `ActionEvent`, the dispatch walk, first-responder promotion, the four dispatch shapes, `observeDispatch`, the keyboard pipeline, and the registration hooks — is documented in [responder-chain.md](responder-chain.md). Read that document before writing a component that participates in the chain.

### L30. Every user-invocable command is a registry entry, and every emitter goes through the two funnels. {#l30}

A *command* is anything a user can invoke by name: a menu item, a chord, a button, a context-menu verb, a slash bridge. Each one is exactly one entry in `command-registry.ts` — its title, its `routing`, its `menuItemId`, its validity, its state, its default `bindings` — and it is invoked through **funnel #1**, `dispatchCommand(id, payload?)`, and bound through **funnel #2**, `keymapRegistry`. No code path may bypass either: not a call site that dispatches a chain action directly when that action names a command, not a component that matches a chord itself, not a UI surface that authors a shortcut string instead of calling `commandShortcut(id)`, not a host-side tier that decides an item's enablement next to the entry that already answers for it.

The doors are plural and the definition is singular. A menu item and a chord are two ways into one row, and the row says once how to open it — so `routing` is a data field rather than a call-site choice, and a rebind, a rename, a new door, or a validity change is one edit that every surface sees. Bypass any funnel and the command becomes invisible in exactly the places built to make it visible: it cannot be shown in the keymap pane, it cannot be rebound, its chord cannot be shadow-analyzed against the native menu layer that resolves *before* the web view sees a keydown, and its menu item's enablement acquires a second opinion that will drift from the first.

The escapes are declared, never implied. Traffic that is not a user intent — tugcast data frames, form-control currency, substrate text-editing bindings, context-menu verbs over a sampled target — is enumerated in `ACTIONS_OUTSIDE_THE_TABLE`, and a command that legitimately has no door yet says `internal: true` with a comment naming what blocks it. The table's lints fail on anything in neither set, so "absent from the table" is never a silent omission.

The test: *can a user invoke this by name?* If yes, it is a command and it belongs in the table with a door and a funnel. If no — it is something a control tells its responder, or something the protocol tells the app — it is currency, and it is declared outside the table. The authoring contract, the field-by-field entry shape, the four-layer chord resolution order, and the enforcement lints are in [commands.md](commands.md); *which* chord an entry gets is derived from the modifier algebra in [chord-tiers.md](chord-tiers.md), so a chord grant states its tier alongside its `menuEligible`/`scope` choice. [L11, D01, D126]

### L12. Selection stays inside card boundaries. {#l12}

`SelectionGuard` clamps selection on `selectionchange`. Every card registers its content area as a selection boundary. [D34, D35, D36, D37, D38]

### L25. Deck → Pane → Card is the canonical canvas hierarchy. {#l25}

A Deck holds Panes; a Pane holds Cards; a Card holds one content component. Position, size, z-order, drag, resize, and chrome are Pane responsibilities; content identity (`componentId`, `title`, `state`) is a Card responsibility. Tabs are a UI affordance for multi-card Panes, not a separate data concept. `TugPane*` names components that render Pane chrome; `Card*` (no `Tug` prefix) names Card-model types and hooks; `--tugx-pane-*` names Pane-chrome tokens; `data-pane-id` and `data-card-id` mark the DOM. Full specification, wire contract, and rename history in [pane-model.md](pane-model.md). [L09, L10, L11, L12]

---

## Motion

### L13. CSS handles declarative motion. TugAnimator handles programmatic motion. `requestAnimationFrame` is not for animation. {#l13}

CSS (`transition`, `@keyframes`) owns hover/focus states, Radix `data-state` enter/exit, and continuous animations. TugAnimator owns animations needing completion promises, cancellation, multi-element coordination, or physics curves. RAF is for gesture-driven frame loops (drag, resize, autoscroll) that read input and write DOM each frame. [D76]

### L14. Radix Presence owns enter/exit DOM lifecycle; TugAnimator does not cross that boundary. {#l14}

Radix delays DOM removal by listening for `animationend`, which WAAPI does not fire. All Radix-managed enter/exit uses CSS `@keyframes` via `tw-animate-css` + `data-state`. TugAnimator is for animations where code controls DOM insertion and removal. [D76]

---

## Token System

### L15. Interactive controls use token-driven control states; content areas stay static. {#l15}

Every interactive control uses the seven-slot token convention: `--<namespace>-<plane>-control-<constituent>-<emphasis>-<role>-<state>`. States lighten progressively (rest darkest, hover, active lightest). Content areas have no state transitions. No box-shadow elevation, no translateY press-down, no gradients — color transitions provide all interaction feedback. [D85, D70, D82]

### L16. Every color-setting rule declares its rendering surface. {#l16}

If a CSS rule sets `color`, `fill`, or `border-color` without setting `background-color` in the same rule, it must include a `@tug-renders-on` annotation naming its surface token. Rules that set both foreground and background are self-documenting. `audit-tokens lint` enforces this. [D81, D83]

### L17. Component alias tokens (`--tugx-*`) resolve to `--tug7-*` in one hop. {#l17}

No alias-to-alias chains. Every component alias must point directly to its `--tug7-*` target. `audit-tokens lint` flags multi-hop chains. [D71]

### L18. Use element/surface as the canonical vocabulary. {#l18}

Tokens producing visible marks (text, icons, borders) are *elements* (`--tug7-element-*`). Tokens defining the field behind them are *surfaces* (`--tug7-surface-*`). Contrast pairing means an element token rendered on a surface token. [D71, D82]

---

## Composition

### L20. Each component owns tokens scoped to its own component slot; composed children keep theirs. {#l20}

When component A composes component B, A's CSS references only A-scoped tokens (e.g., `radio` for TugRadioGroup) and B's CSS references only B-scoped tokens (e.g., `control` for TugButton). A never overrides, aliases, or references B's tokens. B's appearance remains independently tunable per theme. The seven-slot `component` slot is the ownership boundary. [L15, L18, L19]

---

## Paths

### L29. Every persisted or compared path routes through the canonicalization gateway — never a raw path, never bare `canonicalize`. {#l29}

A filesystem path has many spellings for one directory: symlinks (`/u` → `/System/Volumes/Data/Users/…`), macOS `synthetic.conf` firmlinks, the APFS data-volume firmlink (`/System/Volumes/Data/Users/…` ↔ `/Users/…`), and Linux bind mounts. Any path used as a **persisted key** (a ledger `project_dir`, a store key, a defaults domain), a **cross-path comparison** (does this event belong to this project? is this the same checkout?), or a **lookup argument** MUST first pass through the codebase's canonicalization gateway — `CanonicalPath::from_raw` (persisted keys / comparisons), in `tugcast/src/path_resolver.rs`, or `resolve_to_claude_form` (the standalone string form Claude's on-disk layout agrees on), in `tugcore::pathform` (re-exported by `tugcast::path_resolver`, and sited below `tugcast` so every crate that keys on a path — the server that writes a row, the dash library that reads it back — reaches the same function). A path that has not is a *raw* path and may be used only for the immediate OS call that produced it, never stored or matched.

Two spellings of the same directory that skip the gateway silently fail to match, and the failure is invisible until data written under one spelling is read under the other: attribution rows keyed on `/Users/…/tugtool` go dark when the card composes under `/u/src/tugtool`; picker sessions vanish; a trash move no-ops. **Never** reach for bare `std::fs::canonicalize` on a project path — on macOS `realpath(3)` expands the data-volume firmlink to a `/System/Volumes/Data/…` form Claude never writes, which is the same bug wearing a different hat. This law is absolute because the failure mode is silent, recurring, and infuriating: if you touch a path that will outlive its syscall, the gateway is not optional. [D120]

---

## Refusals and Failure Surfaces

### L31. A user gesture produces either the act or a visible reason — never silence. {#l31}

Every control that can refuse must route its refusal to a surface the user is already looking at. A tooltip on the control is the *before* affordance and does not discharge this obligation: by the time someone has pressed, they are looking at the result, not the hover. The refusal reaches a bulletin, a notice, an inline message — something that appears without being hunted for — and it says why, in the wording the code already computed. Where a gate function produces a reason string, delivering that string to the user is mandatory, not optional; a reason computed and discarded is worse than one never computed, because it proves the information was in hand.

Three shapes are violations, and they are violations even when the surrounding code is otherwise correct. A **bare `return` on a gesture path**: the gate refuses, the function exits, nothing is said and nothing happens. A **swallowed internal fault**: a missing store, a null connection, an absent dependency treated as a no-op, which tells the user they mistyped something when in fact the app is broken and they are stranded with no remediation. A **callback parked on an event that may never fire**: the gesture is accepted, deferred to a beat that is not guaranteed to arrive, and lost with no error, no timeout, and no trace. Deferred work carries a deadline; when the deadline passes the work runs anyway, or the failure speaks.

A comment blessing any of these is a defect in the comment as much as in the code, because it converts an oversight into a decision and tells the next reader not to look. Types are the structural half of the enforcement: an action that can refuse returns its verdict rather than `void`, so a caller cannot ignore the refusal without the compiler seeing it, and the control's own surfacing means no caller has to remember.

This law was written from an incident, and the incident is its grounding: a landing button that did nothing when pressed was unreproducible for days purely because its failure mode was silence — two silent `return`s with no error, no log line, and no rendered state, so every investigation had nothing to read. Silence is not a neutral outcome; it is the one outcome that cannot be diagnosed. [L22, L28]

---

## Licensing

### L21. Third-party code and patterns require license compliance before use. {#l21}

When adopting code, algorithms, or substantial implementation patterns from external libraries: (1) verify the license is permissive (MIT, Apache-2.0, BSD, ISC); (2) preserve the required copyright notice in `THIRD_PARTY_NOTICES.md` at the repository root; (3) add a comment in the consuming source file referencing the notice entry. Studying public code for ideas requires no attribution. Copying or closely adapting specific implementations does. When in doubt, attribute. Never use code under GPL, LGPL, SSPL, or other copyleft licenses without explicit approval.
