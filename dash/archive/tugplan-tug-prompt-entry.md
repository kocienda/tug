<!-- tugplan-skeleton v2 -->

## T3.4.b — TugPromptEntry (composition component) {#tug-prompt-entry}

**Purpose:** Land `TugPromptEntry` in tugdeck — a compound composition component that stacks an existing `TugPromptInput` over a bottom toolbar (route indicator + submit/stop button), driven entirely by a `CodeSessionStore` snapshot. After this phase, `TugPromptEntry` is the single composition surface the Tide card (T3.4.c) drops into the bottom half of its split pane to turn a raw `CodeSessionStore` into a usable input surface with visible turn-state affordances.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-15 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

[T3.4.a](./tugplan-code-session-store.md) landed `CodeSessionStore` as a pure TypeScript L02 store owning Claude Code turn state — `idle → submitting → awaiting_first_token → streaming → tool_work → awaiting_approval → errored → idle` transitions, append-only transcript, in-flight streaming `PropertyStore` at `inflight.assistant` / `inflight.thinking` / `inflight.tools`, and the five-member `lastError.cause` union (closed out by [T3.4.a.1](./tide.md#t3-4-a-code-session-store)). The store exposes `send(text, atoms)`, `interrupt()`, `respondApproval(...)`, `respondQuestion(...)`, `dispose()`, and a `CodeSessionSnapshot` shaped for consumers. It is fully tested (101 store-level tests, 10 CONTROL-error tests) against the `v2.1.105/` golden catalog plus synthetic events. [P13](./tide.md#p13-spawn-cap) landed the supervisor-side spawn cap + rate limit as cheap insurance before real UI load arrives. The store is ready; there is nothing to render it.

What's still missing is the composition surface. Today, `tug-prompt-input` is a raw text editor with route-prefix detection and an imperative handle — it has no notion of turn state, no submit button of its own, no queue indicator, no interrupt affordance. A caller wanting to render "an entry box driven by a `CodeSessionStore`" has to hand-wire those concerns every time. T3.4.b fills that gap by shipping `TugPromptEntry` as a single compound component at `tugdeck/src/components/tugways/tug-prompt-entry.tsx` + `.css`, with its own `@tug-pairings` table reusing existing base-tier tokens per [D11], and a thin props interface that takes the stores it needs and renders everything else from snapshot data. After this phase, [T3.4.c](./tide.md#t3-4-c-tide-card) can compose `TugPromptEntry` + `TugMarkdownView` inside a `TugSplitPane` and register the result as the Tide card — with no new state management, no new action handlers, and no conditional rendering paths the composition component does not already own.

There is one meaningful deviation from the T3.4.b description in [tide.md §T3.4.b](./tide.md#t3-4-b-prompt-entry). That section — citing [D-T3-04](./tide.md#d-t3-04) — states that the first consumer of `tug-prompt-entry` is the functional Tide card, not a gallery card, and explicitly prohibits adding a gallery card for the component. **D-T3-04 is hereby declared moot for this plan.** The stated rationale ("mock turn-state environment differs from live wire protocol — tests must match user reality") is fair for unit tests, but the mock `TugConnection` infrastructure already exists in `tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts` (battle-tested across 111 T3.4.a tests and used exclusively to drive the store against **real** golden wire frames). Building a gallery card on top of that mock does not introduce a divergent environment — it reuses the same frame shapes the tests use. The absence of a gallery card, on the other hand, makes theme audits, visual regressions, and design iteration impossible without spinning up a full live session against a running tugcast + claude subprocess. The cost of building one card is an afternoon; the cost of *not* building one echoes through every visual tuning cycle from here through T3.4.d. T3.4.b ships **two** gallery cards:

1. **`gallery-prompt-entry.tsx`** — the component in its `idle` state with an empty `MockTugConnection`-backed `CodeSessionStore`. This is the pristine "rest state" card that theme audits (`audit:tokens lint`) and visual reviews compare across themes. No debug chrome.

2. **`gallery-prompt-entry-sandbox.tsx`** — an interactive playground that wraps the same component in a debug panel with buttons to fire mock `CODE_OUTPUT` / `SESSION_STATE` / `CONTROL` frames through the underlying `MockTugConnection`, walking the component through every phase the store can surface (submitting, awaiting_first_token, streaming, tool_work, awaiting_approval, errored, queue non-empty, etc.). This is where a component author verifies that the CSS selectors work for every `data-phase` + `data-empty` + `data-queued` combination before the Tide card lands.

The two-card split is deliberate: card 1 is the measurable artifact for theme audits, card 2 is the developer tool for verifying visual behavior. Conflating them would give the theme audit a card cluttered with debug buttons, and give the developer a view too minimal to diagnose issues. The plan treats card 2 as a dev-only sandbox that imports from `testing/mock-feed-store.ts` — a pragmatic tradeoff given that gallery code is already bundled only through a dev-surfaced card registry.

A second roadmap override is worth flagging loudly. [tide.md §T3.4.b line 2615](./tide.md#t3-4-b-prompt-entry) specifies that the submit button's label ("Send" vs. "Stop") "sits in `::before` content from a token" — i.e., the label is driven by a CSS custom property on a pseudo-element, not by React-rendered child content. **That pattern is structurally incompatible with [L20]'s no-descendant-restyling rule**, because the `::before` pseudo-element belongs to the composed `TugPushButton`, and the only way for the entry's parent CSS to set its `content` property is via a descendant selector (`.tug-prompt-entry .tug-push-button::before { content: var(...) }`). The plan rejects that path and lands [D03] in its place: the submit label is rendered as React child content (`{snap.canInterrupt ? "Stop" : "Send"}`) directly from the snapshot, honoring [L06]'s explicit "data, not appearance" test — the user reads the label to know what the button will do, so it is semantic data and belongs in React's render cycle. See [D03] for the full rationale. This is the second deliberate override of tide.md §T3.4.b in this plan; future readers should not treat the `::before`-content hint as live guidance.

The forward-looking concern is T3.4.c. This plan deliberately over-specifies the component's props, delegate, and responder surface so T3.4.c is purely "construct the stores, mount the composition, add a split pane." Concretely: every service the component needs is a prop (not a context read, not a module singleton the component reaches for), every imperative method the Tide card will need for keyboard shortcuts goes on the delegate ref now (`focus()`, `setRoute(char)`, not "focus forwarded through the input's ref"), and the responder registration uses a card-supplied `id` prop so the Tide card owns chain identity. T3.4.c's work then reduces to composition, not interface re-discovery.

#### Strategy {#strategy}

- **Component is a compound composition per [L20]; reuses existing base-tier tokens — no new component slot.** `TugPromptEntry` follows the same pattern as `tug-prompt-input.css`: it does not mint a new component-slot token family. Instead, it consumes existing `--tug7-*-global-*`, `--tug7-*-field-*`, and `--tug7-*-badge-*` tokens for the chrome it renders directly (container surface, divider between input and toolbar, toolbar row background, queue badge, errored ring). The composed children — `TugPromptInput`, `TugChoiceGroup`, `TugPushButton` — keep their own token references. The entry's CSS never uses descendant selectors like `.tug-prompt-entry .tug-push-button::before` to reach into composed children; all visual variation comes from the entry's own root data attributes. Per [L20], this satisfies "A never overrides, aliases, or references B's tokens" because the entry references only tokens B (the composed children) does not own — the `global` / `field` / `badge` base-tier tokens the entry consumes are shared infrastructure. No new tokens land in `brio.css` or `harmony.css`; token authoring is **not** a separate commit — the styling lands inline with Steps 2 and 5. See [D11].
- **Snapshot drives appearance via `data-*` attributes on the root.** The component subscribes to `codeSessionStore` via `useSyncExternalStore` exactly once. Every visual variation whose only consumer is CSS — submit-button role color, disabled state, queue badge visibility, errored ring, phase-sensitive styling — is written to `data-*` attributes on the root element during render, mapped to CSS selectors per [L15]. Snapshot `phase` → `data-phase`; `canInterrupt` → `data-can-interrupt`; `queuedSends > 0` → `data-queued` (presence); `lastError !== null` → `data-errored`. These attributes are React-rendered from the snapshot and only CSS reads them — that is the L06-sanctioned "data flows through React; rendering is a downstream consequence" contract.
- **Route value lives in React state — it is data, not appearance.** The currently-selected route (`>`, `$`, `:`) is the user's semantic choice of backend (Claude Code, shell, surface commands). Per [L06]'s explicit example list ("a form field's current value, the selected item in a list"), the route is data and flows through React's render cycle normally via a single `useState<string>`. The prior revision of this plan attempted to hold the route in a direct DOM `data-route` attribute on the indicator — that approach is structurally incompatible with `TugChoiceGroup`, which is a controlled component deriving its pill position from its `value` prop via its own `useLayoutEffect` (see `tug-choice-group.tsx` lines 77–160). Writing `data-route` on the indicator's root element would set an attribute nothing reads, and the pill would stay stuck on the initial route. A `useState<string>` passed as `value={route}` to `<TugChoiceGroup>` is the correct and only working pattern for a controlled component. This is NOT an [L06] violation — L06 explicitly sanctions "controlled components" as the data-through-React shape.
- **`data-empty` is the only direct-DOM derived attribute.** Input emptiness (`promptInputRef.current.isEmpty()`) is observed via the input's existing `onChange` callback prop and written to the root element's `data-empty` attribute via a direct DOM ref. `data-empty` has a single consumer — CSS rules that disable the submit button when the input is empty — so per [L06] it is pure appearance and belongs in the DOM. No React state, no polling, no imperative subscription on the editor.
- **Submit label is data, rendered as React child content.** Per [L06]'s "does any non-rendering consumer depend on this state?" test, the button label ("Send" vs. "Stop") is semantic — the user reads it to decide whether clicking will send a message or interrupt an ongoing turn. It is rendered as child content of `TugPushButton` directly from the snapshot: `{snap.canInterrupt ? "Stop" : "Send"}`. This deliberately overrides [tide.md §T3.4.b line 2615](./tide.md#t3-4-b-prompt-entry), which specifies `::before` content driven from a token — that pattern would require a descendant selector reaching into `TugPushButton`'s pseudo-element, a direct [L20] violation. See [D03].
- **Route indicator bidirectionality goes through the responder chain + React state.** Per [D-T3-01], the route indicator and the input are bidirectionally synced. Input → indicator: `TugPromptInput`'s existing `onRouteChange(route)` prop fires when route prefix detection triggers; the entry's callback updates the `route` React state, and the indicator's next render receives the new `value` and animates the pill via its own `useLayoutEffect`. Indicator → input: `TugChoiceGroup` already dispatches `TUG_ACTIONS.SELECT_VALUE` with a `senderId`; the entry registers as a responder for `select-value`, narrows on the route-indicator's `sender`, updates the `route` React state (so the indicator re-renders with the new value), and calls the new imperative delegate method `setRoute(char)` on the prompt input (so the editor's leading atom reflects the new route). The two paths converge on a single source of truth — the `route` state variable — with no loop because the second write is a no-op when it matches what React already holds.
- **Submit and interrupt flow through the chain too.** The submit button dispatches `TUG_ACTIONS.SUBMIT` via `useControlDispatch()`. The entry's responder handler inspects `snap.canInterrupt` and either calls `codeSessionStore.send(...)` or `codeSessionStore.interrupt()`. This means the Tide card (T3.4.c) can register a global keyboard shortcut (Cmd-Return) that dispatches `submit` to the first responder — and the same handler runs. No callback props; no parallel "click handler" vs. "keyboard handler" implementations.
- **New imperative method: `setRoute(char)` via a widened delegate.** The existing input's imperative handle is typed `TugTextInputDelegate` (defined in `tugdeck/src/lib/tug-text-engine.ts`), a UITextInput-inspired contract exposing low-level engine primitives (`clear`, `insertText`, `selectAll`, paste/delete variants, undo/redo, etc.). `setRoute(char)` is a composition-layer concept that does not belong on that primitive contract. T3.4.b defines a narrower **`TugPromptInputDelegate extends TugTextInputDelegate`** in `tug-prompt-input.tsx` itself, adds `setRoute(char: string): void` to the widened interface, and changes the input's `forwardRef` to expose the widened type. The implementation is `clear()` + `insertText(char)` inside the existing `useImperativeHandle` block — the body calls into engine primitives the delegate already owns, but the type-level extension keeps `TugTextInputDelegate` free of composition-layer concepts. Documented in the input's props JSDoc, unit-tested in its own vitest file before `TugPromptEntry` depends on it. No changes to `tug-text-engine.ts`.
- **Reuse existing `onChange` — do not add `onInputChange`.** `TugPromptInput` already exports `onChange?: () => void` in `TugPromptInputProps` with JSDoc "Called when content changes (typing, atom insertion, deletion, undo)." — wired through the engine's `onChangeRef` path. `TugPromptEntry` consumes this existing prop for the `data-empty` update; no new callback prop is added to the input.
- **Two-card gallery + component tests.** The gallery cards establish visual ground truth; the component's own vitest suite (`__tests__/tug-prompt-entry.test.tsx`) asserts behavior — responder registration, action dispatch, snapshot→data-attribute mapping, delegate forwarding, queue badge presence. Visual regression is enforced by the theme audit (`bun run audit:tokens lint`) on the pristine card; behavior regression is enforced by vitest on the component. Tests do not render the sandbox card.
- **`/` dispatch hook is deferred.** [tide.md §T3.4.b](./tide.md#t3-4-b-prompt-entry) mentions a pre-submit interception for local `:`-surface commands (e.g., `:help`). T3.4.b ships the extension point as an optional `localCommandHandler?: (route, atoms) => boolean | Promise<boolean>` prop — when the handler returns `true`, submission is suppressed and the input is cleared. When the prop is absent or the handler returns `false`, submission proceeds normally. The local-command registry itself is T10's problem; this plan only wires the seam so T3.4.c doesn't need to retrofit it.
- **Warnings are errors on every step.** `bun run check` + `bun run test` + `bun run audit:tokens lint` all pass on every commit. No `any`, no `@ts-expect-error`, no descendant-selector reach-ins, no hardcoded colors, no new IndexedDB dependencies, no `react` imports that bypass `useSyncExternalStore` for store state.

#### Success Criteria (Measurable) {#success-criteria}

- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` and `.css` exist and export `TugPromptEntry` + `TugPromptEntryProps` + a `TugPromptEntryDelegate` interface. (verification: files present; `tsc --noEmit` clean)
- Opening `gallery-prompt-entry` in the running tugdeck shows the component mounted with an empty `MockTugConnection`-backed `CodeSessionStore` in its `idle` state. Submit button shows "Send", disabled (input is empty), and no queue badge is visible. (verification: manual in dev build; also asserted in the component's vitest rendering test)
- Opening `gallery-prompt-entry-sandbox` in the running tugdeck shows the component plus a debug panel with buttons for `session_init`, `assistant_text (partial)`, `assistant_text (partial)`, `turn_complete(success)`, `turn_complete(error)`, `control_request_forward(approval)`, `control_request_forward(question)`, `session_state_errored`, `transport_close`. Clicking each button advances the underlying mock and the entry's visual state updates accordingly. (verification: manual in dev build)
- `bun run audit:tokens lint` exits 0. Every CSS rule setting `color` / `border-color` / `fill` without a same-rule `background-color` carries a `@tug-renders-on` annotation. (verification: lint in Step 7)
- `rg '@tug-pairings' tugdeck/src/components/tugways/tug-prompt-entry.css` returns a single match, and the block contains both the compact format and the expanded table per [component-authoring.md §@tug-pairings](../tuglaws/component-authoring.md). (verification: grep in Step 7)
- `rg 'useReducer' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches. (verification: grep in Step 7)
- `rg -c 'useState' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns exactly `1` — the sole `useState` is for the route value, per [D04]. No other React state in the component. (verification: grep in Step 7)
- `rg '\.tug-prompt-entry \.tug-(prompt-input|choice-group|push-button)' tugdeck/src/components/tugways/tug-prompt-entry.css` returns zero matches — no descendant restyling of composed children per [L20]. (verification: grep in Step 7)
- Vitest `__tests__/tug-prompt-entry.test.tsx` asserts:
  - Renders with a mock `CodeSessionStore`; root element has `data-slot="tug-prompt-entry"` and `data-responder-id="<cardId>"`. (verification: test)
  - Snapshot `phase: "idle"` + empty input → `data-phase="idle"`, `data-empty="true"`, `data-can-interrupt="false"`, no `data-queued`. (verification: test)
  - Typing a character clears `data-empty`; the button's disabled state flips. (verification: test)
  - Typing ">" in an empty input triggers `onRouteChange(">")`; the route indicator's DOM `data-route` attribute reflects ">". (verification: test)
  - Dispatching `TUG_ACTIONS.SELECT_VALUE` with `sender === routeIndicatorSenderId` and `value: "$"` calls `TugPromptInput.setRoute("$")` on the delegate; the input's first character is the `$` route atom. (verification: test)
  - Dispatching `TUG_ACTIONS.SUBMIT` while `snap.canInterrupt === false` calls `codeSessionStore.send(text, atoms)`. (verification: test)
  - Dispatching `TUG_ACTIONS.SUBMIT` while `snap.canInterrupt === true` calls `codeSessionStore.interrupt()`. (verification: test)
  - Advancing the mock store into `phase: "submitting"` flips `data-phase` and `data-can-interrupt` without a React state update inside the component (asserted via a render-counter ref). (verification: test)
  - Advancing the store into `queuedSends: 2` adds `data-queued` to the root; advancing it back to 0 removes the attribute. (verification: test)
  - `localCommandHandler` returning `true` suppresses the `send()` call and clears the input; returning `false` falls through to `codeSessionStore.send(...)`. (verification: test)
- Vitest `__tests__/tug-prompt-input.test.tsx` (existing file, extended) asserts: `setRoute(">")` on an empty input produces a single `>` route atom at position 0; `setRoute("$")` on a non-empty input replaces the content with a single `$` route atom. (verification: test)
- `bun test` is green on every step commit and on the integration checkpoint. (verification: Step 7)

#### Scope {#scope}

**In scope:**
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (new).
- `tugdeck/src/components/tugways/tug-prompt-entry.css` (new).
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry.test.tsx` (new).
- `tugdeck/src/components/tugways/tug-prompt-input.tsx` (edit: add `setRoute(char)` imperative method, one line in `useImperativeHandle` + JSDoc).
- `tugdeck/src/components/tugways/__tests__/tug-prompt-input.test.tsx` (edit: add `setRoute` unit tests).
- `tugdeck/src/components/tugways/cards/gallery-prompt-entry.tsx` (new): pristine showcase card.
- `tugdeck/src/components/tugways/cards/gallery-prompt-entry.css` (new): minimal card layout.
- `tugdeck/src/components/tugways/cards/gallery-prompt-entry-sandbox.tsx` (new): interactive driver card.
- `tugdeck/src/components/tugways/cards/gallery-prompt-entry-sandbox.css` (new): driver panel layout.
- `tugdeck/src/main.tsx` (edit: register both gallery cards alongside `gallery-prompt-input`).
- `tugdeck/src/components/tugways/action-vocabulary.ts` (edit if necessary: ensure `TUG_ACTIONS.SUBMIT` exists; if it does not, add it per [action-naming.md](../tuglaws/action-naming.md) with `phase: "discrete"` semantics).

**Shape:** ~600 lines across the component, CSS, and tests, plus ~400 lines across the two gallery cards (most of it sandbox driver UI).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Tide card registration.** T3.4.c is a separate phase. T3.4.b does not touch `tide-card.tsx`, `useTideCardServices`, card-service memoization, or split-pane persistence.
- **`SessionMetadataStore` rendering.** The component accepts a `sessionMetadataStore` prop for forward-compatibility with T3.4.c (which will surface model name, version, etc. near the entry), but T3.4.b does not render any of its fields. The prop is typed but unused in this phase; the sandbox card supplies a no-op instance.
- **`PromptHistoryStore` rendering.** Same as above: accepted as a prop, not consumed. T3.4.b's scope ends at "the input accepts text and emits it." History nav (up/down arrow recall) is an input-level concern that lives on `TugPromptInput`.
- **File completion / `@` trigger UI.** `fileCompletionProvider` is accepted as a prop and forwarded to `TugPromptInput`, which already knows what to do with it. No new completion logic lands in the entry.
- **Drop handler for `@`-atom drag and drop.** Same: `dropHandler` is forwarded to the input.
- **Local `:`-surface command registry.** The `localCommandHandler` prop is the seam; populating the registry is T10's work.
- **Approval / question UI.** Per [D-T3-08], approval and question prompts render inside the Tide card's output pane (as block-level content), not inside the entry. The entry's role is to flip its `data-phase` to `awaiting_approval` so the CSS can dim the input / disable the submit button while the user answers upstream.
- **`CodeSessionStore` constructor changes.** No edits to `tugdeck/src/lib/code-session-store.ts` or its sub-modules. The component consumes the existing snapshot surface unchanged.
- **Tide card keyboard shortcut (Cmd-K / Cmd-Return).** T3.4.c wires global shortcuts; T3.4.b only ensures the delegate exposes `focus()` and that submit is a chain action so shortcuts can dispatch it.
- **Multi-session UI.** The component is strictly 1:1 with a single `CodeSessionStore` per [D-T3-09]. Any multi-session concerns (tabs, switching, stacking) are a parent's problem.
- **Persistence.** The input already persists editing state via tugbank per [L23]. The entry adds no new persistence.
- **New component-slot tokens.** Per [D11], the component reuses existing `global` / `field` / `badge` base-tier tokens and does not mint new `prompt-entry`-scoped tokens. `brio.css` and `harmony.css` are **not** edited by this plan. Any visual need the existing tokens cannot satisfy would be cause to re-open [D11] — not to add a follow-on commit.

#### Dependencies / Prerequisites {#dependencies}

- [T3.4.a](./tugplan-code-session-store.md) — `CodeSessionStore` with its full snapshot surface. **Landed.**
- [T3.4.a.1](./tide.md#t3-4-a-code-session-store) — CONTROL error routing. **Landed.** (Not structurally required — T3.4.b reads `lastError.cause` for a visual ring but does not branch on the specific cause — but the fuller surface is nicer.)
- [P13](./tide.md#p13-spawn-cap) — Spawn cap + rate limit. **Landed.** (Not structurally required — T3.4.b is tugdeck-only — but cheap insurance before the gallery card makes real spawn requests.)
- `tugdeck/src/components/tugways/tug-prompt-input.tsx` — existing, with `clear()`, `insertText(text)`, `focus()`, `getText()`, `getAtoms()`, `isEmpty()`, and `routePrefixes` / `onRouteChange` props. Adding `setRoute(char)` is part of this plan.
- `tugdeck/src/components/tugways/tug-choice-group.tsx` — existing, already chain-native (`TUG_ACTIONS.SELECT_VALUE` dispatched via `useControlDispatch()` with a `senderId`).
- `tugdeck/src/components/tugways/tug-push-button.tsx` — existing, already chain-native (dispatches a prop-configured `action` via `useControlDispatch()`).
- `tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts` — existing `MockTugConnection` helper. Used in the sandbox gallery card to drive phase transitions. This plan imports it directly from `testing/`; a future cleanup may promote it to a non-test path but that is not T3.4.b's concern.
- Responder chain infrastructure: `useResponder`, `useControlDispatch`, `useResponderForm`, `ResponderChainProvider`, `action-vocabulary.ts`. All existing.
- Token system: existing `--tug7-*-global-*`, `--tug7-*-field-*`, and `--tug7-*-badge-*` tokens in both `brio.css` and `harmony.css`. Both theme files already define these slots with identical structure (verified pre-plan: 18 component slots in brio.css, same set in harmony.css). No theme-file edits needed for T3.4.b.

#### Constraints {#constraints}

- **No new persistence.** Per [D-T3-10] and [D-T3-11].
- **No IndexedDB.** Per [D-T3-10].
- **No React state for appearance.** Per [L06]. The component uses `useSyncExternalStore(store.subscribe, store.getSnapshot)` for the store snapshot, `useRef` for the input delegate + responder id anchor + `snapRef` live-state access, and exactly one `useState<string>` for the route value per [D04] (a controlled-component `value` prop driving `TugChoiceGroup`, which L06 explicitly sanctions as data). No `useReducer`, no `useEffect` mirroring store state into state, no `useState` for appearance concerns.
- **No callback props for user interactions.** Per [L11] and [component-authoring.md §Emitting an action](../tuglaws/component-authoring.md#emitting-an-action-controls). The component does not expose `onSubmit` or `onInterrupt` — those actions go through the chain. The sole callback-shaped prop (`localCommandHandler`) is not a user interaction; it's a synchronous interception hook the Tide card provides, and its call site is *inside* the entry's `submit` responder handler (not emitted to a parent).
- **Composed children keep their own tokens.** Per [L20]. No descendant selectors reach into `TugPromptInput`, `TugChoiceGroup`, or `TugPushButton` CSS.
- **`data-slot="tug-prompt-entry"` on the root.** Per [component-authoring.md §Component](../tuglaws/component-authoring.md#component).
- **Responder `id` is stable across renders.** The card supplies `id` as a prop (typically `cardId`); the component passes it directly to `useResponder` without mutation.
- **First responder is chain-managed.** The component does not call `manager.makeFirstResponder(id)`. Per [component-authoring.md §No `makeFirstResponder` in component code](../tuglaws/component-authoring.md#no-makefirstresponder-in-component-code).
- **Warnings are errors.** `bun run check`, `bun run test`, and `bun run audit:tokens lint` all exit 0 on every committed step.

#### Assumptions {#assumptions}

- The existing `TugPromptInput` route-detection path is correct. Typing `">"` in an empty input fires `onRouteChange(">")` synchronously from the editor's input event handler. (Verified by reading `tug-prompt-input.tsx` in preparation for this plan.)
- `TugChoiceGroup`'s `useControlDispatch` call site can disambiguate by `senderId` — if two segmented controls coexist on a card, each gets a distinct opaque id. The entry hardcodes a stable id for its route indicator so the responder handler can narrow.
- `TUG_ACTIONS.SELECT_VALUE` and `TUG_ACTIONS.SUBMIT` exist in `action-vocabulary.ts` with `discrete` phase semantics. If `SUBMIT` is missing, it lands in a preparatory sub-step of this plan (Step 1).
- `TugPushButton`'s `action` prop wiring dispatches via `useControlDispatch()` with `sender` set to the button's own id. The entry's responder handler does not narrow on sender for submit — any `submit` dispatch routed to this responder is the submit button or a keyboard shortcut targeting this responder, and both mean the same thing.
- `MockTugConnection` in `testing/mock-feed-store.ts` can be imported from non-test code without breaking the build. (It is plain TypeScript, not test-framework-coupled.) If importing from `testing/` triggers a lint/bundler rule, a Step 5 promotion commit moves it to `tugdeck/src/lib/code-session-store/dev-mock.ts` as pure infrastructure — no test-only behavior.
- The existing `global` / `field` / `badge` token slots in `brio.css` and `harmony.css` are sufficient for the entry's chrome needs (container surface, divider, toolbar row, queue badge, errored ring). Verified pre-plan against both theme files. If implementation surfaces a visual need no existing token can satisfy, [D11] is re-opened, not quietly bypassed.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where does `setRoute(char)` land on the input's imperative handle? (DECIDED) {#q01-set-route-landing}

**Question:** `TugPromptInput`'s imperative handle is typed `TugTextInputDelegate`, defined in `tugdeck/src/lib/tug-text-engine.ts`. That type is a UITextInput-inspired contract listing low-level engine primitives (`clear`, `insertText`, `selectAll`, delete/paste/undo variants, typeahead controls, ~25 methods total). `setRoute(char)` is a composition-layer concept — it operates above the text-engine primitive layer. Does it belong on `TugTextInputDelegate`, on a widened input-specific delegate defined in `tug-prompt-input.tsx`, or on an entry-only wrapper delegate?

**Why it matters:** Adding `setRoute` to `TugTextInputDelegate` enlarges a deliberately-minimal low-level contract with a concept above its layer. Adding it entry-side means threading two refs through `TugPromptEntry` (one to the input, one to expose the wrapped methods), which doubles the API surface with no semantic benefit. A widened delegate extending `TugTextInputDelegate` at the component layer keeps the engine type clean while giving the input a single expanded handle its direct consumers see.

**Options (if known):**
- Add `setRoute` to `TugTextInputDelegate` directly in `tug-text-engine.ts`.
- Define `TugPromptInputDelegate extends TugTextInputDelegate` in `tug-prompt-input.tsx`; widen the `forwardRef` type to expose it.
- Keep `TugPromptInput`'s delegate unchanged; expose `setRoute` via a wrapper delegate owned by `TugPromptEntry`.

**Plan to resolve:** Decide now. This is a type-level call with no performance or testability implications; the cost of switching later is one mechanical rename.

**Resolution:** DECIDED. Define `TugPromptInputDelegate extends TugTextInputDelegate` in `tug-prompt-input.tsx` itself and widen the input's `forwardRef<TugPromptInputDelegate, TugPromptInputProps>`. The implementation of `setRoute(char)` inside `useImperativeHandle` is `{ this.clear(); this.insertText(char); }` — the body calls into engine primitives the underlying delegate already owns, but the type-level extension lives at the component layer where route atoms are a first-class concept. Rationale: `tug-text-engine.ts`'s `TugTextInputDelegate` is a UITextInput-inspired engine primitive contract; keeping it free of composition-layer concepts preserves the layering. The input component is the correct owner of "set the leading route atom" because `routePrefixes` and `onRouteChange` already live there as peer APIs.

#### [Q02] Does the submit button dispatch `TUG_ACTIONS.SUBMIT` or a new `TUG_ACTIONS.SUBMIT_PROMPT`? (DECIDED) {#q02-submit-action-name}

**Question:** The action vocabulary has existing conventions. A generic `submit` action could collide with form submissions elsewhere; a domain-specific `submit-prompt` is narrower but pollutes the action table with a special case.

**Resolution:** `TUG_ACTIONS.SUBMIT`. Rationale: the responder chain's walk already scopes handlers — `submit` dispatched while the first responder is a `TugPromptEntry` only ever lands on this entry's handler, regardless of other submit-shaped actions elsewhere in the app. Adding a domain-specific name would set a precedent for "dispatches named after the component that emits them," and the action vocabulary deliberately avoids that (see [action-naming.md §Action Names vs. Browser Command Names](../tuglaws/action-naming.md)). If `TUG_ACTIONS.SUBMIT` does not exist yet, it is added as part of Step 1 with the standard `phase: "discrete"` payload (no `value` required — the responder reads current state from the store snapshot).

#### [Q03] How does the sandbox card get frames into `MockTugConnection` reliably? (DECIDED) {#q03-sandbox-mock-driver}

**Question:** `MockTugConnection.dispatchDecoded(feedId, payload)` is the direct injection path used in tests. In a gallery card, we need a small driver surface with buttons like "advance to streaming" that synthesize the *sequence* of frames a real turn would produce. Do we re-implement per-step fixtures in the card, or reuse the golden fixtures?

**Resolution:** Re-implement a minimal synthetic-fixture helper inline in the sandbox card. Rationale: the golden fixtures under `tugrust/.../v2.1.105/` are static JSONL files loaded via a test helper (`loadGoldenProbe`) that is tests-only. Reaching for them from a gallery card would require bundling jsonl parsing and fixture loading into the production dev build, which is more machinery than the sandbox card justifies. Instead, the sandbox card defines ~10 small synthetic frame factories (e.g., `makeAssistantPartial(text, rev, seq)`, `makeTurnCompleteSuccess()`, `makeControlRequestForwardApproval(requestId, toolName)`) and the driver buttons call them in sequence. The reducer work already validates the fixture-backed reality in the test suite; the sandbox card's job is to exercise the *visual* contract against the *reducer*, not to re-validate the reducer.

#### [Q04] Does the responder handler read store state through a ref or directly off the snapshot closure? (DECIDED) {#q04-handler-state-access}

**Question:** Per [L07], action handlers registered via `useResponder` must read current state through refs, not stale closures — the hook registers once at mount. But `useSyncExternalStore` produces a `snap` variable that updates on every store change. If the handler closes over `snap`, it captures a stale value; if it reads through a ref, it captures the live value.

**Resolution:** Read through a ref. A `snapRef = useRef(snap)` is kept in sync via a `useLayoutEffect` that writes `snapRef.current = snap` on every render. The `submit` handler reads `snapRef.current.canInterrupt` at dispatch time. This matches the pattern documented in [component-authoring.md §Handlers read current state through refs](../tuglaws/component-authoring.md#handling-actions-responders) and in the `useResponder` JSDoc. No `useCallback` dance needed — the hook's proxy layer picks up identity changes, but closures over snapshot values don't work without the ref.

#### [Q05] What's the split between the pristine gallery card and the sandbox card? (DECIDED) {#q05-gallery-split}

**Question:** One card or two? A single card with a collapsible debug panel would reduce file count; two cards would give the theme audit a clean target.

**Why it matters:** The theme audit (`audit:tokens lint`) and the visual-regression workflow both want a pristine "rest state" card to compare across themes. Debug chrome on that card pollutes the comparison. On the other hand, a dev driving the component through every phase needs the debug chrome — a minimal showcase card is useless for that purpose.

**Options (if known):**
- Single card with a collapsible "debug" affordance that shows/hides the driver panel.
- Two cards: one pristine, one sandbox.

**Plan to resolve:** Decide now — the cost of two cards is minor (the sandbox card imports helpers from the pristine card) and the benefit of clean theme-audit targets is structural.

**Resolution:** DECIDED. Two cards. Card 1 (`gallery-prompt-entry.tsx`) is the pristine showcase used by `audit:tokens lint` and visual regression. Card 2 (`gallery-prompt-entry-sandbox.tsx`) is the interactive driver with debug chrome. The separation is cheap — the sandbox card imports the pristine card's `buildMockServices()` helper and wraps it — and the benefit is that theme-level changes can be visually reviewed against a reproducible `idle`-state rendering without fighting debug-panel chrome. See [D07].

---

### Risks and Mitigations {#risks}

- **Risk: descendant restyling creeps in during iteration.** The entry's CSS grows, and under deadline pressure someone writes `.tug-prompt-entry .tug-push-button { gap: 4px; }` to tune the internal layout of a composed child. This is an [L20] violation that audits may not catch until much later.

  **Mitigation:** The Step 7 lint check greps `.tug-prompt-entry .tug-(prompt-input|choice-group|push-button)` and fails the build on any match. The same grep goes into `#success-criteria` so regressions are caught at test time. Layout adjustments between composed children go on wrapper elements the entry owns (e.g., `.tug-prompt-entry-toolbar`), not on the children themselves.

- **Risk: `data-empty` observation is mis-wired.** The component needs to know when the input is empty vs. non-empty to disable/enable the submit button. The input exposes `isEmpty()` as a method (not an observable) and fires an existing `onChange` callback once per user-driven input event. Wiring the observation correctly means using that existing `onChange` — **not** inventing a new `onInputChange` prop, which would produce a dead-code duplicate since `onChange` already covers the same ground.

  **Mitigation:** Spec S02's `handleInputChange` is bound to the input's existing `onChange` prop. Inside the callback, the entry reads `isEmpty()` from the delegate and writes the result to the root element's `data-empty` attribute via `rootRef`. No new callback prop on the input. Step 1's artifact list is explicit: "use existing `onChange`; do not add `onInputChange`." If a future reader sees a dead `onInputChange` prop land, it's a bug; reject the commit.

- **Risk: `setRoute(char)` on `TugPromptInput` duplicates existing internal state.** The imperative handle's `clear()` + `insertText(char)` path works, but if the editor's text-engine has separate internal state tracking "what the current route is" versus "what's in the text," the `clear()` half may not reset the internal tracker, leading to a stale `currentRoute` state on the next input event.

  **Mitigation:** Step 1 lands the `setRoute` method and unit tests it against the exact sequence the integration path will use: `clear()` + `insertText("$")` + subsequent `onRouteChange` invocation. If the editor's internal route state is stale after this sequence, the unit test fails and Step 1's scope expands to fix the editor before `TugPromptEntry` depends on it. No integration work happens on top of an unverified foundation.

- **Risk: `TugChoiceGroup` is a controlled component — DOM-only update strategies are structurally broken.** `TugChoiceGroup` derives its pill position from its `value` prop via its own internal `useLayoutEffect` (see `tug-choice-group.tsx` lines 77–160). Any strategy that tries to move the pill by writing to a `data-*` attribute on the indicator's root element will not move the pill — the attribute will be set on a DOM node that nothing reads, and `TugChoiceGroup`'s internal effect will overwrite it on next render anyway. A controlled component can only be driven by updates to its `value` prop.

  **Mitigation:** Per [D04], the route value lives in a single `useState<string>` in `TugPromptEntry`, passed as `value={route}` to `TugChoiceGroup`. Both update paths (input → indicator, indicator → input) call the state setter. The plan never tries to write `data-route` or any other attribute on the indicator's root element. Spec S03's JSX does not include a `routeIndicatorRef`; there is no ref to the indicator. This risk is called out explicitly because the previous revision of this plan made exactly this mistake, and the fix requires being loud about the controlled-component constraint so it is not re-introduced during implementation.

- **Risk: submit button renders aria-disabled in Step 2–4 because the `submit` handler doesn't exist yet.** `TugPushButton`'s chain-action mode calls `manager.nodeCanHandle(target, action)` and renders `aria-disabled` if the parent responder doesn't register the action (see `internal/tug-button.tsx` lines 286–295). Step 2 scaffolds the component with the button present but Step 5 is where the `SUBMIT` handler lands. Between Steps 2 and 4, the button is present-but-non-functional; a developer smoke-testing the card between commits would see a disabled button.

  **Mitigation:** Step 2 registers a **no-op** `submit` handler in the `useResponder` actions map as part of the scaffold (`[TUG_ACTIONS.SUBMIT]: () => {}`) so `nodeCanHandle` returns true and the button is not aria-disabled. Step 5 replaces the stub with the real branching handler. This is purely a transient-state fix; it does not affect functionality at any commit boundary and the no-op is explicitly called out in Step 2's task list so it is not forgotten.

- **Risk: responder id collisions between the component-hosted `TugPromptEntry` responder and the Tide card responder.** T3.4.c plans to register the Tide card itself as a responder (for `close`, `previous-tab`, `next-tab`). If both the card and the entry register under the same id — or if the entry's responder parents the card's — actions walk in the wrong direction.

  **Mitigation:** The entry takes `id` as a required prop. The Tide card supplies an id derived from its `cardId` with a `-entry` suffix (`tide-card-<uuid>-entry`). The Tide card's own responder uses the bare `cardId`. The entry's `parentId` comes from `ResponderParentContext`, which resolves to the Tide card's responder id, so the walk goes entry → card → canvas, matching the visual hierarchy. Step 6's integration test in the sandbox card verifies the walk order by dispatching `close` from inside the entry and asserting the card's handler runs, not the entry's.

- **Risk: the sandbox card's import from `testing/` breaks a bundler rule.** If `tsconfig.json` or an ESLint rule forbids non-test imports from `**/testing/**`, the sandbox card fails to build.

  **Mitigation:** Step 5 verifies the import works before writing driver code. If it is blocked, Step 5 promotes `MockTugConnection` from `testing/mock-feed-store.ts` to `tugdeck/src/lib/code-session-store/dev-mock.ts` as a one-line re-export. No behavioral change; the promotion is mechanical.

- **Risk: the `@tug-pairings` table is incomplete because the entry's chrome is minimal.** A compound composition with mostly borrowed visuals may register only one or two pairings of its own, and `audit:tokens lint` could flag the file as under-annotated.

  **Mitigation:** The entry will have at least three pairings: the toolbar row background against the queue badge foreground, the separator divider against its surface, and the "errored" ring color against the entry's own surface. If fewer pairings land, the `@tug-pairings: none — compositional, children own pairings` annotation is used per the component authoring guide. Either is valid; the CSS-file-opens-with-a-`@tug-pairings`-block invariant is what the audit enforces.

---

### Design Decisions {#design-decisions}

#### [D01] `TugPromptEntry` is a compound composition, not a cosmetic wrapper (DECIDED) {#d01-compound-composition}

**Decision:** The component is a full compound composition per [component-authoring.md §Compound Composition](../tuglaws/component-authoring.md#compound-composition), with its own visual identity (toolbar chrome, queue badge, layout tokens) and composed children (`TugPromptInput`, `TugChoiceGroup`, `TugPushButton`). It is not a compositional wrapper (no-CSS convenience like `TugPopupButton`).

**Rationale:** The entry renders a toolbar row with its own spacing, divider, and badge — visual elements not owned by any of the three composed children. It needs its own `.css` file and its own `@tug-pairings` table. It does **not** need its own component-slot token family; the existing `global` / `field` / `badge` base-tier tokens cover the chrome it draws (see [D11]). Treating it as a no-CSS wrapper would push toolbar styling into the children (violating [L20]) or into the Tide card's CSS (violating layer separation). Compound composition is the correct pattern.

#### [D02] Snapshot drives `data-*` attributes; no prop mirror (DECIDED) {#d02-data-attributes-from-snapshot}

**Decision:** The component reads `codeSessionStore` via one `useSyncExternalStore` call and writes every derived visual state to `data-*` attributes on the root element in-render. No `useEffect` mirroring snapshot values into `data-*` after commit. No React state tracking a "displayed phase" separate from the snapshot's phase.

**Rationale:** The simpler path is the correct path. React sees the snapshot through the external store hook; the attributes are part of the JSX render; the renderer sets them on commit. An `useEffect` mirror would double the update paths (render-time attribute set vs. effect-time attribute set), add a frame of lag, and break the single-source-of-truth invariant. The external store hook already provides the synchronization guarantee `useSyncExternalStore` was designed for.

#### [D03] Submit label is child content, not `::before` — overrides tide.md §T3.4.b (DECIDED) {#d03-submit-label-as-children}

**Decision:** The submit button's label ("Send" vs. "Stop") is rendered as React child content: `<TugPushButton ...>{snap.canInterrupt ? "Stop" : "Send"}</TugPushButton>`. Not as CSS `::before` content pulled from a token.

**⚠ This deliberately overrides [tide.md §T3.4.b line 2615](./tide.md#t3-4-b-prompt-entry)**, which specifies "the label sits in `::before` content from a token" as a token-driven alternative to conditional JSX. The override is called out prominently in §Context alongside the D-T3-04 override so future readers don't silently inherit stale guidance from tide.md.

**Rationale:**
- **[L20] sovereignty.** Implementing `::before` content from the parent would require `.tug-prompt-entry .tug-push-button::before { content: var(...) }` — a descendant selector reaching into `TugPushButton`'s pseudo-element. That is exactly the [L20] violation this plan is most concerned with. `TugPushButton` already renders its label as child content; respecting that contract means the parent passes label text in the normal way.
- **[L06] data test.** The label ("Send" vs. "Stop") is semantic — the user reads it to decide whether clicking will submit a prompt or interrupt an in-flight turn. Per [L06]'s explicit test ("does any non-rendering consumer depend on this state?"), the answer is yes: the user is a non-rendering consumer who reads the label and acts on it. Labels that change their meaning are data, not appearance, and data belongs in React's render cycle.
- **Simplicity.** Rendering `{snap.canInterrupt ? "Stop" : "Send"}` is one line and honest about what it does. The `::before`-from-a-token approach needs per-phase CSS rules that set `content: "Send"` or `content: "Stop"`, which are strings masquerading as tokens — the indirection buys nothing.

**Implications:**
- `TugPushButton` is rendered with explicit child content; the component's existing support for child content (see `tug-push-button.tsx`) is enough.
- Role-based coloring of the button (the `"danger"` role when interrupting) still comes from a data attribute / role prop; only the label text is data-driven from the snapshot.
- Gallery cards and vitest tests assert the label text directly from the rendered DOM.

#### [D04] Route value lives in React state; `TugChoiceGroup` receives it as a controlled `value` prop (DECIDED) {#d04-route-via-chain}

**Decision:** The currently-selected route (`>`, `$`, `:`) lives in a single `useState<string>` in `TugPromptEntry`. `TugChoiceGroup` is rendered with `value={route}` as a controlled component; its pill position animates automatically via its own `useLayoutEffect` when `value` changes. Both update paths — (a) the input detecting a typed route prefix and firing `onRouteChange`, and (b) the indicator dispatching `TUG_ACTIONS.SELECT_VALUE` through the responder chain — converge on a single `setRoute(r)` call to the React state setter. The SELECT_VALUE handler additionally calls `promptInputRef.current.setRoute(r)` to keep the input's leading atom in sync; this synchronous double-write is safe because the indicator → input direction fires `onRouteChange` again, which re-sets the same state to the same value (a React no-op). The input → indicator direction only updates state, no delegate call back on the input.

**⚠ This supersedes the direct-DOM `data-route` approach from the previous revision of this plan.** The prior strategy — writing `data-route` on the indicator's DOM element via a ref — was structurally incompatible with `TugChoiceGroup`, which is a controlled component (see `tug-choice-group.tsx` lines 77–160): the pill position is derived from the `value` prop via an internal `useLayoutEffect`, not from any `data-*` attribute. Writing `data-route` on its root element would set an attribute nothing reads, and the pill would be permanently stuck on its initial value. React state is the only working path for a controlled component.

**Rationale:**
- **Controlled-component contract.** `TugChoiceGroup`'s API is `value: string` (required) plus `TUG_ACTIONS.SELECT_VALUE` dispatches on user selection. It does not expose any imperative setter for its pill position. Any consumer that wants to programmatically move the pill must update the `value` prop, which means holding the value in React (state, not a ref — a ref wouldn't trigger re-render).
- **[L06] explicitly allows it.** L06 is not "no React state"; it is "no React state *for appearance*." The route value's "selected item in a list" shape is one of L06's explicit examples of data that flows through React normally. The test ("does any non-rendering consumer depend on this state?") passes: the indicator's `value` prop is a non-rendering consumer of the state, read during React's render cycle to compute which segment to mark active.
- **[L11] chain hygiene.** The `TUG_ACTIONS.SELECT_VALUE` path through the chain is preserved — the indicator is still a control, still emits an action, still doesn't use callback props for user interactions. The responder handler just happens to update React state instead of writing directly to DOM.
- **No loop.** Input → state: onRouteChange fires setState. Indicator → state + input: SELECT_VALUE handler fires setState + `input.setRoute(r)`; the input's own route-detection path fires onRouteChange, which calls setState with the same value (React no-op).

**Implications:**
- Exactly one `useState` call in `TugPromptEntry`, for `route`. The Success Criteria grep check is updated from "zero useState matches" to "exactly one useState match, and it's for the route."
- The `onRouteChange` prop on `TugPromptInput` becomes the primary input → indicator sync path; no DOM refs on the indicator needed.
- The SELECT_VALUE handler and the onRouteChange callback share the same setter function; idempotent on matching values.
- Spec S03's JSX structure is updated to include `const [route, setRoute] = useState<string>("")` and `value={route}` on the indicator.

#### [D05] Submit/interrupt unified under `TUG_ACTIONS.SUBMIT` with snapshot-driven dispatch (DECIDED) {#d05-submit-interrupt-unified}

**Decision:** The submit button dispatches `TUG_ACTIONS.SUBMIT` regardless of turn phase. The entry's `submit` handler inspects `snapRef.current.canInterrupt` and either calls `codeSessionStore.send(...)` or `codeSessionStore.interrupt()` based on the snapshot. There is no separate `TUG_ACTIONS.INTERRUPT` emitted from the button.

**Rationale:** Per [D-T3-06], "submit IS the interrupt button." A user pressing the same key or clicking the same location always does the same *action* ("submit my intent"); what that intent means depends on whether a turn is active. The chain should see one action. Splitting it into two action names would force the button to read `snap.canInterrupt` before dispatch (button → store coupling) or force callers to register two handlers (handler fragmentation). One action name, one handler, one snapshot read at dispatch time — consistent with the chain's "handlers read state through refs" pattern.

#### [D06] `localCommandHandler` is an optional synchronous interceptor (DECIDED) {#d06-local-command-hook}

**Decision:** The entry's submit handler, before calling `codeSessionStore.send(...)`, invokes `localCommandHandler?.(route, atoms)` (synchronous signature: `boolean`). Returning `true` means "handled locally, do not send." Returning `false` (or undefined because the prop was omitted) means "send normally." The entry clears the input on either path.

**Rationale:** [tide.md §T3.4.b](./tide.md#t3-4-b-prompt-entry) anticipates a surface built-in registry (`:help`, etc.) that will live in T10. T3.4.b does not build the registry but must leave a seam so T3.4.c does not need to retrofit one later. A single optional prop satisfies that requirement; the prop is synchronous (not async) because local commands are local — any async work they dispatch is their own problem, not the entry's. The default behavior with the prop absent is "send every submission," which is the only defensible pre-T10 semantics.

#### [D07] Two gallery cards, not one (DECIDED) {#d07-two-gallery-cards}

**Decision:** Ship two gallery cards for `TugPromptEntry`: `gallery-prompt-entry.tsx` is the pristine showcase (component in `idle` against an empty mock store, no debug chrome), and `gallery-prompt-entry-sandbox.tsx` is the interactive driver (same component wrapped in a panel of mock-frame-injection buttons). This supersedes [D-T3-04](./tide.md#t3-4-b-prompt-entry), which forbade any gallery card for this component.

**Rationale:**
- The pristine card is the stable target for `audit:tokens lint` and theme visual review. A single card polluted with debug chrome makes those workflows harder — the reviewer has to mentally subtract the buttons.
- The sandbox card is the developer's view for stepping through phase transitions without spinning up a full live session (tugcast + claude + supervisor). The cost of building it is one afternoon; the cost of not having it echoes through every visual tuning iteration.
- [D-T3-04]'s rationale ("tests must match user reality") applies to *tests*, not to *development tooling*. The component's vitest suite drives the real reducer against real snapshot shapes; the sandbox is only for visual exploration, not behavioral verification. Reusing `MockTugConnection` (already battle-tested across 111 T3.4.a tests) means the sandbox and the tests share the same frame shapes, so the "divergent environment" concern does not apply.

**Implications:**
- Two cards, both registered in `main.tsx`.
- The sandbox card imports `MockTugConnection` from `tugdeck/src/lib/code-session-store/testing/` — see [D08].
- The pristine card exposes a `buildMockServices()` helper that the sandbox card re-uses so the two mounts share identical initial state.

#### [D08] `MockTugConnection` imported directly from `testing/` (DECIDED) {#d08-mock-from-testing}

**Decision:** The sandbox gallery card imports `MockTugConnection` directly from `tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts`. No promotion, no re-export, no wrapper.

**Rationale:** `MockTugConnection` is pure TypeScript with no test-framework coupling (it does not import `bun:test`, `jest`, or `vitest`). Importing it from gallery code works as a TypeScript import unless a bundler or lint rule forbids `testing/` paths — in which case Step 5 has a documented mitigation (promotion to `dev-mock.ts`). The cost of pre-promoting is a second file + a commit; the cost of not pre-promoting is zero unless the rule bites. Defer the work until needed. The same tradeoff shows up in `#risks`.

#### [D09] Responder id comes from the parent card, passed as a prop (DECIDED) {#d09-responder-id-from-parent}

**Decision:** `TugPromptEntryProps.id` is required. The entry passes it directly to `useResponder({ id: props.id, actions: { ... } })`. Gallery cards synthesize a stable id at module load time (e.g., `gallery-prompt-entry-main`); the Tide card will supply `${cardId}-entry`.

**Rationale:** Chain-participant components need a stable id across renders. The only sources for a stable id are (a) a domain identifier from above (card id, session id) or (b) a `useId()` call. Using `useId()` here would mean the id changes if the component is remounted, which breaks observer-dispatch patterns where external code references the id. Requiring the id as a prop pushes identity management to the caller, which is where it belongs — the component should not invent an identity for itself.

#### [D10] The entry does NOT register `cut` / `copy` / `paste` / `select-all` (DECIDED) {#d10-entry-no-editing-actions}

**Decision:** Standard editing actions live on `TugPromptInput`'s responder registration (inherited from its existing chain integration as a text-engine component). The entry does not re-register them. The walk routes editing actions past the entry because the entry's `actions` map does not contain those keys.

**Rationale:** Per the responder chain's innermost-first walk, the first responder (the text editor, inside `TugPromptInput`) is the deepest node with a `cut` handler. The walk finds it and stops. The entry does not need to forward editing actions to the input; the chain does that for free. Adding them to the entry's `actions` map would either shadow the input's handlers (breaking clipboard semantics) or be a dead-code dead-weight duplication. The minimum action set for the entry is exactly what it owns: `select-value` (for the route indicator) and `submit` (for the submit/interrupt button).

#### [D11] Reuse existing base-tier tokens; no new `prompt-entry` component slot (DECIDED) {#d11-no-new-token-slot}

**Decision:** `TugPromptEntry` does not mint a new component-slot token family. It consumes existing `--tug7-*-global-*`, `--tug7-*-field-*`, and `--tug7-*-badge-*` tokens in both `brio.css` and `harmony.css`. The component's styling ships **inline with Steps 2 and 5** (not as a preparatory theme commit), and the theme files are **not edited** as part of this plan. Spec S07 enumerates the exact pairings the entry's CSS declares.

**Rationale:**
- **Precedent.** No multi-word component slot exists in the current token vocabulary. All 18 slots in `brio.css` are single-word (`atom`, `badge`, `card`, `checkmark`, `control`, `field`, `global`, `highlight`, `overlay`, `radio`, `segment`, `selection`, `skeleton`, `slider`, `split`, `tab`, `toggle`, `tone`). `prompt-entry` as a two-word slot would be the first — a token-vocabulary change that outsizes this phase's scope.
- **Precedent from the input itself.** `tug-prompt-input.css` does not define `prompt-input`-scoped tokens. It consumes `--tug7-element-global-*`, `--tug7-element-field-*`, and `--tug7-surface-global-*` / `--tug7-surface-field-*`. The compound composition on top of it should follow the same pattern, not branch.
- **Reuse beats proliferation.** Minting a new slot implies a per-theme authoring step for every visual element the entry draws (toolbar background, divider color, queue-badge surface, queue-badge text, errored ring). Each of those visual elements has a natural mapping to an existing token:
  - Entry container surface → reuse the input's surface (`--tug7-surface-global-primary-normal-control-rest`, matching `tug-prompt-input.css` line 68 equivalents).
  - Divider between input and toolbar → `--tug7-element-global-border-normal-default-rest`.
  - Toolbar row background → same surface as the container (no recessed treatment needed; the divider is the visual separation).
  - Queue badge text → `--tug7-element-badge-text-tinted-action-rest`.
  - Queue badge surface → `--tug7-surface-badge-primary-tinted-action-rest`.
  - Errored ring → `--tug7-element-field-border-normal-danger-rest` (reuses the field-family danger border, matching `tug-input.css`'s invalid state).
- **Tests against the same grounding.** Because the entry uses tokens that already exist in both themes, `audit:tokens lint` passes in Step 2 without any token authoring. Gallery theme review in Step 6 exercises these tokens in both `brio` and `harmony` against the already-shipped values.
- **Escape hatch.** If implementation surfaces a visual need no existing token satisfies — e.g., the queue badge looks visually confused sharing `badge-primary-tinted-action` with actual badges — the mitigation is to **re-open [D11]**, propose the new slot (or a new constituent within an existing slot), and add the preparatory theme commit as a named fix. The escape is explicit, not implicit; no silent theme edits.

**Implications:**
- Spec S07 (the pairings table) is the definitive list of token pairs the entry's CSS consumes. Reviewers can grep for the exact tokens against both theme files before Step 2 lands to confirm each pairing resolves.
- No follow-on commit to `brio.css` or `harmony.css` is expected or permitted.
- The entry's `@tug-pairings` table references existing tokens only; `audit:tokens lint` validates against them.
- Component-tier aliases (`--tugx-prompt-entry-*`) may still be used inside the entry's CSS `body {}` block to shorten long token references for readability, provided each alias resolves to a base-tier `--tug7-*` token in one hop per [L17]. These aliases are local to the entry's CSS file, not theme-authored.

---

### Deep Dives {#deep-dives}

#### Responder wiring walkthrough {#responder-wiring}

The entry participates in the responder chain as a **responder** (for `select-value` from its route indicator and `submit` from its submit button) and **not as a control** — the entry itself does not emit actions; its children do. The walk for the three action categories the entry cares about goes like this:

**1. Route selection via click on the indicator.**

```
user clicks "$" segment in TugChoiceGroup
      ↓
TugChoiceGroup.useControlDispatch({
  action: SELECT_VALUE, sender: "route-indicator-...", value: "$", phase: "discrete"
})
      ↓
Chain targets the parent responder (TugPromptEntry) directly (not a first-responder walk)
      ↓
TugPromptEntry.actions[SELECT_VALUE] runs
      ↓
Handler narrows: event.sender === routeIndicatorSenderId ? handle : noop
      ↓
setRouteState("$")              ← React state update
promptInputRef.current.setRoute("$")    ← sync input's leading atom
      ↓
TugPromptInput's imperative handle calls clear() + insertText("$")
      ↓
Editor's input-event handler detects "$" as a route prefix, fires onRouteChange("$")
      ↓
Entry's handleRouteChange("$") callback fires setRouteState("$") — React no-op (value is already "$")
      ↓
React re-renders TugPromptEntry
      ↓
TugChoiceGroup receives value="$" via its controlled prop, animates its pill via its own useLayoutEffect
```

Two things worth calling out:

- **No loop.** The second `setRouteState("$")` fires React's "same value, skip re-render" fast path because the first write already set the state. This is guaranteed by React's bail-out logic for primitive-equal updates — not by any debouncing we write.
- **`useControlDispatch` is a *targeted dispatch*** to the parent responder, bypassing the first-responder walk entirely — that is the contract per [responder-chain.md § Dispatching from a control](../tuglaws/responder-chain.md#dispatching-from-a-control). The "sender narrowing" step in the handler is defensive: the entry's parent responder might in principle receive other `SELECT_VALUE` dispatches from sibling controls (if any), and the sender match ensures we only act on the route indicator's selection.

**2. Text-prefix route detection.**

```
user types ">" in an empty input
      ↓
TugPromptInput's input-event handler fires
      ↓
Editor detects ">" is a route prefix (routePrefixes={[">", "$", ":"]})
      ↓
Editor converts the character to a route atom, emits onRouteChange(">")
      ↓
Entry's handleRouteChange(">") callback fires setRouteState(">")
      ↓
React re-renders TugPromptEntry
      ↓
TugChoiceGroup receives value=">" via its controlled prop, animates its pill
```

This path is callback-driven because the *input* is not emitting an action at the user gesture — it is reacting to its own internal state change. The input is not a chain-participant for route changes; it is a state owner that publishes a derived event. The entry subscribes to that event and propagates into its own React state, which then flows to `TugChoiceGroup` as a normal controlled-component update. Per [D04], this is a sanctioned data-through-React path (not an L06 violation).

**3. Submit / interrupt via button click.**

```
user clicks submit button
      ↓
TugPushButton.useControlDispatch({ action: SUBMIT, phase: "discrete" })
      ↓
Chain targets the parent responder (TugPromptEntry) directly
      ↓
TugPromptEntry.actions[SUBMIT] runs
      ↓
Handler reads snapRef.current.canInterrupt (live value via ref per L07)
      ↓
  canInterrupt === false:
    atoms = promptInputRef.current.getAtoms()
    text = promptInputRef.current.getText()
    handled = localCommandHandler?.(route, atoms) ?? false
    if (!handled) codeSessionStore.send(text, atoms)
    promptInputRef.current.clear()
  canInterrupt === true:
    codeSessionStore.interrupt()
```

Note: the submit button lives *below* the input in the tree, not above it. It is not the first responder; the input is. A keyboard shortcut bound to `submit` (Cmd-Return at the Tide-card level, in T3.4.c) would use a nil-targeted `sendToFirstResponder` — which walks from the input, not from the button. The input does not handle `submit` (it is not in the input's `actions` map), so the walk proceeds up to the entry, which handles it. The same entry handler runs whether the dispatch came from the button (targeted) or the keyboard shortcut (walked).

**4. Editing actions (cut / copy / paste / select-all / undo / redo).**

```
user presses Cmd-X
      ↓
Chain-level keyboard dispatcher fires sendToFirstResponder({ action: CUT })
      ↓
Walk starts at TugPromptInput (which is the first responder because the user's caret is in it)
      ↓
TugPromptInput.actions[CUT] exists → handler runs, editor cuts selection
      ↓
Walk stops; entry's handler is never reached (entry has no CUT handler)
```

The entry does **not** register for editing actions — it is the explicit non-goal [D10]. The chain handles routing for free because the input is the deepest registered node under the caret.

---

#### Phase → visual binding table {#phase-visual-binding}

This is the core contract between the store and the CSS. Every visual variation the component surfaces maps to a named `data-*` attribute on the root element. The CSS selectors are one-to-one with these attributes — no compound CSS expressions beyond a single selector join.

| Source | Root attribute | Values | CSS hook |
|---|---|---|---|
| `snap.phase` | `data-phase` | `idle`, `submitting`, `awaiting_first_token`, `streaming`, `tool_work`, `awaiting_approval`, `errored` | `.tug-prompt-entry[data-phase="idle"]` etc. |
| `snap.canInterrupt` | `data-can-interrupt` | `true` / `false` | `.tug-prompt-entry[data-can-interrupt="true"]` |
| `snap.canSubmit` | `data-can-submit` | `true` / `false` | `.tug-prompt-entry[data-can-submit="false"]` |
| `snap.queuedSends > 0` | `data-queued` | presence-only (attr set or absent) | `.tug-prompt-entry[data-queued]` |
| `snap.lastError !== null` | `data-errored` | presence-only | `.tug-prompt-entry[data-errored]` |
| `snap.pendingApproval !== null` | `data-pending-approval` | presence-only | `.tug-prompt-entry[data-pending-approval]` |
| `snap.pendingQuestion !== null` | `data-pending-question` | presence-only | `.tug-prompt-entry[data-pending-question]` |
| `promptInputRef.current.isEmpty()` | `data-empty` | `true` / `false` (direct DOM write from input's `onChange` callback) | `.tug-prompt-entry[data-empty="true"]` |

**Visual meaning** (for CSS authors):

- `data-phase="idle"` + `data-empty="true"` + `data-can-interrupt="false"`: submit button at rest, slightly dimmed, not clickable.
- `data-phase="idle"` + `data-empty="false"` + `data-can-interrupt="false"`: submit button at rest, active role color, clickable.
- `data-phase="submitting"` + `data-can-interrupt="true"`: submit button flips to interrupt role color (typically `danger`), label reads "Stop", the input area gains a subtle "in-flight" treatment (opacity shift, or border tint).
- `data-phase="streaming"` + `data-can-interrupt="true"`: same button treatment; the input's pulse animation (if any) stays on.
- `data-phase="tool_work"`: button stays "Stop"; no new visual for tool work at the entry level (tool output is rendered upstream in the card's markdown pane).
- `data-phase="awaiting_approval"` + `data-pending-approval` or `data-pending-question`: the input visually dims (approval UI lives upstream in the card body, not inside the entry) and the submit button goes disabled.
- `data-phase="errored"` + `data-errored`: the entry gains a subtle error-ring; the submit button returns to "Send" (you can retry) with the input enabled.
- `data-queued` with any phase: a small badge with the queue count renders in the toolbar, adjacent to the submit button.

**How the CSS consumer finds these:** every attribute is documented in the props interface with a `@selector` annotation per the authoring guide. A theming agent scanning for `[data-phase]` sees every phase-sensitive rule; scanning for `[data-queued]` finds the badge.

---

### Specification {#specification}

#### Spec S01: `TugPromptEntry` props interface {#s01-props}

```typescript
/**
 * TugPromptEntry — Compound composition: TugPromptInput + route indicator +
 * submit/stop button, driven by a CodeSessionStore snapshot.
 *
 * Composes TugPromptInput (editor + route detection), TugChoiceGroup (route
 * indicator), TugPushButton (submit/stop). Each composed child keeps its own
 * tokens [L20]. The entry reuses existing base-tier global/field/badge tokens per [D11].
 *
 * Laws: [L02] useSyncExternalStore for store state, [L06] appearance via
 *       CSS/DOM, [L07] handlers read state via refs, [L11] controls emit
 *       actions, [L15] token-driven states, [L16] pairings declared,
 *       [L19] component authoring guide, [L20] token sovereignty
 * Decisions: [D-T3-01] route selection, [D-T3-06] submit is interrupt,
 *            [D-T3-07] queue during turn, [D-T3-09] 1:1 card↔store
 */
export interface TugPromptEntryProps {
  /** Stable responder id. Typically `${cardId}-entry`. @selector [data-responder-id] */
  id: string;
  /** Store owning Claude Code turn state for this card. */
  codeSessionStore: CodeSessionStore;
  /** Session metadata (model name, version). Accepted for T3.4.c; unused in T3.4.b. */
  sessionMetadataStore: SessionMetadataStore;
  /** Prompt history (recall on arrow up/down). Forwarded to TugPromptInput. */
  historyStore: PromptHistoryStore;
  /** File completion for `@` trigger. Forwarded to TugPromptInput. */
  fileCompletionProvider: CompletionProvider;
  /** Drop handler for dragging files from Finder. Forwarded to TugPromptInput. */
  dropHandler?: DropHandler;
  /**
   * Optional synchronous interceptor for local `:`-surface commands. Called
   * before `codeSessionStore.send(...)` on every submission. Returning `true`
   * suppresses the store send; returning `false` or omitting the prop falls
   * through. The input is cleared on either path. [D06]
   */
  localCommandHandler?: (
    route: string | null,
    atoms: ReadonlyArray<AtomSegment>,
  ) => boolean;
  /** Caller-supplied className merged with the root. @selector standard */
  className?: string;
}

/**
 * Imperative handle exposed via forwardRef. Used by the Tide card (T3.4.c)
 * to drive focus from global keyboard shortcuts.
 */
export interface TugPromptEntryDelegate {
  /** Focus the input. */
  focus(): void;
  /**
   * Clear the input contents. Does not dispatch anything — purely visual.
   * Provided so T3.4.c's reset flows can wipe a card's entry.
   */
  clear(): void;
}
```

Data attributes written on the root — all documented in JSDoc with `@selector`:

```typescript
/** @selector [data-phase="idle" | "submitting" | ...] — from snap.phase (React-rendered) */
/** @selector [data-can-interrupt="true" | "false"] — from snap.canInterrupt (React-rendered) */
/** @selector [data-can-submit="true" | "false"] — from snap.canSubmit (React-rendered) */
/** @selector [data-queued] — presence when snap.queuedSends > 0 (React-rendered) */
/** @selector [data-errored] — presence when snap.lastError !== null (React-rendered) */
/** @selector [data-pending-approval] — presence when snap.pendingApproval !== null (React-rendered) */
/** @selector [data-pending-question] — presence when snap.pendingQuestion !== null (React-rendered) */
/** @selector [data-empty="true" | "false"] — direct DOM write from input's onChange callback + isEmpty() */
```

#### Spec S02: Responder registration {#s02-responder}

```typescript
const routeIndicatorSenderId = `${props.id}-route-indicator`;

// Live snapshot ref for [L07] — handlers read state via ref, not stale closures.
const snapRef = useRef(snap);
useLayoutEffect(() => { snapRef.current = snap; }, [snap]);

// Route state — a controlled-component value for TugChoiceGroup per [D04].
// One useState call, deliberate. L06 explicitly sanctions "selected item in
// a list" as data flowing through React.
const [route, setRouteState] = useState<string>("");

// Live route ref so the submit handler can read the current value without
// closing over the stale `route` closure variable.
const routeRef = useRef(route);
useLayoutEffect(() => { routeRef.current = route; }, [route]);

const { ResponderScope, responderRef } = useResponder({
  id: props.id,
  actions: {
    [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
      if (event.sender !== routeIndicatorSenderId) return;
      if (typeof event.value !== "string") return;
      // Update React state so the indicator re-renders with the new pill
      // position, then sync the input so the editor's leading atom matches.
      // The input's own onRouteChange fires a second setRouteState with the
      // same value — a React no-op.
      setRouteState(event.value);
      promptInputRef.current?.setRoute(event.value);
    },
    [TUG_ACTIONS.SUBMIT]: (_event: ActionEvent) => {
      const snap = snapRef.current;
      const input = promptInputRef.current;
      if (!input) return;
      if (snap.canInterrupt) {
        props.codeSessionStore.interrupt();
        return;
      }
      if (!snap.canSubmit) return; // e.g., awaiting_approval
      const atoms = input.getAtoms();
      const text = input.getText();
      const handled = props.localCommandHandler?.(routeRef.current || null, atoms) ?? false;
      if (!handled) {
        props.codeSessionStore.send(text, atoms);
      }
      input.clear();
      setRouteState(""); // reset the indicator to no-selection after submit
    },
  },
});

// Input → indicator callback: the editor fires this when the user types a
// route-prefix character as the first character of an empty input. React
// state gets the new value and TugChoiceGroup animates its pill on the next
// render cycle.
const handleRouteChange = (r: string | null) => {
  setRouteState(r ?? "");
};

// Input onChange callback: read isEmpty() from the delegate and write the
// result to data-empty on the root element directly. No React state per
// [L06] — data-empty is pure appearance (the only consumer is a CSS rule
// that disables the submit button).
const handleInputChange = () => {
  const root = rootRef.current;
  const input = promptInputRef.current;
  if (!root || !input) return;
  root.setAttribute("data-empty", String(input.isEmpty()));
};
```

The handler **reads `snapRef.current` and `routeRef.current`**, not the `snap` / `route` closure variables. This is the [L07] pattern documented in [component-authoring.md](../tuglaws/component-authoring.md) — without it, the handler would close over a stale snapshot from the render that registered the action.

#### Spec S03: Layout structure {#s03-layout}

```tsx
<ResponderScope>
  <div
    data-slot="tug-prompt-entry"
    ref={(el) => {
      rootRef.current = el;
      responderRef(el);
    }}
    data-phase={snap.phase}
    data-can-interrupt={String(snap.canInterrupt)}
    data-can-submit={String(snap.canSubmit)}
    data-errored={snap.lastError ? "" : undefined}
    data-pending-approval={snap.pendingApproval ? "" : undefined}
    data-pending-question={snap.pendingQuestion ? "" : undefined}
    data-queued={snap.queuedSends > 0 ? "" : undefined}
    data-empty="true"  // initial; updated imperatively from input's onChange callback
    className={cn("tug-prompt-entry", props.className)}
    {...rest}
  >
    <TugPromptInput
      ref={promptInputRef}
      historyStore={props.historyStore}
      fileCompletionProvider={props.fileCompletionProvider}
      dropHandler={props.dropHandler}
      routePrefixes={[">", "$", ":"]}
      onRouteChange={handleRouteChange}
      onChange={handleInputChange}
    />
    <div className="tug-prompt-entry-toolbar">
      <TugChoiceGroup
        items={ROUTE_ITEMS}
        value={route}
        senderId={routeIndicatorSenderId}
        size="sm"
        aria-label="Command route"
      />
      {snap.queuedSends > 0 && (
        <span className="tug-prompt-entry-queue-badge" aria-live="polite">
          {snap.queuedSends}
        </span>
      )}
      <TugPushButton
        action={TUG_ACTIONS.SUBMIT}
        role={snap.canInterrupt ? "danger" : "action"}
        disabled={!snap.canSubmit && !snap.canInterrupt}
        aria-label={snap.canInterrupt ? "Stop turn" : "Send prompt"}
      >
        {snap.canInterrupt ? "Stop" : "Send"}
      </TugPushButton>
    </div>
  </div>
</ResponderScope>
```

Where:
- `ROUTE_ITEMS` is a module-level constant: `[{value: ">", label: ">"}, {value: "$", label: "$"}, {value: ":", label: ":"}]`.
- `rootRef` is a `useRef<HTMLDivElement | null>(null)` local to the component for direct `data-empty` writes.
- `route` is the single `useState<string>` value per [D04]; empty string `""` means no route selected (TugChoiceGroup renders with no pill highlight when `value` does not match any item).
- `handleRouteChange(r)` and `handleInputChange()` are defined in Spec S02 above.
- `promptInputRef` is a `useRef<TugPromptInputDelegate | null>(null)` — the widened delegate type from Spec S04.
- `props` is destructured from the outer function signature; `rest` is whatever's left after destructuring all named props.
- `TugChoiceGroup` is a controlled component: it derives its pill position from `value` via its own `useLayoutEffect` (see `tug-choice-group.tsx` lines 77–160). No ref on the indicator — React state is the only working update path. [D04]
- `cn()` is the standard class-merging helper from `lib/utils.ts`.

#### Spec S04: `TugPromptInput.setRoute(char)` via widened delegate {#s04-set-route}

**Type-level change (in `tug-prompt-input.tsx`):** Define a new interface `TugPromptInputDelegate` that extends the existing `TugTextInputDelegate` from `tug-text-engine.ts`, adding `setRoute`. Widen the component's `forwardRef` type to expose the new interface.

```typescript
// In tug-prompt-input.tsx, after library imports, before component.
import type { TugTextInputDelegate } from "@/lib/tug-text-engine";

/**
 * Widened imperative handle for TugPromptInput. Extends the engine-level
 * TugTextInputDelegate with composition-layer methods that belong to this
 * component (route atoms are a first-class concept here). Kept separate
 * from the engine delegate so the UITextInput-inspired primitive contract
 * in tug-text-engine.ts stays free of composition-layer concepts. [Q01]
 */
export interface TugPromptInputDelegate extends TugTextInputDelegate {
  /**
   * Set the leading route atom to `char`. Clears the input and inserts a
   * single route-prefix character, triggering the existing route-detection
   * path (which fires `onRouteChange(char)` as a side effect). Used by
   * TugPromptEntry when the user clicks a segment in the route indicator.
   *
   * @param char — one of the configured route prefix characters (e.g., `">"`, `"$"`, `":"`)
   */
  setRoute(char: string): void;
}
```

**forwardRef type widening:**

```typescript
// Current:  React.forwardRef<TugTextInputDelegate, TugPromptInputProps>
// Change to:
export const TugPromptInput = React.forwardRef<TugPromptInputDelegate, TugPromptInputProps>(
  function TugPromptInput(props, ref) { /* ... */ }
);
```

**Imperative handle body addition (inside the existing `useImperativeHandle` block):**

```typescript
useImperativeHandle(ref, () => ({
  // ... existing TugTextInputDelegate methods (clear, insertText, selectAll, …) …
  setRoute(char: string): void {
    // Reuse engine-level primitives the delegate already owns.
    // The leading insertText triggers the existing route-detection path,
    // which fires onRouteChange(char) as a side effect.
    this.clear();
    this.insertText(char);
  },
}));
```

**No changes to `tug-text-engine.ts`.** The engine's `TugTextInputDelegate` stays unchanged — `setRoute` is not an engine primitive, it is a composition-layer convenience that happens to call into primitives.

Unit tests in `__tests__/tug-prompt-input.test.tsx` cover:
- `setRoute(">")` on an empty input produces exactly one route atom at position 0.
- `setRoute("$")` on a non-empty input wipes the prior content and leaves exactly one `$` route atom.
- `setRoute(">")` fires `onRouteChange(">")` once via the existing detection path.
- `setRoute("not-a-prefix")` is a no-op for route detection (it inserts the character but does not fire `onRouteChange`) — the entry is responsible for not passing garbage.
- A ref typed `RefObject<TugPromptInputDelegate>` can call both inherited `TugTextInputDelegate` methods (`clear`, `insertText`, `focus`, `isEmpty`, …) and the new `setRoute` method. (Type-level test; a compile-failing assertion would catch regressions.)

#### Spec S05: Action vocabulary preconditions {#s05-action-vocab}

Verify in Step 1:

- `TUG_ACTIONS.SELECT_VALUE` exists. (**Confirmed.** Used by existing choice groups and tab bars.)
- `TUG_ACTIONS.SUBMIT` exists. **Unverified** — may need to be added. If added, the constant is `"submit"` with JSDoc noting: "Dispatched by a form or submission-shaped control to mean 'commit the current draft intent.' The responder handler reads the live state from the store or delegate at dispatch time (per [L07]) to decide what 'commit' means — send, interrupt, save, etc. Phase is always `discrete`."

#### Spec S06: Mock driver API for sandbox card {#s06-mock-driver}

```typescript
// Inside gallery-prompt-entry-sandbox.tsx, as a local module-scope helper.

/**
 * A tiny set of synthetic frame factories that cover every phase transition
 * TugPromptEntry surfaces. Each returns a decoded payload matching the
 * v2.1.105 wire shape for the named event.
 */
const SYNTHETIC = {
  sessionInit: (tsid: string, sessionId: string) => ({ type: "session_init", session_id: sessionId, tug_session_id: tsid }),
  assistantPartial: (tsid: string, msgId: string, text: string, rev: number, seq: number) => ({
    type: "assistant_text", tug_session_id: tsid, msg_id: msgId, text, is_partial: true, rev, seq,
  }),
  assistantFinal: (tsid: string, msgId: string, text: string, rev: number) => ({
    type: "assistant_text", tug_session_id: tsid, msg_id: msgId, text, is_partial: false, rev,
  }),
  toolUse: (tsid: string, toolUseId: string, toolName: string, input: unknown) => ({
    type: "tool_use", tug_session_id: tsid, tool_use_id: toolUseId, tool_name: toolName, input,
  }),
  toolResult: (tsid: string, toolUseId: string, output: unknown) => ({
    type: "tool_result", tug_session_id: tsid, tool_use_id: toolUseId, output, is_error: false,
  }),
  turnCompleteSuccess: (tsid: string, msgId: string) => ({
    type: "turn_complete", tug_session_id: tsid, msg_id: msgId, result: "success",
  }),
  turnCompleteError: (tsid: string, msgId: string) => ({
    type: "turn_complete", tug_session_id: tsid, msg_id: msgId, result: "error",
  }),
  controlRequestApproval: (tsid: string, requestId: string, toolName: string) => ({
    type: "control_request_forward", tug_session_id: tsid, request_id: requestId,
    is_question: false, tool_name: toolName, input: {},
  }),
  controlRequestQuestion: (tsid: string, requestId: string, question: string) => ({
    type: "control_request_forward", tug_session_id: tsid, request_id: requestId,
    is_question: true, question, options: [],
  }),
  sessionStateErrored: (tsid: string, detail: string) => ({
    tug_session_id: tsid, state: "errored", detail,
  }),
  controlSessionUnknown: (tsid: string) => ({
    type: "error", detail: "session_unknown", tug_session_id: tsid,
  }),
} as const;
```

The sandbox card's driver panel exposes buttons labeled after each factory; clicking a button calls `mockConnection.dispatchDecoded(feedId, payload)` with the corresponding frame. A small "run sequence" button at the bottom plays a canned happy-path turn (session_init → user sends → submitting → awaiting_first_token → streaming → turn_complete_success → idle).

#### Spec S07: `@tug-pairings` table — the entry's exact token contract {#s07-pairings}

Per [D11], `TugPromptEntry` reuses existing base-tier tokens. This spec is the definitive list of contrast pairings the entry's CSS declares. The implementer copies this table into `tug-prompt-entry.css`'s header — both the compact format (for `audit:tokens lint`) and the expanded table (for human readers).

**Compact format** (machine-readable):

```css
/* @tug-pairings {
  --tug7-element-global-border-normal-default-rest | --tug7-surface-global-primary-normal-control-rest | informational
  --tug7-element-badge-text-tinted-action-rest     | --tug7-surface-badge-primary-tinted-action-rest    | content
  --tug7-element-field-border-normal-danger-rest   | --tug7-surface-global-primary-normal-control-rest | informational
} */
```

**Expanded table** (human-readable):

```css
/**
 * @tug-pairings
 * | Element                                             | Surface                                              | Role          | Context                                                        |
 * |-----------------------------------------------------|------------------------------------------------------|---------------|----------------------------------------------------------------|
 * | --tug7-element-global-border-normal-default-rest    | --tug7-surface-global-primary-normal-control-rest   | informational | .tug-prompt-entry-toolbar (border-top) — divider above toolbar |
 * | --tug7-element-badge-text-tinted-action-rest        | --tug7-surface-badge-primary-tinted-action-rest     | content       | .tug-prompt-entry-queue-badge (color + background)             |
 * | --tug7-element-field-border-normal-danger-rest      | --tug7-surface-global-primary-normal-control-rest   | informational | .tug-prompt-entry[data-errored] (outline) — errored ring       |
 */
```

**How each pairing is consumed:**

| Rule | Token (element) | Token (surface) | Purpose |
|---|---|---|---|
| `.tug-prompt-entry` base container | — | `--tug7-surface-global-primary-normal-control-rest` | Background matches `TugPromptInput`'s surface; the container is a visual extension of the input. No foreground rule on the bare container. |
| `.tug-prompt-entry-toolbar` | `--tug7-element-global-border-normal-default-rest` (border-top) | `--tug7-surface-global-primary-normal-control-rest` | Divider above toolbar + same background as the container. `@tug-renders-on` annotation names the surface. |
| `.tug-prompt-entry-queue-badge` | `--tug7-element-badge-text-tinted-action-rest` (color) | `--tug7-surface-badge-primary-tinted-action-rest` (background-color) | Small pill badge showing the queue count, colored with the `action` role to match the submit button's rest-state semantics. |
| `.tug-prompt-entry[data-errored]` | `--tug7-element-field-border-normal-danger-rest` (outline) | `--tug7-surface-global-primary-normal-control-rest` | Errored ring rendered as `outline` (not `border`) so it sits outside the container's edge without shifting layout. `@tug-renders-on` names the surface. |

**What the pairings explicitly do NOT cover:**

- `TugPromptInput`'s own text, border, and focus-ring colors — owned by `tug-prompt-input.css`.
- `TugChoiceGroup`'s segment backgrounds, pill positioning, and active-state colors — owned by `tug-choice-group.css`.
- `TugPushButton`'s label color, emphasis/role treatment, and disabled state — owned by `tug-push-button.css` and its internal `tug-button.css`.
- Phase-sensitive color treatments that merely select among the above tokens via `data-*` selectors — those are state selectors, not new pairings. They select existing tokens, not introduce new contrast relationships.

**Theme-file verification (pre-Step-2 preflight):**

Before Step 2's CSS lands, the implementer greps both theme files to confirm every pairing token resolves:

```bash
for tok in \
  --tug7-element-global-border-normal-default-rest \
  --tug7-surface-global-primary-normal-control-rest \
  --tug7-element-badge-text-tinted-action-rest \
  --tug7-surface-badge-primary-tinted-action-rest \
  --tug7-element-field-border-normal-danger-rest; do
  rg -l "$tok" tugdeck/styles/themes/ || echo "MISSING: $tok"
done
```

Expected: every token resolves in both `brio.css` and `harmony.css`. If any `MISSING:` line appears, Step 2 halts and [D11] is re-opened.

**Phase-sensitive CSS selectors (not pairings — these consume the tokens above):**

These selectors are the "state" layer: they apply the tokens above under different conditions. They do not introduce new contrast relationships; `audit:tokens lint` sees them as rule-level `@tug-renders-on` annotations against the same surfaces.

| Selector | Effect | Tokens consumed |
|---|---|---|
| `.tug-prompt-entry[data-phase="idle"]` | Default state; no special treatment. | (inherit from base) |
| `.tug-prompt-entry[data-phase="submitting"], .tug-prompt-entry[data-phase="streaming"], .tug-prompt-entry[data-phase="tool_work"]` | In-flight turn; the container's background stays, but the submit button's role flip (via `snap.canInterrupt` on the button prop) is what the user sees. | (no new tokens; delegates to `TugPushButton`'s `role="danger"` path) |
| `.tug-prompt-entry[data-phase="awaiting_approval"]` | Dim the input area via `opacity: 0.6` (pure CSS, no token) and disable pointer events. Approval UI itself lives upstream in the card body. | (no new tokens) |
| `.tug-prompt-entry[data-errored]` | Show the errored ring via `outline`. | `--tug7-element-field-border-normal-danger-rest` (from pairing table) |
| `.tug-prompt-entry[data-empty="true"]` | Target the submit button's visual via a wrapper-level selector, not descendant selector on the button. Concretely: the wrapper element wrapping the button carries an `opacity` or `pointer-events` treatment; the button itself is untouched. | (no new tokens; purely structural CSS) |
| `.tug-prompt-entry[data-queued]` .tug-prompt-entry-queue-badge` | Badge visibility is handled by the conditional JSX render in Spec S03, not a CSS selector — when `snap.queuedSends > 0` is false, the `<span>` is simply not in the DOM. The `data-queued` attribute is redundant but retained for CSS authors who want to target parent-level layout adjustments. | (no new tokens) |

**Component-tier aliases (optional, [L17]-compliant):**

If any token reference in the entry's CSS appears more than once, the implementer may introduce a `--tugx-prompt-entry-*` alias in `body {}` at the top of the CSS file. Each alias must resolve to a base-tier `--tug7-*` token in one hop. Example:

```css
body {
  /* Component-tier aliases — single hop to base tier per [L17]. */
  --tugx-prompt-entry-surface: var(--tug7-surface-global-primary-normal-control-rest);
  --tugx-prompt-entry-divider: var(--tug7-element-global-border-normal-default-rest);
  --tugx-prompt-entry-errored: var(--tug7-element-field-border-normal-danger-rest);
}
```

These aliases are local to `tug-prompt-entry.css`; they do not land in the theme files.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| Path | Purpose |
|---|---|
| `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | Component implementation + props + delegate |
| `tugdeck/src/components/tugways/tug-prompt-entry.css` | Component styles, `@tug-pairings`, token scope |
| `tugdeck/src/components/tugways/__tests__/tug-prompt-entry.test.tsx` | Vitest suite |
| `tugdeck/src/components/tugways/cards/gallery-prompt-entry.tsx` | Pristine showcase gallery card |
| `tugdeck/src/components/tugways/cards/gallery-prompt-entry.css` | Minimal card layout |
| `tugdeck/src/components/tugways/cards/gallery-prompt-entry-sandbox.tsx` | Interactive driver card |
| `tugdeck/src/components/tugways/cards/gallery-prompt-entry-sandbox.css` | Driver panel layout |

#### Edited files {#edited-files}

| Path | Change |
|---|---|
| `tugdeck/src/components/tugways/tug-prompt-input.tsx` | Add `setRoute(char)` to imperative handle; JSDoc |
| `tugdeck/src/components/tugways/__tests__/tug-prompt-input.test.tsx` | Add `setRoute` unit tests |
| `tugdeck/src/components/tugways/action-vocabulary.ts` | Add `TUG_ACTIONS.SUBMIT` if missing |
| `tugdeck/src/main.tsx` | Register both new gallery cards |

#### New exported symbols {#symbols-new}

- `TugPromptEntry` (React component, `forwardRef` with `TugPromptEntryDelegate`)
- `TugPromptEntryProps` (interface)
- `TugPromptEntryDelegate` (interface)

#### Modified exported symbols {#symbols-modified}

- `TugPromptInput` delegate gains `setRoute(char: string): void`
- `TUG_ACTIONS.SUBMIT` (if added) — string constant

---

### Documentation Plan {#documentation-plan}

- **Module docstring** on `tug-prompt-entry.tsx` cites the minimum law set plus composition-specific laws: `[L02], [L06], [L07], [L11], [L15], [L16], [L19], [L20]`. Decisions: `[D-T3-01], [D-T3-06], [D-T3-07], [D-T3-09]`.
- **Props JSDoc** on every CSS-targetable prop and every `data-*` attribute written to the root — `@selector` annotations point at the exact attribute selectors.
- **CSS file opens with `@tug-pairings`** in both compact and expanded formats. Every rule that sets `color` without `background-color` in the same rule carries `@tug-renders-on`. Any component-tier aliases live in `body {}` and resolve to base `--tug7-*` tokens in one hop per [L17].
- **Gallery cards**: each card's module docstring names the component it previews and lists the mocks it constructs. The sandbox card's docstring explicitly calls out "uses MockTugConnection for dev-only state-machine exploration — not a test harness."
- **`dash/tide.md` update**: mark T3.4.b as `✓ LANDED` in `#execution-order-table` after Step 7, and append a brief status line to §T3.4.b pointing at this plan.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test categories {#test-categories}

1. **Imperative-method tests** (`tug-prompt-input.test.tsx` extension): `setRoute(">")`, `setRoute("$")` on empty + non-empty; `onRouteChange` side-effect firing; position invariants.
2. **Rendering tests** (`tug-prompt-entry.test.tsx`): root `data-slot`, root `data-responder-id`, initial `data-phase="idle"`, initial `data-empty="true"`, `data-can-interrupt="false"`, queue badge absent.
3. **Snapshot-binding tests**: advance the mock store through each phase; assert the root's `data-phase` changes; assert no React state updates inside the entry via a render-counter ref.
4. **Responder handler tests**: dispatch `TUG_ACTIONS.SELECT_VALUE` with correct sender → delegate called; with wrong sender → delegate not called; dispatch `TUG_ACTIONS.SUBMIT` while `canInterrupt: false` → `codeSessionStore.send` called with current text + atoms; dispatch `TUG_ACTIONS.SUBMIT` while `canInterrupt: true` → `codeSessionStore.interrupt` called.
5. **Delegate tests**: `delegate.focus()` forwards to input's `focus()`; `delegate.clear()` forwards to input's `clear()`.
6. **`localCommandHandler` tests**: returning `true` suppresses send but still clears input; returning `false` allows send; omitting the prop is equivalent to `false`.
7. **Queue-badge tests**: `snap.queuedSends: 0` → badge absent; `snap.queuedSends: 1` → badge present with text `"1"`; transition back to `0` → badge removed. No React state updates inside the entry for this transition.
8. **Error-ring test**: dispatching a `SESSION_STATE errored` frame through the mock sets `data-errored` on the root.

#### What the tests do NOT cover {#test-categories-excluded}

- Exact token values or CSS output (enforced by `audit:tokens lint`, not unit tests)
- Exact class names beyond `tug-prompt-entry` and `tug-prompt-entry-toolbar`
- Snapshot tests of the rendered DOM
- Pixel layout
- Theme variation (gallery + `audit:tokens lint` own theming)
- Full turn flow against a golden fixture (the store's own tests cover that)

---

### Execution Steps {#execution-steps}

#### Step 1: Preconditions — widened `TugPromptInputDelegate` + `setRoute` + action vocab {#step-1}

<!-- Step 1 has no dependencies: it establishes prerequisites before the component work begins. -->

**Commit:** `feat(tugdeck): add setRoute to TugPromptInput via widened delegate`

**References:** [Q01] setRoute location via widened delegate, [Q02] submit action name, [D05] submit/interrupt unified, Spec S04, Spec S05, (#s04-set-route, #s05-action-vocab)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-prompt-input.tsx` — new exported interface `TugPromptInputDelegate extends TugTextInputDelegate` adding `setRoute(char: string): void`; `forwardRef` type widened to `<TugPromptInputDelegate, TugPromptInputProps>`; new `setRoute` entry in the existing `useImperativeHandle` block implemented as `{ this.clear(); this.insertText(char); }`.
- `tugdeck/src/components/tugways/__tests__/tug-prompt-input.test.tsx` — new unit tests for `setRoute` covering empty/non-empty/edge-case paths per Spec S04.
- `tugdeck/src/components/tugways/action-vocabulary.ts` — `TUG_ACTIONS.SUBMIT = "submit"` added if missing, with JSDoc noting "dispatched by a form or submission-shaped control; responder reads live state at dispatch time; phase is always `discrete`."

**Tasks:**
- [ ] Read the existing `useImperativeHandle` block in `tug-prompt-input.tsx` and confirm `clear()` + `insertText(char)` are suitable primitives for `setRoute`.
- [ ] Define `TugPromptInputDelegate extends TugTextInputDelegate` at the top of `tug-prompt-input.tsx` (after library imports, before the component) with JSDoc citing [Q01] for the layering rationale.
- [ ] Widen the `forwardRef` generic from `TugTextInputDelegate` to `TugPromptInputDelegate`.
- [ ] Add `setRoute(char: string): void` to the existing `useImperativeHandle` return block as `{ this.clear(); this.insertText(char); }` with JSDoc.
- [ ] Do **not** modify `tug-text-engine.ts`. The engine-level `TugTextInputDelegate` stays a UITextInput-inspired primitive contract with no composition-layer concepts.
- [ ] Do **not** add a new `onInputChange` prop. The existing `onChange?: () => void` prop on `TugPromptInputProps` (line 212 of `tug-prompt-input.tsx`) already fires once per user-driven input event — that's the prop `TugPromptEntry` will consume for `data-empty`. Inventing `onInputChange` would produce a dead-code duplicate.
- [ ] Verify `TUG_ACTIONS.SUBMIT` exists in `action-vocabulary.ts`; add it if missing with `discrete` phase semantics in the JSDoc.
- [ ] Extend `__tests__/tug-prompt-input.test.tsx` with the `setRoute` coverage matrix per Spec S04.

**Tests:**
- [ ] `setRoute(">")` on an empty input produces exactly one route atom at position 0.
- [ ] `setRoute("$")` on a non-empty input wipes prior content and leaves exactly one `$` route atom.
- [ ] `setRoute(">")` fires `onRouteChange(">")` once via the existing detection path.
- [ ] `setRoute("not-a-prefix")` is a no-op for route detection (the character is inserted but `onRouteChange` does not fire).
- [ ] Type-level: a variable declared `const ref: RefObject<TugPromptInputDelegate>` can call both inherited methods (`clear`, `insertText`, `focus`) and the new `setRoute`. (A compile-failing assertion file or inline type-assertion test is acceptable.)

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun run test`
- [ ] `rg 'setRoute' tugdeck/src/components/tugways/tug-prompt-input.tsx` returns at least one match.
- [ ] `rg 'TugPromptInputDelegate' tugdeck/src/components/tugways/tug-prompt-input.tsx` returns at least one match.
- [ ] `rg 'TUG_ACTIONS\.SUBMIT' tugdeck/src/components/tugways/action-vocabulary.ts` returns at least one match.
- [ ] `rg 'onInputChange' tugdeck/src/components/tugways/tug-prompt-input.tsx` returns zero matches (the existing `onChange` prop is the observation path).
- [ ] `rg 'setRoute' tugdeck/src/lib/tug-text-engine.ts` returns zero matches (the engine delegate is unchanged).

---

#### Step 2: Component scaffold + token wiring {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): scaffold TugPromptEntry component`

**References:** [D01] compound composition, [D02] snapshot drives data-attributes, [D04] route state via useState, [D09] responder id from parent, [D11] reuse existing tokens, Spec S01, Spec S02, Spec S03, Spec S07, (#phase-visual-binding, #s01-props, #s02-responder, #s03-layout, #s07-pairings)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` — component file with props interface, `forwardRef` + `useImperativeHandle`, layout skeleton per Spec S03, `useSyncExternalStore` snapshot read, `useState<string>` for the route per [D04], responder registration with a **no-op `submit` handler stub** + the real `select-value` handler shape ready for Step 4.
- `tugdeck/src/components/tugways/tug-prompt-entry.css` — CSS file with the full `@tug-pairings` block from Spec S07 (compact + expanded), optional component-tier aliases in `body {}`, `@tug-renders-on` annotations on every color-setting rule, base block styles for `.tug-prompt-entry` + `.tug-prompt-entry-toolbar`, and the errored-ring + queue-badge rules consuming the Spec S07 tokens. This is the component's full styling foundation — not a stub.
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry.test.tsx` — new vitest file with a single rendering smoke test.

**Tasks:**
- [ ] **Token preflight.** Run the theme-file verification loop from Spec S07 against `brio.css` + `harmony.css`. Every pairing token must resolve in both files. If any token is missing, **halt Step 2** and re-open [D11] — do not author missing tokens as a silent side-quest.
- [ ] Create `tug-prompt-entry.tsx` with module docstring citing the minimum law set ([L02], [L06], [L07], [L11], [L15], [L16], [L19], [L20]) plus [D-T3-01, D-T3-06, D-T3-07, D-T3-09].
- [ ] Export `TugPromptEntryProps` per Spec S01, including every CSS-targetable `data-*` attribute in JSDoc with `@selector` annotations.
- [ ] Export `TugPromptEntryDelegate` interface (empty for now, filled in Step 3).
- [ ] Implement component body: one `useSyncExternalStore(codeSessionStore.subscribe, codeSessionStore.getSnapshot)` call, `useRef` for the input delegate anchor + `rootRef` + `snapRef`, **one `useState<string>("")` for the route** per [D04]. No other React state.
- [ ] Register `useResponder` with a **no-op `TUG_ACTIONS.SUBMIT` handler stub** — `[TUG_ACTIONS.SUBMIT]: () => {}` — so `TugPushButton`'s chain-action mode sees `nodeCanHandle` return true and does not render the button as aria-disabled. Step 5 replaces the stub with the real branching handler. This is explicitly called out in the task list so the stub is not forgotten.
- [ ] Also register `TUG_ACTIONS.SELECT_VALUE` in the same map, with a signature-correct but functionally-empty body (narrow on sender + on string value, then do nothing). Step 4 fills in the body.
- [ ] Write JSX per Spec S03 with `data-slot="tug-prompt-entry"`, the merged `rootRef`/`responderRef` ref callback, `value={route}` on `TugChoiceGroup`, and `{snap.canInterrupt ? "Stop" : "Send"}` as button child content.
- [ ] **Create `tug-prompt-entry.css` with the full Spec S07 contents:** both compact and expanded `@tug-pairings` blocks at the top of the file; optional `body {}` aliases if any token appears more than once; base styles for `.tug-prompt-entry` (flex column, `background-color: var(--tug7-surface-global-primary-normal-control-rest)`, `min-height: 0`); `.tug-prompt-entry-toolbar` (flex row, `border-top: 1px solid var(--tug7-element-global-border-normal-default-rest)`, padding + gap); `.tug-prompt-entry-queue-badge` (compact pill, `background-color: var(--tug7-surface-badge-primary-tinted-action-rest)`, `color: var(--tug7-element-badge-text-tinted-action-rest)`, font size/padding); `.tug-prompt-entry[data-errored]` (errored ring via `outline: 2px solid var(--tug7-element-field-border-normal-danger-rest)`, `outline-offset: -2px`). Every color-setting rule that does not also set `background-color` in the same rule carries a `@tug-renders-on` annotation naming the surface. No descendant selectors that reach into composed children.
- [ ] **Verify the component renders with actual visual chrome** against a `MockTugConnection`-backed store in the Step 2 smoke test. The test asserts computed styles — e.g., `getComputedStyle(root).backgroundColor !== ""` — to catch the "CSS was declared but didn't apply" failure mode. JSDOM computed-style limitations: the test falls back to asserting the presence of the class names and `data-*` attributes if numeric computed styles are unreliable in the test environment.
- [ ] Create smoke test that renders the component against a `MockTugConnection`-backed store.

**Tests:**
- [ ] Component renders without throwing against a minimal `MockTugConnection`-backed store.
- [ ] Root element has `data-slot="tug-prompt-entry"` and `data-responder-id="<supplied id>"`.
- [ ] Initial snapshot state → `data-phase="idle"`, `data-can-interrupt="false"` on root.
- [ ] Submit button renders NOT aria-disabled (because the no-op `submit` handler stub is registered, so `nodeCanHandle` returns true). This is the key verification that the transient-state fix from Risk R04 works.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun run test tug-prompt-entry`
- [ ] `cd tugdeck && bun run audit:tokens lint`
- [ ] `rg 'useState' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns exactly 1 match (the route state).
- [ ] `rg 'useReducer' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches.
- [ ] `rg '@tug-pairings' tugdeck/src/components/tugways/tug-prompt-entry.css` returns at least one match.

---

#### Step 3: Input delegate wiring + `data-empty` {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugdeck): wire TugPromptEntry input delegate + data-empty`

**References:** [D02] snapshot drives data-attributes, Spec S01, Spec S02, Spec S03, (#responder-wiring, #s03-layout)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` — `TugPromptEntryDelegate` populated with `focus()` and `clear()`; `forwardRef` wired to expose it via `useImperativeHandle`; `handleInputChange` callback that reads `promptInputRef.current.isEmpty()` and writes `data-empty` to the root element via `rootRef`; wired to the input's existing `onChange` prop (not a new `onInputChange`).
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry.test.tsx` — delegate forwarding tests + `data-empty` tests.

**Tasks:**
- [ ] Verify `promptInputRef` (widened to `TugPromptInputDelegate` from Step 1) is typed correctly to see the inherited `TugTextInputDelegate` methods (`focus`, `clear`, `isEmpty`, …).
- [ ] Verify `rootRef` from Step 2 is in scope for direct DOM writes.
- [ ] Implement `handleInputChange()` — no arguments, no return — that reads `promptInputRef.current?.isEmpty()` and writes `data-empty` to `rootRef.current` via `setAttribute("data-empty", String(isEmpty))`.
- [ ] Wire `handleInputChange` to the input's **existing `onChange` prop**: `<TugPromptInput onChange={handleInputChange} />`. Do **not** pass `onInputChange`; that prop does not exist (see Step 1 + Risk R02 mitigation).
- [ ] Implement `TugPromptEntryDelegate.focus()` as a pass-through to `promptInputRef.current?.focus()`.
- [ ] Implement `TugPromptEntryDelegate.clear()` as a pass-through to `promptInputRef.current?.clear()`.
- [ ] Expose the delegate via `useImperativeHandle(ref, ...)` on the component's own `forwardRef<TugPromptEntryDelegate, TugPromptEntryProps>` signature.

**Tests:**
- [ ] Initial mount → `data-empty="true"` on root.
- [ ] Typing a character → `data-empty="false"` on root. Assert via a render-counter ref that the entry did NOT re-render between the keystroke and the attribute change (pure DOM write, no React state update for this path).
- [ ] Backspacing back to empty → `data-empty="true"`.
- [ ] `ref.current.focus()` on the delegate calls `TugPromptInput.focus()`.
- [ ] `ref.current.clear()` on the delegate calls `TugPromptInput.clear()`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun run test tug-prompt-entry`
- [ ] `rg 'onInputChange' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches (use existing `onChange`).

---

#### Step 4: Route indicator bidirectional sync via React state {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugdeck): wire TugPromptEntry route state + indicator sync`

**References:** [D04] route state via useState, [Q01] setRoute delegate, Spec S02, Spec S03, (#responder-wiring)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` — stable `routeIndicatorSenderId` constant derived from `props.id`; `handleRouteChange(r)` callback that calls `setRouteState(r ?? "")`; `TUG_ACTIONS.SELECT_VALUE` responder handler (body filled in from Step 2's stub) that narrows on `event.sender === routeIndicatorSenderId`, narrows on `typeof event.value === "string"`, calls `setRouteState(event.value)`, and calls `promptInputRef.current.setRoute(event.value)` to sync the input.
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry.test.tsx` — route sync tests for both directions.

**Tasks:**
- [ ] Add `routeIndicatorSenderId = \`${props.id}-route-indicator\`` constant inside the component.
- [ ] Verify `<TugChoiceGroup>` is rendered with `value={route}` (from the `useState` added in Step 2), `senderId={routeIndicatorSenderId}`, `items={ROUTE_ITEMS}`. **No `ref` on the indicator** — TugChoiceGroup is controlled via its `value` prop, not imperatively. Writing a ref-based `data-route` attribute would not move the pill because `TugChoiceGroup` derives pill position from `value` in its own `useLayoutEffect`.
- [ ] Verify `<TugPromptInput routePrefixes={[">", "$", ":"]} onRouteChange={handleRouteChange} onChange={handleInputChange} />` is in place.
- [ ] Implement `handleRouteChange(r: string | null)` that calls `setRouteState(r ?? "")`. This is input → indicator: when the editor detects a route prefix and fires `onRouteChange`, React state updates and TugChoiceGroup animates its pill on the next render.
- [ ] Replace the Step 2 no-op body of the `TUG_ACTIONS.SELECT_VALUE` handler with the real implementation per Spec S02: narrow on `event.sender === routeIndicatorSenderId` + `typeof event.value === "string"`; then `setRouteState(event.value)` + `promptInputRef.current?.setRoute(event.value)`. The second call fires `onRouteChange` inside the input, which calls `setRouteState` with the same value — React bails out because the value is equal, so no re-render loop.
- [ ] Verify `routeRef` (from Spec S02) stays in sync via `useLayoutEffect(() => { routeRef.current = route; }, [route])` — needed by the submit handler in Step 5 to read the current route through a ref per [L07].

**Tests:**
- [ ] Typing `">"` in an empty input fires the input's `onRouteChange(">")`, the entry's `handleRouteChange(">")` runs, `route` state becomes `">"`, and the rendered TugChoiceGroup has `value=">"` (asserted by the pill's `data-state="active"` on the `>` segment).
- [ ] Dispatching `TUG_ACTIONS.SELECT_VALUE` with `sender === routeIndicatorSenderId` and `value: "$"` causes `route` state to become `"$"` AND `promptInputRef.current.setRoute("$")` to be called; the input's first character is the `$` route atom.
- [ ] Dispatching `TUG_ACTIONS.SELECT_VALUE` with a different sender is a no-op (state unchanged, delegate not called).
- [ ] Dispatching `TUG_ACTIONS.SELECT_VALUE` with `typeof value !== "string"` is a no-op (defensive narrowing per [L11]).
- [ ] After a SELECT_VALUE dispatch, the input's `setRoute` → `onRouteChange` round-trip calls `setRouteState` a second time with the same value; verify (via a render-counter ref) that React bails out and does not re-render the entry twice for a single dispatch.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun run test tug-prompt-entry`
- [ ] `rg 'data-route' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches (the previous plan revision used `data-route`; that approach is now explicitly abandoned per [D04]).
- [ ] `rg 'routeIndicatorRef' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches (no ref on the controlled indicator).

---

#### Step 5: Submit / interrupt + queue badge + error ring {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugdeck): wire TugPromptEntry submit + interrupt + queue`

**References:** [D03] label as children, [D05] submit/interrupt unified, [D06] localCommandHandler seam, [D11] reuse existing tokens, [Q04] handler state via ref, Spec S01, Spec S02, Spec S03, Spec S07, (#phase-visual-binding, #responder-wiring, #s07-pairings)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-prompt-entry.tsx` — `snapRef` synced via `useLayoutEffect`; `routeRef` synced via `useLayoutEffect` (from Step 4); `TUG_ACTIONS.SUBMIT` responder handler **replaces the Step 2 no-op stub** with the real branching implementation reading `snapRef.current.canInterrupt` to branch between `codeSessionStore.send(...)` and `codeSessionStore.interrupt()`; `localCommandHandler` invocation inside the send path using `routeRef.current`; post-submit `setRouteState("")` reset; queue badge rendered conditionally from `snap.queuedSends > 0`; button label rendered as `{snap.canInterrupt ? "Stop" : "Send"}`; `data-errored` / `data-pending-approval` / `data-pending-question` / `data-queued` / `data-can-submit` attributes wired to snapshot per Spec S03.
- `tugdeck/src/components/tugways/tug-prompt-entry.css` — full phase-sensitive selectors per the §Phase → visual binding table, queue-badge styles under `.tug-prompt-entry-queue-badge`.
- `tugdeck/src/components/tugways/__tests__/tug-prompt-entry.test.tsx` — full snapshot-binding + responder-handler test coverage.

**Tasks:**
- [ ] Confirm `snapRef = useRef(snap)` + `useLayoutEffect(() => { snapRef.current = snap; }, [snap])` is in place so handlers read live state per [L07].
- [ ] Confirm `routeRef = useRef(route)` + `useLayoutEffect(() => { routeRef.current = route; }, [route])` is in place (from Step 4).
- [ ] **Replace** the Step 2 no-op `TUG_ACTIONS.SUBMIT` handler with the real implementation per Spec S02.
- [ ] Real handler body: read `snapRef.current` and `promptInputRef.current`; return if no input. If `canInterrupt`, call `codeSessionStore.interrupt()` and return. Else if `!canSubmit`, return (e.g., `awaiting_approval`). Else: compute `atoms = input.getAtoms()`, `text = input.getText()`, `route = routeRef.current || null`; invoke `localCommandHandler?.(route, atoms)`; if not handled, call `codeSessionStore.send(text, atoms)`; clear the input; call `setRouteState("")` to reset the indicator after submit.
- [ ] Verify `<TugPushButton action={TUG_ACTIONS.SUBMIT} role={snap.canInterrupt ? "danger" : "action"} disabled={!snap.canSubmit && !snap.canInterrupt}>{snap.canInterrupt ? "Stop" : "Send"}</TugPushButton>` per Spec S03 — already in Step 2's scaffold; no JSX changes needed here.
- [ ] Render the queue badge conditionally: `{snap.queuedSends > 0 && <span className="tug-prompt-entry-queue-badge" aria-live="polite">{snap.queuedSends}</span>}`.
- [ ] Wire `data-errored`, `data-pending-approval`, `data-pending-question`, `data-queued`, `data-can-submit`, `data-can-interrupt` on the root from snapshot per Spec S03 (most of these already in Step 2's scaffold; only missing ones land here).
- [ ] Extend CSS with phase-sensitive selectors for each `data-*` attribute per the §Phase → visual binding table.
- [ ] Add `.tug-prompt-entry-queue-badge` styles (size, positioning, color) consuming existing `--tug7-element-badge-text-tinted-action-rest` + `--tug7-surface-badge-primary-tinted-action-rest` per [D11] and Spec S07.

**Tests:**
- [ ] Dispatching `TUG_ACTIONS.SUBMIT` with snapshot `canInterrupt: false` and non-empty input calls `codeSessionStore.send` with the current text + atoms, then clears the input.
- [ ] Dispatching `TUG_ACTIONS.SUBMIT` with snapshot `canInterrupt: true` calls `codeSessionStore.interrupt()` and does not call `send`.
- [ ] Dispatching `TUG_ACTIONS.SUBMIT` with `canSubmit: false && canInterrupt: false` is a no-op (e.g., during `awaiting_approval`).
- [ ] `localCommandHandler` returning `true` suppresses the `send` call but still clears the input.
- [ ] `localCommandHandler` returning `false` falls through to `codeSessionStore.send`.
- [ ] Omitting `localCommandHandler` is equivalent to returning `false`.
- [ ] Advancing the mock store to `queuedSends: 2` adds `data-queued` to the root and renders the badge with text `"2"`.
- [ ] Advancing the store back to `queuedSends: 0` removes `data-queued` and the badge.
- [ ] Dispatching a `SESSION_STATE errored` frame through the mock sets `data-errored` on the root.
- [ ] Submitting button label reads `"Send"` when `canInterrupt: false` and `"Stop"` when `canInterrupt: true`.
- [ ] Store phase transitions flip `data-phase` on the root without triggering a React re-render of the entry (asserted via a render-counter ref).

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun run test tug-prompt-entry`
- [ ] `cd tugdeck && bun run audit:tokens lint`

---

#### Step 6: Gallery cards — pristine + sandbox {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugdeck): gallery cards for TugPromptEntry`

**References:** [D07] two gallery cards, [D08] mock from testing, [Q03] sandbox mock driver, [Q05] gallery split, Spec S06, (#context, #s06-mock-driver)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/gallery-prompt-entry.tsx` — pristine showcase card mounting `TugPromptEntry` against a module-singleton `MockTugConnection`-backed `CodeSessionStore` in `idle`. Exports a `buildMockServices()` helper that the sandbox card re-uses.
- `tugdeck/src/components/tugways/cards/gallery-prompt-entry.css` — minimal card layout.
- `tugdeck/src/components/tugways/cards/gallery-prompt-entry-sandbox.tsx` — interactive driver card wrapping the same component in a debug panel of `TugPushButton`s that call the `SYNTHETIC` frame factories per Spec S06. Includes "run happy path" and "reset store" convenience buttons.
- `tugdeck/src/components/tugways/cards/gallery-prompt-entry-sandbox.css` — driver panel layout.
- `tugdeck/src/main.tsx` — `registerGalleryPromptEntryCard()` + `registerGalleryPromptEntrySandboxCard()` calls alongside existing gallery card registrations.

**Tasks:**
- [ ] Create `gallery-prompt-entry.tsx` importing `MockTugConnection` from `tugdeck/src/lib/code-session-store/testing/mock-feed-store.ts`; verify the import resolves without tsconfig/bundler errors. If it does not, halt Step 6 and promote `MockTugConnection` to `tugdeck/src/lib/code-session-store/dev-mock.ts` as a one-line re-export (mechanical, no behavioral change).
- [ ] Implement `buildMockServices(): { codeSessionStore, sessionMetadataStore, historyStore, fileCompletionProvider }` as a module-scope singleton builder per the existing `gallery-prompt-input` pattern.
- [ ] Mount `<TugPromptEntry {...mockServices} id="gallery-prompt-entry-main" />` inside the card's content area.
- [ ] Create `gallery-prompt-entry-sandbox.tsx` importing `buildMockServices` from the pristine card module.
- [ ] Implement the `SYNTHETIC` frame factory module per Spec S06 (~10 factories for session_init, assistant_text partial/final, tool_use, tool_result, turn_complete success/error, control_request_forward approval/question, session_state_errored, session_unknown).
- [ ] Render a debug panel of push buttons, one per factory, wired to call `mockConnection.dispatchDecoded(feedId, payload)`.
- [ ] Add a "run happy path" button that chains `sessionInit → assistantPartial (x2) → turnCompleteSuccess` with a short `await`/delay sequence.
- [ ] Add a "reset store" button that constructs a fresh `MockTugConnection` + `CodeSessionStore` and re-mounts the entry.
- [ ] Register both cards in `main.tsx` alongside `gallery-prompt-input`.

**Tests:**
- [ ] Rendering test: `<GalleryPromptEntryCard />` renders without throwing and the nested `TugPromptEntry` receives its props from `buildMockServices()`.
- [ ] Rendering test: `<GalleryPromptEntrySandboxCard />` renders without throwing, the driver panel buttons are present in the DOM, and clicking `turnCompleteSuccess` button drives the embedded store through a phase transition observed via the snapshot.
- [ ] Manual verification: open the pristine card in a running dev build; observe the component in `idle` state; `audit:tokens lint` passes against this card's theme pairings.
- [ ] Manual verification: open the sandbox card in a running dev build; click through `assistantPartial`, `turnCompleteSuccess`, `controlRequestApproval`, `sessionStateErrored`, `queue-push`; observe each phase + queue + errored visual.

**Checkpoint:**
- [ ] `cd tugdeck && bun run check`
- [ ] `cd tugdeck && bun run test`
- [ ] `cd tugdeck && bun run audit:tokens lint`
- [ ] Both gallery cards appear in the running dev build's gallery surface.

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [D01] compound composition, [D02] snapshot drives data-attributes, [D03] label as children, [D04] route via chain, [D05] submit/interrupt unified, [D06] localCommandHandler seam, [D07] two gallery cards, [D08] mock from testing, [D09] responder id from parent, [D10] entry no editing actions, [D11] reuse existing tokens, Spec S01, Spec S02, Spec S03, Spec S04, Spec S05, Spec S06, Spec S07, (#success-criteria, #exit-criteria)

**Artifacts:**
- `dash/tide.md` — T3.4.b marked `✓ LANDED` in `#execution-order-table` + brief status block under §T3.4.b pointing at this plan.
- This plan's §Roadmap populated with a handover summary for T3.4.c.

**Tasks:**
- [ ] Verify all artifacts from Steps 1–6 are present and the integration contract for T3.4.c is complete.
- [ ] Run the full tugdeck check + test + lint suite in one sequence.
- [ ] Execute grep-based invariants (no `useState`/`useReducer` in the entry, no descendant-selector reach-ins in the CSS).
- [ ] Update `dash/tide.md` to mark T3.4.b as `✓ LANDED`.
- [ ] Update this plan's §Roadmap with a "handover to T3.4.c" note describing what T3.4.c can assume exists.

**Tests:**
- [ ] Full `bun run test` suite green.
- [ ] Full `bun run audit:tokens lint` green.
- [ ] Grep invariant: `rg 'useReducer' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches.
- [ ] Grep invariant: `rg -c 'useState' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns exactly `1` (the sole useState is for the route value per [D04]).
- [ ] Grep invariant: `rg '\.tug-prompt-entry \.tug-(prompt-input|choice-group|push-button)' tugdeck/src/components/tugways/tug-prompt-entry.css` returns zero matches.
- [ ] Grep invariant: `rg 'data-route' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches (abandoned per [D04]).
- [ ] Grep invariant: `rg 'routeIndicatorRef' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches.
- [ ] Grep invariant: `rg 'onInputChange' tugdeck/src/components/tugways/tug-prompt-entry.tsx` returns zero matches (existing `onChange` is the observation path).
- [ ] Grep invariant: `rg '@tug-pairings' tugdeck/src/components/tugways/tug-prompt-entry.css` returns a single block.
- [ ] Grep invariant: `rg 'setRoute' tugdeck/src/lib/tug-text-engine.ts` returns zero matches (engine delegate unchanged).
- [ ] Git invariant: `git diff --stat main -- tugdeck/styles/themes/brio.css tugdeck/styles/themes/harmony.css` returns zero changed lines (no theme-file edits per [D11]).
- [ ] Token presence check: every pairing token listed in Spec S07 resolves in both `brio.css` and `harmony.css` (run the Spec S07 preflight loop).

**Checkpoint:**
- [ ] `cd tugdeck && bun run check && bun run test && bun run audit:tokens lint`
- [ ] `rg 'useReducer' tugdeck/src/components/tugways/tug-prompt-entry.tsx` (expect zero output)
- [ ] `rg -c 'useState' tugdeck/src/components/tugways/tug-prompt-entry.tsx` (expect exactly `1`)
- [ ] `rg '\.tug-prompt-entry \.tug-(prompt-input|choice-group|push-button)' tugdeck/src/components/tugways/tug-prompt-entry.css` (expect zero output)
- [ ] `grep -c 'T3.4.b.*LANDED' dash/tide.md` returns at least 1.

---

### Deliverables and Checkpoints {#deliverables}

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- `tug-prompt-entry.tsx` + `.css` exist, export the component + props + delegate, and conform to the component authoring guide checklist.
- Both gallery cards render in a running dev build and demonstrate every phase transition the component surfaces.
- Vitest suite passes; `audit:tokens lint` passes; no grep-based regressions.
- `dash/tide.md` marks T3.4.b landed.
- T3.4.c can begin without touching this component's TSX or CSS — purely composition.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

**Handover to T3.4.c.** T3.4.c (the Tide card — functional registration) can assume the following are in place and stable:

- `TugPromptEntry` exports a `forwardRef` component whose props are `TugPromptEntryProps` (codeSessionStore, sessionMetadataStore, historyStore, fileCompletionProvider, dropHandler?, sessionId, responderId, onRouteChange?, localCommandHandler?, className?) and whose imperative handle is `TugPromptEntryDelegate { focus(): void; clear(): void }`.
- The entry subscribes to `codeSessionStore` via a single `useSyncExternalStore`; it never owns turn state. T3.4.c supplies the store and the entry reacts.
- Route state (`>`, `$`, `:`) is the sole React state inside the entry [D04]; T3.4.c does not need to coordinate route between card and entry — it is self-contained. If T3.4.c wants to observe route changes (for card-level model badges, etc.), pass an `onRouteChange` callback.
- Submit / interrupt are unified on `snap.canInterrupt` [D05]; T3.4.c does not wire a separate stop affordance.
- `localCommandHandler(route, atoms) => boolean` is the T10 seam [D06]. T3.4.c owns the registry of `:`-surface commands and wraps them in this closure; a `false` return falls through to `codeSessionStore.send(...)`.
- The two gallery cards (`gallery-prompt-entry` pristine, `gallery-prompt-entry-sandbox` interactive) exercise the full phase matrix [D07]; T3.4.c can reuse `buildMockServices()` from `cards/gallery-prompt-entry.tsx` for card-level gallery demos if desired.
- CSS is self-contained in `tug-prompt-entry.css` with no descendant reach-ins [L20]; T3.4.c should not override `.tug-prompt-entry *` selectors.

**Follow-ons explicitly deferred:**

- **Local command registry** (T10). The `localCommandHandler` prop is a seam; populating `:help`, `:settings`, etc. is T10's work.
- **`SessionMetadataStore` rendering** (T3.4.c). Model name + version display near the entry's toolbar. The prop is in place.
- **`PromptHistoryStore` integration beyond forwarding** (post-T3.4.c). Up/down arrow recall on an empty input lives in `TugPromptInput` today; any "history peek" UI inside the entry is future work.
- **`MockTugConnection` promotion** (if the `testing/` import path proves awkward). Pure mechanical move to `dev-mock.ts`; not required unless a bundler rule bites.
<!-- Token authoring follow-on removed per [D11]: the component reuses existing base-tier tokens and ships its full styling inline with Steps 2 + 5. No theme-file edits are deferred. -->

---
