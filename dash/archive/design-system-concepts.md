# Tugways Design System — Concepts and Roadmap {#top}

## Rules of Tugways {#rules-of-tugways}

*Invariants for tugways implementation. Every rule traces to a design decision. Violating any rule requires updating the design decision first — never silently diverge.*

1. **Never call `root.render()` after initial mount.** All state changes flow through subscribable stores or direct DOM manipulation. [D40, D42]
2. **Read external state with `useSyncExternalStore` only.** No `useState` + manual sync. No `useEffect` that copies external values into React state. [D40]
3. **Use `useLayoutEffect` for registrations that must be complete before events fire.** Responder nodes, selection boundaries, and any setup that keyboard/pointer handlers depend on. [D41]
4. **Appearance changes go through CSS and DOM, never React state.** Class toggles, attribute changes, and style mutations that don't affect React's subtree are free. Use them. [D08, D09]
5. **Every action handler must access current state through refs or stable singletons, never stale closures.** `useResponder` registers actions once at mount. If your handler reads a variable that changes over time, it must go through a ref. [D07]
6. **Selection stays inside card boundaries.** `SelectionGuard` clamps selection on `selectionchange`. Every card registers its content area as a selection boundary. [D02, D03]
7. **Tugcard composes chrome; CardFrame owns geometry.** Cards never set their own position, size, or z-index. CardFrame handles drag, resize, and stacking. Tugcard handles header, icon, accessory, and content. [D01, D03]
8. **One responsibility per layer.** DeckManager owns the layout tree. DeckCanvas maps state to components. CardFrame owns geometry. Tugcard owns chrome. Card content owns domain logic. Don't reach across layers. [D01, D03, D05]
9. **Live preview is appearance-zone only; commit crosses zone boundaries.** During mutation transactions (D64), all preview mutations are CSS/DOM. The commit handler may write to stores or React state. Never mix preview with state changes. [D64, D65]
10. **Controls emit actions; responders handle actions.** Controls (buttons, sliders, pickers) are not responder nodes (D63). They dispatch ActionEvents into the chain. Responders receive and handle them. [D61, D63]
11. **After triggering child `setState` from a parent effect, never measure child DOM inline — it's stale.** Use a child-driven ready callback: the child's own `useLayoutEffect` fires after its DOM commits. This is a React contract, not a timing bet. [D78]
12. **Never use `requestAnimationFrame` for operations that depend on React state commits.** RAF timing relative to React's commit cycle is an implementation detail of the browser scheduler, not a contract. Use the ready-callback pattern (Rule 11) instead. [D79]
13. **CSS handles declarative motion. TugAnimator handles programmatic motion. `requestAnimationFrame` is not for animation.** Three lanes, no overlap. CSS (`transition`, `@keyframes`) owns hover/focus states, Radix `data-state` enter/exit, continuous/infinite animations (shimmer, spinners that need no completion), and anything where the browser's compositor can run it with zero JS. TugAnimator owns animations that need completion promises, cancellation semantics, multi-element coordination, or physics curves. `requestAnimationFrame` is for gesture-driven frame loops (drag, resize, autoscroll) that read input and write DOM each frame — these are not animations. [D76]
14. **Radix Presence owns enter/exit DOM lifecycle; TugAnimator does not cross that boundary.** Radix delays DOM removal by listening for `animationend`, which WAAPI does not fire. All Radix-managed enter/exit (Dialog, Popover, Dropdown, Toast) uses CSS `@keyframes` via `tw-animate-css` + `data-state`. TugAnimator is for animations where code — not Radix — controls DOM insertion and removal: flash overlays, skeleton-to-content crossfades, startup overlay fade. [D76]
15. **Interactive controls use token-driven control states; content areas stay static.** Every interactive control (button, input, switch, slider, toggle, checkbox, radio) uses the six-slot token convention: `--tug-base-<plane>-control-<constituent>-<emphasis>-<role>-<state>` where plane is `element` (for text, icon, border) or `surface` (for backgrounds), constituent identifies the visual part, emphasis is the variant (filled, outlined, ghost), role is the semantic role (action, danger, plain, etc.), and state is the interaction state (rest, hover, active, disabled). States lighten progressively (rest darkest → hover → active lightest). Content areas (text, labels, cards, separators, badges, status indicators) have no state transitions. Control tokens are defined in `tug-base.css`; component CSS wires `var()` references. No box-shadow elevation, no translateY press-down, no gradients — color transitions provide all interaction feedback. Toggle controls (checkbox, switch, radio) use the same six-slot convention: track surfaces are `--tug-base-surface-toggle-track-normal-<role>-<state>` where role is `on`, `off`, or `mixed`; thumb elements are `--tug-base-element-toggle-thumb-normal-plain-<state>`; radio dots are `--tug-base-element-radio-dot-normal-plain-<state>`. The role axis (on/off/mixed) is primary; state modifiers layer on top. Never conflate role (what the token represents) with state (what interaction condition is active) — each axis gets its own slot. [D04, Phase 8]
16. **Every color-setting rule declares its rendering surface.** If a CSS rule sets `color`, `fill`, or `border-color` and does NOT set `background-color` in the same rule, it must include a `@tug-renders-on` annotation naming the `--tug-base-*` surface token(s) it renders on. Rules that set both foreground and background are self-documenting (strategy 1 / same-rule match) and need no annotation. `audit-tokens lint` enforces this — zero `MISSING_ANNOTATION` violations are required. [D81]
17. **Component alias tokens resolve to `--tug-base-*` in one hop.** No alias-to-alias chains in component CSS `body {}` blocks. Every component alias (e.g., `--tug-button-bg`) must point directly to its `--tug-base-*` target. Deliberate backward-compat alias layers are exempt if listed in the `COMPAT_ALIAS_ALLOWLIST` in `audit-tokens.ts`, but the final alias in any chain must point directly to `--tug-base-*`. Cross-component dependency chains are not compat layers and must be flattened. `audit-tokens lint` flags multi-hop chains as `MULTI_HOP_ALIAS` violations. [D81]
18. **Use element/surface as the canonical vocabulary for contrast and pairing discussions.** Tokens that produce visible marks (text, icons, borders, shadows, dividers, fills) are *elements* — their names start with `--tug-base-element-`. Tokens that define the field behind them (backgrounds) are *surfaces* — their names start with `--tug-base-surface-`. The terms "foreground", "background", "fg", and "bg" are legacy shorthand from before Phase 3.5A; do not use them in new code, comments, or documentation. Contrast pairing means an element token rendered on a surface token. `audit-tokens pairings` audits all element/surface pairings for accessibility compliance. [Phase 3.5A]

---

## Table of Contents {#toc}

### Concept Areas

| # | Concept | Status | Anchor |
|---|---------|--------|--------|
| 1 | Theme Architecture: Loadable Resources | DESIGNED | [#c01-theme](#c01-theme) |
| 2 | Tugways Design System Definition | DESIGNED | [#c02-tugways](#c02-tugways) |
| 3 | TugButton: The Test Case | DESIGNED | [#c03-tugbutton](#c03-tugbutton) |
| 4 | The Responder Chain | DESIGNED | [#c04-responder](#c04-responder) |
| 5 | Controlled Mutation vs. React State | DESIGNED | [#c05-mutation](#c05-mutation) |
| 6 | Tugcard: The Common Base Component | DESIGNED | [#c06-tugcard](#c06-tugcard) |
| 7 | Feed Abstraction | DESIGNED | [#c07-feed](#c07-feed) |
| 8 | Motion and Visual Continuity | DESIGNED | [#c08-motion](#c08-motion) |
| 9 | Alert and Dialog System | DESIGNED | [#c09-dialog](#c09-dialog) |
| 10 | Card Title Bar Enhancements | DESIGNED | [#c10-titlebar](#c10-titlebar) |
| 11 | Dock Redesign | DESIGNED | [#c11-dock](#c11-dock) |
| 12 | Card Tabs | DESIGNED | [#c12-tabs](#c12-tabs) |
| 13 | Card Snap Sets | DESIGNED | [#c13-snap-sets](#c13-snap-sets) |
| 14 | Selection Model | DESIGNED | [#c14-selection](#c14-selection) |
| 15 | Keybindings View | DEFERRED | [#c15-keybindings](#c15-keybindings) |
| 16 | Brio Theme Revision | DEFERRED | [#c16-brio](#c16-brio) |
| 17 | Tugbank: Persistent Defaults Store | DESIGNED | [#c17-tugbank](#c17-tugbank) |
| 18 | Inactive State Preservation | DESIGNED | [#c18-inactive-state](#c18-inactive-state) |
| 19 | Target/Action Control Model | IMPLEMENTED | [#c19-target-action](#c19-target-action) |
| 20 | Mutation Transactions | DESIGNED | [#c20-mutation-transactions](#c20-mutation-transactions) |
| 21 | Observable Properties | DESIGNED | [#c21-observable-properties](#c21-observable-properties) |
| 22 | Theme Token Overhaul | DESIGNED | [#c22-theme-overhaul](#c22-theme-overhaul) |

### Cross-Cutting Design Decisions

| ID | Decision | Defined In | Anchor |
|----|----------|------------|--------|
| [D01] | Theme format is CSS, not JSON | Concept 1 | [#d01-css-format](#d01-css-format) |
| [D02] | Prefix rename `--tl-` → `--tways-` | Concept 1 | [#d02-tways-prefix](#d02-tways-prefix) |
| [D03] | Stylesheet injection replaces body classes | Concept 1 | [#d03-stylesheet-injection](#d03-stylesheet-injection) |
| [D04] | Optional palette entries with `var()` fallbacks | Concept 1 | [#d04-optional-palette](#d04-optional-palette) |
| [D05] | Three component kinds: wrappers, compositions, originals | Concept 2 | [#d05-component-kinds](#d05-component-kinds) |
| [D06] | `components/tugways/` is the public component API | Concept 2 | [#d06-file-org](#d06-file-org) |
| [D07] | Module-scope components, compose via JSX nesting | Concept 3 | [#d07-composition-model](#d07-composition-model) |
| [D08] | Two button modes: direct-action and chain-action | Concept 3 | [#d08-button-modes](#d08-button-modes) |
| [D09] | Responder chain operates outside React state | Concept 4 | [#d09-chain-outside-react](#d09-chain-outside-react) |
| [D10] | Four-stage key processing pipeline | Concept 4 | [#d10-key-pipeline](#d10-key-pipeline) |
| [D11] | Two-level action validation (`canHandle` + `validateAction`) | Concept 4 | [#d11-action-validation](#d11-action-validation) |
| [D12] | Three-zone mutation model (appearance, local data, structure) | Concept 5 | [#d12-three-zones](#d12-three-zones) |
| [D13] | DOM utility hooks for appearance zone | Concept 5 | [#d13-dom-hooks](#d13-dom-hooks) |
| [D14] | Five structure-zone rules | Concept 5 | [#d14-structure-rules](#d14-structure-rules) |
| [D15] | Tugcard is composition, not inheritance | Concept 6 | [#d15-tugcard-composition](#d15-tugcard-composition) |
| [D16] | Hooks for data (`useTugcardData`), not render props | Concept 6 | [#d16-hooks-not-render-props](#d16-hooks-not-render-props) |
| [D17] | Dynamic min-size based on content | Concept 6 | [#d17-dynamic-minsize](#d17-dynamic-minsize) |
| [D18] | Clean cutover migration for all 8 cards | Concept 6 | [#d18-clean-cutover](#d18-clean-cutover) |
| [D19] | Transport is tugcast, not a separate server | Concept 7 | [#d19-tugcast-transport](#d19-tugcast-transport) |
| [D20] | Three accumulation patterns (snapshot, append-stream, raw stream) | Concept 7 | [#d20-accumulation-patterns](#d20-accumulation-patterns) |
| [D21] | Interface-first: define types, mock backend, implement frontend | Concept 7 | [#d21-interface-first](#d21-interface-first) |
| [D22] | Component inventory: TS interfaces, gallery card, design doc | Concept 3 | [#d22-component-inventory](#d22-component-inventory) |
| [D23] | Motion tokens as CSS custom properties (`--td-duration-*`, `--td-easing-*`) | Concept 8 | [#d23-motion-tokens](#d23-motion-tokens) |
| [D24] | Reduced motion via duration scalar, not removal | Concept 8 | [#d24-reduced-motion](#d24-reduced-motion) |
| [D25] | Four modal categories: alert, sheet, confirm-popover, toast | Concept 9 | [#d25-four-modal-categories](#d25-four-modal-categories) |
| [D26] | Button-confirmation via popover, not sheet or alert | Concept 9 | [#d26-confirm-popover](#d26-confirm-popover) |
| [D27] | Window-shade collapse to title bar, state in CardState | Concept 10 | [#d27-window-shade](#d27-window-shade) |
| [D28] | Three dock button types: card toggle, command, popout menu | Concept 11 | [#d28-dock-button-types](#d28-dock-button-types) |
| [D29] | Dock placement on any edge (right default) | Concept 11 | [#d29-dock-placement](#d29-dock-placement) |
| [D30] | Tab bar visible only when card has multiple tabs | Concept 12 | [#d30-tab-visibility](#d30-tab-visibility) |
| [D31] | Tabs are a Tugcard composition feature, not a frame feature | Concept 12 | [#d31-tabs-in-tugcard](#d31-tabs-in-tugcard) |
| [D32] | Snap requires Option (Alt) modifier during drag | Concept 13 | [#d32-modifier-snap](#d32-modifier-snap) |
| [D33] | Set-move is always active once a set is formed | Concept 13 | [#d33-set-move-always](#d33-set-move-always) |
| [D34] | Three-layer selection containment (CSS + SelectionGuard + developer API) | Concept 14 | [#d34-three-layer-selection](#d34-three-layer-selection) |
| [D35] | SelectionGuard is a singleton, not React state | Concept 14 | [#d35-guard-singleton](#d35-guard-singleton) |
| [D36] | Pointer-clamped selection clipping via caretPositionFromPoint | Concept 14 | [#d36-pointer-clamping](#d36-pointer-clamping) |
| [D37] | Four select modes for card content regions | Concept 14 | [#d37-select-modes](#d37-select-modes) |
| [D38] | Cmd+A scoped to focused card via responder chain | Concept 14 | [#d38-scoped-selectall](#d38-scoped-selectall) |
| [D39] | Default button: Enter key routes to designated button via responder chain | Concept 3 | [#d39-default-button](#d39-default-button) |
| [D40] | DeckManager is a subscribable store — one `root.render()` at mount | Concept 5 | [#d40-deckmanager-store](#d40-deckmanager-store) |
| [D41] | `useResponder` uses `useLayoutEffect` for registration | Concept 5 | [#d41-layout-effect-registration](#d41-layout-effect-registration) |
| [D42] | No repeated `root.render()` from external code | Concept 5 | [#d42-no-repeated-root-render](#d42-no-repeated-root-render) |
| [D43] | Component Gallery is a proper card with tabs, not a floating panel | Concept 3 | [#d43-gallery-card](#d43-gallery-card) |
| [D44] | Progressive tab overflow: icon-only collapse, then overflow dropdown | Concept 12 | [#d44-tab-overflow](#d44-tab-overflow) |
| [D45] | Card-as-tab merge: dropping a card onto another card's tab bar merges it | Concept 12 | [#d45-card-as-tab-merge](#d45-card-as-tab-merge) |
| [D46] | Tugbank replaces settings API with SQLite-backed typed defaults | Concept 17 | [#d46-tugbank](#d46-tugbank) |
| [D47] | Per-domain key-value storage with CAS concurrency | Concept 17 | [#d47-tugbank-domains](#d47-tugbank-domains) |
| [D48] | Frontend reads/writes tugbank via HTTP bridge, same endpoints | Concept 17 | [#d48-tugbank-bridge](#d48-tugbank-bridge) |
| [D49] | Per-tab state bag: scroll position, selection, card-content state | Concept 18 | [#d49-tab-state-bag](#d49-tab-state-bag) |
| [D50] | `useTugcardPersistence` hook for card content state save/restore | Concept 18 | [#d50-persistence-hook](#d50-persistence-hook) |
| [D51] | Focused card ID persisted in DeckState for reload restoration | Concept 18 | [#d51-focused-card](#d51-focused-card) |
| [D52] | Collapsed state persisted in CardState | Concept 18 | [#d52-collapsed-state](#d52-collapsed-state) |
| [D53] | Set members get uniform squared corners via CSS `data-in-set` attribute | Concept 13 | [#d53-set-corners](#d53-set-corners) |
| [D54] | Set perimeter flash via SVG hull polygon trace — outer hull only | Concept 13 | [#d54-set-perimeter-flash](#d54-set-perimeter-flash) |
| [D55] | Break-out restores rounded corners (CSS-driven) and flashes card perimeter | Concept 13 | [#d55-breakout-restore](#d55-breakout-restore) |
| [D56] | Border collapse: snap positions offset by border width to share a single line | Concept 13 | [#d56-border-collapse](#d56-border-collapse) |
| [D57] | Set shadows via clip-path:inset() on .tugcard — no shadow DOM elements | Concept 13 | [#d57-clip-path-shadow](#d57-clip-path-shadow) |
| [D58] | Active/inactive shadow tokens for focused vs. unfocused cards | Concept 13 | [#d58-active-inactive-shadow](#d58-active-inactive-shadow) |
| [D59] | Command-key (metaKey) suppresses card activation on click | Concept 13 | [#d59-command-suppress-activation](#d59-command-suppress-activation) |
| [D60] | Resize click activates the card (brings to front) | Concept 13 | [#d60-resize-activates](#d60-resize-activates) |
| [D61] | Actions carry typed payloads, sender identity, and phase | Concept 19 | [#d61-action-event](#d61-action-event) |
| [D62] | Two dispatch modes: explicit target and nil-target (chain resolution) | Concept 19 | [#d62-dispatch-modes](#d62-dispatch-modes) |
| [D63] | Controls dispatch into chain, never register as responders | Concept 19 | [#d63-controls-not-responders](#d63-controls-not-responders) |
| [D64] | Mutation transactions: begin → preview → commit/cancel | Concept 20 | [#d64-mutation-transactions](#d64-mutation-transactions) |
| [D65] | Transactions operate in appearance zone only | Concept 20 | [#d65-transactions-appearance-zone](#d65-transactions-appearance-zone) |
| [D66] | Style source layers with cascade reader for inspector editing | Concept 20 | [#d66-style-cascade-reader](#d66-style-cascade-reader) |
| [D67] | Typed key-path property store per card | Concept 21 | [#d67-property-store](#d67-property-store) |
| [D68] | PropertyStore integrates with useSyncExternalStore | Concept 21 | [#d68-property-store-sync](#d68-property-store-sync) |
| [D69] | Inspector panels are responder participants | Concept 21 | [#d69-inspector-responders](#d69-inspector-responders) |
| [D70] | TugColor OKLCH palette: 24 hues × continuous intensity/tone space, 5 convenience presets, inline formula for arbitrary colors, P3 support | Concept 22 | [#d70-computed-palette](#d70-computed-palette) |
| [D71] | Token naming: `--tug-{hue}[-preset]`, `--tug-base-*`, `--tug-<component>-*` replace `--tways-*`/`--td-*` | Concept 22 | [#d71-token-naming](#d71-token-naming) |
| [D72] | Global scale: `--tug-zoom` multiplies all dimensions | Concept 22 | [#d72-global-scale](#d72-global-scale) |
| [D73] | Global timing: `--tug-timing` multiplies all durations, `--tug-motion` toggles motion | Concept 22 | [#d73-global-timing](#d73-global-timing) |
| [D74] | Dev cascade inspector: `Ctrl+Option + hover` shows token resolution chain | Concept 22 | [#d74-cascade-inspector](#d74-cascade-inspector) |
| [D75] | Neutral ramp and opacity: `--tug-neutral-*` achromatic ramp, CSS relative color syntax for alpha | Concept 22 | [#d75-neutral-ramp](#d75-neutral-ramp) |
| [D76] | TugAnimator: single programmatic animation engine wrapping WAAPI | Concept 8 | [#d76-tuganimator](#d76-tuganimator) |
| [D77] | Inactive selection appearance: dimmed highlight in unfocused cards via CSS Custom Highlight API | Concept 18 | [#d77-inactive-selection](#d77-inactive-selection) |
| [D78] | Child-driven ready callback: parent triggers child setState, child signals DOM commit via `useLayoutEffect` | Concept 18 | [#d78-content-ready](#d78-content-ready) |
| [D79] | No RAF for React state-dependent DOM operations — RAF is a timing bet, not a contract | Concept 18 | [#d79-no-raf-for-state](#d79-no-raf-for-state) |
| [D80] | Build-time `--tug-color()` expansion: PostCSS plugin replaces `--tug-color(hue, i, t)` with `oklch()` at build time; theme files use `--tug-color()` notation instead of hardcoded hex | Concept 22 | [#d80-tug-color-postcss](#d80-tug-color-postcss) |
| [D81] | Token pairings are machine-auditable: every foreground-on-background rendering relationship is deterministically extractable from CSS alone — either via same-rule background-color or via `@tug-renders-on` annotation. `audit-tokens lint` enforces this. | Phase 1.5 | [#d81-machine-auditable-pairings](#d81-machine-auditable-pairings) |
| [D82] | Four semantic text types govern element plane hue selection: `content` (prose/body), `control` (interactive labels), `display` (titles/headers), `informational` (status/metadata). Each type maps to a dedicated element hue slot and contrast role. | Concept 22 | [#d82-semantic-text-types](#d82-semantic-text-types) |
| [D83] | Five contrast roles replace the legacy four: `content` (75), `control` (60), `display` (60), `informational` (60), `decorative` (15). All readable text roles use thresholds >= 60. `large-text`, `body-text`, `subdued-text`, and `ui-component` are retired. | Concept 22 | [#d83-contrast-role-vocabulary](#d83-contrast-role-vocabulary) |

### Key Architectural Patterns

| Pattern | Description | Anchor |
|---------|-------------|--------|
| Component containment hierarchy | How components nest: CardFrame → Tugcard → content → leaf components | [#containment-hierarchy](#containment-hierarchy) |
| The three-zone model | Appearance (CSS, zero re-renders), Local data (targeted), Structure (subtree) | [#d12-three-zones](#d12-three-zones) |
| Responder chain structure | Component → card content → Tugcard → DeckCanvas → TugApp | [#chain-structure](#chain-structure) |
| Action vocabulary | ~25 standard actions across 8 categories | [#action-vocabulary](#action-vocabulary) |
| Feed accumulation helpers | `useFeedBuffer` (ring buffer) and `useFeedStore` (indexed store) | [#accumulation-helpers](#accumulation-helpers) |
| DOM utility hooks | `useCSSVar`, `useDOMClass`, `useDOMStyle` for appearance-zone mutations | [#d13-dom-hooks](#d13-dom-hooks) |
| Accessibility layering | Inherit native element baseline, extend with ARIA for non-standard states | [#tugbutton-a11y](#tugbutton-a11y) |
| Enter/exit via Radix data-state | CSS `@keyframes` triggered by `data-state="open"/"closed"`, Presence delays unmount | [#enter-exit-transitions](#enter-exit-transitions) |
| Skeleton shimmer | Per-card shapes, synchronized via `background-attachment: fixed`, theme-aware colors | [#skeleton-loading](#skeleton-loading) |
| Startup three-layer continuity | Inline body styles → startup overlay → CSS HMR boundary | [#startup-continuity](#startup-continuity) |
| Imperative-over-declarative alerts | `tugAlert()` returns Promise; host component renders AlertDialog | [#alert-architecture](#alert-architecture) |
| Selection containment | CSS prevention + JS SelectionGuard + `data-td-select` developer API | [#d34-three-layer-selection](#d34-three-layer-selection) |
| Default button | Responder chain designates one button per scope; Enter key activates it | [#d39-default-button](#d39-default-button) |
| Tugbank defaults store | SQLite-backed typed key-value persistence with domain separation and CAS | [#d46-tugbank](#d46-tugbank) |
| Per-tab state preservation | Scroll, selection, and card-content state saved/restored across tab switch and app reload | [#d49-tab-state-bag](#d49-tab-state-bag) |
| Target/action control model | Controls emit ActionEvents with payload, sender, and phase; two dispatch modes (nil-target and explicit-target) | [#d61-action-event](#d61-action-event) |
| Mutation transactions | Snapshot/preview/commit/cancel cycle for live-preview editing; appearance-zone only during preview | [#d64-mutation-transactions](#d64-mutation-transactions) |
| Observable property store | Typed key-path store per card with observation; integrates with useSyncExternalStore for inspector UI | [#d67-property-store](#d67-property-store) |
| TugColor (Hue · Intensity · Tone · Alpha) color palette | 24 OKLCH hue families with Hue/Intensity/Tone axes, 5 convenience presets per hue, neutral ramp, P3 support, pure CSS formulas, build-time `--tug-color()` expansion [D80] | [#d70-computed-palette](#d70-computed-palette) |
| Global scale and timing | `--tug-zoom` multiplies all dimensions; `--tug-timing` multiplies all durations; `--tug-motion` toggles motion on/off | [#d72-global-scale](#d72-global-scale) |

### External References

| Document | Purpose |
|----------|---------|
| `dash/tug-feed.md` | Tug-feed backend architecture (hooks, correlation, schema) |
| `dash/eliminate-frontend-flash.md` | UI-flash root cause analysis and three-layer fix (referenced from [#startup-continuity](#startup-continuity)) |
| `dash/tuglook-style-system-redesign.txt` | Prior art for theme system |
| `dash/react-shadcn-adoption.md` | React/shadcn adoption decisions (historical — shadcn has been removed; components now wrap Radix primitives directly) |
| `dash/tugbank-proposal.md` | Tugbank SQLite-backed defaults store design (schema, API, CLI, concurrency model) |
| `dash/theme-overhaul-proposal.md` | Theme token overhaul: computed OKLCH palette, three-layer token architecture, global scale/timing, cascade inspector |

### Discussion Log

| Entry | Topic | Date | Anchor |
|-------|-------|------|--------|
| 1 | Project Kickoff | 2026-03-01 | [#log-1](#log-1) |
| 2 | Theme Architecture — Initial Design | 2026-03-01 | [#log-2](#log-2) |
| 3 | Theme Architecture — Format Revised to CSS | 2026-03-01 | [#log-3](#log-3) |
| 4 | Tugways Design System Designed | 2026-03-01 | [#log-4](#log-4) |
| 5 | Responder Chain Drafted | 2026-03-01 | [#log-5](#log-5) |
| 6 | Controlled Mutation Designed | 2026-03-01 | [#log-6](#log-6) |
| 7 | Concept 5 Deepened — Specific Machinery | 2026-03-01 | [#log-7](#log-7) |
| 8 | Excalidraw Deep Study | 2026-03-01 | [#log-8](#log-8) |
| 9 | Tugcard Base Component Designed | 2026-03-01 | [#log-9](#log-9) |
| 10 | Feed Abstraction + UI-Flash Prevention | 2026-03-01 | [#log-10](#log-10) |
| 11 | TugButton Designed — Composition Model | 2026-03-02 | [#log-11](#log-11) |
| 12 | Concepts 12-13: Card Tabs and Snap Sets | 2026-03-02 | [#log-12](#log-12) |
| 13 | Concept 14: Selection Model | 2026-03-03 | [#log-13](#log-13) |
| 18 | Default Button Mechanism | 2026-03-02 | [#log-18](#log-18) |
| 21 | Concept 12 Revised — Tab Icons, Type Picker, Phase Split | 2026-03-03 | [#log-21](#log-21) |
| 24 | Tugbank Defaults Store — Concept 17 | 2026-03-04 | [#log-24](#log-24) |
| 25 | Inactive State Preservation — Concept 18 | 2026-03-04 | [#log-25](#log-25) |
| 28 | Target/Action, Mutation Transactions, Observable Properties — Concepts 19–21 | 2026-03-05 | [#log-28](#log-28) |
| 34 | Semantic Text Types and Contrast Role Vocabulary — Phase 3.5B | 2026-03-19 | [#log-34](#log-34) |

---

## Kickoff

Themes need to be "separate" loadable resources; not hard-coded tailwind/CSS.

However, if we think through all the implications of what changing a theme does in an app, we wind up needing to tackle quite a few complex questions like event flow, state management, rendering, component systems, and more. We have recently fixed on React as a core technology and use Radix primitives directly for accessible, unstyled component foundations. However, these alone are not enough. We also want a "tugcard" abstraction to encapsulate the look and feel of a single window-like component in the app, and we want all tugcards to be customizable based on a set of common behaviors. We need to specify what those behaviors are, how to store them, how to customize them, how to render them, and how to respond when they change.

There is also apprehension about React, since simple uses of it tend to accrete state changes that all too easily cause uncontrolled cascades of updates that ripple through an app, causing all sorts of undesirable effects, including brittleness and rigidness in the face of new changes, and poor performance when seemingly trivial updates occur. There are also difficult invariants like the "rule of hooks", which are like ticking time bombs that can go off at any time. We should probably lean away from states as much as possible and lean toward a model where component mutation is safe, controlled, and easy to understand.

## Feature List

- Themes need to be "separate" loadable resources; not hard-coded tailwind/CSS
- Need a settings view for adjusting themes
- Rethink themes as a precursor to the design system; build in support for revising and extending
- Custom Radix-based components for *everything*; never use raw Radix primitives directly in app code
- Tugways: the name of the tug design system for components used in tugcards and tugdeck
- Rename tuglook (the previous/tentative name for the design system) to tugways
- All UI components get a `Tug` prefix to give namespacing and allow us to inventory what we have and what we don't
- Start with `TugButton` as the first test-case component for how to design a tugways component
- Follow on with all components: selects, sliders, input, badges, etc.
- The responder chain is key; it will determine how all components are wired up; look at Apple docs for this
- Tugcard abstraction that serves as the common base component for all cards, offering standard API for what a card is and does
- API to return calculated minsize of a tugcard, so that we can ensure content stays visible
- Accessory views in cards; find window in any text card
- A proper skeleton model to cover moments when we can't display a fully ready-to-use UI
- Full alert/dialog system; app-modal/card-modal/modeless-informational
- Examine how Terminal, Filesystem, Git, Status, and Code cards handle their datafeeds — do we actually have a TugFeed abstraction to cover these uniformly, or is each one ad-hoc? What is the state of how they provide data to tugcast?
- The task-feed: multiplexed output from skills and agents
- Change Brio style to be dark greenish
- Need a keybindings view
- Add minimize/window-shade control to the card title bar (up/down chevron icon)
- Add confirmation dropdown to x/close box for cards
- Turn hamburger menu in the card title bar 90 degrees
- Fix the dock; giving it command buttons and popout menu buttons

---

## Current State (as of March 2026)

### What Exists

**Theme system.** Three themes (Brio, Bluenote, Harmony) defined entirely in `tugdeck/styles/tokens.css` as CSS custom properties. Theme switching works via body class (`td-theme-bluenote`, `td-theme-harmony`; Brio is the `:root` default). The `use-theme.ts` hook reads/sets the current theme, persists to localStorage, dispatches a `td-theme-change` CustomEvent, and syncs to the Swift bridge. All theme data is hardcoded in that one CSS file — no separate loadable resources.

**Token architecture.** Three tiers already in place: Tier 1 palette (`--tl-*`), Tier 2 semantic (`--td-*`), Tier 3 component-specific. Legacy bridge aliases (`--background`, `--foreground`, etc.) map from the `--td-*` layer. This architecture is sound but the values are baked in.

**Card system.** `TugCard` interface in `cards/card.ts` defines: `feedIds`, `collapsible`, `meta` (title, icon, closable, menuItems), and lifecycle methods (`mount`, `onFrame`, `onResize`, `focus`, `destroy`). `ReactCardAdapter` wraps React components to implement this interface. Eight card types are registered. Each card is a standalone React functional component with no shared base beyond what `CardContext` provides.

**Radix primitives.** shadcn has been removed. The former 13 shadcn components in `components/ui/` (Button, Card, Checkbox, Dialog, DropdownMenu, Input, RadioGroup, ScrollArea, Select, Switch, Tabs, Textarea, Tooltip) have been replaced by Tug components that wrap Radix primitives directly in `components/tugways/`.

**Feed system.** `CardContext` provides `feedData: Map<FeedIdValue, Uint8Array>`, and the `useFeed()` hook gives individual cards access to their subscribed feed data. Each card decodes and renders its own feed data independently — there is no uniform `TugFeed` abstraction.

**Dock.** React component, 48px vertical rail on the right edge. Icon buttons for each card type, a settings dropdown menu with theme selector, dev notifications badge, and tug logo.

**Settings card.** Theme selection (RadioGroup), source tree path picker, and developer mode toggle. Minimal.

### What Doesn't Exist

- Loadable/external theme resources
- Tugways naming or namespace
- `Tug`-prefixed component wrappers
- Responder chain or structured event flow
- Common tugcard base component with shared behaviors
- Card min-size calculation API
- Accessory view system for cards
- Skeleton/loading model
- Alert/dialog system beyond raw Radix Dialog
- Keybindings view
- Card minimize/window-shade control
- Close confirmation for cards
- Task-feed for multiplexed agent output
- Dock command buttons or popout menus

---

## Concept Areas

The work breaks down into several interconnected concept areas. Each needs discussion and design before implementation. They are listed here roughly in dependency order — later items build on earlier ones.

### 1. Theme Architecture: Loadable Resources {#c01-theme}

**Status: DESIGNED** (2026-03-01)

**The problem.** All three themes live in `tokens.css` as hardcoded CSS. Adding or modifying a theme means editing that file. Themes cannot be loaded at runtime, bundled separately, or provided by users. Worse, the three-tier architecture is only actually working for Brio — Bluenote and Harmony each duplicate all ~80 values (both `--tl-*` palette AND `--td-*` semantic) with hardcoded hex, bypassing the `var()` chain that should make semantic tokens derive automatically from palette values.

#### Decisions

**Prefix rename: `--tl-` → `--tways-`.** {#d02-tways-prefix} The old `--tl-` prefix (from "tuglook") is renamed to `--tways-` (for "tugways"). This avoids any potential conflict with Tailwind's `--tw-` internal prefix, and there's no reason the prefix needs to be two letters. `--tways-` is distinctive and self-documenting. The semantic tier keeps its `--td-` prefix (for "tugdeck" — the application's purpose-driven mappings, distinct from the design system's palette).

**Format: CSS.** {#d01-css-format} A theme file is a CSS file containing custom property declarations — because that's literally what theme values are. CSS custom properties can hold any CSS value natively: colors, shadows, gradients, complex expressions. No translation, no escaping, no special cases. A structured comment header provides metadata (name, description).

Example theme file (`bluenote.css`):
```css
/**
 * @theme-name Bluenote
 * @theme-description Cool dark theme
 */
body {
  --tways-bg: #2a3136;
  --tways-bg-soft: #363e43;
  --tways-bg-line: rgba(255, 255, 255, 0.018);
  --tways-panel: #3a454c;
  --tways-panel-soft: #313b43;
  --tways-panel-ink: #d9e0e4;
  --tways-surface-1: #3b4348;
  --tways-surface-2: #343c41;
  --tways-surface-3: #30373c;
  --tways-surface-4: #2a3237;
  --tways-surface-screen: #5c6871;
  --tways-surface-screen-ink: #edf2f5;
  --tways-text: #dde4e8;
  --tways-text-soft: #a8b6bf;
  --tways-text-inverse: #edf1f3;
  --tways-accent: #ff8434;
  --tways-accent-strong: #f27024;
  --tways-accent-cool: #4bbde8;
  --tways-accent-1: #ff8434;
  --tways-accent-2: #4bbde8;
  --tways-accent-3: #ab7ee4;
  --tways-accent-4: #ff5162;
  --tways-accent-5: #73c382;
  --tways-accent-6: #ffe465;
  --tways-accent-7: #ec76c9;
  --tways-accent-8: #ff9a72;
  --tways-border: #5b6871;
  --tways-border-soft: #79858d;
  --tways-shadow-hard: #11191f;
  --tways-shadow-mid: #11191f;
  --tways-shadow-soft: rgba(0, 0, 0, 0.44);
  --tways-glow: rgba(142, 183, 190, 0.24);
  /* Complex values work naturally in CSS — no escaping or special handling */
  --tways-depth-raise:
    0 1px 0 0 rgba(255, 255, 255, 0.18),
    0 1px 2px -1px rgba(0, 0, 0, 0.44);
  --tways-track-bg: repeating-linear-gradient(
    to bottom, #6c7b85 0px, #6c7b85 1px, #84939c 2px, #84939c 4px
  );
  /* Optional overrides — omit to use Brio's default derivation */
  --tways-canvas: #2a3136;
  --tways-header-active: #344f5e;
  --tways-header-inactive: #2a3a44;
}
```

Theme files contain palette values (including complex CSS values like shadows and gradients) plus optional override tokens. Any token not specified falls back to Brio's CSS default.

**Where themes live: bundled now, loadable later.** The three current themes (Brio, Bluenote, Harmony) are bundled as separate CSS files in the app. The architecture supports loading external theme files from the filesystem via `fetch()` in the future, but implementing that is not an immediate priority.

**Themes specify palette only.** Theme files contain only Tier 1 palette values (`--tways-*`). The Tier 2 semantic layer (`--td-*: var(--tways-*)`) and the Tier 3 component layer remain in `tokens.css` as permanent `var()` references — they derive automatically when palette values change. This eliminates the current duplication where Bluenote and Harmony each redundantly specify ~80 values.

**Optional palette entries for per-theme semantic overrides.** {#d04-optional-palette} Some tokens like `canvas`, `header-active`, `header-inactive`, `icon-active`, and `grid-color` currently vary per theme but are semantic-tier, not palette. The solution: make them optional palette entries (`--tways-canvas`, `--tways-header-active`, etc.) that themes can specify if they want to diverge from the default derivation. The semantic tier derives them from other palette values by default (e.g., `--td-canvas: var(--tways-canvas, var(--tways-bg))`). No special mechanism — just CSS `var()` with fallback.

**Brio is the blessed default.** Brio's palette values are defined in `tokens.css` as CSS defaults on `body`. When applying a different theme, the theme's CSS overrides palette properties. Missing keys automatically fall back to Brio because the CSS defaults were never overridden.

**Tailwind interaction: works unchanged.** The full chain is: Tailwind utility class (e.g. `bg-primary`) → `@theme` var in `globals.css` (`--color-primary: var(--primary)`) → legacy alias in `tokens.css` (`--primary: var(--td-accent)`) → semantic token (`--td-accent: var(--tways-accent)`) → palette value. Changing palette values at runtime cascades through the entire chain. Tailwind generates utility classes at build time referencing CSS variables; the variables resolve at runtime. No Tailwind involvement in theme switching.

#### Theme Application Mechanism {#d03-stylesheet-injection}

Replace the current body-class approach with stylesheet injection:

1. **Startup:** Brio's values are already in CSS (the `body { --tways-*: ... }` block in `tokens.css`). No injection needed.
2. **Apply theme:** Load the theme CSS file (bundled import or `fetch()` for external). Inject it as a `<style>` element in the document head. Because it appears after `tokens.css` in the cascade, its `body { --tways-*: ... }` declarations override Brio's defaults.
3. **Revert to Brio:** Remove the injected `<style>` element. Brio's CSS defaults in `tokens.css` take over.
4. **Swift bridge:** After applying, read the resolved `background-color` from `document.body` and post it to the Swift bridge (same as today).
5. **Persist:** Store the theme name in localStorage (or shared settings). On next load, re-inject the theme stylesheet.

**What this eliminates:**
- The `body.td-theme-bluenote` and `body.td-theme-harmony` CSS blocks (~190 lines of duplicated values in `tokens.css`)
- The body class toggling mechanism
- The `td-theme-change` CustomEvent (CSS cascade handles visual updates; no React re-render needed)
- The need for any component to "listen" for theme changes — CSS variables just work

**What stays in `tokens.css`:**
- Font declarations
- Brio's palette values as `body { --tways-*: ... }` defaults
- The entire Tier 2 semantic layer (`body { --td-*: var(--tways-*) }`)
- The legacy bridge aliases (`--background: var(--td-bg)`, etc.) — historical artifacts from the former shadcn layer, to be removed during token migration
- Shared tokens that don't vary per theme (radius, spacing, fonts, line-height)
- Scrollbar styling

**What stays in `globals.css`:**
- The `@theme` registration that maps CSS variables into Tailwind's namespace

#### Validation

When loading a theme (bundled or external), validate against Brio's palette as the canonical key set. For each key in Brio that is missing from the loaded theme, the Brio CSS default persists — no explicit fallback code needed. For external themes in the future, we may want to log warnings for missing keys.

### 2. Tugways: The Design System {#c02-tugways}

**Status: DESIGNED** (2026-03-01)

**The problem.** "Tuglook" was the working name for the visual language (tokens, themes, aesthetics). We're renaming to "tugways" and expanding the scope: tugways is the complete design system — tokens, components, patterns, and conventions.

**What tugways encompasses:**
- **Tokens:** the three-tier variable system (palette, semantic, component)
- **Components:** `Tug`-prefixed components that wrap, compose, or extend Radix primitives
- **Patterns:** how components compose (cards, accessory views, dialogs, skeletons)
- **Conventions:** naming, file organization, how new components are added
- **Behaviors:** responder chain, event flow, focus management

#### Decisions

**The `Tug` wrapper's job: cosmetic + behavioral + contractual.** Tugways components are not thin cosmetic wrappers. They encapsulate:
- **Semantic color mapping** — enforce and map tugways semantic colors to concrete elements
- **Component subtypes** — a single tugways component can represent a family of related controls (e.g., TugButton encompasses push button, icon button, icon+text button, three-state button)
- **State management** — states beyond what Radix primitives provide (disabled, loading, active, focused, selected), with consistent visual treatment across the design system
- **Theme-awareness** — components respond to theme changes via CSS variable cascade (no React re-render needed, per concept 1)
- **Responder chain integration** — components participate in the responder chain (concept 4)

**Tugways components carry strong opinions.** Radix provides unstyled, accessible primitives — Tugways components add their own variant model (primary/secondary/danger/ghost and beyond) that reflects the actual needs of the app. The variants cover the full range of what the component needs to express, including subtypes, states, and semantic color mappings.

**Three kinds of tugways components:** {#d05-component-kinds}

1. **Wrappers** — a Radix primitive wrapped with tugways opinions. The Radix primitive is the internal implementation; the Tug component is the public API. Examples: TugButton (wraps Radix Slot), TugInput (wraps native input with tugways styling), TugSelect (wraps Radix Select).

2. **Compositions** — multiple Radix primitives assembled into a higher-level component that has no single Radix equivalent. Examples: a search bar (Input + Button), a toolbar (multiple Buttons in a group), a labeled control (Label + Input + helper text).

3. **Originals** — components that have no Radix primitive equivalent, built from scratch. Examples: card title bar, responder-chain-aware containers, skeleton placeholders, accessory view frames.

**File organization:**

```
components/
  tugways/      # Tug-prefixed components (public API)
    TugButton.tsx
    TugInput.tsx
    TugSelect.tsx
    TugDialog.tsx
    ...
```

**The rule: app code imports from `components/tugways/`.** {#d06-file-org} There is no private `ui/` layer — shadcn has been removed and Tug components wrap Radix primitives directly. This gives us accessible primitives and Radix behavior under the hood, with our own opinions, subtypes, and conventions on top. We don't reinvent — we customize. And when we need something Radix doesn't offer, we build it as an original.

#### Component Library Inventory {#d34-component-library}

The full tugways component library, organized by tier. TugButton (concept 3) is
already built. Alerts, sheets, toasts, and confirm popovers are covered by
concept 9 (Phase 8a). Everything below ships in Phases 8b–8d.

**Tier 1 — Form Controls** (8 wrappers)

| Component | Kind | Wraps | What it adds |
|-----------|------|-------|-------------|
| TugInput | Wrapper | Input | Validation states, error styling, `--td-*` tokens |
| TugTextarea | Wrapper | Textarea | Auto-resize option, char count, error state |
| TugSelect | Wrapper | Select | Tugways variants, token-based styling |
| TugCheckbox | Wrapper | Checkbox | Label integration, mixed state, `--td-accent` |
| TugRadioGroup | Wrapper | RadioGroup | Group label, horizontal/vertical layout |
| TugSwitch | Wrapper | Switch | Label position, size variants |
| TugSlider | Wrapper | Slider | Value display, range labels, tick marks |
| TugLabel | Wrapper | Label | Required indicator, helper text slot |

**Tier 2 — Display & Feedback** (7 components)

| Component | Kind | Wraps | Notes |
|-----------|------|-------|-------|
| TugBadge | Original | — | Tone variants (good/warn/alert/info), pill shape, count mode |
| TugSpinner | Original | — | Size variants, replaces loading prop visuals |
| TugProgress | Original | — | Horizontal bar, percentage, indeterminate mode |
| TugSkeleton | Original | — | Shimmer placeholder, `background-attachment: fixed` sync |
| TugSeparator | Wrapper | Separator | Horizontal/vertical, label slot |
| TugKbd | Original | — | Keyboard shortcut chip display |
| TugAvatar | Original | — | Image + fallback initials, size variants |

**Tier 3 — Navigation & Overlay** (4 wrappers)

| Component | Kind | Wraps | Notes |
|-----------|------|-------|-------|
| TugTooltip | Wrapper | Tooltip | Hover labels, kbd shortcut display |
| TugDropdownMenu | Wrapper | DropdownMenu | Kbd shortcuts in items, tone icons |
| TugScrollArea | Wrapper | ScrollArea | Themed scrollbar, autohide |
| TugContextMenu | Wrapper | ContextMenu | Right-click menus for cards |

**Tier 4 — Data Display** (4 components)

| Component | Kind | Wraps | Notes |
|-----------|------|-------|-------|
| TugTable | Wrapper | Table | Header/row/cell, sortable columns, stripe option |
| TugStatCard | Original | — | Key-value metric display (label + number + trend) |
| TugStatusIndicator | Original | — | Tone-colored dot + text (good/warn/alert/info) |
| TugDialog | Wrapper | Dialog | General-purpose dialog (not alert/sheet) |

**Tier 5 — Data Visualization** (3 originals)

| Component | Kind | Notes |
|-----------|------|-------|
| TugSparkline | Original | SVG inline chart; area, line, column, bar variants |
| TugLinearGauge | Original | Horizontal gauge with needle, thresholds, tick marks |
| TugArcGauge | Original | Radial gauge with needle, center readout |

**Tier 6 — Compound Components** (2 compositions)

| Component | Kind | Composes | Notes |
|-----------|------|----------|-------|
| TugButtonGroup | Composition | TugButton × N | Connected button row, shared border radius |
| TugChatInput | Composition | TugTextarea + TugButton × 2 | Submit + attachment buttons, Enter to submit |

**Total: 28 components** (12 wrappers, 13 originals, 3 compositions) across
three phases (8b–8d).

**What Phase 9 cards need from this library:**

| Card | Key components required |
|------|----------------------|
| Terminal | TugScrollArea, TugSpinner |
| Conversation | TugScrollArea, TugChatInput, TugBadge, TugSpinner |
| Git | TugTable, TugBadge, TugStatusIndicator, TugScrollArea |
| Files | TugTable, TugScrollArea, TugContextMenu |
| Stats | TugProgress, TugSparkline, TugLinearGauge, TugArcGauge, TugStatCard, TugBadge |
| Settings | TugSelect, TugInput, TugCheckbox, TugRadioGroup, TugSwitch, TugSlider, TugLabel, TugSeparator |
| Developer | TugCheckbox, TugSwitch, TugBadge, TugKbd |
| About | TugAvatar, TugSeparator |

**Excluded:** TugAlertDialog (= TugAlert, Phase 8a), TugPopover (internal to
TugConfirmPopover), TugTabBar (Phase 5b), TugCollapsible (Tugcard handles
collapse), TugCommand (post-Phase 9), calendar/date picker/carousel/pagination/
breadcrumb/sidebar/menubar/navigation menu (not needed for tugdeck's card UI).

**Design references:** The retronow mockups (`retronow-unified-review.html`,
`RetronowComponentPackPage.tsx`, `retronow-components.css`) are the visual
models for all components. Sparklines, linear gauges, and arc gauges are drawn
directly from retronow's custom instruments. See
[Retronow Design Reference](tugways-implementation-strategy.md#retronow-design-reference).

#### Subtype Naming

Single component with a subtype prop is the default approach. For example, `<TugButton subtype="icon">` rather than a separate `TugIconButton`. If a subtype diverges enough that the single-component API becomes awkward, break it out into a separate component on a case-by-case basis.

#### Inventory Tracking

The `components/tugways/` directory is the inventory. If a `Tug`-prefixed component file exists, it's wrapped. If it doesn't, it's still raw. No manifest file needed.

### 3. TugButton: The Test Case {#c03-tugbutton}

**Status: DESIGNED** (2026-03-02)

**The problem.** We need a concrete first component to establish the pattern for all tugways components. But a button never exists in isolation — it's always inside a card, a toolbar, a dialog, a section. Before we can design TugButton, we need to answer: **how does the component containment hierarchy work?**

#### The Composition Model {#d07-composition-model}

The rule from concept 5 ([#d14-structure-rules](#d14-structure-rules)) says "never define components inside components." This means:

```tsx
// WRONG — defines a new component function inside another component.
// Creates a brand-new component identity on every render.
// React unmounts and remounts it each time. State is lost. DOM is rebuilt.
function SettingsContent() {
  const ThemeRow = () => <div>...</div>;
  return <ThemeRow />;
}
```

This does **not** mean you can't *use* components inside other components. That's literally what React is — composition through nesting. Every tugways component is a standalone function defined at module scope (in its own file). You compose them by importing and nesting JSX:

```tsx
// RIGHT — every component is a module-scope definition

// tug-button.tsx
export function TugButton({ subtype, onClick, children }) { ... }

// theme-section.tsx
import { TugButton } from "../tugways/tug-button";
export function ThemeSection() {
  return (
    <div>
      <TugButton subtype="push" onClick={applyBrio}>Brio</TugButton>
      <TugButton subtype="push" onClick={applyBluenote}>Bluenote</TugButton>
    </div>
  );
}

// settings-content.tsx
import { ThemeSection } from "./theme-section";
import { SourceTreeSection } from "./source-tree-section";
export function SettingsContent() {
  return (
    <div>
      <ThemeSection />
      <SourceTreeSection />
    </div>
  );
}
```

#### The Containment Hierarchy {#containment-hierarchy}

The full component tree for a card with buttons, showing how concepts 3, 4, 5, and 6 connect:

```
CardFrame                          ← pixel position, size, drag, resize (concept 6)
  └─ Tugcard                       ← chrome, responder node, feed, loading/error (concept 6)
       ├─ CardHeader               ← title bar — internal to Tugcard
       ├─ Accessory slot           ← find bar, etc.
       └─ SettingsContent          ← the unique card content
            ├─ ThemeSection
            │    ├─ TugButton "Brio"
            │    ├─ TugButton "Bluenote"
            │    └─ TugButton "Harmony"
            ├─ SourceTreeSection
            │    └─ TugButton "Choose..."
            └─ DeveloperSection
                 └─ TugSwitch
```

Every box in that tree is a separate module-level component. There is no tight coupling between layers. They connect through three ambient mechanisms:

1. **CSS custom properties** — theme flows through the DOM, not through React props. TugButton's colors come from `var(--td-*)` tokens. Theme changes update the tokens via stylesheet injection ([#c01-theme](#c01-theme)); TugButton picks up the new values at paint time. Zero re-renders.

2. **React context** — the responder chain ([#c04-responder](#c04-responder)) is provided via nested context. Any component anywhere in the tree can participate by calling `useResponder`. TugButton doesn't need to know it's inside a Tugcard — it finds the nearest chain node automatically.

3. **Props and callbacks** — standard React data flow. `onClick`, `subtype`, `disabled`, `children`. Nothing exotic.

The principle: **components are standalone pieces defined at module scope. You snap them together by nesting JSX. The responder chain, theme system, and mutation model are ambient infrastructure that any component can tap into without knowing the specific tree it lives in.**

#### Two Button Modes {#d08-button-modes}

TugButton has two modes of operation:

**Direct-action buttons** — they have an `onClick` handler and just do their thing. The responder chain is not involved. Most buttons are this type:

```tsx
// Direct-action — no chain involvement
<TugButton subtype="push" onClick={() => clearScrollback()}>
  Clear
</TugButton>
```

**Chain-action buttons** — they dispatch an action into the responder chain ([#action-vocabulary](#action-vocabulary)). The button doesn't know *who* handles the action — it dispatches, and the chain routes. These buttons need the chain for two things: *validation* (should I be enabled?) and *dispatch* (fire the action when clicked).

```tsx
// Chain-action — queries the chain for validation, dispatches on click
<TugButton subtype="push" action="find">
  Find
</TugButton>
```

For chain-action buttons, TugButton internally calls `validateAction("find")` from the responder chain to determine if it should be enabled or disabled. This mirrors Apple's `NSMenuItem` — menu items validate themselves against the responder chain before drawing ([#d11-action-validation](#d11-action-validation)). When clicked, TugButton dispatches `"find"` into the chain, and whoever handles it (the focused card's text content, presumably) responds.

A chain-action button is *visible* if someone in the chain can handle the action (`canHandle`), and *enabled* if that handler says it's currently valid (`validateAction`). For example, a "Copy" button is visible whenever a text-bearing card is focused, but only enabled when text is selected.

#### Default Button {#d39-default-button}

In dialogs, alerts, sheets, and popovers, one button is the **default button** — the button activated by the Enter key. This is a fundamental interaction pattern from Apple's HIG: the default button is visually prominent and responds to Return/Enter as a keyboard shortcut, even when focus is on another control within the dialog.

**Visual treatment: `primary` variant = default button.** The `primary` variant's accent fill (`--td-accent` via `--primary`) serves as the default button visual. When a container (alert, sheet, popover) designates a default button, that button uses `variant="primary"`. All other buttons in the group use `secondary` or `ghost`. The accent fill is the affordance that communicates "this is what Enter will do."

**Responder chain integration:** The default button mechanism lives in the responder chain's stage-2 key processing (keyboard navigation). A container registers its default button via `setDefaultButton(buttonRef)` on the `ResponderChainManager`. When Enter is pressed:

1. If a native `<button>` has DOM focus, the browser's default behavior fires (Enter activates the focused button). The responder chain does not interfere — the focused button wins.
2. If a text input or textarea has DOM focus, Enter is consumed by the input. The responder chain does not interfere.
3. Otherwise, the responder chain checks for a registered default button. If one exists, Enter activates it via a synthetic click.

This matches Apple's behavior exactly: Enter activates the default button unless focus is on a control that consumes Enter (text field, focused button). The default button registration is scoped — an app-modal alert's default button takes priority over anything behind it, a card-modal sheet's default button takes priority within the card's scope.

**Registration API:**

```tsx
// Container registers its default button on mount, clears on unmount.
// Only one default button per modal scope (app-modal, card-modal, or popover).
responderChain.setDefaultButton(buttonRef);   // register
responderChain.clearDefaultButton(buttonRef); // unregister (idempotent)
```

**Destructive variant visual treatment:** The `destructive` variant must be visually unmistakable — a bold danger fill, not a subtle tint. The fill color is `--td-danger` (`--tways-accent-4`, a deep red) with `--td-text-inverse` (white/near-white) text. `tug-button.css` must ensure the fill reads clearly across all three themes — explicitly setting `background-color: var(--td-danger)` and `color: var(--td-text-inverse)` so the destructive button is never confused with secondary or ghost. Hover and active states use the same `filter: brightness()` pattern as primary. The destructive button is always visually distinct from the default button (`primary` = accent fill, `destructive` = danger fill).

**Interaction with alert button roles:** The `"cancel"` role in `tugAlert` and `tugSheet` ([#c09-dialog](#c09-dialog)) maps to the default button when a `"destructive"` button is present — Cancel gets `variant="primary"` and is registered as the default button. When no destructive button is present, the affirmative action button is the default. The `"destructive"` role never becomes the default button. This matches Apple's HIG: when confirming a destructive action, Enter should cancel (the safe choice), not confirm.

#### Mutation Zone Assignment {#tugbutton-zones}

TugButton maps to all three zones from concept 5 ([#d12-three-zones](#d12-three-zones)):

**Appearance zone (zero re-renders):**
- Hover, focus ring, active/pressed states — all CSS pseudo-classes (`:hover`, `:focus-visible`, `:active`). No React state.
- Theme colors from `var(--td-*)` tokens. Theme changes flow through CSS variables — zero re-renders.
- Disabled visual state (opacity, cursor) — CSS class toggled based on the `disabled` prop or chain validation.

**Local data zone (targeted re-renders):**
- For chain-action buttons, the enabled/disabled state comes from responder chain validation. The chain is an external store; TugButton subscribes to its validation result for the specific action via `useSyncExternalStore`. Only this button re-renders when its validation state changes — not the entire toolbar, not the card, not the deck.

**Structure zone (subtree re-renders):**
- Whether the button exists at all is determined by its parent's React state. The parent conditionally renders `<TugButton>` or not.

#### TugButton API

```tsx
interface TugButtonProps {
  subtype?: "push" | "icon" | "icon-text" | "three-state";  // default: "push"
  variant?: "primary" | "secondary" | "ghost" | "destructive";  // default: "secondary"
  size?: "sm" | "md" | "lg";  // default: "md"

  // Direct-action mode
  onClick?: () => void;

  // Chain-action mode (mutually exclusive with onClick)
  action?: string;  // action name from the vocabulary (#action-vocabulary)

  // Standard
  disabled?: boolean;  // overrides chain validation if set explicitly
  loading?: boolean;   // shows spinner, disables interaction
  children?: React.ReactNode;

  // Icon support
  icon?: React.ReactNode;  // Lucide icon for "icon" and "icon-text" subtypes

  // Three-state support
  state?: "on" | "off" | "mixed";  // for "three-state" subtype
  onStateChange?: (state: "on" | "off") => void;
}
```

#### What TugButton Adds Over Radix Primitives

Radix provides: accessible slot composition (`Slot`), focus management, and unstyled primitive behavior with `ref` forwarding.

TugButton adds:

1. **Subtypes** — `push`, `icon`, `icon-text`, `three-state`. Radix has no concept of button subtypes. Each subtype adjusts layout (icon-only has square aspect ratio, icon-text has icon + label layout, three-state toggles through on/off/mixed).
2. **Chain-action mode** — the `action` prop connects the button to the responder chain for validation and dispatch. Radix has no event system integration.
3. **Loading state** — a `loading` prop that shows a spinner overlay and disables interaction. Radix has no loading state.
4. **Theme-responsive colors** — variant colors reference `var(--td-*)` semantic tokens, not hardcoded Tailwind classes. Theme switches are free.
5. **Restricted API** — TugButton's API is opinionated — it expresses what tugdeck needs, not every possible button variation.

#### Focus, Keyboard, and Accessibility {#tugbutton-a11y}

TugButton renders a native `<button>` element (via Radix `Slot` composition). This gives us the browser's built-in accessibility baseline for free: focusable via Tab, activates on Enter and Space, announced as "button" by screen readers, and participates in the accessibility tree without extra work. TugButton's job is to *not break* any of that, and to extend it for the subtypes and modes that go beyond a plain button.

**What the native `<button>` provides (inherited, not reimplemented):**
- Tab/Shift+Tab focus navigation
- Enter and Space to activate
- `role="button"` implicit in the element
- `disabled` attribute prevents focus and interaction
- Focus ring via `:focus-visible` (styled by tugways CSS)

**What TugButton adds:**

| Concern | Subtype / Mode | Implementation |
|---------|---------------|----------------|
| `aria-pressed` | `three-state` | Set to `"true"`, `"false"`, or `"mixed"` matching the `state` prop. Screen readers announce "toggle button, pressed/not pressed/mixed." |
| `aria-label` | `icon` (no visible text) | Required when `children` is absent. Icon-only buttons have no visible label; `aria-label` provides the accessible name. TugButton warns in dev mode if an `icon` subtype has neither `children` nor `aria-label`. |
| `aria-disabled` vs `disabled` | chain-action | When a chain-action button is disabled by validation (not by an explicit `disabled` prop), use `aria-disabled="true"` instead of the HTML `disabled` attribute. This keeps the button in the tab order so keyboard users can discover it, while preventing activation. The visual disabled treatment (opacity, cursor) is applied via CSS class, not the attribute. |
| Loading announcement | all (when `loading`) | When `loading` is true, add `aria-busy="true"` and an `aria-label` suffix like "Loading" so screen readers don't just see a spinner. |

**Keyboard interaction beyond activation:**
- **Three-state buttons** — Space toggles between on and off (skipping mixed — mixed is a programmatic state, not a user-toggled one). This matches the WAI-ARIA tri-state checkbox pattern.
- **Chain-action buttons** — Enter/Space dispatches the action into the responder chain, same as `onClick` for direct-action buttons. No additional keyboard behavior.
- **Icon-text and push** — standard button behavior. No custom key handling.

**Focus and the responder chain:**
A TugButton does not register itself as a responder node. Buttons are leaf controls — they activate actions but don't *handle* routed actions. The responder chain operates at a higher level (card content, Tugcard, DeckCanvas). When a TugButton has DOM focus and the user presses a key that isn't Enter/Space, the key event bubbles up through the DOM and reaches the responder chain's key listener, which routes it through the chain as usual. TugButton doesn't intercept or consume arbitrary keys.

#### Component Inventory and Documentation {#d22-component-inventory}

Every tugways component must be discoverable, visually demonstrable, and API-documented. Without a catalog, components get reinvented, variants drift, and the design system exists only in the heads of whoever wrote it.

**The inventory approach — three layers:**

1. **TypeScript interfaces are the API reference.** The `TugButtonProps` interface (and its equivalents for every tugways component) is the canonical documentation of what a component accepts. Type comments document semantics — e.g., "mutually exclusive with onClick" for the `action` prop. No separate API doc is generated; the types *are* the docs. IDE tooling (hover, autocomplete) makes these instantly accessible to developers writing card content.

2. **A component gallery card in tugdeck.** Tugdeck is a card-based dashboard — the natural place to showcase components is a card. A `ComponentGalleryCard` renders every tugways component in all its subtype/variant/state combinations, live, inside the running app. This is the visual inventory: you open the card and see every button subtype, every variant, every size, in both enabled and disabled states, in the current theme. Theme switches update the gallery in real time. This dogfoods the theme system and composition model — the gallery card is itself built from tugways components.

3. **A components manifest in the design document.** This document (design-system-concepts.md) serves as the architectural inventory. Each concept section that defines a component includes: the props interface, subtype/variant matrix, mutation zone assignment, accessibility notes, and the pattern it demonstrates. The TOC's concept list ([#concepts](#concepts)) is the master index.

**What we explicitly skip:** Storybook. It's a heavyweight tool designed for teams sharing a component library across multiple apps. Tugdeck is one app with one frontend. The component gallery card gives us the same visual browsing experience without the build infrastructure, and it runs in the actual app context (themes, responder chain, WebSocket connection) rather than an isolated sandbox.

#### Component Gallery as a Proper Card {#d43-gallery-card}

The Component Gallery starts as a floating absolute-positioned panel (Phase 2) but graduates to a proper registered card with tabs (Phase 5b3). The gallery registers as a card type (`"component-gallery"`) with its own `CardRegistration`, lives in the deck like any other card, and uses five tabs to organize its demo sections:

| Tab | Content |
|-----|---------|
| TugButton | Interactive preview controls + full subtype × variant × size matrix |
| Chain-Action | Chain-action button demos (cycleCard, showSettings, etc.) |
| Mutation Model | Appearance-zone, local-data-zone, and structure-zone demos |
| TugTabBar | Tab bar demo with sample tabs |
| TugDropdown | Dropdown demo with trigger button |

This conversion dogfoods the card and tab systems — the gallery is itself a multi-tab card built from tugways components. It eliminates the z-index hacks needed for the floating panel approach (dropdown portals no longer fight with a z-index:100 overlay). The gallery card is toggled via the same `show-component-gallery` action from the Mac Developer menu; the action now creates/focuses the gallery card in the deck rather than toggling a floating panel.

The gallery card is a developer tool — it appears in the deck and persists across sessions like any card, but it is not a user-facing feature. It does not appear in the dock. Card type registration makes it available from the [+] type picker in any tab bar, which is useful during development.

#### What TugButton Demonstrates for All Tugways Components

TugButton establishes the pattern every tugways component follows:

1. **Module-scope definition** in `components/tugways/tug-button.tsx`. Imported by app code. Never defined inline.
2. **Wraps Radix primitives** internally — Radix `Slot` and native `<button>` are the implementation. TugButton is the public API.
3. **Theme via CSS variables** — appearance-zone only. No React state for visual theming.
4. **Responder chain via context** — chain-action mode for components that dispatch or validate actions. Most components will have a direct-action mode only; chain-action is for toolbar/menu scenarios.
5. **Mutation zones are explicit** — appearance (CSS), local data (chain validation subscription), structure (conditional rendering by parent). Documented for each component.
6. **Subtypes via prop** — a single component handles a family of related controls. Break into separate components only when the single-component API becomes unwieldy.
7. **Accessibility layered on the native element** — inherit the browser baseline, add ARIA attributes for non-standard states (`aria-pressed`, `aria-disabled`, `aria-busy`), warn in dev when accessible names are missing ([#tugbutton-a11y](#tugbutton-a11y)).
8. **Inventoried in three places** — TypeScript interface (API), component gallery card (visual), design document (architectural). Every tugways component gets the same treatment ([#d22-component-inventory](#d22-component-inventory)).

### 4. The Responder Chain {#c04-responder}

**This is the architectural keystone.** Get this right and everything else — keyboard handling, focus management, action dispatch, theme response — falls into place. Get it wrong and we build the same ad-hoc wiring mess we're trying to escape.

**The problem.** Components need a structured way to handle events — particularly keyboard events, focus management, and action dispatch. Without this, every component wires up its own event listeners in ad-hoc ways, leading to conflicts, missed events, and unpredictable behavior.

#### Apple's Responder Chain: What We're Drawing From

The macOS/iOS responder chain (NSResponder/UIResponder) provides the architectural model. Key mechanics:

**The chain is a linked list.** Each responder has a `nextResponder` pointer. Events and actions propagate from the most specific responder (the focused control) up toward the most general (the application). The chain is constructed automatically from the view hierarchy.

**Typical macOS chain structure:**
```
Focused view → superview → ... → content view → NSWindow → NSWindowController → NSApplication
```

**Three things flow through the chain:**
1. **Key events** — delivered to the first responder, propagated up if unhandled
2. **Actions** — semantic commands like `copy:`, `paste:`, `close:` dispatched with nil target; the chain finds the first responder that implements the action
3. **Validation queries** — "can anyone in the chain handle `paste:` right now?" — used to enable/disable menu items and toolbar buttons

**Four-stage key processing pipeline** (in priority order):
1. **Key equivalents** — global shortcuts (Cmd+S, Cmd+W) checked top-down through the view hierarchy before the chain
2. **Keyboard navigation** — Tab, Enter, Escape handled at the system level for focus management
3. **Key bindings → semantic actions** — keystroke mapped to a named action (e.g., Ctrl+E → `moveToEndOfLine:`), then the action walks up the chain
4. **Text insertion** — if no binding matches, the character is inserted into the first responder

This separation into stages is crucial. Global shortcuts take priority over card-level actions. Keyboard navigation takes priority over text editing. Each stage has clear ownership.

**First responder** — one per window. The starting point for key events and nil-targeted actions. Acquired via `makeFirstResponder:` with a negotiation protocol: the current first responder can refuse to resign (e.g., a text field with invalid input), and the new responder can refuse to accept.

**Modal boundaries** — modality works by constraining which chain is active. A modal dialog confines events to its own chain. No special-case modal logic in individual components — the constraint is at the chain-selection level.

**Menu/action validation** — the chain is queried lazily (when a menu opens, not continuously). Each responder answers "can I handle this action?" and "should it be enabled right now?" This decouples controls from handlers completely.

#### How This Maps to Tugdeck {#chain-structure}

**The chain structure for tugdeck:**
```
Focused tugways component (TugButton, TugInput, etc.)
  → Card content area
  → TugCard
  → DeckCanvas
  → TugApp (application level)
```

Each level in the chain corresponds to a real architectural boundary:
- **Tugways component** — handles component-level actions (e.g., a text input handles `selectAll`)
- **Card content** — handles content-specific actions (e.g., conversation card handles `sendMessage`)
- **TugCard** — handles card-level actions (e.g., `close`, `minimize`, `toggleMenu`)
- **DeckCanvas** — handles deck-level actions (e.g., `cycleCards`, `resetLayout`)
- **TugApp** — handles app-level actions (e.g., `showSettings`, `changeTheme`, `quit`)

**First responder = focused card.** Tugdeck has one focused card at a time. That card's chain is the active chain for key events and actions. The card's internal components form the bottom of the chain; the card itself is in the middle; the app is at the top.

**Key processing pipeline for tugdeck** {#d10-key-pipeline} (adapted from Apple's four stages):

| Stage | Scope | Examples | Direction |
|-------|-------|----------|-----------|
| 1. Global shortcuts | App-wide, always active | Cmd+N (new card), Cmd+W (close card), Cmd+, (settings) | Top-down: checked before the chain |
| 2. Keyboard navigation | Focus management | Tab (next control), Shift+Tab (prev), Escape (dismiss), Enter (activate default button — [#d39-default-button](#d39-default-button)) | System-level |
| 3. Action dispatch | Semantic actions via chain | Copy, paste, find, card-specific commands | Bottom-up: chain walks from first responder to app |
| 4. Text input | First responder only | Typing into an input field | Delivered to first responder |

**Modal boundaries in tugdeck:**
- **App-modal dialog** — chain is confined to the dialog. No card receives events. Deck shortcuts disabled.
- **Card-modal** — chain within the card is confined to the modal (e.g., close confirmation). Other cards unaffected. Global shortcuts still work.
- **Modeless notification** — does not affect the chain at all.

**Action validation for tugdeck:**
- Dock buttons, card menu items, and keyboard shortcuts can query the chain: "can anyone handle `find` right now?"
- A card with searchable text would say yes; a terminal card might say no.
- This drives enabling/disabling of dock buttons and menu items dynamically.

#### Implementation Approach {#d09-chain-outside-react}

**The chain operates outside React state.** This is the critical design decision. The responder chain is an imperative system — components register and unregister, actions are dispatched and handled, first responder status is acquired and resigned — all without triggering React re-renders.

**A `ResponderChain` manager** — a stable, mutable object provided via React context. The context value (the manager reference) never changes, so providing it does not cause re-renders. Components interact with the manager imperatively.

**Components register via a `useResponder` hook:**
```
useResponder({
  actions: {
    copy: () => { ... },
    paste: () => { ... },
    find: () => { ... },
  },
  canHandle: (action) => { ... },   // for validation queries
})
```

The hook registers the component as a responder on mount and unregisters on unmount. Internally it uses refs, not state. The `nextResponder` link is determined automatically from the React component tree (the nearest ancestor that also called `useResponder`).

**Action dispatch is a function call:**
```
responderChain.dispatch({ action: 'copy', phase: 'discrete' })  // walks the chain, finds a handler, calls it
responderChain.canHandle('paste')   // validation query — returns true/false
```

**First responder management:**
```
responderChain.makeFirstResponder(cardId)   // sets the focused card
responderChain.resignFirstResponder()       // current first responder gives up focus
```

The manager tracks which card is first responder and starts chain traversal from that card's deepest registered responder.

**Global shortcuts are handled separately** — a top-level `keydown` listener that checks a keybinding map before the chain is consulted. If a global shortcut matches, it's handled immediately and the event doesn't reach the chain.

#### Resolved Questions

**Parent discovery: nested context (option b).** Each responder provides a context to its children containing itself as the parent. Children automatically know their parent responder without walking the fiber tree or explicit IDs.

**Mouse/pointer events: no.** The chain handles keyboard events, actions, and validation only. Mouse events go via hit-testing (DOM event bubbling), following Apple's model.

**Focus model: the responder chain is the focus model.** The deck-manager informs the responder chain when card focus changes (via `makeFirstResponder`), but the responder chain is the single authority on focus. There is no separate focus system.

#### Action Vocabulary {#action-vocabulary}

The action vocabulary is a defined set of action names, organized by category. Actions are strings (not an enum) to allow card-specific extensions, but the standard set is documented here. Modeled on Apple's NSResponder/UIResponder standard actions, filtered to what tugdeck actually needs.

**Clipboard actions** (handled by focused component or card):
| Action | Description |
|--------|-------------|
| `copy` | Copy selection to clipboard |
| `cut` | Cut selection to clipboard |
| `paste` | Paste from clipboard |
| `pasteAsPlainText` | Paste without formatting |

**Selection actions:**
| Action | Description |
|--------|-------------|
| `selectAll` | Select all content in the focused component |

**Find actions** (walk up the chain; text-bearing cards handle these):
| Action | Description |
|--------|-------------|
| `find` | Open find bar / focus find input |
| `findNext` | Find next occurrence |
| `findPrevious` | Find previous occurrence |
| `useSelectionForFind` | Use current selection as find query |

**Undo/Redo:**
| Action | Description |
|--------|-------------|
| `undo` | Undo last action |
| `redo` | Redo last undone action |

**Cancellation:**
| Action | Description |
|--------|-------------|
| `cancel` | Cancel current operation / dismiss modal / deselect (Escape) |

**Scrolling/Navigation:**
| Action | Description |
|--------|-------------|
| `scrollUp` | Scroll up one page |
| `scrollDown` | Scroll down one page |
| `scrollToTop` | Scroll to beginning of content |
| `scrollToBottom` | Scroll to end of content |

**Card actions** (handled at the TugCard level):
| Action | Description |
|--------|-------------|
| `closeCard` | Close the focused card (with confirmation if applicable) |
| `minimizeCard` | Minimize/window-shade the focused card |
| `restoreCard` | Restore a minimized card |
| `focusNextCard` | Move focus to the next card |
| `focusPreviousCard` | Move focus to the previous card |

**App actions** (handled at the TugApp level — end of the chain):
| Action | Description |
|--------|-------------|
| `showSettings` | Open settings card |
| `showAbout` | Open about card |
| `showKeybindings` | Open keybindings view |
| `resetLayout` | Reset card layout to default |
| `changeTheme` | Open theme picker |

**Card-specific actions** (each card type can register its own):
| Action | Card | Description |
|--------|------|-------------|
| `sendMessage` | Conversation | Send the current input |
| `clearTerminal` | Terminal | Clear terminal buffer |
| `refreshStatus` | Git | Refresh git status |
| `refreshFiles` | Files | Refresh file listing |

This vocabulary will grow as we build out the app. The key principle from Apple: actions are **semantic** (what to do), not **mechanical** (how to do it). `copy` means "copy the current selection" — the chain figures out *whose* selection and *how* to copy it.

#### Resolved Items

**Keybinding map: deferred to concept 12.** The responder chain only knows about actions, not keys. Adding keybindings later that dispatch actions into the chain can be done without changing the chain architecture.

**Action validation: two-level, following Apple's model.** {#d11-action-validation} Adopt Apple's battle-tested two-level validation:
1. **`canHandle(action)`** — capability query. "Does any responder in the chain implement this action?" Returns boolean. Analogous to `responds(to:)`.
2. **`validateAction(action)`** — enabled-state query. "I implement this action, but is it currently available?" Returns boolean (or could return metadata). Analogous to `validateMenuItem:`. Called on the responder that `canHandle` found.

This drives dynamic UI: a dock button or menu item is *visible* if someone in the chain can handle the action, and *enabled* if that handler says it's currently valid. For example, `copy` is visible whenever a text-bearing card is focused, but only enabled when text is selected.

### 5. Controlled Mutation vs. React State {#c05-mutation}

**Status: DESIGNED** (2026-03-01)

**The problem.** React's core model is: state changes → re-render → DOM update. This is elegant for small components but becomes a liability at scale. A single state change in a high-level component triggers a re-render cascade through its entire subtree. Performance suffers. Reasoning about what re-renders when becomes difficult. Hooks like `useMemo` and `useCallback` are band-aids that add complexity without solving the fundamental issue.

The real question: how do we get *precise* control over event firing in React in a way that respects its model, allows us to manipulate *data* that belongs to components, get *targeted re-renders* when display information changes, and do *both* without one tripping over the other?

#### The Key Insight: We're Not Fighting React — We're Scoping It

The mistake most React apps make is putting *everything* in React state. Theme? State. Focus? State. Card position? State. Scroll position? State. Then every change triggers a re-render cascade and you're drowning in `useMemo`/`useCallback` band-aids.

But we've already been designing systems that operate outside React state:
- **Theme changes** (concept 1): CSS variable swap on the document element. Zero re-renders.
- **Responder chain and focus** (concept 4): imperative manager with refs. Zero re-renders.
- **Card positions and layout**: deck-manager manipulates DOM directly. Zero re-renders.

The pattern is already clear. The principle is: use React for what it's good at (rendering UI from data), and use the DOM directly for what React isn't needed for (visual state that the browser handles natively via CSS).

#### Three Zones of Change {#d12-three-zones}

Every change in the app falls into one of three zones. Each zone has a different mechanism and a different re-render profile:

| Zone | What Changes | Mechanism | Re-renders? |
|------|-------------|-----------|-------------|
| **Appearance** | Theme, focus indicators, animations, card position/size, scroll position, selection highlight | CSS custom properties, CSS classes, DOM `style` manipulation, data attributes | **No.** The browser handles it via CSS cascade or direct DOM mutation. React never knows it happened. |
| **Local data** | Card content (feed data), form input values, component-internal state | React state **local to the component that displays it** | **Yes, but only that component.** The re-render is targeted because the state lives at the leaf, not at the root. |
| **Structure** | Show/hide a section, add/remove a card, open/close a modal, switch tabs | React state at the **appropriate level** — the nearest common ancestor of the affected subtree | **Yes, the affected subtree.** This is what React is designed for. |

The rules:

1. **Never put appearance state in React state.** Theme tokens are CSS variables. Focus indicators are CSS classes toggled by the responder chain. Card dimensions are set by the layout engine via `element.style`. Animations are CSS transitions or `requestAnimationFrame`. None of these need React's diffing — the browser handles them natively and efficiently.

2. **Keep data state as local as possible.** A card's feed data belongs in that card's component, not in a shared parent. A form value belongs in the input component, not in the form's parent. The further down the tree state lives, the smaller the re-render blast radius.

3. **When you must share state, use selective subscriptions.** React 18+ provides `useSyncExternalStore` for this exact purpose: an external mutable store that components subscribe to selectively. Each component subscribes to a *slice* of the store. Only components whose slice changed re-render.

4. **The responder chain, theme system, and layout engine are imperative systems.** They operate outside React's state model. They touch the DOM directly or via CSS. React components can *read* from them (to render initial state), but ongoing changes flow through imperative channels, not state updates.

#### `useSyncExternalStore`: The Key React Pattern

This is the React-sanctioned escape hatch for external mutable data. It lets data live outside React (in a plain object, a WebSocket handler, a feed processor) while components subscribe to exactly the slice they need:

```
// External store — mutated imperatively (e.g., by WebSocket handler)
const feedStore = {
  data: new Map<string, Uint8Array>(),
  listeners: new Set<() => void>(),

  subscribe(callback) { ... },
  getFeed(feedId) { return this.data.get(feedId); },

  // Called by WebSocket — NOT a React action
  updateFeed(feedId, payload) {
    this.data.set(feedId, payload);
    this.listeners.forEach(l => l());
  }
};

// In a card component — subscribes to ONE feed
function GitCard() {
  const feedData = useSyncExternalStore(
    feedStore.subscribe,
    () => feedStore.getFeed('git')  // only re-renders when THIS feed changes
  );
  // render from feedData...
}
```

Data mutates freely outside React. The WebSocket handler updates the store. Only the card that subscribes to the changed feed re-renders. No cascade. No context propagation. No `useMemo`.

This pattern applies to:
- **Feed data per card** — each card subscribes to its own feed(s)
- **Responder chain state** — dock buttons subscribe to `canHandle`/`validateAction` for their action, re-rendering only when the focused card changes
- **Connection status** — components that display connection state subscribe to connection store

#### How Each Existing System Maps to the Zones

| System | Zone | Mechanism | Why |
|--------|------|-----------|-----|
| Theme switching | Appearance | CSS variable injection on `<html>` (concept 1) | Colors are CSS — the browser cascades them instantly |
| Card focus change | Appearance | Responder chain sets CSS class on focused card (concept 4) | Focus ring is visual — no component content changes |
| Card position/resize | Appearance | Deck-manager sets `element.style.transform/width/height` | Layout is geometry — React doesn't need to know |
| Feed data arrival | Local data | `useSyncExternalStore` per card per feed | Each card re-renders independently when its data changes |
| Form input typing | Local data | React `useState` in the input component | The input re-renders; nothing else does |
| Card metadata (title, icon) | Local data | State in the card header component, not above it | Only the header re-renders when title/icon changes |
| Open/close a card | Structure | React state in deck canvas | The card mounts/unmounts; other cards unaffected |
| Open a modal dialog | Structure | React state in the modal system | The modal mounts; the rest of the app doesn't re-render |
| Dock button enabled state | Local data | Dock subscribes to responder chain validation | Only affected dock buttons re-render when focus changes |

#### What This Means in Practice

When a developer adds a new feature to tugdeck, the question is never "should I use React state?" in the abstract. The question is: **which zone does this change belong to?**

- "I need to highlight the focused card" → **Appearance.** Toggle a CSS class. Don't touch state.
- "I received new git status data" → **Local data.** `useSyncExternalStore` in the git card. Only the git card re-renders.
- "The user clicked the settings dock button" → **Structure.** The settings card mounts. State change at the deck level. Other cards don't re-render.
- "The theme changed" → **Appearance.** Inject a stylesheet. Zero re-renders. Every component picks up the new colors via CSS variables instantly.
- "The user typed in the message input" → **Local data.** `useState` in the input. Only the input re-renders.

The three-zone model makes the answer mechanical, not a judgment call. And critically: **the appearance zone — the biggest source of cascade re-renders in typical React apps — never touches React at all.**

#### Specific Machinery for Each Zone {#d13-dom-hooks}

**Appearance Zone — the DOM utility layer.** We need a small set of hooks that make it ergonomic to do CSS/DOM mutations from React components without reaching for `useState`. These are thin wrappers around `ref.current.style.setProperty()` and `ref.current.classList.toggle()`, but having them as *named patterns* prevents developers from accidentally using React state instead:

```
// Set a CSS custom property on a ref'd element — no re-render
function useCSSVar(ref, name, value) {
  useEffect(() => {
    ref.current?.style.setProperty(name, value);
  }, [name, value]);
}

// Toggle a CSS class on a ref'd element — no re-render
function useDOMClass(ref, className, condition) {
  useEffect(() => {
    ref.current?.classList.toggle(className, condition);
  }, [className, condition]);
}

// Apply a style object imperatively — for layout engine, drag, resize
function useDOMStyle(ref, styles) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const [prop, value] of Object.entries(styles)) {
      el.style[prop] = value;
    }
  }, [styles]);
}
```

These live in a `tugways/hooks/` directory alongside `useResponder`. They are the sanctioned way to make appearance changes. The rule: **if you're changing how something looks (not what it shows), use one of these hooks, not `useState`.**

For high-frequency updates (drag, resize, scroll, animation), bypass even these hooks — use `requestAnimationFrame` with a ref directly:

```
// During drag — 60fps, zero React involvement
function onPointerMove(e) {
  requestAnimationFrame(() => {
    panelRef.current.style.transform = `translate(${x}px, ${y}px)`;
  });
}
// On drag end — sync final position to React state (structure zone)
function onPointerUp(e) {
  setCardPosition({ x: finalX, y: finalY });
}
```

The principle: **bypass React during the gesture, sync on commit.** This is how Excalidraw handles canvas interaction — imperative during drag, state update on completion.

**Local Data Zone — `useSyncExternalStore` with gotcha prevention.** The core mechanism is `useSyncExternalStore`, but it has specific traps that will bite us if we're not careful:

*Gotcha 1: Snapshot reference instability.* If `getSnapshot` returns a new object every call, the component re-renders on every store notification even if the data hasn't changed. React will warn: "The result of getSnapshot should be cached."

```
// WRONG — new object every call, re-renders every time
() => ({ feed: store.getFeed('git') })

// RIGHT — return the same reference
() => store.getFeed('git')
```

*Gotcha 2: Subscribe function identity.* If `subscribe` is defined inside the component, it creates a new function reference every render, causing unsubscribe/resubscribe loops:

```
// WRONG — defined inside component
function GitCard() {
  const data = useSyncExternalStore(
    (cb) => store.subscribe(cb),  // new function every render!
    ...
  );
}

// RIGHT — stable reference, defined outside or as store method
const data = useSyncExternalStore(
  store.subscribe,  // same function reference always
  ...
);
```

*Gotcha 3: Selective subscription.* Vanilla `useSyncExternalStore` notifies on *any* store change. To re-render only when a specific feed changes, the store can use per-feed listener sets, or we can use `useSyncExternalStoreWithSelector` (a React shim) which takes a selector and equality function:

```
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';

function useFeed(feedId) {
  return useSyncExternalStoreWithSelector(
    feedStore.subscribe,
    feedStore.getSnapshot,
    null, // no server snapshot
    (snapshot) => snapshot.get(feedId),  // select this feed only
    Object.is  // re-render only if the Uint8Array reference changed
  );
}
```

**Whether to use a library (Zustand, Jotai) or raw `useSyncExternalStore`:** For the feed store, raw `useSyncExternalStore` is sufficient — the pattern is simple (per-card subscription by feed ID). If we find ourselves building more complex shared state (undo/redo stacks, multi-card coordination), Zustand or Jotai would reduce boilerplate. Jotai's atomic model (each atom is its own store) is particularly clean for per-card independence. Decision: **start raw, adopt a library if/when the complexity warrants it.**

**Structure Zone — React state with discipline.** {#d14-structure-rules} This is standard React, but with rules to prevent cascade:

*Rule 1: State lives at the lowest common ancestor, not higher.* The deck canvas owns "which cards are open" state. A card owns its own tab state. A form owns its input values. Never lift state to a parent that doesn't need it for rendering.

*Rule 2: Split contexts by domain and frequency.* Never put unrelated state in one context. A connection-status context (changes rarely) must be separate from a feed-data context (changes constantly). Otherwise every connection-status consumer re-renders on every feed update.

*Rule 3: Never derive state in `useEffect`.* If a value can be computed from props or other state, compute it during render (or use `useMemo`). Don't set it in an effect — that triggers a double render.

```
// WRONG — extra render from effect
const [filtered, setFiltered] = useState([]);
useEffect(() => {
  setFiltered(items.filter(i => i.active));
}, [items]);

// RIGHT — derive during render
const filtered = items.filter(i => i.active);
```

*Rule 4: Never define components inside components.* The inner component is recreated every render, destroying all its internal state and DOM:

```
// WRONG — CardContent is a new component type every render
function Card() {
  const CardContent = () => <div>...</div>;
  return <CardContent />;
}

// RIGHT — defined outside
const CardContent = () => <div>...</div>;
function Card() {
  return <CardContent />;
}
```

*Rule 5: Never create objects/arrays/functions inline in JSX props* (unless the React Compiler handles it — and it doesn't always, especially with third-party libraries):

```
// RISKY — new object every render
<Child style={{ color: 'red' }} />

// SAFE — stable reference
const style = { color: 'red' };  // module-level constant
<Child style={style} />
```

#### React Compiler v1.0 — What It Helps and What It Doesn't

React Compiler (shipped October 2025) automatically memoizes components and hooks at build time. This means:

**We can stop writing** `useMemo`, `useCallback`, and `memo` in most cases. The compiler inserts memoization at the correct granularity automatically. At Meta, this yielded up to 12% improvement on initial loads and >2.5x faster specific interactions.

**The compiler does NOT solve:**
- State placement problems (state too high in the tree still causes cascades)
- Context value instability (new object every render still re-renders all consumers)
- External store integration (third-party libraries may still need manual memoization)
- Side effects during render (the compiler bails out entirely on Rules-of-React violations)
- The appearance zone problem (CSS-driven state is always better than React state for visual changes, regardless of memoization)

The compiler is a safety net, not a substitute for the three-zone model. It makes the structure zone cheaper but doesn't eliminate the need to keep appearance out of React and data state local.

#### Architectural Precedent: Excalidraw

Excalidraw is the closest open-source precedent to tugdeck's architecture — a desktop-like React app with imperative rendering alongside React UI chrome:

- **React** renders the toolbar, dialogs, panels, context menus, and property inspector
- **Imperative canvas** (`<canvas>` element) handles all drawing, selection handles, collaborative cursors, and snap lines at 60fps via `requestAnimationFrame`
- **Scene class** is the single source of truth for canvas elements — a plain mutable object, not React state
- **Jotai atoms** manage UI-level state (dialog open/closed, sidebar visibility) independently from the canvas state
- **Action system** mediates user input → element mutations — actions are "entry points" for interactions, dispatched imperatively

The parallel to tugdeck: React renders card content and chrome. The deck-manager (imperative) handles card positioning and layout. The responder chain (imperative) handles focus and action dispatch. Feed data lives in an external store. Theme lives in CSS. React only re-renders when *content* changes — never for appearance, focus, layout, or theme.

#### Diagnostic Tools

When something re-renders that shouldn't:
1. **React DevTools Profiler** — enable "Highlight updates when components render" to visually see cascade re-renders
2. **`why-did-you-render` library** — patches React to log unnecessary re-renders with specific reasons
3. **React Compiler ESLint rule `react-hooks/todo`** — surfaces files where the compiler bailed out (silently skipping optimization)

#### Summary: The Complete Machinery

| Zone | Mechanism | Hooks/Tools | Re-renders |
|------|-----------|-------------|------------|
| **Appearance** | CSS custom properties, CSS classes, DOM style | `useCSSVar`, `useDOMClass`, `useDOMStyle`, `requestAnimationFrame` + refs | **Never** |
| **Local data** | External mutable store + selective subscriptions | `useSyncExternalStore` (raw or with selector), or Jotai atoms if complexity grows | **Only the subscribing component** |
| **Structure** | React state at the right ancestor level | `useState`, `useReducer`, split contexts | **The affected subtree** |

The DOM utility hooks (`useCSSVar`, `useDOMClass`, `useDOMStyle`) are our answer to "do we need a CSS-targeted API to help with mutations?" — yes, a small, lightweight set of hooks that make appearance-zone changes ergonomic and explicit. They don't do anything complex; they just make the right thing easy and the wrong thing (using `useState` for appearance) unnecessary.

#### Lessons from Excalidraw (Architectural Study)

Excalidraw (MIT licensed, github.com/excalidraw/excalidraw) is the closest open-source precedent to what we're building. It's a desktop-like React app with imperative rendering, an action system, and multiple interactive surfaces. A deep architectural study of the codebase reveals patterns to adopt, patterns to learn from, and gotchas to avoid.

**Patterns to adopt:**

1. **The action system is the best part of their architecture.** Every user operation — keyboard shortcut, toolbar button, context menu item, command palette entry — is a registered `Action` with a `perform` function, a `keyTest` for keyboard matching, a `predicate` for enable/disable, and an optional `PanelComponent` for property UI. This unifies all input paths into a single abstraction. Our responder chain action vocabulary (concept 4) maps directly to this: `perform` → our action handlers, `keyTest` → our keybinding map, `predicate` → our `canHandle`/`validateAction`.

2. **CSS variables for theming, not React context.** Confirmed — they use `--icon-fill-color`, `--color-selection`, `--color-surface-lowest`, etc. Theme switches are nearly free in performance terms. Same as our concept 1 approach.

3. **AppState subset types as render firewalls.** They define narrow type projections (`StaticCanvasAppState` with ~5 fields, `InteractiveCanvasAppState`, `UIAppState`) so that components receive only the state they need. A change to `openDialog` does not invalidate the static canvas. This is the manual version of selective subscriptions — and it works. For tugdeck, `useSyncExternalStore` with selectors gives us this automatically, but the *principle* is the same: never pass more state than a component needs.

4. **Separate contexts by domain (8 contexts, not 1).** They provide `useApp()`, `useAppProps()`, `useExcalidrawElements()`, `useExcalidrawAppState()`, `useExcalidrawSetAppState()`, `useExcalidrawActionManager()`, `useExcalidrawContainer()`, `useEditorInterface()` — each returning a narrow slice. Components subscribe only to what they use.

5. **Imperative for high-frequency, React for structure.** Their dual-canvas approach separates interactive feedback (selection handles, snap lines — redrawn every frame via `requestAnimationFrame`) from content rendering (scene elements — throttled to ~60fps). During drag, they call `this.setState()` directly and sometimes use `flushSync()` for low-latency. Our parallel: deck-manager handles card positioning imperatively; React handles card content.

**Patterns to learn from (but adapt):**

1. **The giant class component (395KB App.tsx) is intentional.** It centralizes all state coordination, gives direct `this` access for imperative state, and avoids distributed-state bugs. But it's an acknowledged lock-in. We should use functional components with our responder chain as the coordination mechanism instead — the chain provides the same centralized coordination without a god component.

2. **Scene class as mutable source of truth.** Their `Scene` class holds all drawable elements in a plain mutable object, not React state. It notifies subscribers via a `sceneNonce` (random integer regenerated on every mutation). Components check `sceneNonce` in their memo comparisons. For tugdeck, `useSyncExternalStore` gives us this subscription pattern automatically — the store mutates freely, components subscribe to slices.

3. **In-place element mutation for hot paths.** During drag/draw, they call `mutateElement()` which mutates the element object directly (preserving reference stability, incrementing version). For history/undo, they use `newElementWith()` which returns an immutable copy. The lesson: sometimes you need both mutable and immutable patterns for the same data, depending on the context.

**Gotchas we must avoid:**

1. **Focus management between imperative and React surfaces is fragile.** Their text editing system uses a deferred blur strategy, `setTimeout(0)` for DOM synchronization, and a dedicated `useTextEditorFocus` hook — all because browsers don't have good primitives for "this textarea belongs to that canvas." Every new panel or popover that appears during text editing must integrate with this system. We will face similar issues when text inputs inside cards need to coexist with the responder chain's keyboard handling. Plan for this from the start.

2. **State subset types require discipline.** Every new AppState field requires deciding which subset it belongs to. Put it in too many subsets → unnecessary re-renders. Miss it from a needed subset → stale renders. For tugdeck, our three-zone model provides the first-level classification (appearance/local/structure), but within the local and structure zones, we need similar discipline about what data flows where.

3. **Soft-delete, don't remove.** Excalidraw never removes elements from arrays — deletion sets `isDeleted: true`. This simplifies undo/redo and prevents array index invalidation during iteration. We should consider similar patterns for card state and feed data.

4. **Don't underutilize your atomic state library.** Excalidraw's Jotai integration is minimal (two tiny files). Most state lives in the class component's `this.state`. They acknowledged this should expand. We should be intentional from the start about what goes in external stores vs. React state, rather than defaulting everything to React and migrating later.

#### React 19 Rendering Model and External State {#react19-rendering-model}

The three-zone model (D12) and the Excalidraw precedent establish the *principle*: imperative systems like DeckManager and ResponderChainManager operate outside React state. But the principle alone is not enough — we must also understand how React 19's rendering pipeline interacts with external state, because getting this wrong produces timing bugs that are invisible in tests and devastating in practice.

##### The `createRoot().render()` Timing Trap

In React 19, **`createRoot().render()` is asynchronous.** It schedules work via `queueMicrotask()` and returns immediately. When the call returns:

- No components have re-rendered
- No DOM mutations have occurred
- No `useEffect` or `useLayoutEffect` callbacks have fired
- No `useSyncExternalStore` subscriptions have been notified

This is confirmed by the React team ([GitHub #32811](https://github.com/facebook/react/issues/32811)): *"Once we start rendering, it's synchronous. But the actual `render()` call is not and always runs in the next microtask."*

The danger: if an external class calls `root.render()` and then immediately performs imperative operations that depend on the rendered state, those operations see a stale React tree. The render hasn't happened yet.

##### The Concrete Bug

DeckManager calls `this.reactRoot.render()` on every state mutation — `addCard`, `removeCard`, `moveCard`, `focusCard`, `applyLayout`, etc. When the responder chain's `cyclePanel` handler runs:

```
Time 0:   cyclePanel calls DeckManager.focusCard(nextId)
          → DeckManager reorders cards, calls root.render()
          → root.render() schedules microtask, RETURNS IMMEDIATELY
          → DeckManager.focusCard() returns

Time 0+:  cyclePanel calls manager.makeFirstResponder(nextId)
          → Sets firstResponderId to nextId (synchronous, immediate)
          → React tree has NOT re-rendered — effects have NOT fired

Microtask: React processes the render
           → Components see new props
           → useEffect registrations fire (if any deps changed)
```

This creates a dual-update-path problem: some state flows through `root.render()` (async), component state flows through `setState` (batched), and imperative mutations happen synchronously — three different timing guarantees in one handler. Even when the individual operations are correct, the different timing can produce inconsistencies.

##### The Excalidraw Solution

Excalidraw faces the same tension — imperative canvas state + React UI — and solves it definitively:

1. **Never calls `root.render()` from outside React.** One initial mount, then all updates flow through `this.setState()` or store subscriptions. This is the single most important architectural decision.
2. **Scene class as a subscribable store.** Elements live in a plain `Scene` class (not React state). When elements change, `Scene.triggerUpdate()` fires callbacks, which call `this.setState({})` to trigger re-renders. Components read fresh data from `Scene` during render.
3. **ActionManager receives getter functions.** Instead of capturing values in closures, event handlers access state via `() => this.state` — always fresh.

The lesson: the async render gap disappears when you stop calling `root.render()` from imperative code. External stores notify React through `useSyncExternalStore`, which triggers `SyncLane` (synchronous) renders — no microtask delay, no gap.

##### Design Decisions {#d40-deckmanager-store}

**[D40] DeckManager is a subscribable store — one `root.render()` at mount.** DeckManager gains `subscribe`/`getSnapshot` methods following the `useSyncExternalStore` contract. The constructor calls `root.render()` exactly once to mount the React tree. All subsequent state changes mutate `this.deckState`, increment a version counter, and notify subscribers. DeckCanvas reads deckState via `useSyncExternalStore(manager.subscribe, manager.getSnapshot)` instead of receiving it as props from `root.render()`.

This eliminates the async render gap entirely: `useSyncExternalStore` forces `SyncLane` updates (always synchronous, no concurrent interleaving), preventing tearing between store state and rendered UI.

```typescript
// DeckManager — subscribable store pattern
class DeckManager {
  private subscribers = new Set<() => void>();
  private stateVersion = 0;

  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  };

  getSnapshot = (): DeckState => this.deckState;

  private notify(): void {
    this.stateVersion++;
    for (const cb of this.subscribers) cb();
  }

  focusCard(cardId: string): void {
    // ... reorder cards ...
    this.deckState = { ...this.deckState, cards };
    this.notify();  // NOT this.render()
  }
}

// Constructor — ONE root.render(), ever:
this.reactRoot.render(
  <DeckManagerContext.Provider value={this}>
    <TugThemeProvider initialTheme={this.initialTheme}>
      <ErrorBoundary>
        <ResponderChainProvider>
          <DeckCanvas connection={this.connection} />
        </ResponderChainProvider>
      </ErrorBoundary>
    </TugThemeProvider>
  </DeckManagerContext.Provider>
);
```

**[D41] `useResponder` uses `useLayoutEffect` for registration.** {#d41-layout-effect-registration} Responder chain registration switches from `useEffect` to `useLayoutEffect`. `useLayoutEffect` runs synchronously during the commit phase — after DOM mutations but before the browser processes the next event. This ensures responder nodes are always registered before any keyboard or pointer event can fire.

Combined with D40 (`useSyncExternalStore` forces `SyncLane` renders), this guarantees: when a store notification triggers a re-render, all responder registrations complete in the same synchronous commit phase, before the browser returns to the event loop.

```typescript
// use-responder.tsx — registration in commit phase
useLayoutEffect(() => {
  const { id, actions = {}, canHandle, validateAction } = optionsRef.current;
  manager.register({ id, parentId, actions, canHandle, validateAction });
  return () => { manager.unregister(id); };
}, [manager, parentId]);
```

**[D42] No repeated `root.render()` from external code.** {#d42-no-repeated-root-render} After the initial mount, external-to-React code never calls `root.render()`. All state changes flow through subscribable stores (`useSyncExternalStore`) or imperative DOM manipulation (appearance zone). This eliminates the async render gap — the source of timing bugs when imperative operations run between `root.render()` and the actual render.

The one exception: `DeckManager.destroy()` calls `reactRoot.unmount()` on teardown.

##### Timing Guarantees

With D40 + D41 + D42, the event flow for `cyclePanel` becomes deterministic:

```
Time 0:   cyclePanel calls DeckManager.focusCard(nextId)
          → DeckManager reorders cards, calls this.notify()
          → Subscriber callbacks fire synchronously
          → useSyncExternalStore detects version change

Time 0+:  cyclePanel calls setDeselected(false)
          → React setState (batched with the SyncLane update)

Time 0++: cyclePanel calls manager.makeFirstResponder(nextId)
          → Imperative, immediate

Time 0+++: cyclePanel returns, captureListener returns

Microtask: React processes the batched SyncLane render
           → DeckCanvas re-renders with new deckState (from store)
           → New deselected state applied
           → useLayoutEffect: responder registrations updated
           → Commit complete — all state consistent

Next event: Ctrl+` fires
           → dispatch({ action: "cyclePanel", phase: "discrete" }) walks: card → deck-canvas → found
           → Responder chain is fully consistent
```

The key guarantee: by the time the next keyboard event fires, React has committed, `useLayoutEffect` has run, and the responder chain is fully up-to-date.

##### When `flushSync` Is and Isn't Needed

`flushSync` forces React to render synchronously within the current call stack. We do NOT need it for the subscribable store pattern — `useSyncExternalStore` already triggers `SyncLane` renders, which React processes at the next microtask drain point.

`flushSync` would be needed only if imperative code must see the rendered DOM *within the same synchronous call stack* — for example, measuring an element's dimensions immediately after a state change. This is rare in our architecture because:
- Card positioning is appearance-zone (direct DOM manipulation, no React)
- Responder registration uses `useLayoutEffect` (fires during commit)
- Feed data flows through `useSyncExternalStore` (targeted re-renders)

If a future need arises, `flushSync` is the escape hatch, but it should be treated as a code smell indicating that the zone boundaries may need adjustment.

##### Relationship to Existing Patterns

This section extends the three-zone model (D12) with specific machinery for the boundary between imperative systems and React:

| System | Zone | Before (broken) | After (D40-D42) |
|--------|------|------------------|------------------|
| Card state (position, z-order) | Appearance → Structure | `root.render()` on every mutation (async gap) | `useSyncExternalStore` (SyncLane, no gap) |
| Responder registration | Appearance | `useEffect` (deferred, after paint) | `useLayoutEffect` (commit phase, before paint) |
| Focus change | Appearance | `root.render()` + `makeFirstResponder` (timing race) | `notify()` + `makeFirstResponder` (deterministic) |
| Card add/remove | Structure | `root.render()` with new props (async gap) | Store subscription triggers mount/unmount (SyncLane) |

### 6. Tugcard: The Common Base Component {#c06-tugcard}

**The problem.** Each card is a standalone React component that implements `TugCard` via `ReactCardAdapter`. There is no shared behavior beyond what `CardContext` provides. Every card independently handles its own layout, loading state, error state, feed data decoding, and metadata management. Eight cards, eight ad-hoc implementations of the same concerns.

**What tugcard should provide:**
- Standard card chrome (title bar, menu, close/minimize controls)
- Min-size calculation API — returns the minimum dimensions needed for content to remain visible
- Accessory view slots (e.g., find-in-text bar that any text-bearing card can use)
- Loading/skeleton state for moments before data is available
- Error state handling
- Theme-responsive behavior (reacts to theme changes without re-rendering via the mechanism from concept 5)
- Responder chain integration (concept 4) — the card is a responder that manages its child responders
- Feed subscription and data decoding (standardized, not per-card ad-hoc)

#### Composition, Not Inheritance {#d15-tugcard-composition}

React idiom strongly favors composition, and so do we. Tugcard is a wrapper component. Card authors compose their content into it:

```tsx
<Tugcard meta={meta} feedIds={[FeedId.GIT]}>
  <GitCardContent />
</Tugcard>
```

Tugcard owns the chrome, the responder chain node, the feed subscription, and the loading/error states. The child component receives feed data via a `useTugcardData()` hook — not a render prop. {#d16-hooks-not-render-props} Tugcard gates the child's mount: children don't render until feed data arrives, so the hook always returns populated data, never null. This follows the Excalidraw precedent — hooks for data access, parent handles gating logic.

```tsx
// Inside GitCardContent — useTugcardData() is always populated because
// Tugcard only mounts children after the first feed frame arrives.
function GitCardContent() {
  const data = useTugcardData<GitStatus>();
  return <div>{data.branch}</div>;
}
```

For feedless cards (AboutCard, SettingsCard), `feedIds={[]}` means the gate is always open — children mount immediately, `useTugcardData()` returns null, and the child simply never calls it.

#### Relationship to CardFrame

CardFrame stays. It is the positioning/sizing/drag/resize shell — it knows about pixels, z-index, pointer capture, and canvas bounds. Tugcard lives *inside* CardFrame and replaces the current pattern where each card component independently manages its own header, feed subscription, and state. Clean separation:

```
CardFrame (position, size, drag, resize, z-index)
  └─ Tugcard (chrome, responder, feed, loading/error, accessories)
       └─ card content (the part unique to each card type)
```

CardFrame doesn't know what a feed is or what a responder chain is. Tugcard doesn't know about pixel positions or drag handles.

The existing CardHeader stays conceptually — Tugcard renders the title bar internally using the same visual design (28px height, icon, title, menu, close/minimize controls). But the header gets its metadata directly from Tugcard's props rather than going through the `useCardMeta` → context → DeckCanvas → props round-trip. The header is an implementation detail of Tugcard, not something card authors interact with.

This is a new component, a clean break from the previous card-frame/card-header pattern. When implementation begins, all 8 existing cards migrate at once. None of them do important work yet — they're sketches. We eliminate old patterns immediately rather than maintaining two systems.

#### Dynamic Min-Size {#d17-dynamic-minsize}

All card controls must be visible. Cards only ever scroll for content, and even then the scroll container's frame must be visible — just not its full content bounds. The min-size is dynamic, content-based:

1. **Tugcard measures its non-scrollable regions**: header height (28px) + accessory slot heights (variable) + any fixed controls the child declares.
2. **The child declares a `minContentSize`**: the minimum dimensions the scroll container needs to be usable — not to show all content, just to have a visible frame (typically 60–80px).
3. **Tugcard's total min-size** = header + accessories + child's minContentSize.
4. **Dynamic recalculation**: when a find bar opens, min-size grows by the bar's height. When the child adds or removes fixed controls, min-size adjusts.
5. **CardFrame reads the min-size**: Tugcard exposes its computed minimum via a ref or callback. CardFrame already clamps resize — it just reads Tugcard's computed minimum instead of its current hardcoded `MIN_SIZE_PX = 100`.

```tsx
// Card author declares minimum content area size
<Tugcard meta={meta} feedIds={[FeedId.GIT]} minContentSize={{ width: 200, height: 80 }}>
  <GitCardContent />
</Tugcard>
```

#### Accessory View Slot

One slot: a top accessory that sits between the header and the content area. Find-in-text lives here.

```tsx
<Tugcard
  meta={meta}
  feedIds={[FeedId.CODE_OUTPUT]}
  accessory={showFind ? <FindBar onClose={() => setShowFind(false)} /> : null}
>
  <ConversationContent />
</Tugcard>
```

When the accessory is null, the slot collapses to zero height and the min-size shrinks accordingly. One slot is enough. If we need a bottom accessory later, we add it then.

The visual stack inside Tugcard:

```
┌─────────────────────────────┐
│  CardHeader (28px)          │  ← title, icon, menu, close/minimize
├─────────────────────────────┤
│  Accessory slot (0px–Npx)   │  ← find bar, or collapsed to nothing
├─────────────────────────────┤
│                             │
│  Content area               │  ← child component renders here
│  (scrollable if needed)     │
│                             │
└─────────────────────────────┘
```

#### Loading and Error States

**Loading.** Before any feed frame arrives, Tugcard renders a skeleton state in the content area (below the header). The child component is not mounted until data exists. The skeleton is a standard Tugcard visual — card authors don't design their own loading states.

**Error.** Tugcard wraps the child in an error boundary. If the child throws during render, Tugcard catches it and shows an error state in the content area. The header stays functional — close button works, card is still draggable. Card authors get error handling for free.

#### Responder Chain Integration

Tugcard is a responder node (concept 4). It sits between DeckCanvas and the card content in the chain:

```
DeckCanvas (app-level responder)
  └─ Tugcard (card-level responder)
       └─ card content responder (card-specific actions)
```

Tugcard handles standard card actions: `close`, `minimize`, `toggleMenu`, `find`. It delegates everything else down to the child content's responder. When a Tugcard becomes the "key" card (focused), it becomes the active node in the responder chain, and its children become eligible first responders.

#### Theme-Responsive Behavior

Per concept 5, appearance-zone only. Tugcard does not re-render on theme change. Its chrome uses CSS custom properties (`var(--td-header-active)`, `var(--td-panel)`, etc.) that resolve at paint time. The stylesheet injection mechanism from concept 1 updates the underlying `--tways-*` palette values; Tugcard's semantic tokens derive from those; everything updates for free. Zero re-renders.

#### Feed Subscription

Tugcard subscribes to the declared `feedIds` and holds the latest payload per feed. It decodes the raw `Uint8Array` via a `decode` prop (defaulting to JSON parse). The decoded data is what `useTugcardData()` returns to the child. This standardizes the subscription pattern and eliminates the per-card `useFeed` + `useEffect` decode boilerplate.

```tsx
// For cards that need custom decoding (e.g., terminal receives raw bytes):
<Tugcard
  meta={meta}
  feedIds={[FeedId.TERMINAL_OUTPUT]}
  decode={(feedId, bytes) => bytes}  // pass through raw
>
  <TerminalContent />
</Tugcard>
```

#### Tugcard Props Summary

```tsx
interface TugcardProps {
  meta: TugCardMeta;                           // title, icon, closable, menuItems
  feedIds: readonly FeedIdValue[];             // feeds to subscribe to
  decode?: (feedId: FeedIdValue, bytes: Uint8Array) => unknown;  // default: JSON parse
  minContentSize?: { width: number; height: number };            // default: { width: 100, height: 60 }
  accessory?: React.ReactNode | null;          // top accessory slot (find bar, etc.)
  children: React.ReactNode;                   // card content
}
```

#### Migration: Clean Cutover {#d18-clean-cutover}

All 8 existing cards (Conversation, Terminal, Git, Files, Stats, Settings, Developer, About) migrate to Tugcard at once. These cards are sketches, not production features. We eliminate `ReactCardAdapter`, `CardContextProvider`, `useCardMeta`, and the per-card `useFeed` + decode pattern in a single pass. One system, not two.

### 7. Feed Abstraction {#c07-feed}

**The problem.** Two distinct feed systems need design: (a) the **per-card data feed** — each card receives raw `Uint8Array` data via `useFeed()` and decodes it independently with no shared model; and (b) the **tug-feed** — a structured, real-time progress stream reporting what skills and agents are doing as they run.

**Backend architecture:** `dash/tug-feed.md` contains the complete tug-feed design — hooks-first event capture, correlation chain, feed event schema, four-phase implementation strategy, and risk analysis. This concept covers the **frontend rendering side**: how tug-feed events become visible UI through the design system's machinery, and how per-card data feeds relate to Tugcard.

#### Per-Card Data Feeds

Each card handles its own feed subscription ad-hoc:
- Terminal card: passes raw bytes to xterm.js
- Git card: decodes binary to text, parses as structured data
- Files card: same pattern, different structure
- Stats card: subscribes to four different feeds, decodes each differently
- Conversation card: complex message protocol with streaming

Tugcard (concept 6) standardizes the subscription and decode pattern: `feedIds` declares subscriptions, `decode` handles deserialization, `useTugcardData()` provides typed access. But the per-card feeds are genuinely different — raw bytes vs. structured JSON vs. streaming messages. A uniform `TugFeed` abstraction may not be desirable beyond what Tugcard already provides.

#### Tug-Feed: The Frontend Rendering Story

The tug-feed backend (designed in `tug-feed.md`) produces a stream of semantically-enriched events. Four architectural layers handle capture and correlation:

- **Layer 1 (Event Capture):** Async plugin hooks on `PreToolUse(Task)`, `SubagentStart`, `SubagentStop`, `PostToolUse(Task)` — pure observation, no orchestrator changes. Agent-scoped hooks on `PostToolUse(Edit|Write|Bash)` for file and command detail within agents.
- **Layer 2 (Feed-Capture Process):** Shell handlers that correlate hook events into semantic records. A `PreToolUse(Task)` stashes orchestrator context (step_anchor, plan_path, agent_role) keyed by `(session_id, agent_type)`. `SubagentStart` associates that context with `agent_id`. `SubagentStop` enriches with agent results. Correlation state lives in `.tugtool/feed/.pending-agents.json`.
- **Layer 3 (Feed Event Schema):** Typed JSON events written to `.tugtool/feed/feed.jsonl`. Each event carries `version`, `timestamp`, `session_id`, `event_type`, `plan_path`, `step_anchor`, `agent_role`, `workflow_phase`, and type-specific `data`. Thirteen event types: `agent_started`, `agent_completed`, `phase_changed`, `step_started`, `step_completed`, `file_modified`, `command_ran`, `build_result`, `test_result`, `review_verdict`, `drift_detected`, `commit_created`, `error`.
- **Layer 4 (Consumers):** CLI viewer (`tugcode feed tail`), **web dashboard card** (tugdeck — this is where the design system concepts apply), post-hoc report generator, notification sink.

The web dashboard consumer is a feed-progress card in tugdeck. This is where the design system intersects:

#### Event-to-Visual Mapping

Each of the 13 tug-feed event types needs a rendering strategy in the dashboard card:

| Event Type | Visual Representation |
|-----------|----------------------|
| `agent_started` | Animated spinner with agent role label (architect, coder, reviewer) |
| `agent_completed` | Spinner → checkmark/X with duration badge |
| `phase_changed` | Phase indicator updates (architect → code → review) |
| `step_started` | New step row appears in progress list with title and index (e.g., "Step 3 of 5") |
| `step_completed` | Progress bar segment fills, duration shown |
| `file_modified` | File path appended to a collapsible change list under the active step |
| `command_ran` | Command description with exit-code indicator (green check / red X) |
| `build_result` | Build status badge: passing (green) / failing (red with error count) |
| `test_result` | Test summary: "12 passed, 0 failed, 2 skipped" |
| `review_verdict` | APPROVE (green badge) / REVISE (amber badge with finding count) |
| `drift_detected` | Warning indicator with severity and unexpected file list |
| `commit_created` | Short SHA + message, linked to the step it belongs to |
| `error` | Red error banner with tool name and message |

These visual representations are Tugways components (concept 2) — badges, progress bars, spinners, status indicators. They follow the tugways naming convention and theme-responsive behavior.

#### Mutation Zone Assignment

The three-zone model (concept 5) applied to the feed-progress card:

- **Appearance zone (zero re-renders):** Animated spinners, progress bar fills, elapsed-time counters, phase indicator transitions. These are CSS transitions and `requestAnimationFrame` updates. A new `agent_started` event triggers a CSS class toggle on the step row — the spinner appears via CSS animation, no React state change. Progress bar width is set via `useDOMStyle` (concept 5 DOM utility hook). Elapsed time ticks via `requestAnimationFrame` updating a ref'd element's text content.
- **Local data zone (targeted re-renders):** The feed event stream itself. A `FeedEventStore` (external mutable store, subscribed via `useSyncExternalStore`) accumulates events and exposes them by step. When a new `step_started` event arrives, only the step-list component re-renders to add the new row. When a `file_modified` event arrives, only the file-list component for that step re-renders.
- **Structure zone (subtree re-renders):** Card mount/unmount, expanding/collapsing step detail sections, switching between summary and detail views.

#### Transport: Tugcast {#d19-tugcast-transport}

Tug-feed events reach the browser through **tugcast** — the existing WebSocket server that already bridges all data feeds to tugdeck. No new transport infrastructure.

Tugcast's binary framing protocol (`[1-byte FeedId][4-byte length][payload]`) carries every feed over a single WebSocket connection. Terminal I/O, git status, filesystem events, stats, agent messages — all flow through this same pipe. The tug-feed is just another feed.

**How it works:**
1. The feed-capture process (tug-feed.md Layer 2) writes enriched events to `.tugtool/feed/feed.jsonl`.
2. A new tugcast feed implementation (a `StreamFeed` using `broadcast`, since events are append-only and consumers need the full sequence) tails that JSONL file using `notify` (same pattern as `FilesystemFeed`) and publishes each new event as a frame with `FeedId::TugFeed` (`0x50`).
3. Register the new feed ID in `tugcast-core/src/protocol.rs` (Rust) and `tugdeck/src/protocol.ts` (TypeScript).
4. The feed-progress card subscribes via `TugConnection.onFrame(FeedId.TUG_FEED, cb)` — the standard mechanism every card already uses.

This makes the feed-progress card "just another Tugcard with a feedId." It benefits from tugcast's existing authentication, heartbeat, reconnection with bootstrap, and per-client state management. The tugcast `StreamFeed` trait's `broadcast` channel ensures every connected client receives every event in order, with the `BOOTSTRAP` state machine handling reconnection (re-sending recent events if a client lags).

#### The Live-Tail Pattern and Accumulation {#d20-accumulation-patterns}

The feed-progress card is a live-tail viewer — events append, the view updates in place. This differs from snapshot cards (Git, Stats) that receive a latest-state replacement on each frame.

Looking at the existing cards, three accumulation patterns emerge:

**Pattern 1: Snapshot (latest value wins).** Git card, stats cards. Each frame replaces the previous. No accumulation. `useTugcardData()` returns the current snapshot directly.

**Pattern 2: Append-stream (events accumulate into a buffer).** Files card (capped event list), conversation card (message history), and the new feed-progress card. Each frame adds to a growing data structure. The card manages its own buffer — this is inherently card-specific because the buffer structure, cap, and indexing vary (files card caps at 50/100/200 entries; conversation card has complex message ordering and streaming; feed-progress card indexes by step/phase).

**Pattern 3: Raw stream (pass-through to an external renderer).** Terminal card. Raw bytes go directly to xterm.js, which manages its own scroll buffer. The card doesn't accumulate — xterm does.

Accumulation is card-specific, but we should provide common support for the append-stream pattern since multiple cards use it. Two helpers:

**`useFeedBuffer<T>(options)`** {#accumulation-helpers} — a hook that maintains a capped ring buffer of decoded events. Cards that just need "recent N events in order" use this directly:

```tsx
function FilesCardContent() {
  const events = useFeedBuffer<FsEvent>({ maxSize: 200 });
  return <EventList items={events} />;
}
```

**`useFeedStore<T, S>(store)`** — a hook that feeds each decoded event into an external mutable store (the `FeedEventStore` pattern from the mutation zone discussion). Cards that need structured indexing — grouping events by step, tracking phase transitions, maintaining running totals — build a custom store and subscribe to slices via `useSyncExternalStore`:

```tsx
// Feed-progress card uses a custom store that indexes events by step
const feedStore = createFeedEventStore();

function FeedProgressContent() {
  const latestEvent = useTugcardData<FeedEvent>();
  // Each new event feeds into the store
  useFeedStore(feedStore, latestEvent);
  // Components subscribe to store slices
  const steps = useSyncExternalStore(feedStore.subscribe, feedStore.getSteps);
  return <StepList steps={steps} />;
}
```

Both helpers live in `tugways/hooks/` alongside the DOM utility hooks from concept 5.

#### Per-Card Data Feeds: Is Tugcard Enough?

Looking at all 8 existing cards through the lens of Tugcard's `feedIds`/`decode`/`useTugcardData()`:

- **Git, Files, Stats (snapshot cards):** `decode` parses JSON, `useTugcardData()` returns the latest snapshot. Tugcard is sufficient.
- **Terminal (raw stream):** `decode` passes bytes through, the child hands them to xterm.js. Tugcard is sufficient.
- **Conversation (append-stream with complex protocol):** `decode` parses each JSON-line message. Accumulation into message history is card-specific (ordering buffer, streaming chunks, tool-use/result pairing). Tugcard + `useFeedStore` covers this.
- **Stats (multi-feed):** Subscribes to 4 feed IDs (`Stats`, `StatsProcessInfo`, `StatsTokenUsage`, `StatsBuildStatus`). Tugcard already supports multiple `feedIds` — `useTugcardData()` keyed by feed ID.
- **Feed-progress (new, append-stream):** `decode` parses each event. `useFeedStore` with a step-indexed store. Tugcard + `useFeedStore` covers this.

**Conclusion: Tugcard's mechanism is sufficient.** The `feedIds`/`decode`/`useTugcardData()` pattern handles subscription and deserialization for all card types. The two accumulation helpers (`useFeedBuffer` for simple cases, `useFeedStore` for structured indexing) handle the append-stream pattern. No additional `TugFeed` abstraction is needed.

#### Interface-First, Mock the Backend {#d21-interface-first}

Define the interfaces clearly: the `FeedEvent` TypeScript types mirroring the 13 event types from tug-feed.md Layer 3, the `FeedId.TUG_FEED` constant, and the `FeedEventStore` that indexes events by step/phase. Implement the frontend feed-progress card against these interfaces with mock data. The backend (hooks, correlation, tugcast feed implementation) comes online later at a time of our choosing.

```tsx
// The feed-progress card — same pattern as every other card
<Tugcard
  meta={{ title: "Progress", icon: "Activity", closable: true, menuItems: [] }}
  feedIds={[FeedId.TUG_FEED]}
  decode={(feedId, bytes) => JSON.parse(new TextDecoder().decode(bytes)) as FeedEvent}
>
  <FeedProgressContent />
</Tugcard>
```

#### Questions to Resolve

- **Tugcast feed type:** `StreamFeed` (broadcast, every event in order) seems right for append-only events. But should the feed also provide a bootstrap snapshot (recent event history) on reconnection, like the terminal feed does via `tmux capture-pane`? If so, the implementation needs to read the tail of `feed.jsonl` on client connect.
- **Event batching:** Should tugcast batch multiple tug-feed events into a single WebSocket frame (JSON array), or send one frame per event? One-per-frame is simpler and matches the existing pattern. Batching reduces frame count during bursts but adds parsing complexity.
- **`useFeedBuffer` cap policy:** When the buffer is full, drop oldest (ring buffer)? Or stop accepting? Ring buffer is the obvious default, but the conversation card may want different behavior (keep all messages, paginate).

### 8. Motion and Visual Continuity {#c08-motion}

**Status: DESIGNED** (2026-03-02)

**The problem.** Tugdeck has no coherent story for how things move, appear, disappear, or transition between states. This shows up everywhere: dialogs pop into existence with no visual cue that they're modal. Cards have no skeleton or loading state. CSS edits in dev mode flash the entire UI. If we ever add card minimization, there's no way to animate the state change. These are all symptoms of one missing piece: **a motion and visual continuity system.**

This concept unifies what were previously three separate concerns — skeleton/loading states (old concept 8), UI-flash prevention (old concept 14), and the new transitions/animations story — into a single design that answers: **how does tugdeck manage visual state changes over time?**

#### Motion Tokens {#d23-motion-tokens}

Motion tokens are CSS custom properties, following the same `var(--td-*)` convention as theme tokens. They live in the appearance zone ([#d12-three-zones](#d12-three-zones)) — animations and transitions are visual presentation, not React state. Theme files can override motion tokens (e.g., a "calm" theme could use longer durations), but the defaults are global.

**Duration tokens** — four tiers, named by magnitude:

| Token | Value | Usage |
|-------|-------|-------|
| `--td-duration-fast` | 100ms | Micro-interactions: hover feedback, toggle state, focus ring |
| `--td-duration-moderate` | 200ms | Standard transitions: button press, panel expand/collapse |
| `--td-duration-slow` | 350ms | Major transitions: dialog appear/dismiss, card state change |
| `--td-duration-glacial` | 500ms | Dramatic transitions: startup overlay fade, first-paint reveal |

Four durations, not sixteen. Tugdeck is a developer tool, not a consumer app. Animations should feel crisp and purposeful, never decorative. If you're reaching for `glacial`, question whether the animation is needed at all.

**Easing tokens** — three curves, named by behavior:

| Token | Value | Usage |
|-------|-------|-------|
| `--td-easing-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Elements already on screen changing state. Fast start, gentle land. |
| `--td-easing-enter` | `cubic-bezier(0, 0, 0, 1)` | Elements appearing. Starts slow (from nothing), decelerates into place. |
| `--td-easing-exit` | `cubic-bezier(0.2, 0, 1, 1)` | Elements leaving. Accelerates away, doesn't waste time at the start. |

These are MD3's standard/decelerate/accelerate curves. They feel natural because they model physical objects — things at rest accelerate smoothly; things arriving decelerate.

**Duration scalar** — the reduced-motion kill switch: {#d24-reduced-motion}

```css
:root {
  --td-duration-scalar: 1;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --td-duration-scalar: 0.001;
  }
}
```

Every transition and animation duration is wrapped: `calc(var(--td-duration-scalar) * var(--td-duration-moderate))`. When the user prefers reduced motion, the scalar drops to near-zero (not zero — `0.001` ensures `animationend` and `transitionend` events still fire, which Radix's Presence component depends on for unmount timing).

**Apple's "replace, don't remove" principle:** When reduced motion is active, spatial animations (translate, scale) should be replaced with opacity fades, not eliminated entirely. The UI still needs to communicate state changes — a dialog should still fade in to signal modality, even if it doesn't scale up. This means components that animate `transform` should have a reduced-motion alternative that animates `opacity` instead.

**Where tokens live:** In `tokens.css` alongside the theme tokens, within a `/* Motion */` section. They are not theme-specific by default — all themes share the same motion timing. A theme *can* override them (e.g., `--td-duration-moderate: 300ms` for a more relaxed feel), but this is the exception, not the norm.

#### TugAnimator: Programmatic Animation Engine {#tuganimator}

**[D76] TugAnimator is the single programmatic animation engine for tugways.** {#d76-tuganimator}

CSS `transition` declarations remain for declarative hover/focus states — they're appearance-zone, zero-JS, compositor-accelerated, and auto-reversible. But everything beyond simple property transitions — enter/exit animations, spring dynamics, coordinated multi-element animations, drag release, card snapping — goes through TugAnimator. This is not two competing systems; it's declarative CSS for declarative state, and one programmatic engine for everything programmatic.

TugAnimator wraps the Web Animations API (WAAPI), which provides the completion handlers, cancellation, and additive composition that CSS animations lack:

**Core capabilities:**

| Capability | How |
|-----------|-----|
| **Completion promises** | `await tugAnimator.animate(el, props, opts)` — resolves when animation finishes, like UIView.animate's completion block |
| **Cancellation modes** | Cancel and snap to end value, cancel and hold at current interpolated value, cancel and reverse from current position |
| **Named animation slots** | `animate(el, props, { key: 'position' })` — a new animation with the same key cancels the previous one, like `CALayer.add(_:forKey:)` |
| **Additive composition** | Uses WAAPI's `composite: 'add'` so interrupting a running animation layers rather than clobbers — this is what makes iOS animations feel fluid |
| **Animation groups** | Coordinate multiple elements with a single completion, like UIView.animate: `const group = tugAnimator.group(opts); group.animate(cardA, ...); group.animate(cardB, ...); await group.finished;` |
| **Token-aware** | Reads `--tug-timing` to scale durations, respects `--tug-motion` toggle |
| **Reduced-motion aware** | Spatial animations (transform) replaced with opacity fades when motion is disabled, following Apple's "replace, don't remove" principle |

**Physics solvers** — TugAnimator pre-computes physics curves into WAAPI keyframes:

| Solver | Model | Use case |
|--------|-------|----------|
| **Spring** | Damped harmonic oscillator (mass, stiffness, damping, initial velocity) | Card snap to position, interruptible drag release, bounce-back |
| **Gravity + bounce** | Constant acceleration with coefficient of restitution | Drop-to-rest, playful reveals |
| **Friction / deceleration** | Exponential decay | Inertial scroll, flick gestures |

Spring animations support velocity matching on interruption: when a running spring is interrupted by a new animation, the current velocity transfers to the new animation's initial velocity. This is the key to fluid, interruptible motion — the object never appears to "reset" mid-flight.

**Relationship to CSS transitions:** CSS `transition` declarations handle hover, focus, and other declarative state changes. They stay in CSS because:
1. The compositor thread handles them at guaranteed 60fps with zero JS
2. They auto-reverse when the triggering state changes (e.g., hover off mid-transition)
3. They require no event listeners or cleanup

TugAnimator handles everything else: coordinated transitions, spring physics, drag release, flash overlays, startup fade, and skeleton-to-content crossfades. CSS `@keyframes` remain for Radix-managed enter/exit, continuous/infinite animations (shimmer, gallery petals), and any animation that needs no completion handler or cancellation. Gesture-driven `requestAnimationFrame` loops (drag tracking, resize, autoscroll) are not animations and stay as rAF.

**Decision rule — CSS vs TugAnimator vs rAF:**

| Question | → CSS | → TugAnimator | → rAF (not animation) |
|----------|-------|---------------|----------------------|
| Needs completion promise? | No | **Yes** | N/A |
| Needs cancellation modes? | No | **Yes** | N/A |
| Needs coordination across elements? | No | **Yes** | N/A |
| Needs physics (spring, bounce, friction)? | No | **Yes** | N/A |
| Triggered by CSS state (hover, focus, data-state)? | **Yes** | No | No |
| Runs continuously/infinitely? | **Yes** | No | No |
| Radix manages the DOM node? | **Yes** (`@keyframes`) | No | No |
| Reads pointer/input each frame? | No | No | **Yes** |

#### Enter/Exit Transitions {#enter-exit-transitions}

Enter/exit is the hardest animation problem in React: when a component unmounts, its DOM node vanishes instantly, leaving no time for an exit animation. Tugdeck's approach uses **Radix's data-state mechanism + CSS `@keyframes`** directly.

**How it works:**

1. Radix components (Dialog, Popover, etc.) set `data-state="open"` when visible and `data-state="closed"` just before unmounting.
2. Radix's `Presence` component delays DOM removal — it keeps the node alive in an `unmountSuspended` state and listens for the `animationend` event.
3. CSS `@keyframes` drive the actual animation, triggered by `data-state` selectors.
4. When `animationend` fires, Radix removes the node.

**The CSS pattern** (using `tw-animate-css` utilities already in the project):

```css
/* Dialog overlay — fade */
[data-state="open"]  { animation: enter var(--td-duration-slow) var(--td-easing-enter); }
[data-state="closed"] { animation: exit var(--td-duration-slow) var(--td-easing-exit); }

/* Dialog content — fade + scale */
[data-state="open"]  { --tw-enter-opacity: 0; --tw-enter-scale: 0.95; }
[data-state="closed"] { --tw-exit-opacity: 0; --tw-exit-scale: 0.95; }
```

The `tw-animate-css` package provides the `enter` and `exit` keyframes that read from `--tw-enter-*` / `--tw-exit-*` CSS variables. We set those variables to define what the animation does; the keyframes do the interpolation.

**Critical constraint: CSS `@keyframes` only.** Radix's Presence listens for `animationend`, not `transitionend`. CSS `transition` properties will not delay unmount. This is a known Radix limitation (issue #996, closed as wont-fix). All enter/exit animations must use `@keyframes`, which the `tw-animate-css` pattern already provides.

**What uses enter/exit transitions:**

| Component | Enter | Exit | Notes |
|-----------|-------|------|-------|
| Dialog overlay | Fade in | Fade out | Communicates modality |
| Dialog content | Fade + scale up from 95% | Fade + scale down to 95% | Focuses attention |
| Popover / dropdown | Fade + slide from anchor edge | Fade + slide back | Direction depends on placement |
| Toast / notification | Slide in from edge | Slide out + fade | Non-blocking, so exit can be faster |
| Card minimize (future) | Scale down to icon size | Scale up from icon | FLIP technique — see below |

**Card state transitions (minimize/iconify):** This is a layout animation, not a simple enter/exit. The card changes size and position. The FLIP technique (First, Last, Invert, Play) handles this: measure the card's current bounds, apply the layout change instantly, compute the delta, then animate only `transform` (compositor-friendly) to bridge the visual gap. TugAnimator ([#d76-tuganimator](#d76-tuganimator)) handles the interpolation via WAAPI, with spring physics for natural deceleration and completion-based cleanup.

**Reduced motion for enter/exit:** Replace scale+fade with fade-only. The dialog still signals modality (it fades in over a dimmed backdrop), but the spatial movement is removed:

```css
@media (prefers-reduced-motion: reduce) {
  [data-state="open"]  { --tw-enter-scale: 1; }  /* no scale, fade only */
  [data-state="closed"] { --tw-exit-scale: 1; }
}
```

#### Skeleton and Loading States {#skeleton-loading}

When a card first appears or loses its data connection, it needs a visual language for "data is arriving" that is smooth, theme-aware, and consistent across all cards.

**Skeleton shimmer — pure CSS, synchronized:**

```css
.td-skeleton {
  background: linear-gradient(90deg,
    var(--td-skeleton-base) 25%,
    var(--td-skeleton-highlight) 50%,
    var(--td-skeleton-base) 75%);
  background-size: 200% 100%;
  background-attachment: fixed;  /* all skeletons shimmer in sync */
  animation: td-shimmer calc(var(--td-duration-scalar) * 1.5s) ease-in-out infinite;
  border-radius: var(--td-radius-sm);
}

@keyframes td-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

Key details:
- **`background-attachment: fixed`** — all skeleton elements on screen shimmer in unison, not independently. This looks intentional rather than chaotic.
- **Theme-aware colors** — `--td-skeleton-base` and `--td-skeleton-highlight` are semantic tokens derived from the theme's background. Brio: dark gray → slightly lighter gray. Harmony: warm tan → slightly lighter tan. The shimmer is always subtle.
- **Duration scalar applies** — when reduced motion is active, shimmer duration drops to near-instant (effectively a static placeholder with no movement).

**Per-card skeleton shapes:**

Each card type defines its own skeleton layout — a terminal skeleton has rectangular text-line placeholders; a git-status skeleton has a tree-like structure with branch lines. Skeletons are not generic gray boxes. They preview the card's actual content structure so the transition to real content feels like "filling in" rather than "replacing."

Tugcard ([#c06-tugcard](#c06-tugcard)) already gates child mounting: when feed data hasn't arrived, the card renders its skeleton. Card content components provide a static `skeleton` property (a React component) that Tugcard renders in place of the content:

```tsx
function TerminalCardContent() { /* ... actual content ... */ }
TerminalCardContent.skeleton = () => (
  <div className="td-skeleton-group">
    <div className="td-skeleton" style={{ width: "60%", height: 14 }} />
    <div className="td-skeleton" style={{ width: "80%", height: 14 }} />
    <div className="td-skeleton" style={{ width: "45%", height: 14 }} />
  </div>
);
```

**Skeleton → content transition:**

When data arrives, the skeleton crossfades to the actual content. This is an appearance-zone animation — no React state for the animation itself:

1. Tugcard renders the real content alongside the skeleton (both in the DOM).
2. The skeleton has `opacity: 1`; the content has `opacity: 0`.
3. On data arrival, a CSS class swap triggers: skeleton fades out (`opacity: 0`, duration `--td-duration-moderate`), content fades in (`opacity: 1`, same duration).
4. After `transitionend`, the skeleton is removed from the DOM.

This crossfade is subtle and fast — the user barely notices it. What they *do* notice is that the card was never blank.

**Error and disconnected states:**

- **"No data yet"** — the skeleton keeps shimmering. No timeout. The skeleton *is* the "waiting" indicator.
- **"Disconnected"** — the `DisconnectBanner` (already implemented) renders a yellow bar at the top of the deck. Cards retain their last data (from `DeckManager.lastPayload`). Skeletons don't reappear — showing stale data is better than showing a loading state for a temporary disconnection.
- **"Failed to load"** — Tugcard renders an error state (icon + message) in place of content. This is a structure-zone change (conditional rendering), not an animation. The error state appears immediately — no transition, because errors should not be softened.

#### Startup Continuity {#startup-continuity}

Startup continuity prevents the visible flash during full page reloads (browser refresh, `reload_frontend` control frame, backend restart + reload). The three-layer approach from `dash/eliminate-frontend-flash.md`:

**Layer A — Inline body styles** (eliminates the white flash):

```html
<body style="margin:0;padding:0;overflow:hidden;background-color:#1c1e22">
```

The value `#1c1e22` is Brio's canvas color. Applied during HTML parse, before any CSS loads. For non-Brio users, there's a brief shift from Brio's dark to the actual theme color when CSS loads — far less jarring than white → dark. The pragmatic default.

**Layer B — Startup overlay** (hides the mount transition):

```html
<div id="deck-startup-overlay"
     style="position:fixed;inset:0;background:#1c1e22;z-index:99999;
            pointer-events:none"></div>
```

The overlay covers the viewport from first paint. It hides the empty `deck-container` during settings-fetch and React-mount phases. After React commits the first render to the DOM, a `useLayoutEffect` in the root component (DeckCanvas) fires deterministically — before the browser paints — and starts a TugAnimator fade-out on the overlay. The browser composites both the React content and the first frame of the fade animation in a single paint. This is the `onContentReady` pattern ([D78], [D79], Rules 11–12) applied at viewport scope: card-level readiness uses a ref flag + `useLayoutEffect`; viewport-level readiness uses `useLayoutEffect` directly in the root component. Same mechanism, same guarantees, different scope.

Note: the overlay and Tugcard skeletons operate at different levels. The overlay covers the *entire viewport* during app bootstrap. Skeletons cover *individual cards* once mounted. The sequence is: overlay fades out → deck with skeleton cards is revealed → cards crossfade to real content as data arrives.

**Layer C — CSS HMR boundary** (dev mode only — prevents full reloads for CSS changes):

A dedicated `css-imports.ts` module that imports all CSS files and has `import.meta.hot.accept()`. CSS invalidations stop at this boundary instead of propagating to `main.tsx`. CSS edits hot-swap `<style>` tags without full page reload. This is a Vite dev-server concern — `import.meta.hot` is tree-shaken in production builds.

**Relationship to theme system:** When themes become loadable resources ([#c01-theme](#c01-theme)), the stylesheet injection mechanism bypasses Vite's module graph entirely — injected `<style>` elements are runtime DOM mutations, not module imports. Layer C is only needed for base `tokens.css` and `globals.css` changes that go through Vite's build pipeline.

**See:** `dash/eliminate-frontend-flash.md` for the full root cause analysis, module graph walkthrough, and implementation plan.

#### What Concept 8 Demonstrates {#c08-demonstrates}

This concept establishes the pattern for all visual continuity in tugdeck:

1. **Motion is tokenized** — durations and easings are CSS custom properties, not magic numbers scattered across components. Change `--td-duration-moderate` once, every transition in the app updates. ([#d23-motion-tokens](#d23-motion-tokens))
2. **Motion lives in the appearance zone** — animations are CSS `@keyframes` and `transition` properties, not React state. Theme changes, reduced motion, and timing adjustments are free — zero re-renders. ([#d12-three-zones](#d12-three-zones))
3. **Reduced motion is a scalar, not a kill switch** — spatial animations become opacity fades, not nothing. The UI still communicates state changes. ([#d24-reduced-motion](#d24-reduced-motion))
4. **Two complementary motion layers** — CSS `transition` for declarative hover/focus states (compositor-accelerated, zero JS); TugAnimator for everything programmatic (completion handlers, cancellation, springs, physics, coordinated groups). Not competing systems — one is declarative, one is imperative. ([#tuganimator](#tuganimator))
5. **Enter/exit uses Radix's data-state + CSS keyframes** — standard component transitions use the Radix + tw-animate-css stack. Complex enter/exit (coordinated, physics-based) can use TugAnimator. ([#enter-exit-transitions](#enter-exit-transitions))
6. **Skeletons are per-card, synchronized, and theme-aware** — each card defines its skeleton shape. All skeletons shimmer in unison. Colors come from theme tokens. ([#skeleton-loading](#skeleton-loading))
7. **Startup follows the same rules as everything else** — nothing visible until ready, every transition authored. The three startup layers (inline body styles, startup overlay, CSS HMR boundary) are applications of these principles at the viewport level, not exceptions to them. The overlay is a viewport-scoped readiness gate, just as skeletons are card-scoped readiness gates. Both hide unready content and reveal it with a managed transition. The overlay fade-out uses `useLayoutEffect` in the root component as the deterministic readiness signal ([D78], [D79], Rules 11–12) and TugAnimator for the managed fade ([D76], Rules 13–14). ([#startup-continuity](#startup-continuity))

### 9. Alert and Dialog System {#c09-dialog}

**Status: DESIGNED** (2026-03-02)

**The problem.** Tugdeck needs structured modal interaction at multiple scopes — app-wide, card-scoped, button-local, and non-blocking — with each level having clear rules for how it interacts with the responder chain, focus management, and the rest of the UI.

#### Apple's Modal Model: What We're Drawing From {#apple-modal-model}

Apple's AppKit provides the architectural reference. Three mechanisms, each with different scope and event handling:

**`NSApplication.runModal(for:)`** — app-modal. Starts a nested run loop. The calling code *blocks* at the call site. Only the modal window receives events. All other windows are inert. When the user clicks a button, `stopModal(withCode:)` breaks the loop and control returns to the caller with a `ModalResponse` value.

**`NSWindow.beginSheet(_:completionHandler:)`** — document-modal. A sheet slides down from the parent window's title bar. Only the parent window is blocked; other windows remain interactive. The completion handler fires asynchronously when the sheet is dismissed. Sheets queue — if one is already showing, the next one waits.

**`NSAlert`** — the alert primitive. Configurable: `messageText`, `informativeText`, `alertStyle` (informational/warning/critical), up to 3+ buttons via `addButton(withTitle:)`. Can be presented as either app-modal (`runModal()`) or document-modal (`beginSheetModal(for:completionHandler:)`).

**`NSPopover`** — not modal. Auxiliary content anchored to a view. Three behaviors: `.transient` (closes on outside click), `.semitransient` (closes on parent window interaction), `.applicationDefined` (manual). Does not trap focus. Not used for confirmations in Apple's own apps — but SwiftUI's `confirmationDialog` renders as a popover on iPad, establishing precedent for button-anchored confirmations.

#### How This Maps to Tugdeck {#d25-four-modal-categories}

JavaScript cannot block the event loop like AppKit's `runModal(for:)`. But we can block the *responder chain*. When an app-modal alert is showing, the chain manager sets a `modalScope` flag. `dispatch()` checks this flag and refuses to route actions to the main chain. The dialog's own buttons use direct `onClick` handlers — they bypass the chain entirely. This gives the *behavioral* equivalent of Apple's nested run loop without blocking the thread.

**Four categories, mapped from Apple:**

| Category | Apple equivalent | Scope | Chain impact | Focus |
|----------|-----------------|-------|-------------|-------|
| **TugAlert** | `NSAlert.runModal()` | Entire app | Chain blocked | Trapped in dialog |
| **TugSheet** | `NSWindow.beginSheet()` | Single card | Card's node suspended | Trapped in sheet |
| **TugConfirmPopover** | iPad `confirmationDialog` | Button-local | None | Moves to popover |
| **TugToast** | Notification center | None | None | Never steals focus |

#### TugAlert — App-Modal Alert {#tugalert}

Blocks the entire application. The user must respond before doing anything else.

**When to use:** Critical errors, unsaved-changes warnings, destructive actions that affect multiple cards or the whole app, first-run setup confirmations.

**Responder chain:** The chain manager enters `modalScope: "app"`. All `dispatch()` calls to the main chain are refused. Global shortcuts (Cmd+Q) are blocked. Escape dismisses the alert (matching Apple's behavior). The alert's buttons have direct `onClick` handlers — they do not participate in the responder chain.

**Focus:** Radix AlertDialog handles focus trapping. Tab/Shift+Tab cycle within the dialog. On dismiss, focus returns to the element that triggered the alert. Background content gets the `inert` attribute (applied automatically by Radix).

**Visual treatment:** Full-viewport overlay (semi-transparent dark backdrop using motion tokens from [#c08-motion](#c08-motion)). Alert content fades in + scales from 95% using the enter/exit pattern from [#enter-exit-transitions](#enter-exit-transitions). Overlay click does *not* dismiss (this is AlertDialog, not Dialog — the user must click a button).

**Why AlertDialog, not Dialog:** Radix's `AlertDialog` sets `role="alertdialog"` and prevents overlay-click dismissal. `Dialog` allows dismissal by clicking outside, which is wrong for confirmations. The behavioral difference maps exactly to Apple's distinction between sheets (can cancel by clicking elsewhere on some platforms) and alerts (must respond explicitly).

**API — imperative, Promise-based:**

```tsx
const response = await tugAlert({
  title: "Delete project?",
  message: "This action cannot be undone.",
  style: "warning",                              // "informational" | "warning" | "critical"
  buttons: [
    { label: "Delete", role: "destructive" },    // red text, not the default
    { label: "Cancel", role: "cancel" },          // bold, default (Enter key)
  ],
});
// response === "Delete" | "Cancel"
```

The imperative API wraps a declarative React component internally. A `TugAlertHost` component (rendered once, at the app root) listens for alert requests and manages the AlertDialog state. The `tugAlert()` function posts a request and returns a Promise that resolves when the user clicks a button.

**Button roles** (modeled on `UIAlertAction.Style` and Apple HIG):
- `"destructive"` — red text, `variant="destructive"`. Signals danger. Never the default button.
- `"cancel"` — the safe choice. Responds to Escape. When a `"destructive"` button is present, Cancel becomes the default button: `variant="primary"` (accent fill), registered with the responder chain via `setDefaultButton`, responds to Enter ([#d39-default-button](#d39-default-button)). There is exactly one cancel button.
- `"default"` — the affirmative action. When no `"destructive"` button is present, this is the default button: `variant="primary"`, registered via `setDefaultButton`, responds to Enter. When a `"destructive"` button *is* present, the `"default"` role uses `variant="secondary"` (not the default button — Cancel takes priority).

Apple's HIG guidance: when the alert confirms a destructive action that the user explicitly initiated, make Cancel the default button so Enter cancels rather than confirms. `tugAlert` follows this — `"cancel"` is always the default button when a `"destructive"` button is present. The `primary` variant's accent fill (`--td-accent`) is the visual affordance that communicates which button Enter will activate ([#d39-default-button](#d39-default-button)).

**Alert styles** (modeled on `NSAlert.Style`):
- `"informational"` — app icon. Notice about a current or impending event.
- `"warning"` — caution badge. User should be aware of consequences.
- `"critical"` — caution icon. Potential data loss or system damage.

In practice, the visual difference between styles is minimal (icon changes). The semantic distinction matters for screen readers and for establishing the gravity of the alert.

#### TugSheet — Card-Modal Dialog {#tugsheet}

Blocks a single card. Other cards remain interactive.

**When to use:** Card close confirmation ("you have unsaved changes"), card-specific settings that require acknowledgment, card-specific destructive actions.

**Responder chain:** The card's responder node is marked `suspended`. Actions dispatched from within the card's subtree are blocked. Other cards' chains are unaffected. Deck-level actions (switching focus to another card) still work. Global shortcuts still work — this matches Apple's behavior where sheets don't disable the menu bar.

**Focus:** Focus is trapped within the card's sheet content. Tab/Shift+Tab cycle within the sheet. On dismiss, focus returns to the card's previously focused element. The card's content area (outside the sheet) receives a visual dimming overlay but other cards do not.

**Visual treatment:** The sheet renders *within the card's bounds*, not as a full-viewport overlay. A semi-transparent backdrop covers only the card's content area. The sheet content slides down from the card's header (matching Apple's sheet animation) or fades in, using motion tokens. Other cards are visually unaffected — they remain bright and interactive.

**Implementation — Radix Dialog with scoped rendering:**

Radix's `Dialog.Portal` accepts a `container` prop to render inside a specific DOM element. For card-modal sheets:

1. The sheet portal targets the card's content container.
2. The overlay is scoped to the card (CSS `position: absolute` within the card, not `position: fixed` on the viewport).
3. `inert` is applied to the card's content area only — not to the whole document. This is manual (Radix applies `inert` globally for its portals); we override by removing `inert` from non-card elements after Radix applies it, or by not using Radix's `modal` mode and implementing card-scoped inertness ourselves.

This is the one place where we diverge from Radix's defaults. Radix doesn't natively support subtree-scoped modality. We accept the extra implementation work because card-modal is a core interaction pattern — cards are independent workspaces, and blocking the entire app for a card-level concern violates that model.

**API — imperative, same shape as TugAlert:**

```tsx
const response = await tugSheet(cardId, {
  title: "Close this card?",
  message: "You have unsaved changes.",
  buttons: [
    { label: "Close Without Saving", role: "destructive" },
    { label: "Cancel", role: "cancel" },
  ],
});
```

A `TugSheetHost` is rendered inside each Tugcard. It listens for sheet requests scoped to its card ID.

#### TugConfirmPopover — Button-Anchored Confirmation {#d26-confirm-popover}

A small popover graphically tied to a button that compels the user to move their mouse and click again to confirm. Not modal in the responder chain sense — it's a lightweight UI gate on a single action.

**When to use:** Close-button confirmation on cards, delete-item buttons, any single-button destructive action where a full alert is too heavy but accidental clicks need prevention.

**Responder chain:** No impact. The chain is unaffected. The popover is just UI — the underlying button enters a "pending confirmation" visual state while the popover is open, but no chain nodes are suspended or blocked.

**Focus:** Focus moves to the popover on open. The confirm button is registered as the default button via `setDefaultButton` ([#d39-default-button](#d39-default-button)), so Enter activates it even if focus is elsewhere within the popover. Escape closes the popover and returns focus to the trigger. The popover does not trap focus — Tab can move out of it, which closes it (matching `NSPopover.Behavior.transient`). This is intentional: the popover is lightweight. Moving focus away is equivalent to clicking away — a soft cancel.

**Visual treatment:** Radix Popover anchored to the trigger button. Arrow pointing to the trigger. Positioned via `side`/`align` props with collision avoidance. Enter/exit animation using the `data-state` + CSS `@keyframes` pattern from [#enter-exit-transitions](#enter-exit-transitions). Fast timing — `--td-duration-fast` — because this is a micro-interaction, not a major state change.

**API — declarative component (not imperative):**

```tsx
<TugConfirmPopover
  onConfirm={() => closeCard(cardId)}
  message="Close this card?"
  confirmLabel="Close"
  confirmVariant="destructive"
>
  <TugButton subtype="icon" icon={<X />} aria-label="Close card" />
</TugConfirmPopover>
```

`TugConfirmPopover` wraps its children as the trigger. When clicked, instead of immediately firing `onConfirm`, it opens a small popover with the message and two buttons: the confirm button (label and variant configurable) and a Cancel button. The user must click confirm (or press Enter, since confirm is focused) to execute the action. Clicking away, pressing Escape, or clicking Cancel dismisses without confirming.

**Why this is a separate category from TugSheet:** The user's response was clear — button confirmation is its own thing. It's not modal to the card or the app. It doesn't block the responder chain. It doesn't trap focus. It's a lightweight "are you sure?" tied to a specific button. A TugSheet for every close button would be too heavy — it dims the card, traps focus, suspends the chain. The confirm popover is snappy: click, see a small popover, click again or press Enter to confirm. Done.

**Close-button integration:** The card title bar's close button ([#c10-titlebar](#c10-titlebar)) wraps in `TugConfirmPopover`. Click the X → popover appears anchored to the X → click "Close" or press Enter → card closes. Click away → nothing happens. This is the standard pattern for all destructive button actions.

#### TugToast — Non-Blocking Notification {#tugtoast}

Fire-and-forget notifications that don't interrupt the user's workflow.

**When to use:** Build succeeded/failed, agent completed a step, connection restored, settings saved, any status update the user should see but doesn't need to act on.

**Responder chain:** No impact whatsoever. Toasts don't participate in the chain. They don't receive focus. They don't block actions. They are pure informational.

**Focus:** Toasts never steal focus. They appear in a corner of the viewport and auto-dismiss after a configurable duration. A global hotkey (Alt+T, configurable) moves focus to the toast region for keyboard interaction. This matches macOS's notification behavior — notifications are announced by VoiceOver but don't take key focus.

**Accessibility:** Sonner renders a persistent `<section role="region" aria-label="Notifications">` with `aria-relevant="additions text"`. Screen readers announce new toasts via the live region without interrupting the user's current interaction. The region element exists in the DOM even when no toasts are showing — required for ARIA live regions to work.

**Implementation — Sonner:**

```tsx
// App root — render once
<TugToaster position="bottom-right" theme="system" duration={4000} />

// Anywhere in the app — fire and forget
tugToast.success("Build succeeded");
tugToast.error("Connection lost");
tugToast.info("Agent completed step 3");

// With action button
tugToast("Settings saved", {
  action: { label: "Undo", onClick: () => revertSettings() },
});

// Promise-based (loading → success/error)
tugToast.promise(deployBuild(), {
  loading: "Deploying...",
  success: "Deployed successfully",
  error: (err) => `Deploy failed: ${err.message}`,
});
```

`TugToaster` is a thin wrapper around Sonner's `Toaster` that applies tugways theming (colors from `var(--td-*)` tokens, border radius from `--td-radius-*`, enter/exit animation from [#enter-exit-transitions](#enter-exit-transitions)). `tugToast` is a thin wrapper around Sonner's `toast` function.

**Toast variants:**
- `success` — green accent (token: `--td-toast-success`)
- `error` — red accent (token: `--td-toast-error`)
- `warning` — yellow accent (token: `--td-toast-warning`)
- `info` — blue accent (token: `--td-toast-info`)
- Default — no accent color, neutral background

**Auto-dismiss:** 4 seconds default. Configurable per-toast via `duration`. Hovering pauses the timer (Sonner default behavior). Error toasts use a longer duration (8 seconds) because they're more important.

#### Alert System Architecture {#alert-architecture}

**Host components:** Two host components render at fixed points in the tree:

```
TugApp
  ├─ TugAlertHost          ← listens for tugAlert() requests, renders AlertDialog
  ├─ TugToaster            ← Sonner toast container
  └─ DeckCanvas
       ├─ CardFrame
       │    └─ Tugcard
       │         ├─ TugSheetHost   ← listens for tugSheet(cardId) requests
       │         └─ card content
       └─ ...
```

`TugAlertHost` and `TugSheetHost` are thin React components that subscribe to an alert request store (a simple `useSyncExternalStore` pattern — matches [#d12-three-zones](#d12-three-zones)). When `tugAlert()` or `tugSheet()` is called, the request is posted to the store, the host component renders the dialog, and the Promise resolves when the user responds.

**The imperative-over-declarative bridge:** `tugAlert()` and `tugSheet()` are imperative functions that return Promises, but they drive declarative React components under the hood. The pattern:

1. Call `tugAlert({ title, message, buttons })`.
2. The function creates a Promise, posts a request object to a module-level store.
3. `TugAlertHost` re-renders, sees the pending request, renders `<AlertDialog>`.
4. User clicks a button. The `onClick` handler resolves the Promise with the button's label and clears the request from the store.
5. `TugAlertHost` re-renders, sees no pending request, unmounts the dialog.

This is the standard React pattern for imperative-over-declarative APIs (same pattern as `react-hot-toast`, Sonner, Chakra's `useToast`).

#### Mutation Zone Assignment {#dialog-zones}

| Zone | What changes | Mechanism |
|------|-------------|-----------|
| **Appearance** | Backdrop opacity, dialog scale/fade animation, dimming of blocked content | CSS transitions + `data-state` (zero re-renders) |
| **Local data** | Alert host's pending request state | `useSyncExternalStore` on the alert request store |
| **Structure** | Dialog component mount/unmount, `inert` attribute on background | React conditional rendering driven by request store |

#### What Concept 9 Establishes {#c09-demonstrates}

1. **Four modal categories with clear scope** — app-modal, card-modal, button-confirmation, toast. Each has defined responder chain impact, focus behavior, and visual treatment. ([#d25-four-modal-categories](#d25-four-modal-categories))
2. **Responder chain modality** — app-modal blocks the chain globally; card-modal suspends one node; confirm-popover and toast have zero chain impact. The chain is the modality mechanism, not the DOM. ([#apple-modal-model](#apple-modal-model))
3. **Imperative API for alerts, declarative for confirmations** — `tugAlert()` and `tugSheet()` return Promises (Apple-inspired, web-adapted). `TugConfirmPopover` is a component you wrap around a button. `tugToast` is fire-and-forget. ([#tugalert](#tugalert), [#d26-confirm-popover](#d26-confirm-popover), [#tugtoast](#tugtoast))
4. **Button-confirmation is its own category** — not a sheet, not an alert. A lightweight popover anchored to the trigger button. Snappy, not ceremonial. ([#d26-confirm-popover](#d26-confirm-popover))
5. **All animations use concept 8's motion system** — enter/exit via `data-state` + CSS keyframes, timing from motion tokens, reduced-motion scalar applies. ([#c08-motion](#c08-motion))

### 10. Card Title Bar Enhancements {#c10-titlebar}

**Status: DESIGNED** (2026-03-02)

**The problem.** The card title bar needs three changes: a window-shade collapse control, a close confirmation, and a menu icon rotation. These are small individually, but they establish patterns for how the title bar evolves.

The good news: the existing `CardHeader` component (`card-header.tsx`) already has the plumbing for all three — `showCollapse` prop with `onCollapse` callback, `onClose` callback, and the `EllipsisVertical` menu icon. The work is connecting these to the right behaviors.

#### Window-Shade Collapse {#d27-window-shade}

**What it is:** Collapse the card to its title bar only — the content area disappears, leaving just the 28px header strip. Click again (or click the same chevron) to expand back to full size. This is the classic Mac OS "window shade" from System 7 through Mac OS 9.

**State:** The collapsed/expanded state is stored in `CardState` (the layout tree's per-card state object). It persists across re-renders and is included in layout serialization so the deck remembers which cards are collapsed on reload.

```ts
// Addition to CardState in layout-tree.ts
interface CardState {
  position: { x: number; y: number };
  size: { width: number; height: number };
  collapsed: boolean;  // ← new
}
```

**Control:** A chevron button in the title bar (between the menu button and close button, replacing the current `Minus` icon). The chevron points down when expanded (indicating "collapse available") and up when collapsed (indicating "expand available"). The existing `showCollapse` prop and `onCollapse` callback on `CardHeader` already support this — `showCollapse` just needs to default to `true` instead of `false`.

```
Expanded:  [icon] TERMINAL    [☰] [▾] [✕]
Collapsed: [icon] TERMINAL    [☰] [▴] [✕]
```

Use `ChevronDown` / `ChevronUp` from lucide-react. The current `Minus` icon for collapse is ambiguous — it could mean minimize, close, or subtract. Chevrons clearly communicate directionality.

**CardFrame behavior when collapsed:**

1. Height animates from current `size.height` to `CARD_TITLE_BAR_HEIGHT` (28px) + border. Uses `--td-duration-moderate` and `--td-easing-standard` from concept 8's motion tokens ([#d23-motion-tokens](#d23-motion-tokens)).
2. Content area has `overflow: hidden` and its height goes to 0. No content is unmounted — it's hidden, not removed. This means the card's internal state (terminal session, scroll position, form values) is preserved.
3. Resize handles are hidden when collapsed — there's nothing to resize. Drag remains active (you can reposition a collapsed card).
4. The card's position doesn't change — it collapses downward in place (the top edge stays where it is, the bottom edge moves up).

**Mutation zone:** The collapse animation is appearance-zone (CSS `height` transition on the card frame, `overflow: hidden` on content). The collapsed state itself is local data (persisted in `CardState` via DeckManager). The chevron icon swap is a structure-zone change (conditional rendering of the icon based on `collapsed`).

**Double-click on header:** As a secondary gesture, double-clicking the title bar toggles collapse — matching macOS behavior (System Preferences → Dock → "Double-click a window's title bar to minimize"). This is a convenience, not the primary control.

#### Close Confirmation {#close-confirmation}

**Trigger: always.** Every closable card gets a confirmation popover when the close button is clicked. This uses the TugConfirmPopover pattern from concept 9 ([#d26-confirm-popover](#d26-confirm-popover)).

**Implementation:** Replace the current direct `onClose` call in `CardHeader`'s close button with a `TugConfirmPopover` wrapper:

```tsx
{meta.closable && (
  <TugConfirmPopover
    onConfirm={onClose}
    message={`Close ${meta.title}?`}
    confirmLabel="Close"
    confirmVariant="destructive"
  >
    <button className="card-header-btn ..." aria-label="Close card" type="button">
      <X width={14} height={14} />
    </button>
  </TugConfirmPopover>
)}
```

The popover anchors to the X button. Click X → popover appears below → click "Close" or press Enter → card closes. Click away or press Escape → nothing happens. This matches the pattern described in concept 9 — snappy, button-local, no responder chain impact.

**Future refinement:** The "always confirm" rule is a safe starting point. Later, we may differentiate — cards with unsaved state always confirm, cards without unsaved state close immediately. But that requires a notion of "unsaved state" in the card model, which doesn't exist yet. Always-confirm is the pragmatic default.

#### Menu Icon Rotation {#menu-icon-rotation}

**Change:** Rotate the hamburger menu icon 90 degrees so the three dots are horizontal (`EllipsisVertical` → stays vertical but the dots should read as a more standard vertical kebab menu icon). Actually, the current `EllipsisVertical` is already a vertical three-dot icon. The request is to rotate it to horizontal — use `Ellipsis` (horizontal three-dot) from lucide-react instead.

Wait — re-reading the original request: "Rotate hamburger menu icon 90 degrees." The current icon is `EllipsisVertical` (⋮). Rotating 90° would make it horizontal (⋯). This is a one-line change:

```tsx
// Before
import { EllipsisVertical } from "lucide-react";

// After
import { Ellipsis } from "lucide-react";
```

This is a purely cosmetic change. `Ellipsis` (⋯) reads as "more options" in the same way `EllipsisVertical` (⋮) does — both are standard menu trigger icons. The horizontal variant is arguably more common on the web.

#### Title Bar Button Order {#titlebar-button-order}

The current order is: `[menu] [collapse] [close]`, right-aligned. This matches macOS window button ordering convention (left-to-right: close, minimize, maximize on Mac — but our buttons are right-aligned, so the order inverts). For consistency with web conventions (where the close button is rightmost):

```
[icon] CARD TITLE    [⋯] [▾/▴] [✕]
         menu ─────────┘    │     └── close (always rightmost)
         collapse ──────────┘
```

This order is already correct in the existing `CardHeader` implementation. No change needed.

#### What Concept 10 Establishes {#c10-demonstrates}

1. **Window-shade collapse persists in CardState** — layout serialization remembers collapsed cards. Content is hidden (CSS), not unmounted (React). State preserved. ([#d27-window-shade](#d27-window-shade))
2. **Close confirmation uses TugConfirmPopover** — the title bar is the first real consumer of concept 9's button-confirmation pattern. Always-confirm for now; differentiable later. ([#close-confirmation](#close-confirmation))
3. **Title bar animations use motion tokens** — collapse/expand height transition uses `--td-duration-moderate` + `--td-easing-standard`. Appearance zone, zero unnecessary re-renders. ([#d23-motion-tokens](#d23-motion-tokens))

### 11. Dock Redesign {#c11-dock}

**Status: DESIGNED** (2026-03-02)

**The problem.** The dock currently has one kind of button: card-toggle buttons that show/focus a card. It needs two additional kinds: command buttons (that trigger an action directly) and popout menu buttons (that open a floating menu anchored to the dock). It also needs positional flexibility and hover tooltips.

The existing dock (`dock.tsx`) is a fixed 48px vertical rail on the right edge with six card buttons, a settings dropdown, and a logo. The redesign adds button types and flexibility without fundamentally changing the structure.

#### Three Button Types {#d28-dock-button-types}

The dock has three kinds of buttons, each rendered with the same visual treatment (32×32 icon button) but with different click behavior:

| Type | Click behavior | Visual indicator | Example |
|------|---------------|-----------------|---------|
| **Card toggle** | Show/focus/toggle a card | Badge count (existing) | Terminal, Git, Files |
| **Command** | Execute an action directly | None (or brief flash) | Future test-case buttons |
| **Popout menu** | Open a floating menu anchored to the button | Caret/chevron indicator | Settings (existing), future grouped commands |

**Card toggle buttons** — unchanged from current behavior. Click shows the card if hidden, focuses it if visible but not key, or toggles it off if already key. Badge counts display notification state. These are the top group in the dock.

**Command buttons** — direct-action buttons for the dock. Click fires a callback immediately. No popover, no menu, no confirmation (unless the command wraps in `TugConfirmPopover` from concept 9). These will be added as we implement tugways components and need test-case triggers. They live in the same button group as card toggles, below them.

**Popout menu buttons** — buttons that open a floating menu anchored to the dock. The settings gear icon is already this type (it uses `CardDropdownMenu`). The menu uses Radix DropdownMenu, positioned to the side of the dock opposite its edge (e.g., if dock is on the right, menus open to the left). The menu's `side` and `align` props adjust automatically based on dock placement.

#### Dock Placement {#d29-dock-placement}

The dock can be placed on any edge: **right** (default), left, top, or bottom. The placement is a setting stored in the settings API (same mechanism as theme).

| Placement | Layout | Menu direction |
|-----------|--------|---------------|
| Right | Vertical, 48px wide, fixed to right edge | Menus open left |
| Left | Vertical, 48px wide, fixed to left edge | Menus open right |
| Top | Horizontal, 48px tall, fixed to top edge | Menus open below |
| Bottom | Horizontal, 48px tall, fixed to bottom edge | Menus open above |

The dock is always a flexbox — `flex-col` for vertical placements (left/right), `flex-row` for horizontal (top/bottom). Icons rotate or stay the same — lucide icons are symmetrical, so no rotation needed. The canvas area (`DeckCanvas`) adjusts its inset to account for the dock's position and width/height.

**Implementation note:** The current dock is hardcoded as `fixed top-0 right-0 bottom-0 w-12 flex-col`. Placement support means parameterizing these: position props come from a `dockPlacement` setting, and the CSS classes are computed from it. The `side` prop on `CardDropdownMenu` flips based on placement.

#### Tooltips {#dock-tooltips}

Every dock button shows a tooltip on hover, displaying the button's label. The tooltip appears on the side opposite the dock edge (e.g., dock on the right → tooltips appear to the left). Radix Tooltip is already in the project (`components/ui/tooltip.tsx`) with enter/exit animations.

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <IconButton Icon={Terminal} label="Terminal" onClick={...} />
  </TooltipTrigger>
  <TooltipContent side={tooltipSide}>
    Terminal
  </TooltipContent>
</Tooltip>
```

The `tooltipSide` is derived from dock placement: right dock → `"left"`, left dock → `"right"`, top dock → `"bottom"`, bottom dock → `"top"`.

A `TooltipProvider` wraps the entire dock to configure shared delay settings — `delayDuration={400}` (standard hover delay before showing), `skipDelayDuration={100}` (after one tooltip shows, subsequent ones appear faster as the user scans).

#### Responder Chain: The Dock Is Not a Responder {#dock-chain}

The dock does not participate in the responder chain. It never receives keyboard events via the chain. It never handles routed actions. It is purely a direct-interaction surface — you click a button, it fires a callback.

This is intentional. The dock is chrome, not content. It doesn't need action validation (no `canHandle`/`validateAction`). It doesn't need to participate in focus management. Its buttons are always visible and always enabled (badge counts and button presence are controlled by the card registry, not the chain).

The dock *triggers* things that interact with the chain — clicking a card toggle may change which card is first responder, and a popout menu might fire an action that eventually reaches the chain — but the dock itself is outside the chain.

#### Dock Configuration Shape {#dock-config}

```ts
interface DockConfig {
  placement: "right" | "left" | "top" | "bottom";  // default: "right"
  buttons: DockButtonConfig[];  // ordered list of buttons
}

type DockButtonConfig =
  | { type: "card-toggle"; cardType: string; icon: string; label: string }
  | { type: "command"; icon: string; label: string; action: string }
  | { type: "popout-menu"; icon: string; label: string; menuId: string }
  | { type: "spacer" }
  | { type: "logo" };
```

The button list is declarative — the dock renders whatever buttons the config specifies, in order. The default config matches the current dock: six card toggles, a spacer, the settings popout menu, and the logo. Future changes (adding test-case command buttons, reordering) are config changes, not component changes.

The `menuId` on popout-menu buttons references a menu definition registered elsewhere (the settings menu is built in `Dock` today; in the redesign it would be registered by ID so other menus can be added without modifying the dock component).

#### What Concept 11 Establishes {#c11-demonstrates}

1. **Three dock button types** — card toggle, command, popout menu. Same visual, different click behavior. Declared in config, not hardcoded. ([#d28-dock-button-types](#d28-dock-button-types))
2. **Dock placement** — right/left/top/bottom. Canvas inset adjusts. Menu direction and tooltip side flip automatically. ([#d29-dock-placement](#d29-dock-placement))
3. **Dock is outside the responder chain** — pure direct-interaction chrome. No `useResponder`, no action validation, no focus management. ([#dock-chain](#dock-chain))
4. **Tooltips via Radix Tooltip** — already in the project. Consistent delay, auto-positioned opposite the dock edge. ([#dock-tooltips](#dock-tooltips))

### 12. Card Tabs {#c12-tabs}

**Status: DESIGNED** (2026-03-02)

**The problem.** Cards need to share a single frame. A terminal card and a code card should be able to coexist in one panel, switched via tabs at the top. The data model already has `TabItem[]` and `activeTabId` in `CardState`, and a `tab-bar.tsx` exists — but the current implementation is entangled with the old card infrastructure (`ReactCardAdapter`, `TugCard` interface) that gets demolished in Phase 0. Tabs need to be rebuilt as a first-class Tugcard composition feature.

#### When Tabs Appear {#d30-tab-visibility}

The tab bar is **hidden for single-tab cards**. Most cards are single-tab — terminal, git, files, stats, settings, developer, about. The tab bar only renders when `tabs.length > 1`. This keeps the common case clean: no visual overhead for cards that don't use tabs.

When a second tab is added to a card (via dock command, drag-onto-card gesture, or programmatic API), the tab bar appears between the title bar and the content area. When tabs are reduced back to one, the tab bar disappears.

```
┌─────────────────────────────┐
│ [≡] Terminal           [–][×]│  ← title bar (always present)
├─────────────────────────────┤
│ [Terminal 1] [Code ▾]  [+]  │  ← tab bar (only when tabs.length > 1)
├─────────────────────────────┤
│                             │
│         content area        │  ← active tab's Tugcard content
│                             │
└─────────────────────────────┘
```

The title bar displays the **active tab's title and icon**. The card frame's identity follows the active tab.

#### Tab Icons

Each tab displays an **icon from its card type registration**. The icon is a property of the card type (`TugcardMeta.icon`), not stored on `TabItem`. Both the title bar (single-tab cards) and the tab bar (multi-tab cards) pull from the same source: `getRegistration(tab.componentId).defaultMeta.icon`.

In single-tab cards, the icon appears in the title bar. When a second tab is added, each tab in the tab bar shows its type icon alongside its title. This is especially important for mixed-type tabs — the icon is the quickest way to distinguish a terminal tab from a code tab in the same card.

#### Tabs Are a Tugcard Feature {#d31-tabs-in-tugcard}

Tabs live inside the Tugcard composition layer, not in CardFrame. CardFrame handles positioning, sizing, drag, resize, z-index — it doesn't know about tabs. Tugcard manages:

- The `tabs` array and `activeTabId` state
- Rendering the tab bar component (when `tabs.length > 1`)
- Mounting/unmounting tab content (active tab is mounted, inactive tabs are unmounted to save resources — terminal cards may opt into keeping their tab mounted to preserve session state)
- Reporting the active tab's minimum content size to CardFrame via the dynamic min-size mechanism ([D17])

This separation means CardFrame stays simple — it wraps one Tugcard, which internally manages however many tabs it has.

#### Tab Types

Tabs can be **same-type** (two terminal tabs in one frame) or **mixed-type** (a terminal tab and a code tab sharing a frame). There is no restriction on mixing card types — CardFrame doesn't care what it contains, and each tab carries its own `componentId` for independent content rendering. Each tab is a `TabItem` with its own `componentId` and `id`:

```ts
interface TabItem {
  id: string;          // unique instance ID (crypto.randomUUID())
  componentId: string; // card type: "terminal", "code", "git", etc.
  title: string;       // display title in tab bar
  closable: boolean;   // whether the tab shows a close button
}
```

This is the existing `TabItem` interface from `layout-tree.ts` — unchanged. The data model is already correct.

#### Tab Gestures

**Click-based gestures (Phase 5b):**

| Gesture | Action |
|---------|--------|
| Click tab | Switch to that tab |
| Click tab close (×) | Close that tab (with confirmation if configured) |
| Click [+] button | Open type picker dropdown, then add a tab of the selected type |

The [+] button opens a **type picker dropdown** listing all registered card types (from `getAllRegistrations()`). Each entry shows the card type's icon and title. Selecting a type adds a new tab of that type to the card. This supports mixed-type tabs naturally — the user picks any card type, not just the active tab's type.

**Drag gestures (Phase 5b2):**

| Gesture | Action |
|---------|--------|
| Drag tab within bar | Reorder tabs |
| Drag tab out of bar | Detach into a new card frame |
| Drag tab from one card onto another card's tab bar | Merge as a new tab (any card type) |

The drag gestures are the primary way users reorganize tabbed cards. They build on the click-based tab infrastructure from Phase 5b and add pointer-capture and hit-testing mechanics.

**Card-as-tab merge (Phase 5b5):** {#d45-card-as-tab-merge}

Dragging a single-tab card onto another card's tab bar merges it as a new tab. This completes the tab composition story — Phase 5b2's drag gestures handle tab-to-tab operations, but there is no way to merge an entire card into another card via drag. The card-as-tab merge uses drop target detection: a normal card drag (via CardFrame) checks on drop whether the pointer is over another card's tab bar. If so, instead of completing the card move, the source card's tab is merged into the target card via `mergeTab`, and the now-empty source card is removed. This reuses the existing `mergeTab` DeckManager method and the tab bar's `data-card-id` hit-test infrastructure from Phase 5b2.

#### Responder Chain Integration

The active tab's content is the active responder node within the card's position in the chain. Switching tabs changes which content view receives actions:

```
DeckCanvas
  └── Tugcard (card-level responder)
        └── [active tab's content responder]  ← switches when tab changes
```

Inactive tabs have no responder registration. When a tab switch occurs, the old tab's content responder is unregistered and the new tab's content responder is registered in its place. This is automatic via `useResponder` — when the inactive tab's content unmounts, its responder deregisters; when the new tab's content mounts, it registers.

Tugcard registers two card-level responder actions for tab navigation:

| Action | Behavior |
|--------|----------|
| `previousTab` | Switch to the previous tab (wraps to last) |
| `nextTab` | Switch to the next tab (wraps to first) |

These are no-ops for single-tab cards. Keyboard bindings (e.g., Ctrl+Shift+Tab / Ctrl+Tab) are wired in a later phase — Phase 5b establishes the actions so the responder chain infrastructure is ready.

#### Tab Bar Component

The tab bar is a simple horizontal strip:

```tsx
<TugTabBar
  tabs={tabs}
  activeTabId={activeTabId}
  onTabSelect={(tabId) => setActiveTabId(tabId)}
  onTabClose={(tabId) => removeTab(tabId)}
  onTabAdd={(componentId) => addTab(componentId)}
/>
```

Each tab renders its **icon** (from `getRegistration(tab.componentId).defaultMeta.icon`) alongside its title. Styled with `--td-*` tokens. Active tab has a bottom border accent. Inactive tabs are muted. Close buttons appear on hover. The [+] button at the end opens a type picker dropdown. Overflow is handled by progressive collapse (Phase 5b4, [#d44-tab-overflow](#d44-tab-overflow)).

#### Tab Overflow — Progressive Collapse {#d44-tab-overflow}

When tabs exceed the display width of their card, the tab bar collapses progressively rather than scrolling or wrapping:

**Stage 1: Icon-only collapse.** Inactive tabs collapse from icon+label to icon-only. The active tab always shows its full icon+label. This reclaims the label width for every inactive tab, often enough to fit all tabs.

**Stage 2: Overflow dropdown.** If icon-only collapse still doesn't fit all tabs, excess tabs move into an overflow dropdown anchored at the right end of the tab bar (before the [+] button). The dropdown shows the full icon+label for each overflow tab. Selecting a tab from the dropdown makes it the active tab and moves it into the rightmost visible position in the tab strip — the previously rightmost visible tab shifts into the overflow dropdown.

**Measurement:** A `ResizeObserver` on the tab bar container drives the collapse logic. When the container width changes (card resize, tab add/remove), the bar recalculates which tabs fit:

1. Measure total width needed for all tabs at full size (icon+label)
2. If it fits → Stage 0 (all tabs at full size)
3. If not → collapse inactive tabs to icon-only, re-measure
4. If it still doesn't fit → compute how many icon-only tabs fit, put the rest in the overflow dropdown

**Active tab visibility rule:** The active tab is always visible in the tab strip, never hidden in the overflow dropdown. When the user selects a tab from the overflow dropdown, that tab moves to the rightmost visible slot, displacing the tab that was there into the overflow. The [+] type picker and overflow dropdown button are always visible.

**Interaction with drag gestures (Phase 5b2):** Dragging a tab into a card that is already overflowing adds the tab to the logical tab list. The overflow calculation re-runs, and the new tab may land in the overflow dropdown if it doesn't fit. Dragging a tab out of an overflowing card removes it from the list and may promote an overflow tab back into the visible strip.

| State | Active tab | Inactive tabs | Overflow button |
|-------|-----------|---------------|-----------------|
| All fit (full size) | icon + label | icon + label | hidden |
| All fit (icon-only inactive) | icon + label | icon only | hidden |
| Overflow | icon + label | icon only (visible) or in dropdown (hidden) | visible, shows count |

#### Persistence

Tab state is already persisted in `CardState.tabs` and `CardState.activeTabId`. The serialization format (v5) already handles this. No changes to `serialization.ts` are needed for the basic tab feature.

#### What Concept 12 Establishes {#c12-demonstrates}

1. **Tab bar visibility gated on count** — hidden for single-tab cards, visible for multi-tab. No visual overhead in the common case. ([#d30-tab-visibility](#d30-tab-visibility))
2. **Tabs are a Tugcard composition feature** — CardFrame is unaware. Tugcard manages tab state, tab bar rendering, and content switching internally. ([#d31-tabs-in-tugcard](#d31-tabs-in-tugcard))
3. **Same data model** — `TabItem`, `CardState.tabs`, `CardState.activeTabId` are unchanged from the existing `layout-tree.ts`. The infrastructure was designed for tabs from the start; only the UI layer needs rebuilding.
4. **Responder chain follows the active tab** — tab switching is a chain reconfiguration, handled automatically by mount/unmount of content responders.
5. **Tab icons from card registration** — each tab displays its card type icon from `TugcardMeta.icon`. The icon is a property of the card type, shared between the title bar (single-tab) and the tab bar (multi-tab).
6. **Mixed-type tabs without restriction** — any card type can share a frame with any other. CardFrame is type-agnostic; each tab carries its own `componentId`.
7. **Five-phase implementation** — Phase 5b covers click-based tab management (create, switch, close, type picker, icons). Phase 5b2 adds drag gestures (reorder, detach, merge). Phase 5b3 converts the Component Gallery from a floating panel to a proper tabbed card ([#d43-gallery-card](#d43-gallery-card)). Phase 5b4 adds progressive tab overflow ([#d44-tab-overflow](#d44-tab-overflow)). Phase 5b5 adds tab refinements including card-as-tab merge ([#d45-card-as-tab-merge](#d45-card-as-tab-merge)).

### 13. Card Snap Sets {#c13-snap-sets}

**Status: DESIGNED** (2026-03-02)

**The problem.** The current card snap system is always-on: every drag operation shows snap guides and snaps cards to edges. This is useful for organizing layouts but gets in the way of quick, casual card repositioning. The snap behavior should be opt-in via a modifier key, so users can freely drag cards without unintended snapping.

The geometric engine (`snap.ts`) is solid — ~500 lines of spatial math for shared-edge detection, set computation, sash groups, and docked corner rendering. The behavior change is in **when** that engine is consulted, not in **how** it works.

#### Modifier-Gated Snapping {#d32-modifier-snap}

Snap guides and snap-to-edge behavior activate **only when the user holds Option (Alt) during drag**. Without the modifier:

| Modifier held? | During drag | On drop |
|----------------|------------|---------|
| **No** | Free movement, no guides, no snap | Card lands at cursor position, no set formed |
| **Yes (Option)** | Snap guides appear, card snaps to nearby edges | If snapped, a set is formed with the adjacent card(s) |

The modifier is checked continuously during drag — the user can press Option mid-drag to activate snapping, or release it to return to free movement. This provides a fluid, discoverable experience:

1. Start dragging a card (free movement)
2. Move near another card — nothing happens
3. Press Option — snap guides appear, card snaps to the nearby edge
4. Release Option — card unsnaps, returns to cursor position
5. Press Option again, release mouse — card snaps and a set is formed

The visual feedback is immediate: guides appear/disappear as the modifier is pressed/released. There is no latency or mode-switch delay.

#### Implementation: Where the Gate Lives

The modifier gate is in `DeckManager`'s drag handler, not in `snap.ts`. The snap module remains a pure geometry library — it computes snap positions given rectangles. The caller decides whether to use those positions:

```ts
// In DeckManager drag handler (simplified)
function onDragMove(cardId: string, cursorX: number, cursorY: number, event: MouseEvent) {
  if (event.altKey) {
    // Option held: compute snap and apply
    const snapResult = computeSnap(dragRect, otherRects, SNAP_THRESHOLD_PX);
    applyPosition(cardId, snapResult.x ?? cursorX, snapResult.y ?? cursorY);
    showGuides(snapResult.guides);
  } else {
    // No modifier: free movement
    applyPosition(cardId, cursorX, cursorY);
    hideGuides();
  }
}
```

The existing `findSharedEdges` and `computeSets` functions in `snap.ts` are untouched. `computeSnap` gained a `borderWidth` parameter for border collapse ([D56]). `computeSetHullPolygon` was added for set perimeter flash ([D54]).

#### Set-Move Is Always Active {#d33-set-move-always}

Once a set is formed (cards are snapped together), **set-move is always active**. Dragging any member of a set moves the entire group — no modifier needed. This is the current behavior and it stays.

The rationale: sets are intentional structures. The user opted into the set by holding Option during snap. Once formed, the set should behave as a unit. Requiring Option for every set-move would be tedious.

| Scenario | Behavior |
|----------|----------|
| Drag a card that's in a set (no modifier) | Entire set moves together |
| Drag a card that's in a set (with Option) | Entire set moves together (same behavior) |
| Drag a card far enough from its set (no modifier) | Card breaks out of the set, moves freely |
| Option+drag a breakaway card near another card | Snap guides appear, card can join a new set |

#### Break-Out Behavior

Breaking a card out of a set works as it does today: drag a set member far enough away from the group (beyond the snap threshold) and it detaches. The card becomes a free-floating panel again.

The existing break-out detection in `DeckManager` (measuring drag distance from the set's bounding box) remains unchanged. The only addition: after break-out, if Option is held, the detached card can immediately snap to a different card to form a new set.

#### Visual Feedback

| State | Visual |
|-------|--------|
| Free drag (no Option) | Card follows cursor, no guides, no highlighting |
| Option held during drag | Snap guides appear (existing blue/accent lines), target edges highlight |
| Card snaps to edge | Border-width overlap applied ([D56]), corners squared via `data-in-set` ([D53]) |
| Set formed | Set flash traces outer hull perimeter ([D54]), clip-path hides interior shadows ([D08]) |
| Set-move (no modifier) | All set members translate together, clip-path values unchanged |
| Break-out (Option pressed during set-move) | Detached card gets rounded corners, full shadow, perimeter flash ([D55]) |

The snap guides, border collapse, and sash rendering are existing features. The modifier gate, hull-polygon flash, clip-path shadow system, and break-out restoration were added in Phases 5c/5c2.

#### Set Corner Rounding {#d53-set-corners}

When cards form a set by snapping, all set member corners become squared (`border-radius: 0`). Solo cards retain rounded corners (`var(--td-radius-md)`, currently 6px). This makes the set look like a single unified shape.

The mechanism is CSS-driven via the `data-in-set` attribute on `.card-frame`:

```css
.card-frame[data-in-set="true"] { border-radius: 0; }
.card-frame[data-in-set="true"] .tugcard { border-radius: 0; }
```

`updateSetAppearance()` sets or removes `data-in-set` on each card frame based on set membership computed by `findSharedEdges` and `computeSets`. This is an appearance-zone operation per the three-zone model ([D12]) — no React state involved.

**Design note**: The original design called for per-corner computation (exterior corners rounded, interior corners squared). The uniform approach was chosen instead because: (a) it's dramatically simpler — a single CSS attribute toggle vs. per-corner DOM mutations, (b) the visual difference is negligible at 6px radius, and (c) it eliminates a class of edge cases with L-shaped and T-shaped set topologies.

#### Set Perimeter Flash {#d54-set-perimeter-flash}

When a set is formed on pointer-up, the **outer hull** of the set flashes the accent color. Internal edges where cards connect do **not** flash — only the exterior boundary of the combined shape.

Implementation: `flashSetPerimeter()` computes the outer hull polygon of the set via `computeSetHullPolygon()` (a coordinate-compression + grid-based boundary trace algorithm in `snap.ts`), then renders a single SVG element with a `<path>` that strokes the hull perimeter. The SVG includes a glow filter (`<feGaussianBlur>` + `<feMerge>`) for the accent glow effect. Each flash gets a unique filter ID (via a module-level counter) to avoid cross-SVG collisions. The SVG uses `animation: set-flash-fade 0.5s ease-out forwards` from `chrome.css` and self-removes on `animationend`.

Flash parameters: stroke `var(--td-accent)`, width 3px, glow blur 4px.

**Design note**: The original design described per-card flash overlays with selective edge suppression. The hull polygon SVG approach was chosen instead because it produces a visually perfect single continuous perimeter — no corner artifacts, no border-radius mismatches between adjacent card overlays, and no need for per-edge CSS utility classes.

The `computeSetHullPolygon()` algorithm:
1. **Coordinate compression**: Collect unique X/Y values from all rect edges, sort them
2. **Boolean grid**: Fill cells where any rect covers that region
3. **Clockwise boundary trace**: Walk the perimeter keeping interior on the left (screen coordinates, y-down). At concave corners turn counterclockwise `(dir+3)%4`, at convex corners turn clockwise `(dir+1)%4`
4. **Collinear removal**: Remove vertices on straight lines between neighbors
5. **Canvas coordinate conversion**: Convert grid indices back to canvas coordinates

Returns an array of `Point` objects in canvas coordinates, ordered clockwise.

#### Break-Out Visual Restoration {#d55-breakout-restore}

Break-out is triggered by pressing the snap modifier (Alt/Option) mid-drag while in a set — the card detaches and enters snap mode. This is detected as a modifier transition (false→true) in `applyDragFrame`.

When a card breaks out:

1. **Immediately restore rounded corners** on the detached card — `data-in-set` is removed from the card frame, and CSS returns the corners to `var(--td-radius-md)`.
2. **Clear the detached card's clip-path** — `tugcardEl.style.clipPath = ''` so the card shows full shadow on all sides.
3. **Flash the detached card's perimeter** via `flashCardPerimeter()`, which creates a `.card-flash-overlay` div with `border: 3px solid var(--td-accent)`, box-shadow glow, and `inset: -1px`. The overlay uses `animation: set-flash-fade` and self-removes on `animationend`.
4. **Update remaining set members** — `onCardMoved` triggers a store mutation, which fires the store subscriber in `deck-canvas.tsx`, which calls `updateSetAppearance()` to recompute clip-paths and `data-in-set` for the remaining members.

The corner and clip-path restore happen synchronously during break-out detection. The store subscriber handles remaining member updates asynchronously but within the same frame.

#### Border Collapse via Snap Offset {#d56-border-collapse}

When a card snaps to an adjacent card's edge, the snap position is offset by the card's computed border width so that the two borders **overlap into a single line** rather than sitting side by side (which would produce a visible double-border).

The offset is the actual computed border width of the `.tugcard` element (currently `1px solid var(--td-border)`), read via `getComputedStyle().borderTopWidth` (or the relevant edge). This handles fractional pixel values correctly — the snap target is `neighborEdge - borderWidth`, not a hardcoded 1px offset.

This adjustment lives in `computeSnap` in `snap.ts`: when a snap alignment is found, the snap position is shifted inward by the border width so the snapping card's border overlaps the neighbor's border. The border width is passed as a parameter to `computeSnap`, keeping the function pure (no DOM access inside `snap.ts`).

#### Set Shadows via Clip-Path {#d57-clip-path-shadow}

Set member shadows are controlled via `clip-path: inset()` on `.tugcard`, not by creating or removing shadow DOM elements. The `computeClipPathForCard()` helper in `card-frame.tsx` determines which edges are interior (shared with a neighbor) and which are exterior:

- **Exterior edges**: extend the clip-path by `SHADOW_EXTEND_PX` (20px) beyond the border-box, allowing the full box-shadow to show
- **Interior edges**: clip at `0px` (the border-box edge), hiding the shadow on that side

The SharedEdge convention from `findSharedEdges`: vertical axis means cardA's right touches cardB's left; horizontal axis means cardA's bottom touches cardB's top. Solo cards (no shared edges) get no clip-path at all — full shadow on all sides.

`updateSetAppearance()` applies the computed clip-path to each card's `.tugcard` child element via `tugcardEl.style.clipPath`. It also runs per-frame during sash co-resize to keep clip-paths correct as the shared edge moves.

**Design note**: The original implementation used `.set-shadow` DOM elements — absolutely-positioned divs with their own box-shadow, sized and positioned to cover the set hull polygon. This approach was replaced because: (a) it required complex element lifecycle management (create, position, translate, remove), (b) the hull polygon shadow had visual artifacts at concave set topologies, and (c) per-card clip-path is dramatically simpler — no DOM elements created or removed, just a style property computed from shared-edge data.

#### Active/Inactive Shadow Tokens {#d58-active-inactive-shadow}

Cards display different shadow intensity based on focus state:

| Token | Brio (default) | Bluenote | Harmony (light) |
|-------|---------------|----------|-----------------|
| `--td-card-shadow-active` | `0 2px 8px rgba(0, 0, 0, 0.4)` | `0 2px 8px rgba(0, 0, 0, 0.45)` | `0 2px 8px rgba(0, 0, 0, 0.18)` |
| `--td-card-shadow-inactive` | `0 1px 4px rgba(0, 0, 0, 0.2)` | `0 1px 4px rgba(0, 0, 0, 0.22)` | `0 1px 4px rgba(0, 0, 0, 0.09)` |

Inactive shadows use roughly half the blur radius and opacity of active shadows. The CSS rules:

```css
.tugcard { box-shadow: var(--td-card-shadow-inactive); }
.card-frame[data-focused="true"] .tugcard { box-shadow: var(--td-card-shadow-active); }
```

The `data-focused` attribute is set by CardFrame based on the `isFocused` prop from DeckManager. Unfocused cards also receive a dim overlay via the `::after` pseudo-element (`--td-card-dim-overlay`).

#### Command-Key Suppresses Activation {#d59-command-suppress-activation}

Holding the Command key (metaKey) during a pointer-down on a card frame **suppresses** the `onCardFocused` call, preventing the card from coming to the front or becoming active. This is a standard macOS convention — Command-click interacts with a window without changing the window order.

The check is in `handleFramePointerDown`:

```typescript
const handleFramePointerDown = useCallback((event: React.PointerEvent) => {
  if (!event.metaKey) {
    onCardFocused(id);
  }
}, [id, onCardFocused]);
```

The same check is applied in `handleResizeStart` to maintain consistency — Command+resize-drag does not bring the card to front.

#### Resize Click Activates Card {#d60-resize-activates}

Clicking a resize handle now explicitly calls `onCardFocused(id)` to bring the card to front before starting the resize gesture. Previously, resize handles called `event.stopPropagation()` which prevented the frame's `handleFramePointerDown` from firing, meaning resize would start on an inactive card without activating it.

The fix adds `onCardFocused(id)` at the top of `handleResizeStart` (subject to the Command-key check per [D59]), then `stopPropagation()` to prevent a redundant second activation from the frame handler.

#### What Concept 13 Establishes {#c13-demonstrates}

1. **Snap is modifier-gated** — Option (Alt) activates snap guides and snap-to-edge during drag. Free drag is the default. ([#d32-modifier-snap](#d32-modifier-snap))
2. **Set-move is always active** — once a set is formed, dragging any member moves the group. No modifier needed for set operations. ([#d33-set-move-always](#d33-set-move-always))
3. **Geometric engine untouched** — `snap.ts` remains a pure geometry library. The modifier gate lives in the drag handler, not the math. The `snap.ts` additions are: border-width offset parameter in `computeSnap` ([#d56-border-collapse](#d56-border-collapse)) and `computeSetHullPolygon` for flash ([#d54-set-perimeter-flash](#d54-set-perimeter-flash)).
4. **Fluid modifier interaction** — Option can be pressed/released mid-drag with immediate visual feedback. Pressing Option while in a set triggers break-out. No mode switches, no state machines.
5. **Set visual identity** — snapped cards form a unified visual shape: squared corners via CSS `data-in-set`, single-line borders via border-width offset, clip-path suppresses interior shadows, and perimeter flash traces the outer hull via SVG polygon. ([#d53-set-corners](#d53-set-corners), [#d54-set-perimeter-flash](#d54-set-perimeter-flash))
6. **Break-out visual restoration** — pressing Option during set-move detaches the card, restores rounded corners and full shadow, and flashes the card's perimeter. ([#d55-breakout-restore](#d55-breakout-restore))
7. **Shadow architecture** — box-shadow lives on `.tugcard` unconditionally via CSS. Interior set edges are hidden via `clip-path: inset()` computed per card from shared-edge data. Active (`--td-card-shadow-active`) and inactive (`--td-card-shadow-inactive`) shadow tokens differentiate focused vs. unfocused cards. No shadow DOM elements are created or removed — the old `.set-shadow` element approach was replaced by the clip-path system.

### 14. Selection Model {#c14-selection}

**Status: DESIGNED** (2026-03-03)

**The problem.** The browser treats all card content as a single document flow. A user can start selecting text in one card's content area and drag the selection into another card, across the canvas background, and even through card title bars — producing a meaningless cross-card selection that spans chrome, gaps, and unrelated content. Title bar text (card titles, button labels) is selectable. There are no selection boundaries between cards or between chrome and content. This is the default DOM behavior and it will not do for a card-based workspace.

Cards are independent workspaces. Selection must respect that independence: it must never cross card boundaries, never include chrome elements, and must be controllable at a fine-grained level by card content authors. Additionally, content areas with `overflow: auto` must provide excellent autoscrolling when the user drags to select near the scroll edges.

#### Platform Assessment {#selection-platform}

The web platform's selection containment capabilities were thoroughly researched. The findings:

| Technology | Selection Containment? | Status |
|------------|----------------------|--------|
| `user-select: contain` (CSS) | Designed for exactly this purpose | **Not implemented in any modern browser.** Only ever worked in IE as `-ms-user-select: element`. No WebKit/Safari/Chrome/Firefox support. GitHub's polyfill was archived with the conclusion that the behavior "cannot currently be polyfilled due to technical limitations." |
| Shadow DOM | Prevents selection crossing in Firefox only | **Not reliable in WebKit/Safari.** Selection visually crosses shadow boundaries in our target platform (macOS WKWebView). |
| iframes | True selection isolation | **Too heavyweight.** Each iframe is a separate document with its own JavaScript context, styling, and memory overhead. Not viable for card content. |
| `overflow: hidden/auto` | No effect on selection | Content clips visually but **selection passes right through** overflow boundaries. |
| CSS `contain` property | No effect on selection | Purely a **rendering optimization**. `contain: content`, `contain: strict`, etc. do not create selection boundaries. |
| `contenteditable` containers | Implicit `user-select: contain` behavior | **Unusable as a containment mechanism.** Brings unwanted side effects: input events, cursor blinking, editing capabilities, IME activation. The spec says editing hosts implicitly behave as `user-select: contain`, but we cannot use `contenteditable` just for selection containment. |
| JavaScript Selection API | Full programmatic control | **The viable approach.** `window.getSelection()`, `Selection.setBaseAndExtent()`, `document.caretPositionFromPoint()`, `selectstart`/`selectionchange` events provide the primitives needed to build selection containment in JavaScript. |

**Conclusion:** Since `user-select: contain` does not exist in WebKit, we must build selection containment ourselves using CSS prevention for the passive layer and the JavaScript Selection API for the active layer. This is the same approach used by VS Code panels, ProseMirror, and other serious editor frameworks.

#### Three-Layer Selection Containment {#d34-three-layer-selection}

The selection model uses three complementary layers:

**Layer 1: CSS Prevention (passive).** Prevent selection from *starting* in non-content areas via `user-select: none`. This is the first line of defense — it eliminates ~60% of the problem by making it impossible to start a selection from chrome or gap areas.

| Element | `user-select` | Rationale |
|---------|--------------|-----------|
| Canvas background (`.deck-canvas`) | `none` | Gap between cards is not content |
| Card frame border/resize handles | `none` | Structural chrome |
| Card header (`.tugcard-header`) | `none` | Already implemented in Phase 5 |
| Accessory slot (`.tugcard-accessory`) | `none` | Chrome controls (find bar inputs get explicit `text`) |
| Card content area (`.tugcard-content`) | `text` | Explicitly opt-in to selection |
| Resize handles (`.card-frame-resize-*`) | `none` | Hit areas only, no text |

CSS prevention alone does not stop a selection that *starts* in a content area from *extending* out of the card. Layer 2 handles that.

**Layer 2: SelectionGuard (active JS containment).** A singleton JavaScript object that monitors and clips selection at runtime. It enforces the rule: **a selection that starts in a card's content area cannot extend beyond that card's content area.**

**Layer 3: Developer API for card content.** Data attributes that card content authors use to control selectability within their content areas. This provides the fine-grained control needed for different card types (terminal, code editor, form controls, etc.).

#### SelectionGuard: The Runtime Containment Engine {#d35-guard-singleton}

SelectionGuard is a plain TypeScript singleton (not React state, not a hook — follows the same pattern as ResponderChainManager from concept 4). It operates entirely outside React's render cycle.

**Why a singleton, not React state:**
- Selection events fire at very high frequency during drag selection (every few milliseconds)
- Clipping must happen synchronously, without waiting for React re-renders
- Selection tracking state (which card owns the current selection) is ephemeral and interaction-scoped — not application state
- Follows the three-zone model ([D12]): selection containment is appearance-zone behavior (DOM manipulation, zero re-renders)

**Architecture:**

```typescript
class SelectionGuard {
  private boundaries: Map<string, HTMLElement>;  // cardId → content area element
  private activeBoundary: HTMLElement | null;    // card that owns the current selection
  private isSelecting: boolean;                  // pointer is down and dragging
  private savedSelections: Map<string, SavedSelection>; // per-card saved selections

  // Called by useSelectionBoundary hook in Tugcard
  register(cardId: string, element: HTMLElement): void;
  unregister(cardId: string): void;

  // Selection persistence (used by Phase 5b tab switching)
  saveSelection(cardId: string): SavedSelection | null;
  restoreSelection(cardId: string, saved: SavedSelection): void;

  // Internal — attached to document
  private handleSelectStart(event: Event): void;
  private handleSelectionChange(): void;
  private handlePointerMove(event: PointerEvent): void;
  private handlePointerUp(event: PointerEvent): void;
  private autoScrollTick(boundary: HTMLElement, pointerY: number): void;
}
```

**Hook for Tugcard integration:**

```typescript
// Used once inside Tugcard, on the content area div
function useSelectionBoundary(cardId: string, contentRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    selectionGuard.register(cardId, el);
    return () => selectionGuard.unregister(cardId);
  }, [cardId, contentRef]);
}
```

Tugcard automatically calls `useSelectionBoundary` on its content area element. Card authors never interact with SelectionGuard directly.

#### Pointer-Clamped Selection Clipping {#d36-pointer-clamping}

The clipping algorithm uses pointer tracking during drag selection to provide smooth, continuous containment with no visual flash:

**Phase 1: `selectstart` event.** When a selection begins, identify which registered boundary element contains the `event.target`. Store it as `activeBoundary`. If no boundary contains the target (selection started in chrome or canvas gap), the CSS prevention layer should have already blocked it — but as a safety net, cancel the selection.

**Phase 2: `pointermove` during selection.** While the pointer is down and a selection is active:
1. Check if the pointer coordinates are inside the `activeBoundary`'s bounding rect.
2. If the pointer is inside, do nothing — the browser's native selection behavior is correct.
3. If the pointer has exited the boundary:
   a. Clamp the pointer coordinates to the boundary's rect edges.
   b. Call `document.caretPositionFromPoint(clampedX, clampedY)` to find the nearest valid text position at the boundary edge.
   c. Call `selection.extend(node, offset)` to pin the selection's focus endpoint to that boundary-edge position.

This produces smooth, continuous selection clamping — the selection grows to the edge of the card content area and stops, just as it would with native `user-select: contain`. There is no visual flash because the clamping happens on every pointer move, before the browser has a chance to render the unconstrained selection.

**Phase 3: `selectionchange` safety net.** As a fallback (for cases where the selection changes without pointer movement, e.g., keyboard-driven selection extension via Shift+arrow), monitor `selectionchange`:
1. Get the selection's `Range` via `selection.getRangeAt(0)`.
2. Check if `range.commonAncestorContainer` is within the `activeBoundary`.
3. If not, clip the selection:
   - Determine direction (forward or backward) by comparing anchor and focus positions.
   - For forward escape: set focus to the last text node in the boundary.
   - For backward escape: set focus to the first text node in the boundary.
   - Use `Selection.setBaseAndExtent()` to rewrite the selection.

**Phase 4: `pointerup`.** Clear `activeBoundary` and `isSelecting` state.

**Cross-browser note:** `document.caretPositionFromPoint()` reached Baseline status in December 2025 and is available in all modern browsers. For WKWebView specifically, `document.caretRangeFromPoint()` (WebKit's older API) is also available as a fallback. The implementation should try `caretPositionFromPoint` first and fall back to `caretRangeFromPoint`.

#### Four Select Modes for Card Content {#d37-select-modes}

Card content authors control selectability within their content areas using a `data-td-select` attribute on any element inside the content area:

| `data-td-select` value | Behavior | Use case |
|------------------------|----------|----------|
| (not set / default) | `text` — standard browser text selection | Most card content |
| `none` | Not selectable — equivalent to `user-select: none` on this subtree | UI controls, buttons, labels within content |
| `all` | Atomic selection — clicking anywhere in the element selects its entire text content | Code snippets, copy-ready output blocks |
| `custom` | SelectionGuard does not clip selection within this subtree; the region manages its own selection entirely | Terminal emulator (xterm.js), code editor (CodeMirror/Monaco) |

**How `data-td-select` works with SelectionGuard:**

- **`none`**: Applied via CSS rule `[data-td-select="none"] { user-select: none; }`. Pure CSS, no JS involvement.
- **`all`**: Applied via CSS rule `[data-td-select="all"] { user-select: all; }`. The browser handles atomic selection natively.
- **`custom`**: SelectionGuard checks whether the selection anchor is within a `data-td-select="custom"` element. If so, the guard does not clip — the embedded component (xterm.js, CodeMirror, contenteditable) manages selection independently. The containment boundary effectively shrinks to the custom region: selection still cannot escape the card, but within the custom region, the embedded component has full control. This includes contenteditable regions — a `<div contenteditable data-td-select="custom">` receives full selection autonomy, with the guard verifying that selection cannot escape the card even when contenteditable's native behavior tries to extend it.

**Example usage in a code card:**

```tsx
function CodeCardContent() {
  const data = useTugcardData<CodePayload>();
  return (
    <div>
      <div data-td-select="none" className="toolbar">
        <TugButton>Run</TugButton>
        <TugButton>Copy</TugButton>
      </div>
      <div data-td-select="custom" className="editor-container">
        <CodeMirrorEditor value={data.source} />
      </div>
      <div data-td-select="all" className="output-block">
        <pre>{data.output}</pre>
      </div>
    </div>
  );
}
```

#### Cmd+A Scoped to Focused Card {#d38-scoped-selectall}

Cmd+A (Select All) must select all content in the *focused card only*, not the entire page.

**Integration with the responder chain:**

1. Cmd+A enters the key pipeline (concept 4, [D10]).
2. Stage 3 (action dispatch) routes the `selectAll` action through the responder chain.
3. The focused Tugcard's responder handles `selectAll`:
   - Get the card's content area element (the selection boundary element).
   - Call `window.getSelection().selectAllChildren(contentElement)`.
   - This selects all text within the content area, respecting `data-td-select="none"` regions (the browser skips `user-select: none` elements during `selectAllChildren`).

4. If a `data-td-select="custom"` region is focused (e.g., the user is working in a CodeMirror editor), the `selectAll` action is delegated to the custom component's responder, which handles it internally (e.g., CodeMirror's own select-all).

This integrates with the existing action vocabulary: `selectAll` is already defined in the responder chain's action table (concept 4), and `copy`, `cut`, `pasteAsPlainText`, and `useSelectionForFind` all depend on the selection being correctly scoped to a card.

#### Autoscroll During Selection Drag {#selection-autoscroll}

When a card's content area has `overflow: auto` and the user drags to select text near the scroll edge, the content must autoscroll smoothly.

**Native behavior:** The browser provides autoscrolling for `overflow: auto` containers natively — when the user drags to select near the top or bottom edge, the container scrolls automatically. This works in WebKit/Safari and is the preferred mechanism.

**Required implementation:**

1. **`overscroll-behavior: contain`** on the card content area — prevents scroll from chaining to the parent (canvas), which would cause the entire canvas to scroll when the user drags past the bottom of a card's content.

2. **RAF-based autoscroll in SelectionGuard.** Pointer-clamped clipping actively breaks native browser autoscroll: when SelectionGuard clamps the pointer to the card boundary and calls `selection.extend()`, the browser never sees the pointer leave the scrollable area, so it never triggers its native autoscroll. Since we break it, we must replace it. SelectionGuard implements a `requestAnimationFrame`-based autoscroll during clamped selection drag:

```typescript
// SelectionGuard autoscroll — required because pointer clamping breaks native autoscroll
const EDGE_SIZE_PX = 40;
const MAX_SCROLL_SPEED = 20;

function autoScrollTick(boundary: HTMLElement, pointerY: number) {
  const rect = boundary.getBoundingClientRect();
  const topEdge = rect.top + EDGE_SIZE_PX;
  const bottomEdge = rect.bottom - EDGE_SIZE_PX;

  if (pointerY < topEdge) {
    const speed = Math.round(MAX_SCROLL_SPEED * (1 - (pointerY - rect.top) / EDGE_SIZE_PX));
    boundary.scrollTop -= speed;
  } else if (pointerY > bottomEdge) {
    const speed = Math.round(MAX_SCROLL_SPEED * (1 - (rect.bottom - pointerY) / EDGE_SIZE_PX));
    boundary.scrollTop += speed;
  }
}
```

The autoscroll uses distance-based acceleration: scroll speed increases as the pointer gets closer to the edge. The RAF loop continues as long as the pointer stays in the edge zone, even if the pointer stops moving. After each scroll tick, SelectionGuard re-clamps and re-extends the selection to track the newly visible content.

#### Selection Styling {#selection-styling}

Selection highlight colors are theme-aware via CSS custom properties:

```css
.tugcard-content ::selection {
  background: var(--td-selection-bg);
  color: var(--td-selection-text);
}
```

New tokens added to the semantic tier:

| Token | Purpose | Default derivation |
|-------|---------|-------------------|
| `--td-selection-bg` | Selection highlight background | `color-mix(in srgb, var(--td-accent) 40%, transparent)` |
| `--td-selection-text` | Selected text foreground | `var(--td-text)` |

These are appearance-zone tokens — theme switches update them for free via the CSS cascade, with zero re-renders.

#### Selection State in the Three-Zone Model {#selection-zones}

| Aspect | Zone | Mechanism |
|--------|------|-----------|
| Selection highlight rendering | Appearance | CSS `::selection` pseudo-element, `--td-*` tokens |
| Active boundary tracking | Appearance | SelectionGuard singleton, refs, event handlers |
| Selection range clipping | Appearance | `Selection.setBaseAndExtent()`, `selection.extend()` |
| Autoscroll during drag | Appearance | `requestAnimationFrame` + `scrollTop` mutation |
| `selectAll` action routing | Local data | Responder chain action dispatch |
| Clipboard operations | Local data | Responder chain `copy`/`cut` actions + Clipboard API |

No React state is involved in any selection operation. Selection is entirely an appearance-zone concern, managed imperatively by SelectionGuard and the browser's CSS cascade.

#### What Each Card Type Needs {#card-type-selection}

| Card Type | Content Selection | `data-td-select` Usage |
|-----------|------------------|----------------------|
| Hello (static text) | Default (`text`) | None needed — standard text selection |
| Terminal | `custom` on xterm.js container | xterm.js manages its own selection model |
| Code/Conversation | `text` default, `all` on code output blocks | `none` on toolbar buttons, `custom` on CodeMirror editor, `all` on output pre blocks |
| Git | `text` on branch/commit info | `none` on action buttons and status icons |
| Files | `text` on file names/paths | `none` on action buttons and tree expand/collapse controls |
| Settings | `none` on most | `text` on labels and descriptions |
| Stats | `text` on metric values | `none` on gauge/sparkline visualizations |
| About | Default (`text`) | Standard text selection |

#### What Concept 14 Establishes {#c14-demonstrates}

1. **Three-layer selection containment** — CSS prevention for non-content areas, JavaScript SelectionGuard for runtime clipping, developer API for fine-grained content control. No single web platform feature solves selection containment; the three layers together provide complete coverage. ([#d34-three-layer-selection](#d34-three-layer-selection))
2. **SelectionGuard is a singleton outside React** — follows the same imperative pattern as ResponderChainManager. High-frequency selection events are handled synchronously without React re-renders. Selection is purely an appearance-zone concern. ([#d35-guard-singleton](#d35-guard-singleton))
3. **Pointer-clamped clipping for zero-flash containment** — during drag selection, pointer coordinates are clamped to the card boundary and `caretPositionFromPoint` finds the nearest text position at the edge. This provides smooth, continuous containment without visual flash. RAF-based autoscroll replaces the native autoscroll that pointer-clamping breaks. ([#d36-pointer-clamping](#d36-pointer-clamping))
4. **Four select modes** — `text` (default), `none` (non-selectable), `all` (atomic), `custom` (embedded component manages selection, including contenteditable). Card authors declare intent via `data-td-select` attributes. The `custom` mode is explicitly verified with contenteditable regions. ([#d37-select-modes](#d37-select-modes))
5. **Cmd+A scoped via responder chain** — `selectAll` routes through the key pipeline to the focused card's responder, which calls `selectAllChildren` on the card's content area. Integrated with existing copy/cut/find actions. ([#d38-scoped-selectall](#d38-scoped-selectall))
6. **Selection persistence infrastructure** — `saveSelection` and `restoreSelection` methods on SelectionGuard serialize and restore selection state per card via DOM tree paths and offsets. Phase 5b tab switching uses this to retain selection across tab changes. ([#d35-guard-singleton](#d35-guard-singleton))

### 15. Keybindings View {#c15-keybindings}

**Status: DEFERRED**

**The problem.** Currently the only keyboard shortcut is `Control+\` for panel cycling. We need a view to display and configure keybindings.

**Questions to resolve (when revisited):**
- Is this a card (like settings) or a modal dialog?
- Can users customize keybindings, or is this display-only?
- How do keybindings interact with the responder chain? The responder chain should be the mechanism that routes keyboard events to the correct handler.
- What keybindings do we need beyond panel cycling? Card-specific shortcuts? Global shortcuts? Command palette?

### 16. Brio Theme Revision {#c16-brio}

**Status: DEFERRED**

**The problem.** Brio's current palette is deep graphite. The request is to shift it to dark greenish.

**Depends on:** Theme architecture (concept 1). If themes become loadable resources, this is just a new theme file. If themes remain in CSS, it's a token value change.

### 17. Tugbank: Persistent Defaults Store {#c17-tugbank}

**Status: DESIGNED** (2026-03-04)

**The problem.** The current persistence path for deck state is `settings-api.ts` → HTTP POST → tugcast Rust backend → flat file. This works for the simple case (one layout blob, one theme string), but as the design system matures, the frontend needs to persist increasingly granular state: per-tab scroll positions, per-tab selections, card collapse flags, per-card content state blobs, focused card identity, and future user preferences. A flat JSON blob POSTed on every mutation is the wrong tool for this — it lacks typing, domain separation, granular writes, and multi-process safety.

**The solution.** Tugbank is a SQLite-backed typed defaults store, modeled after Apple's `UserDefaults`/`defaults`. It provides domain-separated key-value storage with typed values (bool, i64, f64, string, bytes, JSON), WAL-mode concurrent access, and compare-and-swap concurrency control. The full design is in `dash/tugbank-proposal.md`.

**Storage path.** The default database file is `~/.tugbank.db` (a dotfile in the user's home directory). The `--path` CLI flag or programmatic path parameter overrides this default, targeting a specific file for both reads and writes. There is no cascade or multi-file lookup — exactly one file is active at a time.

**Blob size limit.** Values of type `Bytes` are capped at 10 MB. The limit is enforced at the API level (in `DefaultsStore` / `DomainHandle` write methods) before touching SQLite. This keeps the database file reasonable while accommodating use cases like avatar icons.

#### Tugbank Replaces Settings API {#d46-tugbank}

**[D46] Tugbank replaces settings API with SQLite-backed typed defaults.**

The current `settings-api.ts` uses two HTTP endpoints (`GET /api/settings`, `POST /api/settings`) backed by a flat file. Tugbank replaces this storage layer:

- **Backend**: The tugcast Rust server gains a `DefaultsStore` (from the `tugbank-core` crate) opened at startup. The existing `/api/settings` endpoints are rewritten to read/write tugbank domains instead of the flat file.
- **Frontend**: `settings-api.ts` is updated to use the new endpoints. The HTTP interface (fetch/post) is preserved — the frontend does not link tugbank directly.
- **Migration**: On first startup with tugbank, if a legacy flat settings file exists, migrate its contents into the `dev.tugtool.deck` domain and remove the flat file.

#### Domain Separation {#d47-tugbank-domains}

**[D47] Per-domain key-value storage with CAS concurrency.**

Tugbank organizes data by domain (reverse-URL strings). The tugways frontend uses these domains:

| Domain | Keys | Value Types |
|--------|------|-------------|
| `dev.tugtool.deck.layout` | `cards` (the DeckState blob) | JSON |
| `dev.tugtool.deck.state` | `focusedCardId`, `collapsed.<cardId>` | string, bool |
| `dev.tugtool.deck.tabstate` | `<tabId>.scroll`, `<tabId>.selection`, `<tabId>.content` | JSON |
| `dev.tugtool.app` | `theme`, `devMode` | string, bool |

Domain separation means writing a card's scroll position does not require re-serializing the entire layout blob. Each key can be written independently.

#### HTTP Bridge {#d48-tugbank-bridge}

**[D48] Frontend reads/writes tugbank via HTTP bridge, same endpoints.**

The frontend does not link the tugbank Rust crate directly. Instead, tugcast exposes HTTP endpoints that bridge to tugbank:

- `GET /api/defaults/<domain>` — read all keys in a domain
- `GET /api/defaults/<domain>/<key>` — read a single key
- `PUT /api/defaults/<domain>/<key>` — write a single key
- `DELETE /api/defaults/<domain>/<key>` — delete a single key

The existing `GET /api/settings` and `POST /api/settings` endpoints are preserved as compatibility shims during migration, then removed.

#### Implementation Notes

- **Rust crate**: `tugbank-core` is a library crate in the tugtool workspace. It wraps `rusqlite` with the schema, value encoding, domain CRUD, and CAS logic from the tugbank proposal. Enforces the 10 MB blob size limit at the write API boundary.
- **CLI**: `tugbank` is a binary crate providing a `defaults`-like CLI for debugging and scripting. Default database path is `~/.tugbank.db`; overridable with `--path`.
- **Testing**: Unit tests for value roundtrip, SQL mapping, CAS conflict detection, blob size enforcement. Integration tests for two-process writer contention.
- **Sub-phases**: Phase 5e is split into four sub-phases for incremental delivery: (5e1) `tugbank-core` library crate, (5e2) `tugbank` CLI binary, (5e3) tugcast HTTP bridge integration, (5e4) settings migration.

### 18. Inactive State Preservation {#c18-inactive-state}

**Status: DESIGNED** (2026-03-04)

**The problem.** When a tab becomes inactive (the user switches to another tab in the same card), the inactive tab's content component unmounts. When the app reloads, all ephemeral DOM state is lost. In both cases, the user loses:

- **Text selection** — whatever text was highlighted disappears
- **Scroll position** — scrollable content areas jump back to the top
- **Card content state** — form input values, tree expand/collapse, search filters, sort orders, cursor positions in editable fields
- **Focused card identity** — which card had keyboard focus
- **Collapse state** — which cards were window-shaded

The Phase 5a selection guard already saves/restores selections across tab switches (in-memory), but this state does not survive app reload. Scroll positions are never captured at all. Card content state is entirely unmanaged.

**The solution.** A two-layer state preservation system: Tugcard-managed state (scroll, selection, collapse, focus) that Tugcard captures automatically, and card-content-managed state that card content components opt into via a hook.

#### Per-Tab State Bag {#d49-tab-state-bag}

**[D49] Per-tab state bag: scroll position, selection, card-content state.**

Each tab gets an associated state bag that survives both tab switches and app reload. The state bag is stored in tugbank under the `dev.tugtool.deck.tabstate` domain, keyed by tab ID.

**Tugcard-managed state** (captured automatically by Tugcard on deactivation):

| Field | Type | Captured From |
|-------|------|---------------|
| `scroll` | `{ x: number; y: number }` | `contentArea.scrollLeft`, `contentArea.scrollTop` |
| `selection` | `SavedSelection \| null` | `SelectionGuard.saveSelection(cardId)` — the existing index-path encoding |

**Card-content-managed state** (opted in via `useTugcardPersistence`):

| Field | Type | Captured From |
|-------|------|---------------|
| `content` | `unknown` (opaque JSON) | Card content component's `onSave` callback |

**Lifecycle:**

1. **Tab deactivation** (switching away): Tugcard reads scroll position from the content area DOM, calls `SelectionGuard.saveSelection()`, calls the card content's `onSave` callback. Writes the state bag to the in-memory cache (debounced flush to tugbank).
2. **Tab activation** (switching to): Tugcard reads the state bag from the in-memory cache. **Restore order is critical — content first, then scroll, then selection:**
   - **Content restore** runs in `useLayoutEffect` body (synchronous, before RAF). Calls `onRestore` with saved content state. If the card content calls `setState` in response, React flushes the re-render synchronously (React 19 behavior inside `useLayoutEffect`), so the DOM has its full content structure and scrollable height before the next step.
   - **Scroll and selection restore** use a child-driven ready callback (Rule 11, Rule 12). When card content registered `useTugcardPersistence` and `bag.content` exists (persist path): Tugcard stores pending scroll/selection in refs and writes an `onContentReady` callback. The child's own `useLayoutEffect` fires after its DOM commits and calls `onContentReady`, which applies scroll and selection. Flash suppression: `visibility:hidden` is applied in the `useLayoutEffect` body when scroll state exists, and cleared in `onContentReady` after scroll is set. When no persistence is registered or `bag.content` is undefined (direct-apply path): the DOM is already stable, so scroll and selection are applied directly in the `useLayoutEffect` body — no callback, no hiding.
   - **Cleanup**: on rapid tab switches, the previous effect's cleanup clears the `restorePendingRef` flag (cancelling the pending `onContentReady` callback), resets pending refs, and restores visibility if hidden — no cross-contamination between tabs.
3. **Auto-save** (scroll, selection, content changes): Each Tugcard installs a debounced auto-save mechanism. A `scroll` listener on the content area and a `selectionchange` listener on `document` (filtered to the card's boundary) both funnel into a `markDirty` callback that schedules a debounced save (1 second). Card content can also trigger saves via `useTugcardDirty()`, which returns a stable `markDirty` function from `TugcardDirtyContext`. On fire, the debounced save captures scroll, selection, and content state for the currently-active tab and writes to the in-memory cache (which flushes to tugbank on the normal debounce). Cleanup removes listeners and clears pending timers on unmount.
4. **App save — browser events** (visibility change + beforeunload): Each Tugcard registers a save callback with DeckManager on mount via `useLayoutEffect` (Rule #3). The callback captures scroll, selection, and content state for that card's currently-active tab — identical to the tab-deactivation save, but triggered externally rather than by a tab switch. DeckManager listens for `visibilitychange` (`document.visibilityState === 'hidden'`) and `beforeunload`. On either event, DeckManager calls all registered save callbacks, then flushes all dirty tab states to tugbank immediately (bypassing the normal debounce). This ensures the currently-active tab's state in every card is persisted even if no tab switch occurred during the session. Unregistration happens in the `useLayoutEffect` cleanup (Rule #3). **Transport note:** On `beforeunload`, the page is unloading and normal `fetch` calls may not complete. Use `fetch` with `keepalive: true` for the flush — this guarantees the request is dispatched even during page teardown, and unlike `navigator.sendBeacon()` it supports PUT requests (which tugbank's `putTabState` endpoint requires). The `visibilitychange` handler uses the normal `fetch` path since the page remains alive.
5. **App save — native app paths** (macOS lifecycle): WKWebView does not fire `visibilitychange` or `beforeunload` on app quit, so the native side triggers saves directly via `evaluateJavaScript`:
   - **App quit** (`applicationShouldTerminate`): Swift calls `window.__tugdeckSaveState()`, which invokes `DeckManager.saveAndFlushSync()`. This runs all registered save callbacks and flushes dirty tab states to tugbank via **synchronous XHR** (not `fetch`, which is async and would race with process shutdown). The Swift side uses `NSApplication.terminateLater` and calls `reply(toApplicationShouldTerminate: true)` in the JS completion handler, ensuring all writes complete before teardown.
   - **App deactivation** (`applicationDidResignActive`): Swift calls `window.__tugdeckAppDeactivated()`, which invokes `DeckManager.saveAndFlush()` (async fetch — the app is still running) and `SelectionGuard.deactivateApp()` (moves the active card's highlight Range from activeHighlight to inactiveHighlight, dimming all selections).
   - **App activation** (`applicationDidBecomeActive`): Swift calls `window.__tugdeckAppActivated()`, which invokes `SelectionGuard.activateApp()` (restores the previously-active card's Range from inactiveHighlight to activeHighlight, and restores the browser Selection for copy/paste).
6. **App reload**: Tugcard reads state bags from tugbank during initialization (two-phase fetch in `main.tsx`). Same restore path as tab activation — content first via persist path or direct-apply fallback, all within `useLayoutEffect`. **Prerequisite:** CSS Highlight objects are created eagerly in the SelectionGuard constructor (module scope, before React mounts) so they exist before any Tugcard restore effects fire. `SelectionGuard.attach()` installs event listeners only — it does not create the Highlight objects.

**In-memory cache:** During a session, state bags are cached in memory (a `Map<tabId, TabStateBag>` on DeckManager or a dedicated store). Tugbank is the durable backing store; the in-memory cache avoids HTTP round-trips on every tab switch.

#### Persistence Hook for Card Content {#d50-persistence-hook}

**[D50] `useTugcardPersistence` hook for card content state save/restore.**

Card content components opt into state persistence by calling a hook:

```typescript
function useTugcardPersistence<T>(options: {
  onSave: () => T;
  onRestore: (state: T) => void;
}): void;
```

**How it works:**
- `onSave` is called by Tugcard when the tab deactivates or the app saves. The card content returns whatever state it wants to persist (form values, tree expand state, sort order, etc.). The returned value must be JSON-serializable.
- `onRestore` is called by Tugcard when the tab activates and a saved state exists. The card content receives its previously-saved state and applies it.

**Contract:**
- The hook registers callbacks with Tugcard via context. Tugcard calls them at the right lifecycle points.
- Card content owns the schema of its persisted state. Tugcard treats it as opaque JSON.
- If no saved state exists on restore (first mount, or state was cleared), `onRestore` is not called.

**Examples of card-content state:**

| Card Type | Persisted State |
|-----------|----------------|
| Files card | `{ expandedPaths: string[], sortColumn: string, sortDir: "asc" \| "desc" }` |
| Git card | `{ activeSection: string, filter: string }` |
| Settings card | `{ unsavedChanges: Record<string, unknown> }` |
| Code card | `{ cursorLine: number, cursorColumn: number }` |
| Terminal card | *(deferred — xterm.js has its own buffer model)* |

#### Focused Card Persistence {#d51-focused-card}

**[D51] Focused card ID persisted in DeckState for reload restoration.**

The currently-focused card ID is written to tugbank under `dev.tugtool.deck.state` → `focusedCardId`. On reload, after all cards are mounted, DeckManager calls `makeFirstResponder` on the restored card ID (if it still exists in the deck).

#### Collapsed State Persistence {#d52-collapsed-state}

**[D52] Collapsed state persisted in CardState.**

Add `collapsed?: boolean` to `CardState` in `layout-tree.ts`. This field is serialized with the layout and restored on reload. When `true`, the card renders in window-shade mode (title bar only, content hidden). The collapse UI itself is built in Phase 8a (title bar enhancements), but the data field and persistence are established here so that Phase 8a can simply read/write it.

#### Inactive Selection Appearance {#d77-inactive-selection}

**[D77] Inactive selection appearance: dimmed highlight in unfocused cards via CSS Custom Highlight API.**

When a card loses focus, any visible text selection in that card should render with a dimmed, desaturated background rather than the active highlight color. This follows the standard macOS/Windows convention where inactive window selections use a gray or muted treatment to visually distinguish them from the active selection.

**Implementation:** CSS Custom Highlight API (`CSS.highlights`, `::highlight()`) managed by SelectionGuard. The browser clears the global Selection on `pointerdown` in another card, so the `::selection` pseudo-element has nothing to style once focus moves. Instead, SelectionGuard proactively captures the live selection Range on every `pointerdown` outside the card (capture phase, before the browser clears the selection), clones it, and adds it to a named CSS Highlight registered as `"inactive-selection"`. The highlight is styled via CSS (Rule 4 — appearance through CSS and DOM, never React state):

```css
::highlight(inactive-selection) {
  background-color: var(--tug-base-selection-bg-inactive);
  color: inherit;
}
```

The `--tug-base-selection-bg-inactive` token is defined in `tug-tokens.css` with theme-specific overrides in `bluenote.css` and `harmony.css`. The brio theme uses the base token value directly.

**Lifecycle:** SelectionGuard owns the highlight lifecycle. CSS Custom Highlight objects (`activeHighlight` for `"card-selection"`, `inactiveHighlight` for `"inactive-selection"`) are created eagerly in the SelectionGuard constructor — which runs at module scope before React mounts — so they exist before any Tugcard restore effects fire. `attach()` installs document-level event listeners and re-registers the highlights with `CSS.highlights` (idempotent). `detach()` unregisters from `CSS.highlights` (stops painting) but does not null the Highlight objects — they are owned by the singleton for its lifetime. On each `pointerdown` (capture phase, before the browser clears the global Selection), a highlight-management loop runs before the existing tracking loop. Elements marked with `data-no-activate` (e.g. close buttons) are skipped — clicking a background card's close button must not dim the frontmost card's selection:

- **Capture path** (click target outside card, selection anchor inside card): the live Range is cloned and added to the highlight. The cloned Range is stored in `highlightRanges` and becomes the source of truth for future restore.
- **Restore path** (click target inside a card that has a stored highlight range): the Range is stashed as a pending restore (`pendingHighlightRestore`), then the highlight entry is cleared from both `highlightRanges` and the `Highlight` object. On the subsequent `pointerup`, if the current selection is collapsed (the user clicked without dragging to select new text), the stashed Range is used to restore the real Selection via `window.getSelection().removeAllRanges()` + `addRange()`. If the selection is not collapsed (the user dragged to create a new selection), the stashed Range is discarded — the user's new selection takes precedence. This mirrors the macOS convention: clicking an inactive window with a dimmed selection reactivates the selection rather than placing a caret. The collapsed-vs-non-collapsed check on `pointerup` prevents the stored range from fighting with intentional drag-to-select operations.
- **Canvas clicks** (target outside all cards) naturally trigger capture for any card with a selection.

**Fallback:** The original `::selection` rule on `.card-frame[data-focused="false"]` is retained as a harmless no-op — it has nothing to style since the browser clears the Selection, but it provides graceful degradation on browsers that do not support the CSS Custom Highlight API.

**App deactivation/activation:** When the app loses focus (`applicationDidResignActive`), `SelectionGuard.deactivateApp()` moves the active card's Range from `activeHighlight` to `inactiveHighlight`, dimming all selections to match macOS behavior (inactive app = all selections dimmed). When the app regains focus (`applicationDidBecomeActive`), `activateApp()` moves the Range back to `activeHighlight` and restores the browser Selection via `removeAllRanges()` + `addRange()` so copy/paste works immediately.

**Note:** Feature detection (`CSS.highlights !== undefined`) gates all highlight operations. On unsupported browsers, inactive cards simply do not show dimmed selections — no errors occur.

#### Child-Driven Ready Callback {#d78-content-ready}

**[D78] Child-driven ready callback: parent triggers child setState, child signals DOM commit via `useLayoutEffect`.**

When a parent component triggers a child's `setState` (e.g., calling `onRestore` to restore saved content), the parent cannot measure or manipulate the child's DOM inline — the child's re-render has not committed yet. This is a proven React 19 fact, not a theory:

- `setState` inside `useLayoutEffect` does NOT commit child DOM inline. The parent sees stale DOM.
- `flushSync` inside `useLayoutEffect` is a noop — it does not force inline commit.
- Bottom-up effect ordering does not help. Child `setState` is not committed between child and parent layout effects.
- A parent's no-deps `useLayoutEffect` does NOT fire on the child's re-render (the parent doesn't re-render).

**The solution: a ref-flag mechanism in the child.** When `onRestore` is called, it sets a ref flag (`restorePending = true`) and calls `setState`. The child's own no-deps `useLayoutEffect` fires on every render of that component — including the re-render caused by `setState`. When it sees the flag, it fires the `onContentReady` callback and clears the flag.

This works because a component's own `useLayoutEffect` firing after its own DOM commit is a React contract, not a timing bet. The mechanism:

1. Parent calls `onRestore(savedState)` — this calls child's `setState` and sets `restorePending = true`
2. Child re-renders with new state
3. Child's no-deps `useLayoutEffect` fires — DOM is committed
4. Flag is true → fire `onContentReady`, clear flag

**Properties proven by spike (tugdeck/src/__tests__/content-ready-spike.test.tsx):**
- DOM is fully committed when the callback fires (S2)
- One-shot per restore — no false fires on subsequent re-renders (S3)
- Sequential restores each get their own callback (S4)
- Non-restore `setState` (user interaction) does not trigger the callback (S5)
- Works through context indirection, nested components, and sibling components (S6, S7, S8)
- Supports cancellation via external ref guard (S11)

**Integration with `useTugcardPersistence`:** The ref-flag mechanism is built into the persistence hook. Card content components get `onContentReady` for free when they use `useTugcardPersistence`. Tugcard's restore flow uses it: Phase 1 effect hides content and calls `onRestore`; the `onContentReady` callback applies scroll, restores selection, and unhides.

#### No RAF for React State-Dependent DOM Operations {#d79-no-raf-for-state}

**[D79] Never use `requestAnimationFrame` for operations that depend on React state commits. RAF is a timing bet, not a contract.**

The prior pattern in tugcard's restore flow used a double-RAF (nested `requestAnimationFrame`) to wait for child content to be laid out before applying scroll position. This pattern is fundamentally flawed:

- **RAF timing relative to React's commit cycle is an implementation detail.** In current browsers, SyncLane updates process before the next paint, so a single RAF happens to see committed DOM. But this is not a contract — browser schedulers, React internals, and concurrent features can all change this relationship.
- **Double-RAF is a timing guess with no verification.** It fires once and forgets. If the child's re-render hasn't committed by the second frame (e.g., during heavy app-launch rendering), `scrollTop` is silently clamped to 0 with no retry.
- **RAF is not testable in happy-dom.** The test environment implements RAF via `setTimeout(0)`, which does not match browser scheduling. Timing-based patterns cannot be reliably verified in tests.

**The replacement:** Use the child-driven ready callback (D78). The child's `useLayoutEffect` fires at exactly the right moment — after its DOM commits. This is deterministic, testable, and based on a React contract.

**Scope:** This rule applies specifically to DOM operations that depend on React state commits (scroll restore after content restore, selection restore after content mount, focus management after state-driven visibility changes). RAF remains appropriate for non-React DOM operations: drag frame batching, pointer move throttling, ResizeObserver write deferral (to avoid observer loops), and continuous animations. The distinction: if the operation waits for React to commit a state change, use Rule 11. If it batches raw DOM reads/writes independent of React, RAF is fine.

#### Monaco Editor Forward Compatibility {#monaco-forward-compat}

The `useTugcardPersistence` hook's `content` field in `TabStateBag` is typed as `unknown` (opaque JSON) and can hold arbitrarily deep state structures. This is intentionally designed to accommodate rich editor state models. When Phase 8/9 introduces a Monaco-based code card, the card content should use `editor.saveViewState()` in `onSave` and `editor.restoreViewState()` in `onRestore` to persist Monaco's full view state (cursor position, scroll state, folding state, find widget state, etc.) through the hook. No structural changes to the persistence infrastructure are needed — the hook and state bag are already designed to handle this. Terminal buffer persistence (xterm.js) is similarly deferred to Phase 9.

### 19. Target/Action Control Model {#c19-target-action}

**Status: IMPLEMENTED** (2026-03-05)

**The problem.** The responder chain dispatches actions as bare strings — `dispatch('copy')`. This works for discrete commands (copy, paste, close) but breaks down for continuous controls. A slider scrub isn't a single event — it's a begin → change → change → change → commit sequence. A color picker preview needs to communicate "the user is scrubbing hue, here's the current value, and they haven't committed yet." The chain has no way to express this.

TugButton already has two modes (direct-action and chain-action, [D08]), but both fire a single event. There's no sender identity, no typed payload, and no phase. When inspector panels need to edit properties on the focused card's content, the bare-string dispatch signature is insufficient.

**The inspiration.** Apple's UIKit target/action pattern (UIControl → target → action selector). Controls don't need hard coupling to handlers. A nil-target action naturally maps to the responder chain. The key additions: typed payloads (a slider sends its current value, not just "valueChanged"), action phases (begin/change/commit/cancel for continuous gestures), and explicit-target dispatch for when the target is known.

#### ActionEvent: Typed Payloads and Phases {#d61-action-event}

**[D61] Actions carry typed payloads, sender identity, and phase.**

`ResponderChainManager.dispatch()` accepts only `ActionEvent` objects — no string overload, no backward compatibility shim:

```typescript
export type ActionPhase = 'discrete' | 'begin' | 'change' | 'commit' | 'cancel';

export interface ActionEvent {
  action: string;              // semantic name from action vocabulary
  sender?: unknown;            // the control that initiated (ref or instance)
  value?: unknown;             // typed payload (color, number, point, etc.)
  phase: ActionPhase;          // lifecycle phase
}
```

This is a clean break: passing a bare string to `dispatch()` is a TypeScript compile error. All call sites produce `ActionEvent` objects (e.g., `dispatch({ action: 'copy', phase: 'discrete' })`). All action handlers receive the full `ActionEvent` — handler signatures are `(event: ActionEvent) => void` throughout. Continuous controls use `begin/change/commit/cancel`. Validation queries (`canHandle`, `validateAction`) remain string-based — they ask about capability by action name, not about a specific event instance.

**Phase semantics:**

| Phase | Meaning | Typical Source | Mutation Zone |
|-------|---------|----------------|---------------|
| `discrete` | One-shot action | Button click, keyboard shortcut | Local data or structure |
| `begin` | Gesture started | Pointer down on slider/picker | Opens mutation transaction (D64) |
| `change` | Live value update | Pointer move during scrub | Appearance zone only (preview) |
| `commit` | Gesture completed | Pointer up, Enter key | Local data or structure (finalize) |
| `cancel` | Gesture aborted | Escape key, pointer leave | Appearance zone (restore snapshot) |

**No backward compatibility:** Every `dispatch("actionName")` call was migrated to `dispatch({ action: "actionName", phase: "discrete" })`. Every `actions: { name: () => void }` handler was migrated to `actions: { name: (event: ActionEvent) => void }` (or `(_event: ActionEvent) => void` for handlers that ignore the event). This was a large but mechanical migration done in a single step to ensure the codebase compiles at all times within the step boundary.

#### Two Dispatch Modes {#d62-dispatch-modes}

**[D62] Two dispatch modes: explicit target and nil-target (chain resolution).**

Controls can dispatch actions in two ways:

**Nil-target dispatch** — send the action into the responder chain. The chain walks from first responder upward until a handler is found:

```typescript
// TugSlider with nil-target — chain resolves the handler
manager.dispatch({ action: 'setOpacity', value: 0.75, phase: 'change' });
```

**Explicit-target dispatch** — send directly to a specific responder by ID via `dispatchTo(targetId, event)`. Bypasses the chain walk. Used when the target is known (e.g., an inspector panel editing a specific card's properties). Throws `Error` with a descriptive message when the target ID is not registered — explicit-target dispatch is a programmer assertion that the target exists:

```typescript
// Inspector targets a specific card's responder
manager.dispatchTo(cardId, { action: 'setBackgroundColor', value: '#ff6600', phase: 'change' });

// Throws: dispatchTo: target "nonexistent" is not registered
manager.dispatchTo('nonexistent', { action: 'foo', phase: 'discrete' });
```

**Per-node capability query** — `nodeCanHandle(nodeId, action)` checks whether a specific node can handle a given action without chain walk. Looks up the node in the nodes map, checks the actions record and optional `canHandle` callback. Returns `false` if the node is not registered. This is the per-node equivalent of the chain-walk `canHandle` method.

**TugButton target prop** — TugButton's existing `action` prop remains nil-target. A new optional `target` prop enables explicit-target dispatch. When both `action` and `target` are set, TugButton uses `dispatchTo(target, event)` instead of `dispatch(event)`, and `nodeCanHandle(target, action)` for the enabled/disabled check instead of chain-walk `canHandle(action)`. A dev-mode warning fires if `target` is set without `action`.

**TugButton never-hide semantics** — TugButton never returns `null` based on chain-action state. When `canHandle` returns false (nil-target) or `nodeCanHandle` returns false (target mode), the button renders with `aria-disabled="true"` instead of being hidden. This is standard UI behavior — users see the button exists but it is inert. The previous hide-when-unhandled behavior was removed.

**DeckCanvas last-resort responder** — DeckCanvas registers `canHandle: () => true` so it handles all actions as a last-resort catch-all. This means chain-action buttons are almost never disabled in practice because the chain walk always reaches DeckCanvas. Note: `canHandle` is the advisory override for validation queries only — dispatch still checks the actions map, so dispatching an unregistered action to DeckCanvas is a safe no-op.

All tugways controls (TugSlider, TugInput, TugColorPicker, etc.) will support the same two dispatch modes.

#### Controls Are Not Responders {#d63-controls-not-responders}

**[D63] Controls dispatch into chain, never register as responders.**

This is the existing TugButton design (it doesn't register via `useResponder`, [#tugbutton-a11y](#tugbutton-a11y)), now formalized as a rule for all tugways controls. Controls *emit* actions; responders *handle* actions. This separation keeps the chain clean — controls are leaf UI that dispatch into the chain, while responders (card content, Tugcard, DeckCanvas, TugApp) handle and validate.

A TugSlider with `action="setFontSize"` dispatches `{ action: 'setFontSize', value: 14, phase: 'change' }` into the chain. The focused card's content area handles it. The slider never appears in the responder chain tree.

**The exception:** Controls that *also* handle routed actions (e.g., a text input that handles `selectAll` and `paste`) register as responders for those specific actions. But they do so as responders, not as controls — the control identity (emitting actions) and the responder identity (handling actions) are separate roles that happen to coexist in the same component.

#### New Action Vocabulary Entries

The target/action model adds the following to the [action vocabulary](#action-vocabulary):

**Inspector actions** (dispatched by inspector controls, handled by card content):

| Action | Payload | Description |
|--------|---------|-------------|
| `setProperty` | `{ path: string, value: unknown }` | Set an inspectable property by key-path |
| `getProperty` | `{ path: string }` | Query a property value (response via PropertyStore) |

**Continuous control actions** (dispatched by sliders, pickers, coordinate fields):

| Action | Payload | Description |
|--------|---------|-------------|
| `setOpacity` | `number` | Set opacity (0–1) |
| `setFontSize` | `number` | Set font size in px |
| `setColor` | `{ property: string, color: string }` | Set a color property |
| `setPosition` | `{ x: number, y: number }` | Set position coordinates |

Card-specific continuous actions extend this vocabulary as needed.

### 20. Mutation Transactions {#c20-mutation-transactions}

**Status: DESIGNED** (2026-03-05)

**The problem.** Inspector panels need live preview: as you scrub a color picker, the target element updates in real time. But if you cancel, everything must revert. The three-zone model (D12) says appearance changes are CSS/DOM mutations (zero re-renders) — correct. But there's no mechanism to *snapshot and restore* the appearance state when a preview is abandoned.

The "bypass React during the gesture, sync on commit" principle from the Excalidraw study ([#d13-dom-hooks](#d13-dom-hooks)) describes the timing correctly. Mutation transactions formalize this with snapshot/restore semantics.

#### Transaction Lifecycle {#d64-mutation-transactions}

**[D64] Mutation transactions: begin → preview → commit/cancel.**

A `MutationTransaction` captures the initial state of targeted CSS properties and DOM attributes before any preview mutations begin. During the transaction, appearance-zone mutations are applied directly. On commit, the final values become canonical. On cancel, the snapshot is restored.

```typescript
interface MutationTransaction {
  readonly id: string;
  begin(target: Element, properties: string[]): void;  // snapshot current values
  preview(target: Element, property: string, value: string): void;  // appearance-zone mutation
  commit(): void;   // finalize — values stay as-is, write to store if needed
  cancel(): void;   // restore snapshot — every previewed property reverts
}
```

**Integration with action phases (D61):** `phase: 'begin'` opens a transaction. `phase: 'change'` calls `preview()`. `phase: 'commit'` calls `commit()`. `phase: 'cancel'` calls `cancel()`. The responder that handles continuous actions manages the transaction lifecycle.

**What gets snapshotted:**
- CSS custom property values (`element.style.getPropertyValue()`)
- Inline style properties (`element.style[prop]`)
- Data attributes (`element.dataset[key]`)
- CSS class presence (`element.classList.contains()`)

**What does NOT get snapshotted:** Computed styles that come from class rules or theme tokens. The transaction only tracks values that the transaction itself *writes*. If a preview sets `element.style.backgroundColor = 'red'`, the snapshot records the previous inline `backgroundColor` (which may be empty, meaning "inherit from class/token"). Cancel restores the empty value, and the cascade takes over again.

#### Appearance Zone Only {#d65-transactions-appearance-zone}

**[D65] Transactions operate in the appearance zone only.**

During a transaction, all mutations are CSS custom property writes, inline style changes, data-attribute toggles, or class toggles. No React state changes. No re-renders. This is Rule #9.

On commit, if the change needs to persist (e.g., a card's background color saved to tugbank via PropertyStore), the commit handler writes to the appropriate store. This crosses from appearance zone to local-data zone — but only once, at commit time, not on every scrub tick.

```
begin:   snapshot CSS/DOM state
change:  mutate CSS/DOM directly (appearance zone, 60fps, zero re-renders)
change:  ...
change:  ...
commit:  final CSS/DOM state stays; write to PropertyStore (local-data zone, one re-render)
 —or—
cancel:  restore snapshot (appearance zone, zero re-renders)
```

**Transaction manager:** A `MutationTransactionManager` singleton creates and tracks active transactions. Only one transaction per target element at a time (starting a new transaction on the same element cancels the previous one). The manager is an imperative object, not React state — consistent with the responder chain and selection guard patterns.

#### Style Cascade Reader {#d66-style-cascade-reader}

**[D66] Style source layers with cascade reader for inspector editing.**

CSS values on an element come from multiple sources. An inspector needs to show which layer a value comes from and edit at the right layer. A `StyleCascadeReader` utility provides read-only introspection:

```typescript
interface StyleLayer {
  value: string;
  source: 'token' | 'class' | 'inline' | 'preview';
}

interface StyleCascadeReader {
  getDeclared(element: Element, property: string): StyleLayer | null;
  getComputed(element: Element, property: string): string;
  getTokenValue(tokenName: string): string;  // reads from document's computed style
}
```

**Source layer priority** (highest to lowest):

| Layer | Source | Example |
|-------|--------|---------|
| `preview` | Active MutationTransaction | Inspector scrubbing a color |
| `inline` | `element.style[prop]` | Card-specific override |
| `class` | CSS class rules | `.tugcard` base styles |
| `token` | CSS custom properties from theme | `var(--td-surface-2)` |

The cascade reader tells the inspector *what to show* (the current effective value and where it comes from). The transaction system (D64) tells it *how to edit* (preview at the inline/preview layer, commit to the appropriate persistent layer).

**Implementation note:** `getDeclared` uses `element.style.getPropertyValue()` for inline values and `getComputedStyle()` comparison logic for class-level values. The `preview` source is tracked by the MutationTransactionManager — if a transaction is active on the element, the previewed properties are reported as `source: 'preview'`.

### 21. Observable Properties {#c21-observable-properties}

**Status: DESIGNED** (2026-03-05)

**The problem.** Inspectors and card content need to stay in sync without tight coupling. When a card's content has editable properties (background color, font, position), an inspector panel needs to read and write those properties without importing the card's internals. Today there's no shared property model — each card manages its own state independently.

This is the KVC/KVO problem from Apple's Cocoa framework: key-value coding provides uniform property access by string path, and key-value observing provides change notification without explicit delegation. The tugways equivalent needs to work with the three-zone model and `useSyncExternalStore`.

#### Typed Key-Path Property Store {#d67-property-store}

**[D67] Typed key-path property store per card.**

Each card that wants to expose inspectable properties registers a `PropertyStore` — a typed key-value store with observation. This is not a general-purpose global store; it's scoped to a single card (or component) and exposes only the properties that external code (inspectors, other cards) should see.

```typescript
interface PropertyStore {
  get(path: string): unknown;
  set(path: string, value: unknown, source?: string): void;
  observe(path: string, listener: PropertyChangeListener): () => void;  // returns unsubscribe
  getSchema(): PropertySchema;  // describes available paths and their types
}

type PropertyChangeListener = (change: PropertyChange) => void;

interface PropertyChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  source: string;       // who made the change ('inspector', 'content', 'feed', etc.)
  transactionId?: string;  // links to MutationTransaction if in a preview cycle
}

interface PropertySchema {
  paths: PropertyDescriptor[];
}

interface PropertyDescriptor {
  path: string;            // e.g., 'style.backgroundColor', 'layout.x', 'content.fontSize'
  type: 'string' | 'number' | 'boolean' | 'color' | 'point' | 'enum';
  label: string;           // human-readable label for inspector UI
  enumValues?: string[];   // for 'enum' type
  min?: number;            // for 'number' type
  max?: number;            // for 'number' type
  readOnly?: boolean;      // inspector shows but cannot edit
}
```

**Key-paths** are dot-separated strings. The store validates paths against its schema at registration — no arbitrary key access. A card registers its store via a context or the responder chain:

```typescript
// In card content component
const store = usePropertyStore({
  paths: [
    { path: 'style.backgroundColor', type: 'color', label: 'Background' },
    { path: 'style.fontSize', type: 'number', label: 'Font Size', min: 8, max: 72 },
    { path: 'style.fontFamily', type: 'enum', label: 'Font', enumValues: ['system-ui', 'monospace', 'serif'] },
  ],
  onGet: (path) => { /* read from DOM or internal state */ },
  onSet: (path, value, source) => { /* apply to DOM or internal state */ },
});
```

**Change records** include `source` so that circular updates are avoided — when the inspector sets a property (source: `'inspector'`), the card's observer knows the change came from outside and doesn't re-dispatch it back.

#### useSyncExternalStore Integration {#d68-property-store-sync}

**[D68] PropertyStore integrates with `useSyncExternalStore`.**

For React components that need to display a property value (like an inspector field showing the current color), the store exposes a per-path subscription interface compatible with `useSyncExternalStore`. This means inspector UI re-renders only when the specific property it displays changes — not when any property on the card changes.

```typescript
// In an inspector field component — subscribes to ONE property
function ColorField({ store, path }: { store: PropertyStore; path: string }) {
  const value = useSyncExternalStore(
    (cb) => store.observe(path, cb),
    () => store.get(path)
  );
  return <TugColorPicker value={value as string} /* ... */ />;
}
```

**Snapshot stability:** `PropertyStore.get()` returns the same reference for unchanged values (same rule as D40's `getSnapshot`). For object values (points, colors), the store caches the reference and only replaces it when the value actually changes. This prevents `useSyncExternalStore` from triggering spurious re-renders.

**Relationship to feed data:** PropertyStore is for *editable, inspectable* properties — things the user can see and change via UI controls. Feed data (concept 7) flows through `useFeedBuffer`/`useFeedStore` and is typically read-only from the frontend's perspective. Some cards may bridge feed data into PropertyStore (e.g., a stats card exposing computed values as read-only inspectable properties), but the two systems serve different purposes.

#### Inspector Panels as Responder Participants {#d69-inspector-responders}

**[D69] Inspector panels are responder participants.**

An inspector panel registers as a responder node via `useResponder`, just like any other component in the chain. When it edits a property, it dispatches an action through the chain — using explicit-target dispatch (D62) to the card that owns the PropertyStore:

```
Inspector UI           Responder Chain           Card Content
    │                       │                        │
    │  dispatchTo(cardId, { │                        │
    │    action: 'setProperty',                      │
    │    value: { path: 'style.backgroundColor',     │
    │             value: '#ff6600' },                 │
    │    phase: 'change'    │                        │
    │  })                   │                        │
    │──────────────────────▶│───────────────────────▶│
    │                       │                        │ store.set(path, value)
    │                       │                        │ (appearance-zone preview)
    │                       │                        │
    │◀──────────────── observer notification ────────│
    │ (useSyncExternalStore re-renders inspector field)
```

The inspector doesn't import the card's internal code. It discovers available properties through `PropertyStore.getSchema()`. It reads values via `store.get()`. It writes via dispatching actions. The card is the authority on its own properties.

**Inspector as a card or panel:** An inspector can be implemented as a card (lives in the deck like any other card, can be tabbed), as a sidebar panel, or as a popover attached to a toolbar button. The PropertyStore + responder chain integration works identically regardless of how the inspector is hosted — the coupling is through the chain and the store, not through component hierarchy.

**Multiple inspectors, one target:** Multiple inspector panels can observe the same PropertyStore simultaneously. Each subscribes to the paths it cares about. Changes from any source (any inspector, the card itself, feed data) notify all observers.

### 22. Theme Token Overhaul {#c22-theme-overhaul}

**Status: DESIGNED**

**The problem.** The current token system (`--tways-*` palette, `--td-*` semantic) has served well for establishing theme machinery, but the naming is ad hoc, the accent system uses meaningless ordinals (`accent-1` through `accent-8`), the color palette is rigid (fixed hex values per theme), and there's no systematic way to resize the UI or control animation speed. The legacy bridge aliases (`--background`, `--foreground`, `--primary`, etc.) — inherited from the former shadcn layer — create an opaque layer that obscures the actual canonical tokens. The roadmap's much larger component inventory (28+ components, inspector panels, data visualization) requires a token system designed for the full scope, not just today's small CSS footprint.

**Full proposal.** The complete research-backed proposal is in `dash/theme-overhaul-proposal.md`, including external research references (Primer, Spectrum, Open Props, Carbon, Chakra, OKLCH guidance), current code audit, roadmap requirements analysis, and the complete semantic taxonomy (~300 tokens across 10 domains).

#### Computed OKLCH Color Palette — TugColor (Hue · Intensity · Tone · Alpha) {#d70-computed-palette}

**[D70] 24 hue families with TugColor (Hue/Intensity/Tone) axes, defined as pure CSS formulas.** Instead of hardcoded hex values per theme, the palette is computed from OKLCH parameters using the TugColor system. 24 named hue families (cherry, red, tomato, flame, orange, amber, gold, yellow, lime, green, mint, teal, cyan, sky, blue, cobalt, violet, purple, plum, pink, rose, magenta, berry, coral) each mapped to specific OKLCH hue angles.

Each color is defined by three axes:
- **Hue**: one of 24 named color families mapped to OKLCH hue angles (cherry=10° through coral=20°)
- **Intensity (i, 0–100)**: chroma scaling. At i=50, chroma equals the sRGB-safe max for that hue. Above 50 pushes into P3 gamut on capable displays.
- **Tone (t, 0–100)**: lightness scaling via piecewise linear mapping. t=0 → L_DARK (0.15), t=50 → per-hue canonical L, t=100 → L_LIGHT (0.96).

Token naming format: `--tug-{hue}` for canonical, `--tug-{hue}-{preset}` for convenience presets, `--tug-{hue}-h/canonical-l/peak-c` for per-hue constants, `--tug-l-dark/l-light` for globals.

Examples: `--tug-red` (canonical), `--tug-red-intense`, `--tug-blue-muted`, `--tug-green-peak-c`.

The palette engine exposes a **continuous color space** — 24 hues × 100 intensity levels × 100 tone levels. Five convenience presets per hue cover the most common needs:

| Preset    | i | t | Character                          |
|-----------|-----|-----|------------------------------------|
| canonical | 50  | 50  | The crayon color — reference point  |
| light     | 20  | 85  | Background-safe, airy              |
| dark      | 50  | 20  | Contrast text, dark surfaces       |
| intense   | 90  | 50  | Pops, draws attention              |
| muted     | 20  | 50  | Subdued, secondary                 |

These five presets have **fixed i/t values across all themes** — they are stable reference colors, not the system's backbone. Any other i/t combination is accessible via the inline `calc()`+`clamp()` formula or `tugColor()` in JS.

Per-hue chroma caps are derived by binary-searching the maximum safe chroma at each hue's canonical lightness, with a 2% safety margin. The caps are hardcoded as static tables — not computed at runtime.

**Static CSS architecture.** The palette is defined entirely in static CSS using `oklch()` + `calc()` + `clamp()` formulas — no JavaScript injection required. The architecture has two tiers:

1. **Per-hue constants** (74 variables): Static values in a CSS file, derived from `tug-color-canonical.json`. These are the only values that require computation (gamut boundary binary search), and they change only when canonical L values are retuned. Three constants per hue (`-h`, `-canonical-l`, `-peak-c`) plus two globals (`--tug-l-dark`, `--tug-l-light`).

2. **Convenience presets** (120 variables = 24 hues × 5 presets): Pure CSS using `oklch()` with `calc()`, `clamp()`, and the per-hue constants. Literal i/t numbers (not CSS custom property references) because the five presets have fixed values:

```css
/* Per-hue constants (static, from canonical.json): */
--tug-red-h: 25;
--tug-red-canonical-l: 0.62;
--tug-red-peak-c: 0.44;

/* Convenience preset — muted: i=20, t=50 */
--tug-red-muted: oklch(
  calc(
    var(--tug-l-dark)
    + clamp(0, 50, 50)
      * (var(--tug-red-canonical-l) - var(--tug-l-dark)) / 50
    + (clamp(50, 50, 100) - 50)
      * (var(--tug-l-light) - var(--tug-red-canonical-l)) / 50
  )
  calc(20 / 100 * var(--tug-red-peak-c))
  var(--tug-red-h)
);
```

The `clamp()` piecewise math: t 0→50 maps L from L_DARK to canonical-l; t 50→100 maps L from canonical-l to L_LIGHT. At t=50 (the hinge), L equals canonical-l exactly. Intensity scales chroma linearly: `i/100 * peak-c`.

**Arbitrary colors via inline formula.** Theme files define chromatic semantic tokens using the same formula with theme-specific i/t numbers. This is the primary way themes express chromatic choices — not by overriding presets, but by writing the formula with the desired numbers:

```css
/* Harmony theme — accent is orange at i=60, t=55 */
--tug-base-accent-default: oklch(
  calc(
    var(--tug-l-dark)
    + clamp(0, 55, 50)
      * (var(--tug-orange-canonical-l) - var(--tug-l-dark)) / 50
    + (clamp(50, 55, 100) - 50)
      * (var(--tug-l-light) - var(--tug-orange-canonical-l)) / 50
  )
  calc(60 / 100 * var(--tug-orange-peak-c))
  var(--tug-orange-h)
);
```

**Why pure CSS, not JS injection.** The TugColor transfer function (piecewise linear L, linear C) is simple enough to express entirely in CSS `calc()` + `clamp()`. CSS `oklch()` natively accepts `calc()` expressions for L, C, and h. This eliminates the runtime CSS injection dance entirely for the palette layer. The only values requiring JS computation are the chroma caps (gamut boundary search), but those are static constants that rarely change.

**P3 support.** A `@media (color-gamut: p3)` block overrides `--tug-{hue}-peak-c` with wider P3 chroma caps derived from `MAX_P3_CHROMA_FOR_HUE`. All formulas (convenience presets and theme inline formulas) automatically produce richer colors because they reference `peak-c` — no separate P3 definitions needed.

**JS API retained.** The `tugColor(hueName, i, t, canonicalL, peakChroma?)` function remains in `palette-engine.ts` for programmatic use (inline styles, color pickers, data visualization) where CSS custom properties aren't accessible. It uses the same piecewise math as the CSS formulas.

**Theme influence.** Themes define their chromatic semantic tokens using the inline TugColor formula with theme-specific i/t choices. Themes can also override per-hue canonical-l values for contrast adjustments. The five convenience presets are not overridden per-theme — they serve as stable reference colors.

#### Build-Time `--tug-color()` Expansion {#d80-tug-color-postcss}

**[D80] PostCSS plugin expands `--tug-color(hue, i, t)` to `oklch()` at build time; theme files use `--tug-color()` instead of hardcoded hex.**

The inline `calc()`+`clamp()` formula [D70] gives themes full parametric control, but the verbose CSS syntax is unwieldy for the hundreds of achromatic tokens (surfaces, grays, borders, text) in theme files. The `--tug-color()` notation provides a compact, human-readable alternative that expands to concrete `oklch()` values at build time — zero runtime cost.

**Syntax.** `--tug-color(hue, intensity, tone)` where `hue` is a named hue family (e.g., `blue`, `cobalt`) or a raw numeric OKLCH angle, `intensity` is 0–100, and `tone` is 0–100. Examples: `--tug-color(blue, 5, 13)`, `--tug-color(237, 5, 13)`, `--tug-color(cobalt, 3, 18)`.

**PostCSS plugin.** A bespoke PostCSS plugin (`postcss-tug-color.ts`) walks the CSS AST and replaces `--tug-color()` calls with computed `oklch(L C h)` strings using the same piecewise math as `tugColor()`. The plugin is wired into Vite via `css.postcss.plugins` (inline config), coexisting with `@tailwindcss/vite` which operates as a separate Vite plugin. No new third-party PostCSS dependencies — `postcss` itself is promoted from transitive to explicit devDependency.

**Reverse mapper.** `oklchToTugColor()` in `palette-engine.ts` inverts the TugColor math: given an `oklch()` string, it finds the closest named hue family and recovers intensity/tone parameters. This enables programmatic hex-to-TugColor derivation for the one-time theme conversion and is independently useful for developer tooling. `tugColorPretty()` formats the result as a human-readable string (e.g., `"blue i=5 t=13"`).

**Theme conversion.** All hardcoded hex values in theme files (tug-tokens.css, bluenote.css, harmony.css) are replaced with `--tug-color()` calls. A one-time conversion script uses `oklchToTugColor()` to programmatically derive TugColor parameters for every hex token. Special case: `#ffffff` maps to `var(--tug-white)`. Values inside `rgba()`, `color-mix()`, and `var()` expressions are preserved unchanged. `tug-palette.css` is not modified — its `var()` formulas for P3 gamut overrides remain as-is.

**Relationship to D70.** The `--tug-color()` notation is syntactic sugar over the same continuous color space defined in [D70]. The PostCSS plugin uses the same constants (`HUE_FAMILIES`, `DEFAULT_CANONICAL_L`, `MAX_CHROMA_FOR_HUE`, `PEAK_C_SCALE`) and the same piecewise L/C formulas. The inline `calc()`+`clamp()` formula remains available for cases where runtime CSS custom property resolution is needed (e.g., P3 overrides via `peak-c`).

#### Machine-Auditable Token Pairings {#d81-machine-auditable-pairings}

**[D81] Token pairings are machine-auditable. Every foreground-on-background rendering relationship is deterministically extractable from CSS alone — either via same-rule `background-color` or via `@tug-renders-on` annotation. `audit-tokens lint` enforces this.**

The Phase 1 audit tool (`audit-tokens.ts`) revealed that 104 of 362 token pairings (29%) were unresolvable using heuristic strategies (ancestor prefix, class-name extension, class-name truncation). Heuristics are fundamentally limited by missing information — they guess which ancestor sets the background, and when they guess wrong, pairings go unresolved or resolve incorrectly.

The fix is two-pronged:

**@tug-renders-on annotation (Rule 16).** Every CSS rule that sets `color`, `fill`, `border-color`, `border` shorthand (containing a color token), directional border shorthands, or `-webkit-text-fill-color` without setting `background-color` in the same rule must carry a `/* @tug-renders-on: --tug-base-{surface} */` annotation. Multi-surface variant: `/* @tug-renders-on: --tug-base-{surface-a}, --tug-base-{surface-b} */`. Rules that set both foreground and background in the same rule are self-documenting (strategy 1 / same-rule match) and need no annotation. The annotation parser reads comments before the comment-stripping step, associates each annotation with the immediately following CSS rule selector (whitespace-only lines allowed between annotation and selector; intervening comments are not), and returns a `Map<selector, surface[]>`. Annotation-derived pairings flow into `@tug-pairings` blocks via `inject --apply`.

**Alias chain flattening (Rule 17).** Multi-hop alias chains in component CSS `body {}` blocks prevent static resolution of a component token to its `--tug-base-*` target without executing the chain. Every component alias must resolve in one hop. Backward-compat alias layers are exempt if listed in `COMPAT_ALIAS_ALLOWLIST` in `audit-tokens.ts` (currently `--tug-dropdown-*` → `--tug-menu-*`, 14 entries). Cross-component dependency chains (e.g., `--tug-tab-bar-bg` → `--tug-card-title-bar-bg-inactive`) are not compat layers and must be flattened.

**`audit-tokens lint` subcommand.** Enforces four checks with hard exit code 1 on any violation: (1) `MISSING_ANNOTATION` — every fg rule without same-rule bg has an annotation; (2) `MULTI_HOP_ALIAS` — no multi-hop alias chains outside the compat allowlist; (3) `MISSING_PAIRINGS_BLOCK` — every component CSS file has a `@tug-pairings` block; (4) `UNRESOLVED_PAIRING` — zero pairings without a deterministic surface after annotation parsing.

#### Semantic Text Types {#d82-semantic-text-types}

**[D82] Four semantic text types govern element plane hue selection and contrast role assignment.**

All text tokens are classified into exactly one of four semantic types. The type determines both the element plane hue slot used when generating the token's color and the contrast role assigned in the pairing map.

| Type | Purpose | Examples | Element hue slot | Contrast role |
|------|---------|---------|------------------|---------------|
| `content` | Prose, body text, descriptions | Card body, paragraphs, list items | `element.content` | `content` (75) |
| `control` | Interactive element labels | Button text, menu items, tab labels | `element.control` | `control` (60) |
| `display` | Titles, headers, emphasis | Card titles, section headers, hero text | `element.display` | `display` (60) |
| `informational` | Status, metadata, secondary | Badges, timestamps, placeholders, muted text | `element.informational` | `informational` (60) |

The four types map cleanly to the Phase 3.5A naming convention component axis (`global`, `control`, `cardTitle`, `badge`). The current system uses a single `text` hue for all text tokens, preventing independent color control for different text purposes. The four-type classification makes this control explicit: `element.content` drives prose, `element.control` drives interactive labels, `element.display` drives titles, and `element.informational` drives muted/status text. Each may resolve to a different hue angle, enabling the recipe author to tune the typographic palette per-type without affecting the others.

**Default hue conventions** (baked into `EXAMPLE_RECIPES`, not enforced by the engine):
- `element.content` — primary brand hue (e.g., `"cobalt"` at 250°)
- `element.control` — matches `element.content` by default (same typographic family as prose)
- `element.display` — a subtly warmer hue than `element.content` (e.g., `"indigo"` at 260°, +10° from cobalt) to distinguish titles visually
- `element.informational` — matches `surface.canvas` hue to make metadata recede into the background
- `element.decorative` — near-neutral; structural marks should not compete with semantic content

These conventions are recipe authoring guidelines, not engine constraints. The engine reads each element hue directly from the recipe with no automatic shifting.

#### Contrast Role Vocabulary {#d83-contrast-role-vocabulary}

**[D83] Five contrast roles replace the legacy four-role system. All readable text roles maintain thresholds >= 60.**

| Role | Threshold | Purpose | Replaces |
|------|-----------|---------|---------|
| `content` | 75 | Primary prose text | `body-text` (75) |
| `control` | 60 | Interactive element labels | `large-text` (60) and interactive `ui-component` entries |
| `display` | 60 | Titles, headers | *(new)* |
| `informational` | 60 | Muted/metadata text | `subdued-text` (was 45, raised to 60) and structural `ui-component` entries |
| `decorative` | 15 | Non-text ornamental marks | `decorative` (15, unchanged) |

**Why all text roles at 60+.** Card titles, display headers, and informational text (badges, timestamps, placeholders) must be as legible as body text. Reducing any text threshold below 60 compromises legibility. The `decorative` role (threshold 15) is the only appropriate reduced-contrast role because it covers non-text visual marks where contrast is not a legibility concern.

**`subdued-text` threshold raised from 45 to 60.** The old `subdued-text` role allowed muted/placeholder text at threshold 45. The new `informational` role raises this to 60 — muted text must still be readable. This may require formula tone adjustments for pairings that currently pass at 45 but fail at 60.

**`ui-component` split into `control` and `informational`.** The old `ui-component` role covered heterogeneous elements — interactive icons, field borders, badge text, structural borders, accent fills — under a single low threshold of 30. The new vocabulary resolves this ambiguity by semantic intent: interactive elements (icons on buttons/tabs/menus, field borders, toggle tracks/thumbs, checkbox/radio parts) are reclassified to `control` (60); structural/metadata elements (global borders, badge borders/text, tone fills/icons, accent fills, muted/subtle text) are reclassified to `informational` (60). Both now require 60 — double the old `ui-component` threshold of 30.

**Retired role names.** `body-text`, `subdued-text`, `large-text`, and `ui-component` are removed from the `ContrastRole` type and `CONTRAST_THRESHOLDS` map. No new code may reference them. The pairing map, contrast exceptions, `@tug-pairings` blocks, and all test assertions use only the five roles above.

#### Neutral Ramp and Opacity {#d75-neutral-ramp}

**[D75] TugColor extends to neutrals and alpha via `--tug-neutral-*` and CSS relative color syntax.**

The TugColor system covers chromatic colors. For a complete, coherent color system with no behavioral dropoffs, it extends to neutrals and transparency:

**Neutral ramp.** In OKLCH, gray is chroma=0 at various lightness values — conceptually, any hue at i=0 (the hue angle becomes irrelevant). The TugColor system adds a `neutral` pseudo-hue using the same tone-to-L mapping but with C=0:

```css
/* Neutral ramp using the same 5 convenience preset tone stops: */
--tug-neutral:         oklch(0.555 0 0);  /* t=50 (canonical) */
--tug-neutral-light:   oklch(0.835 0 0);  /* t=85 */
--tug-neutral-dark:    oklch(0.311 0 0);  /* t=20 */
--tug-neutral-intense: oklch(0.555 0 0);  /* same as canonical (no chroma to boost) */
--tug-neutral-muted:   oklch(0.555 0 0);  /* same as canonical (no chroma to reduce) */

/* Named anchors for common grays: */
--tug-black: oklch(0 0 0);
--tug-white: oklch(1 0 0);
```

The neutral tone-to-L mapping uses a fixed canonical L of 0.555 (the minimum allowed by the system). This produces a perceptually uniform gray ramp that behaves identically to chromatic hues — surface tokens, foreground tokens, and border tokens can all reference neutral presets using the same `var()` pattern.

**Opacity / alpha.** For semi-transparent variants of any palette color, CSS provides two composable mechanisms (both supported in WKWebView):

```css
/* Relative color syntax — derive alpha from any palette variable: */
color: oklch(from var(--tug-orange) l c h / 0.5);

/* color-mix — blend with transparent: */
background: color-mix(in oklch, var(--tug-orange) 50%, transparent);
```

No precomputed alpha variants are needed. The palette system produces opaque colors; transparency is applied at the point of use via standard CSS composition. This keeps the palette layer clean while giving consumers full control.

#### Three-Layer Token Architecture {#d71-token-naming}

**[D71] `--tug-{hue}[-preset]` / `--tug-base-*` / `--tug-<component>-*` replace `--tways-*`/`--td-*`.**

- **Layer 0 (TugColor palette)**: A continuous color space (24 hues × 100 i × 100 t) expressed in pure CSS using `oklch()` + `calc()` + `clamp()`. Per-hue constants: `--tug-{hue}-h/canonical-l/peak-c`. Five convenience presets per hue (canonical, light, dark, intense, muted) with fixed i/t. Arbitrary colors via the inline formula with literal i/t numbers. Includes `--tug-neutral-*` achromatic ramp and `--tug-black`/`--tug-white` anchors [D75]. ~200 CSS variables in a static file — no JS injection. P3 overrides via `@media (color-gamut: p3)` block overriding `peak-c` constants. Themes write chromatic semantic tokens using the inline formula with theme-specific i/t choices.
- **Layer 1 (`--tug-base-*`)**: Canonical semantics. The stable, readable contract. All component styling resolves from this layer. Chromatic tokens wire to TugColor presets (e.g., `--tug-base-accent-default: var(--tug-orange)`). Achromatic tokens (surfaces, foreground, borders) wire to `--tug-neutral-*` or remain literal values where no palette mapping applies.
- **Layer 2 (`--tug-<component>-*`)**: Component/pattern bindings. Named per component (e.g., `--tug-button-*`, `--tug-card-*`), where `base` is the special root-level component name used in Layer 1. Exist only when base semantics are too generic. Must resolve from `--tug-base-*`.

The grammar is: `--tug-base-<domain>-<role>[-<emphasis>][-<state>]` for semantics, `--tug-<component>-<role>[-<state>]` for component tokens. The `--tug-comp-*` prefix is banned — it adds nothing and is confusingly similar to CSS "computed" style.

All legacy prefixes (`--td-*`, `--tways-*`) and aliases (`--background`, `--foreground`, `--primary`, `--destructive`, etc.) are removed after migration. Temporary shims bridge the transition.

#### Global Scale {#d72-global-scale}

**[D72] `--tug-zoom` controls UI density via CSS `zoom`.** A single `--tug-zoom: 1` CSS custom property on `:root` drives `zoom: var(--tug-zoom)` on `<body>`. This scales the entire UI — layout boxes, text, spacing, radii, icons, everything — with one number.

```css
:root { --tug-zoom: 1; }
body  { zoom: var(--tug-zoom); }
```

Setting `--tug-zoom: 1.25` makes the entire UI 25% larger. Setting `--tug-zoom: 0.85` produces compact mode. This is a major accessibility win. Unlike `transform: scale()`, CSS `zoom` affects layout boxes, so scaled elements occupy their correct space without overlaps or gaps.

No per-token `calc()` wiring is needed. Zoom scales all rendered content uniformly — Tailwind utility classes, hardcoded pixel values, inline styles, and token-driven dimensions all scale together. This eliminates the need to rewrite every dimension through `calc(<base> * var(--tug-zoom))`.

**Component-level scale.** Each `Tug*` component family can optionally set `zoom: var(--tug-<component>-zoom, 1)` on its root element for fine-tuning relative proportions. Zoom composes multiplicatively — a component with `zoom: 0.9` inside a body with `zoom: 1.25` renders at effective zoom `1.125`.

**What scales:** Everything rendered — font sizes, spacing, radii, icon sizes, stroke widths, component dimensions. **What doesn't scale:** Color, opacity, z-index, timing (that is the timing system's job).

#### Global Timing {#d73-global-timing}

**[D73] `--tug-timing` multiplies all durations; `--tug-motion` toggles motion.**

Two separate controls:

- `--tug-timing: 1` (default) multiplies all animation/transition durations. Set to `5` for slow-motion debugging. Set to `0.5` for snappy mode.
- `--tug-motion: 1` (default) toggles motion on/off. Set to `0` by `prefers-reduced-motion: reduce` media query, or manually. When `0`, a `data-tug-motion="off"` attribute on `<body>` triggers a global CSS rule that zeroes all animation/transition durations.

These are categorically different: "slow motion for debugging" is not the same as "no motion for accessibility."

All duration tokens include the timing multiplier:

```css
--tug-base-motion-duration-fast: calc(100ms * var(--tug-timing));
--tug-base-motion-duration-moderate: calc(200ms * var(--tug-timing));
```

Easing curves are not affected by timing — they describe motion shape, not duration.

**No per-component timing.** Unlike scale (where different components may need different densities), all motion in the system should feel unified. Unique durations are named tokens in `--tug-base-motion-*`, not component multipliers.

#### Dev Cascade Inspector {#d74-cascade-inspector}

**[D74] `Ctrl+Option + hover` shows token resolution chain.** Dev-mode only. Hovering any component shows a floating overlay with:

- Component identity and DOM path.
- Selected computed properties (background, foreground, border, shadow, radius, typography).
- Full resolution chain: `--tug-<component>-*` → `--tug-base-*` → `--tug-{hue}[-preset]`.
- For TugColor palette colors: hue family name, preset name, and TugColor coordinates (i/t/L).
- Current `--tug-zoom` and `--tug-timing` multiplier effects.
- Pin/unpin support. Escape closes.

Built on the existing inspector architecture: `StyleCascadeReader`, mutation transactions, property store, responder chain.

---

## Dependency Map

```
                    ┌──────────────────────┐
                    │  1. Theme Architecture│
                    │  (loadable resources) │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  2. Tugways Design   │
                    │  System Definition   │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
   ┌──────────▼──────┐  ┌──────▼──────┐  ┌──────▼──────────┐
   │ 4. Responder    │  │ 5. Mutation │  │ 3. TugButton    │
   │    Chain        │  │    Model    │  │    (test case)  │
   └──────────┬──────┘  └─────┬───────┘  └─────────────────┘
              │               │
              └───────┬───────┘
                      │
           ┌──────────▼───────────┐
           │  6. Tugcard Base     │
           │  Component           │
           └──────────┬───────────┘
                      │
        ┌─────────────┼─────────────┬─────────────┐
        │             │             │             │
   ┌────▼────┐  ┌─────▼─────┐  ┌───▼───┐  ┌─────▼─────┐
   │ 7. Feed │  │ 8. Motion │  │ 9. Di-│  │10. Title  │
   │ Abstrac.│  │ & Visual  │  │ alogs │  │    Bar    │
   └─────────┘  │ Continuity│  └───────┘  └───────────┘
                └───────────┘

   ┌─────────┐  ┌───────────┐  ┌─────────────┐
   │11. Dock │  │12. Card   │  │14. Selection│
   │ Redesign│  │    Tabs   │  │    Model    │
   └─────────┘  └───────────┘  └─────────────┘

   ┌─────────────┐  ┌───────────┐  ┌─────────────┐
   │13. Card Snap│  │15. Key-   │  │16. Brio     │
   │    Sets     │  │  bindings │  │  Revision   │
   └─────────────┘  └───────────┘  └─────────────┘

   ┌─────────────────┐       ┌─────────────────────┐
   │17. Tugbank       │──────▶│18. Inactive State   │
   │ (defaults store) │       │    Preservation     │
   └─────────────────┘       └─────────────────────┘

   ┌─────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
   │19. Target/Action │─▶│20. Mutation          │─▶│21. Observable       │
   │ Control Model    │  │    Transactions      │  │    Properties       │
   └─────────────────┘  └─────────────────────┘  └─────────────────────┘

   ┌──────────────────────────┐
   │22. Theme Token Overhaul  │◀── (Concepts 1, 2, 20, 21)
   │ (palette, scale, timing) │
   └──────────────────────────┘
```

Concepts 12 (Card Tabs) depends on concept 6 (Tugcard). Concept 13 (Card Snap Sets) is
independent — it modifies the geometric engine's activation, not the design system stack.
Concept 14 (Selection Model) depends on concepts 4 (Responder Chain), 5 (Mutation Model),
and 6 (Tugcard) — the selection guard uses appearance-zone mutation patterns, integrates with
the responder chain for `selectAll`/`copy`/`cut` actions, and is wired into Tugcard via a hook.
Concepts 15–16 can proceed independently once the core stack (1-6) is designed.
Concept 17 (Tugbank) is infrastructure — it depends on the tugcast backend but not on the
frontend design system stack. Concept 18 (Inactive State Preservation) depends on concepts 6
(Tugcard), 12 (Card Tabs), 14 (Selection Model), and 17 (Tugbank) — it uses the selection
guard's save/restore API, extends Tugcard with lifecycle hooks, and persists state via tugbank.
Concept 19 (Target/Action) depends on concept 4 (Responder Chain) — it extends the dispatch
mechanism with ActionEvent payloads and phases. Concept 20 (Mutation Transactions) depends on
concepts 5 (Mutation Model) and 19 (Target/Action) — transactions map to action phases and
operate within the appearance zone. Concept 21 (Observable Properties) depends on concepts 19
(Target/Action) and 20 (Mutation Transactions) — property stores use transactions for live
preview and actions for write coordination. Concept 22 (Theme Token Overhaul) depends on
concepts 1 (Theme Architecture) and 2 (Tugways Design System) for the foundation it replaces,
and concepts 20 (Mutation Transactions) and 21 (Observable Properties) for the cascade
inspector's integration with the style introspection infrastructure.

---

## Discussion Log

*This section will capture key decisions, alternatives considered, and rationale as we work through the concept areas above.*

### Entry 1: Project Kickoff {#log-1} (2026-03-01)

Opened with the full feature list above. Identified 13 concept areas (later expanded to 14) that need design work before implementation. The core architectural challenge is the responder chain + mutation model (concepts 4-5), which determines how everything else gets wired together. The theme architecture (concept 1) is the stated starting point, but it pulls in the component system (concepts 2-3) and the card abstraction (concept 6) because theme changes must flow through all of those layers.

### Entry 2: Theme Architecture — Initial Design {#log-2} (2026-03-01)

Worked through all six original questions for concept 1. Initially proposed JSON as the theme format with direct property injection via `style.setProperty()`. Identified three open items: complex CSS tokens (shadows, gradients) that don't fit cleanly in flat JSON; per-theme semantic overrides (`--td-header-active`, `--td-canvas`); and the Harmony canvas color special case.

### Entry 3: Theme Architecture — Format Revised to CSS {#log-3} (2026-03-01)

The three open items from entry 2 exposed a flaw in the JSON recommendation. Complex CSS values (multi-part shadows, gradients) are native CSS — putting them in JSON means round-tripping CSS through JSON for no benefit. Revised to **CSS as the theme format**: a theme file is a CSS file with `body { --tways-*: ... }` declarations plus a structured comment header for metadata.

Additional decisions in this revision:

- **Prefix rename: `--tl-` → `--tways-`.** The old "tuglook" prefix is renamed to avoid any potential conflict with Tailwind's `--tw-` prefix. Four letters is fine — clarity beats brevity.
- **CSS format resolves the complex token problem.** Shadows, gradients, and any other complex CSS values work natively. No escaping, no special cases.
- **Optional palette entries resolve the semantic override problem.** Tokens like `canvas`, `header-active`, `header-inactive` become optional `--tways-*` entries. The semantic tier derives them from other palette values by default using `var()` with fallback (e.g., `--td-canvas: var(--tways-canvas, var(--tways-bg))`). Themes that want to diverge just specify the value; themes that don't, omit it.
- **Canvas color: no special mechanism.** Harmony just specifies `--tways-canvas` in its theme file. The semantic tier uses it if present, falls back to `--tways-bg` if not. Same pattern for all optional overrides.
- **Stylesheet injection replaces both body classes and property injection.** Load theme CSS, inject as `<style>` element. Remove it to revert to Brio. Simpler than iterating keys.

Next: move to concept 2 (Tugways design system definition).

### Entry 4: Tugways Design System Designed {#log-4} (2026-03-01)

Worked through all four questions for concept 2. Key decisions:

- **Tug wrappers are substantial.** Not cosmetic — they encapsulate subtypes (push, icon, icon+text, three-state for buttons), additional states (disabled, loading, active), semantic color mapping, theme-awareness, and responder chain integration.
- **Strong opinions.** Radix provides unstyled accessible primitives. Tugways components define their own variants that cover the actual needs of the app.
- **Three component kinds:** wrappers (Radix primitive + opinions), compositions (multiple Radix primitives → higher-level), and originals (no Radix equivalent).
- **File organization:** `components/tugways/` is the public API. App code imports from `tugways/` only.
- **Don't reinvent — customize.** Radix provides accessible primitives; tugways wraps them directly, adding opinions, subtypes, and conventions on top.

Open items resolved in follow-up: priority list of 15 components after TugButton; single-component-with-subtype-prop as default naming (break out on a case-by-case basis); the `tugways/` directory itself is the inventory — no manifest.

Next: concept 3 (TugButton test case).

### Entry 5: Responder Chain Drafted {#log-5} (2026-03-01)

Skipped concept 3 (TugButton) to design concept 4 (Responder Chain) first — TugButton's behavior depends on how the chain works. Researched Apple's NSResponder/UIResponder chain in depth. Key design decisions:

- **Chain structure:** focused tugways component → card content → TugCard → DeckCanvas → TugApp. Each level corresponds to a real architectural boundary.
- **Four-stage key processing pipeline** (adapted from Apple): global shortcuts (top-down, pre-chain) → keyboard navigation (system-level) → action dispatch via chain (bottom-up) → text input (first responder only). Stages have clear priority ordering.
- **First responder = focused card.** One at a time. Key events and nil-targeted actions start from the focused card's deepest registered responder.
- **Modal boundaries constrain the chain.** App-modal confines to dialog chain. Card-modal confines within card. No per-component modal logic.
- **Action validation** — chain is queried lazily ("can anyone handle `find`?") to enable/disable dock buttons and menu items.
- **Operates outside React state.** The chain is an imperative system: stable manager object provided via context (reference never changes, no re-renders), components register via `useResponder` hook using refs, action dispatch is function calls. This is the key to avoiding React state cascades.

Open questions resolved in follow-up: `useResponder` finds parent via nested context; mouse events excluded (hit-testing only, per Apple's model); the responder chain IS the focus model (deck-manager informs it, doesn't compete with it); action vocabulary designed from Apple's standard actions, filtered to tugdeck needs (~25 standard actions across 8 categories, plus extensibility for card-specific actions).

Remaining open items resolved: keybinding map deferred to concept 14 (chain only knows actions, not keys); action validation adopts Apple's two-level model (`canHandle` for capability, `validateAction` for enabled state) — decades of battle-tested usage.

Concept 4 is fully designed. No open items.

### Entry 7: Concept 5 Deepened {#log-7} — Specific Machinery (2026-03-01)

Requested more specifics on the exact mechanisms for the three-zone model. Researched `useSyncExternalStore` gotchas, CSS custom property patterns, refs best practices, signals landscape, React Compiler v1.0, common anti-patterns, and real-world precedents (Excalidraw, Dockview, Figma).

Key additions to concept 5:

- **DOM utility hooks** (`useCSSVar`, `useDOMClass`, `useDOMStyle`): a small set of hooks that make appearance-zone mutations ergonomic. These are the sanctioned way to change how something looks without React state. For high-frequency updates (drag, resize), bypass even these — use `requestAnimationFrame` + refs directly, sync to React state only on gesture completion.
- **`useSyncExternalStore` gotchas codified**: snapshot reference instability (must return same reference if data unchanged), subscribe function identity (must be stable, defined outside component), and selective subscription (use `useSyncExternalStoreWithSelector` or per-feed listener sets).
- **Store decision: start raw, adopt library if needed.** Raw `useSyncExternalStore` is sufficient for feed data. Jotai's atomic model is the fallback if complexity grows.
- **Five structure-zone rules codified**: state at lowest common ancestor; split contexts by domain; never derive state in effects; never define components inside components; avoid inline object creation in JSX props.
- **React Compiler v1.0**: removes need for manual `useMemo`/`useCallback`/`memo`, but doesn't solve state placement, context instability, or the appearance-zone problem. Safety net, not substitute.
- **Excalidraw as architectural precedent**: React for UI chrome, imperative canvas for rendering, Scene class as mutable source of truth, Jotai for UI state, action system for user input mediation. Directly parallel to tugdeck's architecture.

### Entry 8: Excalidraw Deep Study {#log-8} (2026-03-01)

Conducted a thorough architectural study of Excalidraw (MIT, open source). Key findings for tugdeck:

**Adopt:** Their action system (unifies keyboard, toolbar, context menu, command palette into one `Action` interface with `perform`/`keyTest`/`predicate` — maps directly to our responder chain actions). CSS variables for theming. AppState subset types as render firewalls. 8 separate contexts instead of 1. Imperative for high-frequency, React for structure.

**Adapt:** The giant 395KB class component centralizes state but is a lock-in — we use functional components with the responder chain for coordination instead. Scene class as mutable source of truth — we use `useSyncExternalStore` for the same subscription pattern. In-place mutation for hot paths + immutable copies for history.

**Avoid:** Focus management between imperative and React surfaces is fragile (deferred blur hacks, `setTimeout(0)`). State subset discipline is essential — every field must go in the right subset. Don't underutilize your external store library — be intentional from the start about what goes where.

The action system is the pattern most directly applicable to our responder chain design. Excalidraw's `perform`/`keyTest`/`predicate`/`PanelComponent` maps to our `actions`/keybinding map/`canHandle`+`validateAction`/tugways component.

### Entry 6: Controlled Mutation vs. React State Designed {#log-6} (2026-03-01)

The fear: we're fighting an opinionated framework. The realization: we're not fighting it — we're scoping it. React is good at rendering UI from data. The DOM and CSS are good at visual state. The mistake is putting visual state in React state.

The design distills to a **three-zone model**:

1. **Appearance zone** (theme, focus, animations, layout, scroll) — CSS variables, CSS classes, DOM style manipulation. **Zero re-renders.** This is the biggest win: the entire category of changes that causes cascade re-renders in typical React apps never touches React at all.
2. **Local data zone** (feed data, form values, component-internal state) — React state local to the component that displays it, or `useSyncExternalStore` for external data with selective subscriptions. **Targeted re-renders** — only the affected component.
3. **Structure zone** (show/hide sections, mount/unmount cards, open/close modals) — React state at the appropriate ancestor level. **Subtree re-renders** — this is what React is designed for.

The three-zone model makes the answer to "should I use React state?" mechanical, not a judgment call. Each change maps to exactly one zone based on what it affects. The existing systems (theme/concept 1, responder chain/concept 4, deck-manager layout engine) are all already in the appearance zone — operating outside React state by design.

`useSyncExternalStore` is the key React-sanctioned pattern for the local data zone: external mutable stores with selective subscriptions. Feed data, responder chain validation, connection status — all fit this pattern. Each consumer subscribes to its slice. Only affected components re-render.

No open items.

### Entry 9: Tugcard Base Component Designed {#log-9} (2026-03-01)

Designed concept 6 after studying all 8 existing card implementations, the CardFrame/CardHeader chrome, CardContext, ReactCardAdapter, and DeckCanvas rendering hub.

Key decisions:

- **Composition pattern.** Tugcard is a wrapper component, not a base class. Card authors compose their content into `<Tugcard>` as children.
- **Hooks for data, not render props.** The Excalidraw study confirmed hooks over render props. Tugcard gates the child mount — children only render after feed data arrives, so `useTugcardData()` always returns populated data, never null. Feedless cards (`feedIds={[]}`) mount immediately; `useTugcardData()` returns null but those cards never call it.
- **CardFrame stays.** It handles positioning, sizing, drag, resize, z-index. Tugcard lives inside CardFrame and handles chrome, responder chain, feed, loading/error, accessories. Clean separation — neither knows about the other's domain.
- **Dynamic min-size.** Header + accessories + child's declared `minContentSize`. Recalculates when accessories appear/disappear. CardFrame reads Tugcard's computed minimum instead of its hardcoded `MIN_SIZE_PX = 100`.
- **One accessory slot.** Top, between header and content area. Find-in-text is the first use case. Collapses to zero height when null.
- **Tugcard is a responder node.** Handles standard card actions (close, minimize, toggleMenu, find). Delegates card-specific actions to the child's responder.
- **Loading and error handled by Tugcard.** Skeleton until first feed frame; error boundary wraps child. Card authors get both for free.
- **Clean cutover migration.** All 8 existing cards are sketches. Migrate all at once, eliminate `ReactCardAdapter`, `CardContextProvider`, `useCardMeta`, and per-card `useFeed` + decode boilerplate in a single pass.

No open items.

### Entry 10: Feed Abstraction Reframed {#log-10} + UI-Flash Prevention Added (2026-03-01)

**Concept 7 rewritten three times.** First pass: thin summary of tug-feed.md, "see the other doc." Second pass: proper frontend rendering story with event-to-visual mapping, mutation zone assignment, and transport options. Third pass incorporated critical corrections:

- **Transport: tugcast, not a new server.** The second pass proposed `tugcode feed serve` or a "separate WebSocket/SSE channel" — both nonsensical given that tugcast already exists as the single WebSocket server bridging all feeds to tugdeck. Tugcast's binary framing protocol, authentication, heartbeat, reconnection, and per-client state management are all in place. The tug-feed is just another `FeedId` (`0x50`) registered in the protocol, with a `StreamFeed` implementation that tails `feed.jsonl`. Fixed in both `design-system-concepts.md` and `tug-feed.md` (Phase 4 rewritten to reference tugcast).
- **Three accumulation patterns identified.** Snapshot (latest value wins — Git, Stats), append-stream (events accumulate — Files, Conversation, feed-progress), and raw stream (pass-through — Terminal). Accumulation is card-specific, but two helpers support the append-stream pattern: `useFeedBuffer` (capped ring buffer for simple cases) and `useFeedStore` (external mutable store with structured indexing for complex cases like the feed-progress card).
- **Per-card data feeds: Tugcard is sufficient.** Reviewed all 8 existing cards through Tugcard's `feedIds`/`decode`/`useTugcardData()` lens. Every card type is covered — no additional `TugFeed` abstraction needed.
- **Interface-first implementation.** Define TypeScript types for the 13 event types, implement the frontend card with mock data, bring the backend online later.

**Concept 14 added: UI-Flash Prevention.** Three scenarios cause visual flash (CSS edit, frontend reload, backend restart). Root cause analysis and three-layer fix detailed in `dash/eliminate-frontend-flash.md`. Layers: inline body styles (eliminate white flash), startup overlay (hide mount transition), CSS HMR boundary (prevent full reloads for CSS changes). Concept 14 is nearly independent of the core stack — it's infrastructure-level work that can be implemented at any time. The only connection to the design system is that Layer C (HMR boundary) affects how base CSS changes propagate during development; runtime theme injection (concept 1) bypasses the Vite module graph entirely.

### Entry 11: TugButton Designed — Composition Model {#log-11} (2026-03-02)

Designed concept 3 after a key clarification: the "never define components inside components" rule from concept 5 was causing confusion about how buttons (which are always children of larger compositions) could work. The clarification: `define` ≠ `use`. Components are standalone module-scope definitions. You compose them by importing and nesting JSX — the fundamental React pattern.

Key decisions:

- **[D07] Module-scope components, compose via JSX nesting.** Every component is defined at module scope (in its own file). No component functions defined inside other component functions. Composition happens through JSX nesting — `<ThemeSection>` renders `<TugButton>` elements, `<SettingsContent>` renders `<ThemeSection>`, `<Tugcard>` renders `<SettingsContent>`. The containment hierarchy is just nested imports.
- **[D08] Two button modes: direct-action and chain-action.** Direct-action buttons have an `onClick` handler — no responder chain involvement. Chain-action buttons have an `action` prop — they dispatch into the responder chain and auto-validate via `canHandle`/`validateAction`. Most buttons are direct-action; chain-action is for toolbar and menu scenarios.
- **Three ambient connection mechanisms.** Components connect to the system through (1) CSS custom properties for theme, (2) React context for the responder chain, (3) props and callbacks for data. No tight coupling between layers. TugButton doesn't know it's inside a Tugcard.
- **Mutation zone assignment explicit for TugButton** — appearance (CSS pseudo-classes for hover/focus/active, theme colors from `var(--td-*)`), local data (chain validation via `useSyncExternalStore`), structure (conditional rendering by parent). This pattern will be documented for every tugways component.
- **TugButton API designed** — subtypes (push, icon, icon-text, three-state), variants (primary, secondary, ghost, destructive), chain-action mode, loading state. Wraps Radix primitives internally but exposes a restricted, opinionated API.
- **Pattern established for all tugways components** — module-scope definition, wraps Radix primitives internally, theme via CSS variables, responder chain via context, mutation zones documented, subtypes via prop.

No open items. Concept 3 is fully designed.

### Entry 12: Concept 8 Unified — Motion and Visual Continuity {#log-12} (2026-03-02)

Merged three previously separate concerns — skeleton/loading states (old concept 8), UI-flash prevention (old concept 14), and a new transitions/animations story — into a single unified concept. The unifying insight: these are all aspects of **how tugdeck manages visual state changes over time.**

Researched motion systems across Material Design 3, Carbon (IBM), Norton DS, Cloudscape (AWS), Apple HIG, and Radix. Key findings that shaped the design:

- **MD3 and Carbon publish motion tokens as structured values** (duration tiers, easing curves by behavior type). We adopted this as CSS custom properties following our `--td-*` convention.
- **Norton DS's duration scalar pattern** — a single `--td-duration-scalar` multiplier that zeros out all durations for `prefers-reduced-motion`. Elegant: one variable swap, all motion stops. We use `0.001` instead of `0` so Radix's `animationend` events still fire.
- **Radix's `data-state` + CSS `@keyframes`** is used directly. Standard component transitions use this pattern. Critical constraint: Radix's Presence component listens for `animationend`, not `transitionend` — exit animations must use `@keyframes`. (Note: Entry 32 later introduced TugAnimator for programmatic animations beyond simple Radix transitions.)
- **Apple's "replace, don't remove" principle** for reduced motion — spatial animations become opacity fades, not nothing.

Key decisions:
- **[D23] Motion tokens as CSS custom properties.** Four durations (fast/moderate/slow/glacial) and three easings (standard/enter/exit). Intentionally minimal — tugdeck is a dev tool, not a consumer app.
- **[D24] Reduced motion via scalar, not removal.** `calc(var(--td-duration-scalar) * var(--td-duration-*))` pattern. Spatial animations replaced with opacity fades when scalar is active.
- **Skeleton shimmer uses `background-attachment: fixed`** so all skeleton elements shimmer in unison across the viewport.
- **Skeleton → content crossfade** is an appearance-zone animation (CSS class swap, opacity transition). No React state for the animation itself.
- **Old concept 14 absorbed** — the three-layer startup continuity approach (inline body styles, startup overlay, CSS HMR boundary) is now a subsection of concept 8 rather than a standalone concept.

Concept count reduced from 14 to 13. No open items in concept 8.

### Entry 13: Concept 9 Designed — Alert and Dialog System {#log-13} (2026-03-02)

Designed concept 9 after researching Apple's AppKit/UIKit modal APIs in depth. The core challenge: AppKit's `runModal(for:)` blocks the calling code via a nested run loop. JavaScript can't do this. The solution: block the *responder chain*, not the thread.

Researched `NSApplication.runModal(for:)`, `NSWindow.beginSheet()`, `NSAlert` (styles, buttons, presentation modes), `UIAlertController` (action styles, preferred action), `NSPopover`, SwiftUI `confirmationDialog`, Radix Dialog/AlertDialog/Popover, the native `<dialog>` element with `showModal()`, the `inert` attribute, and Sonner for toasts.

Key decisions:

- **[D25] Four modal categories.** TugAlert (app-modal, chain blocked), TugSheet (card-modal, card node suspended), TugConfirmPopover (button-local, no chain impact), TugToast (non-blocking, no chain impact). Each maps to a specific Apple mechanism.
- **[D26] Button-confirmation is a popover, not a sheet or alert.** The user specified: "a simple popup graphically tied to a button that compels the user to move their mouse and click again." This is lighter than a card-modal sheet — no chain suspension, no focus trapping, no backdrop dimming. Snappy micro-interaction.
- **Imperative API for alerts and sheets.** `tugAlert()` and `tugSheet()` return Promises, inspired by `NSAlert.runModal()` returning `ModalResponse`. The imperative API wraps declarative React components (host pattern: `TugAlertHost` at app root, `TugSheetHost` inside each Tugcard).
- **Radix AlertDialog for app-modal** (prevents overlay-click dismissal), **scoped Dialog for card-modal** (portal targets card container, manual `inert` scoping), **Radix Popover for button confirmation** (anchored, collision-aware, transient dismiss).
- **Button roles from `UIAlertAction.Style`**: destructive (red, never default), cancel (bold, responds to Enter/Escape), default (standard). When destructive is present, cancel is always the default — matching Apple HIG.
- **Sonner for toasts** — live region accessibility, never steals focus, theme-aware via `--td-*` tokens.

Card-modal scoping (TugSheet) is the most complex implementation: Radix doesn't support subtree-scoped modality natively. We diverge from Radix defaults here, applying `inert` to the card's content area only and rendering the portal inside the card container. This is justified because cards are independent workspaces — blocking the entire app for a card-level concern violates the model.

No open items. Concept 9 is fully designed.

### Entry 14: Concept 10 Designed — Card Title Bar Enhancements {#log-14} (2026-03-02)

Three small, well-scoped changes with straightforward designs. Read the existing `card-header.tsx` and `card-frame.tsx` to confirm the plumbing is already in place — `showCollapse`, `onCollapse`, `collapsible` all exist but are currently inactive.

Key decisions:

- **[D27] Window-shade collapse to title bar.** Content hidden via CSS (`overflow: hidden`, height transition to 0), not unmounted. Card internal state (terminal session, scroll position, form values) preserved. `collapsed: boolean` added to `CardState` for persistence. Chevron icon (ChevronDown/ChevronUp) replaces the ambiguous Minus icon. Double-click on header as secondary gesture.
- **Close confirmation uses TugConfirmPopover** from concept 9 — first real consumer of the button-confirmation pattern. Always-confirm for now; can differentiate by unsaved-state later.
- **Menu icon: `EllipsisVertical` → `Ellipsis`** — one-line import change. Horizontal three-dot is more standard on web.

Collapse animation uses concept 8's motion tokens (`--td-duration-moderate`, `--td-easing-standard`). Title bar button order confirmed: [menu] [collapse] [close] — already correct in existing code.

No open items. Concept 10 is fully designed.

### Entry 15: Concept 11 Designed — Dock Redesign {#log-15} (2026-03-02)

Read the existing `dock.tsx` to understand the current structure. The dock is already well-structured — six card toggle buttons, a settings dropdown (which is already a popout menu), a spacer, and a logo. The redesign formalizes what's there and adds flexibility.

Key decisions:

- **[D28] Three button types: card toggle, command, popout menu.** Same 32×32 visual treatment, different click behavior. Declared in a config array, not hardcoded. Command buttons are for future test-case triggers.
- **[D29] Dock placement on any edge.** Right (default), left, top, bottom. Canvas inset adjusts. Menu direction and tooltip side auto-flip based on placement. Flexbox direction switches between `flex-col` (vertical) and `flex-row` (horizontal).
- **Dock is not a responder.** Never participates in the chain. No `useResponder`, no action validation. Pure direct-interaction chrome. Triggers chain-affecting actions indirectly (e.g., card toggle changes first responder).
- **Tooltips on every button.** Radix Tooltip already in project. `delayDuration={400}`, `skipDelayDuration={100}`. Side opposite dock edge.
- **Commands stay in settings dropdown.** Reset layout, restart server, reload frontend remain where they are. No dedicated dock buttons for these.

No open items. Concept 11 is fully designed.

### Entry 16: Concepts 12-13 Designed — Card Tabs and Snap Sets {#log-12} (2026-03-02)

Two missing concepts identified and designed:

**Concept 12: Card Tabs.** The data model (`TabItem`, `CardState.tabs`, `CardState.activeTabId`) already exists in `layout-tree.ts` and a `tab-bar.tsx` already renders tabs — but both are entangled with the old `ReactCardAdapter`/`TugCard` infrastructure demolished in Phase 0. The redesign makes tabs a Tugcard composition feature:

- **[D30] Tab bar hidden for single-tab cards.** Most cards are single-tab. The tab bar only appears when `tabs.length > 1`. No visual overhead in the common case.
- **[D31] Tabs are a Tugcard feature, not a CardFrame feature.** Tugcard manages tab state, renders the tab bar, and switches content. CardFrame is unaware — it wraps one Tugcard that internally manages however many tabs it has.
- **Responder chain follows active tab.** Tab switching is automatic via mount/unmount — old tab's content responder deregisters, new tab's content responder registers.
- **Same-type and mixed-type tabs supported.** Two terminals in one frame, or a terminal + code card sharing a frame. Each tab is a `TabItem` with its own `componentId`.

**Concept 13: Card Snap Sets.** The geometric engine (`snap.ts`) is solid. The behavioral change: snapping is no longer always-on.

- **[D32] Snap requires Option (Alt) modifier during drag.** Without the modifier: free drag, no guides, no snapping. With the modifier: snap guides appear, cards snap to edges, sets form on drop. The modifier can be pressed/released mid-drag with immediate visual feedback.
- **[D33] Set-move is always active once formed.** Sets are intentional structures — requiring Option for every set-move would be tedious. The modifier is only for *forming* sets.
- **Geometric engine untouched.** The modifier gate lives in `DeckManager`'s drag handler, not in `snap.ts`. Pure geometry library stays pure. (One addition: `computeSnap` gains a border-width offset parameter for [D56].)
- **[D53] Set corners squared.** All set member corners become squared (`border-radius: 0`) via CSS `data-in-set` attribute. Solo cards retain rounded corners. (Simplified from original per-corner design during implementation.)
- **[D54] Set perimeter flash on formation.** `computeSetHullPolygon()` computes the outer boundary; a single SVG path strokes the hull with glow filter. (Replaced original per-card overlay design during implementation.)
- **[D55] Break-out restores corners + flash.** Removing `data-in-set` restores rounded corners via CSS. `flashCardPerimeter()` creates a `.card-flash-overlay` div on the detached card.
- **[D56] Border collapse via snap offset.** Snap positions are offset by the computed border width so adjacent card borders overlap into a single line. No hardcoded pixel values — uses actual computed border width for fractional-pixel correctness.

Deferred concepts renumbered: Keybindings View → 14, Brio Theme Revision → 15. Concept count is now 15.

### Entry 17: Concept 14 Designed — Selection Model {#log-13} (2026-03-03)

Phase 5 implementation revealed a critical selection problem: the browser treats all card content as a single document flow, allowing text selection to span across cards, through title bars, and across the canvas background. Visible in manual testing — dragging from one card's content area into another produces a cross-card selection spanning unrelated content and chrome elements.

Thorough web platform research revealed that the CSS property designed for this (`user-select: contain`) was never implemented in any modern browser (only old IE supported it as `-ms-user-select: element`). Shadow DOM does not prevent selection crossing in WebKit/Safari. iframes provide true isolation but are too heavyweight. CSS `overflow` and `contain` have no effect on selection boundaries.

The viable approach is a three-layer system built on the JavaScript Selection API:

- **[D34] Three-layer selection containment.** CSS `user-select: none` on all non-content areas prevents selection from starting in the wrong place. JavaScript SelectionGuard clips selection at runtime when it tries to escape a card boundary. A `data-td-select` attribute API gives card authors fine-grained control within content areas.
- **[D35] SelectionGuard is a singleton, not React state.** Follows the same imperative pattern as ResponderChainManager. Selection events fire at very high frequency during drag; synchronous handling is essential. Selection containment is purely an appearance-zone concern with zero React re-renders.
- **[D36] Pointer-clamped clipping via caretPositionFromPoint.** During drag selection, when the pointer exits the card boundary, coordinates are clamped to the boundary edge and `document.caretPositionFromPoint()` finds the nearest text position. This produces smooth, continuous containment with no visual flash — the selection never visually escapes the card.
- **[D37] Four select modes.** `data-td-select` attribute with values: default (text), `none` (non-selectable controls), `all` (atomic selection for code blocks), `custom` (embedded component like xterm.js or CodeMirror manages its own selection). The guard respects these modes.
- **[D38] Cmd+A scoped to focused card.** The `selectAll` responder action calls `selectAllChildren` on the focused card's content area. Integrated with existing copy/cut/find actions in the responder chain action vocabulary.

Also designed: theme-aware selection styling via `--td-selection-bg` and `--td-selection-text` tokens, RAF-based autoscroll (required because pointer-clamping breaks native autoscroll), `overscroll-behavior: contain` to prevent scroll chaining, and `saveSelection`/`restoreSelection` methods on SelectionGuard for tab switch persistence (Phase 5b). The `custom` select mode explicitly covers contenteditable regions. Multi-card clipboard coordination is a non-issue — the platform clipboard handles cross-card copy/paste natively.

Deferred concepts renumbered: Keybindings View → 15, Brio Theme Revision → 16. Concept count is now 16.

### Entry 18: Default Button Mechanism {#log-18} (2026-03-02)

Added [D39] to concept 3 (TugButton). The default button pattern draws together TugButton's `primary` variant, the responder chain's stage-2 key pipeline, and the alert/dialog button role system into a cohesive mechanism.

Key decisions:

- **[D39] Default button via responder chain.** A container (alert, sheet, popover) registers one button as the default button via `setDefaultButton(buttonRef)` on the ResponderChainManager. Enter at stage 2 of the key pipeline activates the default button unless a native button or text input has DOM focus. Registration is scoped — app-modal scope takes priority over card-modal scope.
- **`primary` variant = default button visual.** The accent fill (`--td-accent` via `--primary`) communicates which button Enter will activate. This formalizes the existing color mapping: `primary` was already the accent-filled variant, now it has explicit semantic meaning as the default button affordance.
- **Alert button roles updated.** The `"cancel"` and `"default"` roles now explicitly reference D39. When a destructive button is present, Cancel gets `variant="primary"` and becomes the default button (Enter cancels). When no destructive button is present, the affirmative action gets `variant="primary"` and becomes the default button. The `"destructive"` role never becomes the default button.
- **Key pipeline stage 2 updated.** The "Enter (confirm)" entry now references D39 as the formal mechanism.

- **Destructive variant visual fix.** The `destructive` variant must show a bold danger fill (`--td-danger`, deep red) with inverse text (`--td-text-inverse`, white/near-white). The actual fill was not visually distinct. Phase 5d adds explicit `background-color` and `color` rules to `tug-button.css` to ensure destructive buttons are unmistakable across all themes.

No new concepts. D39 is an addition to concept 3 that ties together concepts 3, 4, and 9.

### Entry 19: React 19 Rendering Model and DeckManager Store Migration {#log-19} (2026-03-03)

Phase 5a implementation exposed a fundamental timing bug: the responder chain's `cyclePanel` handler calls `DeckManager.focusCard()` → `root.render()` (async in React 19) → `makeFirstResponder()` (synchronous), creating a race between React's deferred render and the imperative responder chain state. The bug manifests as Ctrl+` cycling failing — the first press deselects the focused card, subsequent presses produce a system beep because `dispatch()` returns false.

Deep investigation into React 19's `createRoot().render()` behavior confirmed: `root.render()` schedules work via `queueMicrotask()` and returns immediately. No components re-render, no effects fire, no DOM updates when the call returns. This is an intentional React 19 design — unlike the old `ReactDOM.render()` which was synchronous.

Study of Excalidraw's architecture (the closest open-source precedent) revealed their solution: **never call `root.render()` from outside React.** Their Scene class is a subscribable store; React reads from it during render. One initial mount, then all updates flow through store subscriptions.

Three new design decisions added to Concept 5:

- **[D40] DeckManager is a subscribable store.** One `root.render()` at construction time. All subsequent state mutations call `notify()` instead of `render()`. DeckCanvas reads deckState via `useSyncExternalStore`. This eliminates the async render gap entirely — `useSyncExternalStore` forces `SyncLane` (synchronous) renders.
- **[D41] `useResponder` uses `useLayoutEffect` for registration.** Responder nodes register during the commit phase (before paint), not in a deferred `useEffect`. Combined with D40's `SyncLane` renders, registration is always complete before the next browser event.
- **[D42] No repeated `root.render()` from external code.** After the initial mount, external code never calls `root.render()`. State changes flow through subscribable stores or direct DOM manipulation (appearance zone).

These decisions formalize what Concept 5 already prescribed: DeckManager operates imperatively, React subscribes to external stores. The implementation had diverged from the design — DeckManager was calling `root.render()` on every mutation instead of notifying subscribers. D40-D42 close that gap.

New phase **5a2: DeckManager Store Migration** added to the implementation strategy between Phase 5a (Selection Model) and Phase 5b (Card Tabs).

### Entry 20: Rules of Tugways {#log-20} (2026-03-03)

Added the "Rules of Tugways" section at the very top of this document (before the Table of Contents). Eight hard invariants distilled from existing design decisions [D01]-[D42], phrased as prohibitions and imperatives that can be mechanically verified during implementation. The rules exist because the D40-D42 investigation revealed that correct design principles in Concept 5 were not followed during implementation — DeckManager diverged from the subscribable store pattern. Short, scannable rules at the top of the document prevent this class of drift. Referenced from CLAUDE.md so AI agents see the critical rules every session.

### Entry 21: Concept 12 Revised — Tab Icons, Type Picker, Phase Split {#log-21} (2026-03-03)

Revised Concept 12 (Card Tabs) with three additions and a phase split:

- **Tab icons**: Each tab displays its card type icon from `TugcardMeta.icon` (already present in the registration interface). The icon appears in the title bar for single-tab cards and in the tab bar for multi-tab cards. Same source: `getRegistration(tab.componentId).defaultMeta.icon`.
- **[+] type picker**: The add-tab button opens a dropdown listing all registered card types (icon + title). Selecting a type adds a new tab of that type, enabling mixed-type tabs through normal UI flow.
- **Mixed-type tabs without restriction**: Strengthened the mixed-type support language. CardFrame is type-agnostic; there is no reason to restrict which card types can share a frame.
- **Phase split**: Implementation split into Phase 5b (click-based: create, switch, close, icons, type picker, active/inactive states) and Phase 5b2 (drag gestures: reorder within bar, detach to new card, merge into existing card). This keeps 5b focused on data flow and component rendering while 5b2 handles pointer-capture and hit-testing mechanics.

### Entry 22: Gallery Card and Tab Overflow — Phases 5b3, 5b4 {#log-22} (2026-03-03)

Post-Phase 5b implementation review led to two new phases:

- **[D43] Component Gallery as a proper card.** The gallery started as an absolute-positioned floating panel (Phase 2). Now that cards and tabs exist, the gallery should dogfood them. Phase 5b3 converts it to a registered card type with five tabs (TugButton, Chain-Action, Mutation Model, TugTabBar, TugDropdown). This eliminates z-index hacks (dropdown portals fought with the panel's z-index:100), gives the gallery proper card lifecycle (persistence, deck membership), and validates the tab system with a real multi-tab card.
- **[D44] Progressive tab overflow.** Phase 5b's tab bar scrolled horizontally on overflow — functional but not ideal. Phase 5b4 adds three-stage progressive collapse: (1) inactive tabs collapse to icon-only, (2) remaining overflow tabs move into a dropdown. The active tab is always visible in the strip. A ResizeObserver drives the collapse measurement. This interacts with Phase 5b2's drag gestures — dragging a tab into an overflowing card triggers re-measurement and may route the new tab to the overflow dropdown.
- **Phase count**: Concept 12 now has four implementation phases (5b, 5b2, 5b3, 5b4). Phase 5b3 depends on Phase 5b (tab system must exist). Phase 5b4 depends on Phase 5b (tab bar component must exist) but not on 5b2 or 5b3.

### Entry 23: Tab Refinements — Phase 5b5 {#log-23} (2026-03-03)

Post-Phase 5b2 implementation review identified a gap in tab composition: single-tab cards cannot be merged into other cards via drag. Phase 5b2 handles tab-to-tab drag gestures (reorder, detach, merge) but requires a tab bar to initiate drag from. Single-tab cards have no tab bar.

- **[D45] Card-as-tab merge.** Dropping a card onto another card's tab bar merges it as a new tab. This uses drop target detection on the existing CardFrame drag path — on pointer up, check if the drop position is over a tab bar. If so, call `mergeTab` instead of completing the card move. Reuses the `data-card-id` hit-test infrastructure from Phase 5b2.
- **Phase 5b5: Tab Refinements.** A collection phase for tab-related refinements discovered during implementation. Card-as-tab merge is the first item. Additional refinements may be added as Phases 5b3 and 5b4 are implemented.
- **Phase count**: Concept 12 now has five implementation phases (5b, 5b2, 5b3, 5b4, 5b5). Phase 5b5 depends on Phase 5b2 (drag coordinator and hit-test infrastructure must exist).

### Entry 24: Tugbank Defaults Store — Concept 17 {#log-24} (2026-03-04)

As the design system matures, the flat JSON blob persistence model (`settings-api.ts` → HTTP POST → flat file) becomes inadequate. Per-tab scroll positions, selections, card content state, collapse flags, and focused card identity all need granular, typed persistence. Rather than bolt increasingly complex state onto the existing flat-file system, we adopt tugbank — a SQLite-backed defaults store modeled after Apple's `UserDefaults`.

- **[D46] Tugbank replaces the settings API** as the backend storage layer. The frontend HTTP interface is preserved (new REST endpoints), but the backend switches from flat file to SQLite with WAL-mode concurrency.
- **[D47] Domain separation** organizes state by concern: `dev.tugtool.deck.layout` for card geometry, `dev.tugtool.deck.tabstate` for per-tab ephemeral state, `dev.tugtool.app` for user preferences. Granular writes mean changing one card's scroll position doesn't re-serialize the entire layout.
- **[D48] HTTP bridge** keeps the frontend decoupled from the Rust crate — tugcast exposes RESTful endpoints that map to tugbank operations.
- **Phase 5e**: Implementation phase, split into four sub-phases: (5e1) `tugbank-core` library crate, (5e2) `tugbank` CLI binary, (5e3) tugcast HTTP bridge integration, (5e4) settings migration. This is infrastructure that Phase 5f (state preservation) builds on.

### Entry 25: Inactive State Preservation — Concept 18 {#log-25} (2026-03-04)

Cards and tabs lose ephemeral state in two scenarios: tab switch (inactive tab unmounts) and app reload (all DOM state lost). The Phase 5a selection guard already saves/restores selections in memory across tab switches, but scroll position is never captured, card content state is unmanaged, and nothing survives app reload.

- **[D49] Per-tab state bag** defines the three categories of state each tab preserves: scroll position (Tugcard-managed, automatic), selection (Tugcard-managed, via SelectionGuard), and card content state (opt-in via hook).
- **[D50] `useTugcardPersistence` hook** gives card content components a clean opt-in API. Card content provides `onSave`/`onRestore` callbacks; Tugcard calls them at the right lifecycle points. The state blob is opaque JSON — card content owns the schema.
- **[D51] Focused card persistence** writes the focused card ID to tugbank. On reload, keyboard focus is restored to the correct card.
- **[D52] Collapsed state** adds `collapsed?: boolean` to `CardState`. The field persists with the layout; the collapse UI is Phase 8a's responsibility.
- **[D77] Inactive selection appearance** dims selections in unfocused cards via the CSS Custom Highlight API (`::highlight(inactive-selection)`), replacing the original `::selection` approach (which cannot style cleared selections). SelectionGuard captures the live Range proactively on `pointerdown` and registers it with `CSS.highlights`. Styled with `--tug-base-selection-bg-inactive` token. Phase 5f2 fixes the original Phase 5f implementation. App deactivation/activation (`deactivateApp`/`activateApp`) extends this to the whole-app level: all selections dim when the app loses focus, the active card's selection restores when the app regains focus.
- **Auto-save**: Each Tugcard installs debounced scroll and selectionchange listeners (1-second debounce) that automatically persist state during normal use. Card content can trigger saves via `useTugcardDirty()` hook. This supplements the tab-switch and app-save paths with continuous incremental persistence.
- **Native app lifecycle**: `applicationShouldTerminate` with `terminateLater` calls `saveAndFlushSync()` (synchronous XHR) to guarantee all state is written before quit. `applicationDidResignActive`/`applicationDidBecomeActive` save state and manage selection highlight dimming.
- **Unified card rendering**: DeckCanvas constructs Tugcard directly for all cards (single-tab and multi-tab). The `contentFactory` field on `CardRegistration` provides card-specific content; the old `factory` + `cloneElement` injection pattern was removed.
- **Monaco forward compatibility**: The `useTugcardPersistence` hook's opaque `content` blob is designed to accommodate rich editor state. Phase 8/9 Monaco integration should use `editor.saveViewState()`/`editor.restoreViewState()` through the hook — no structural changes needed.
- **Phase 5f**: Implementation phase. Depends on Phase 5e (tugbank) for durable storage and Phase 5b (tabs) for the tab state lifecycle. Builds the state bag, persistence hook, scroll/selection capture, collapse field, focused card restoration, inactive selection appearance, auto-save, and native app lifecycle integration.

### Entry 26: Card Snap Set Refinements — Phase 5c2 {#log-26} (2026-03-04)

Phase 5c delivered modifier-gated snapping and set-move. Manual testing revealed four visual refinements needed to make sets feel like unified shapes rather than cards that happen to be adjacent:

- **[D53] Set corners squared at internal seams.** Implementation simplified from the original per-corner design to uniform `border-radius: 0` for all set members via CSS `data-in-set` attribute. Simpler and visually equivalent at 6px radius.
- **[D54] Set perimeter flash — outer hull only.** Implementation diverged from the original per-card overlay design to a single SVG hull polygon trace via `computeSetHullPolygon()` in `snap.ts`. This produces a cleaner single continuous perimeter with no corner artifacts.
- **[D55] Break-out restores corners + flash.** Removing `data-in-set` restores rounded corners via CSS. `flashCardPerimeter()` creates a `.card-flash-overlay` div. Remaining set members update via store subscriber.
- **[D56] Border collapse via snap offset.** `computeSnap` gains a `borderWidth` parameter. Drag reads computed border width from `.tugcard`; resize uses hardcoded 1px.
- **Phase 5c2**: Touches `snap.ts` (border-width offset, hull polygon algorithm), `card-frame.tsx` (corner rounding, set flash, break-out restoration), and `chrome.css` (flash overlay rules).

### Entry 27: Shadow Rewrite and Card Refinements {#log-27} (2026-03-05)

Post-5c2 implementation revealed that the `.set-shadow` DOM element approach for set shadows had fundamental problems: visual glitches at concave set topologies, complex element lifecycle management, and a `_gestureActive` flag system that gated the store subscriber to avoid conflicts between gesture-time shadow tracking and subscriber-driven updates.

Four PRs resolved this:

1. **Set Shadow Glitches (#87)**: Fixed hull polygon computation bugs and visual artifacts.
2. **Hull Polygon Visual Overhaul (#86)**: Rewrote `computeSetHullPolygon` with coordinate compression + grid-based boundary trace algorithm.
3. **Set Shadow Rewrite (#88)**: Replaced the entire `.set-shadow` DOM element system with `clip-path: inset()` on `.tugcard`. Five steps: (a) CSS foundation — universal shadow on `.tugcard`, remove `.set-shadow` rules; (b) rewrite `updateSetAppearance` to apply clip-path instead of creating shadow elements; (c) delete gesture-active flag and all shadow tracking from drag/resize; (d) add per-frame clip-path update to sash co-resize; (e) cleanup and verification.
4. **Three Quick Fixes (dash)**: Added `--td-card-shadow-inactive` token, resize-click activation, Command-key suppression of activation.

New design decisions:

- **[D57] Set shadows via clip-path:inset()** — `computeClipPathForCard()` maps SharedEdge data to inset values. Interior edges clip at 0px (hiding shadow), exterior edges extend by `SHADOW_EXTEND_PX` (20px) to show full shadow. No DOM elements created or removed.
- **[D58] Active/inactive shadow tokens** — focused cards use `--td-card-shadow-active` (stronger shadow), unfocused use `--td-card-shadow-inactive` (half blur, half opacity). CSS-driven via `data-focused` attribute.
- **[D59] Command-key suppresses activation** — `metaKey` check in `handleFramePointerDown` and `handleResizeStart` skips `onCardFocused` call. Standard macOS convention.
- **[D60] Resize click activates card** — `handleResizeStart` explicitly calls `onCardFocused(id)` since `stopPropagation()` prevents the frame's handler from firing.

**Deleted infrastructure**: `_gestureActive`/`isGestureActive`/`setGestureActive` flag system, `dragShadowEl`/`dragShadowOrigin` refs, `resizeShadowEl`/`resizeShadowOriginX`/`resizeShadowOriginY` locals, defensive sweep block in `handleDragStart`, shadow translation in drag/resize RAF loops, `.set-shadow` and `.set-shadow-shape` CSS rules.

**Phases 5c and 5c2 are now complete.** The card snapping system is fully implemented: modifier-gated snap, set formation, set-move, break-out, border collapse, corner squaring, hull polygon flash, clip-path shadow management, active/inactive shadow differentiation, and activation refinements.

### Entry 28: Target/Action, Mutation Transactions, Observable Properties — Concepts 19–21 {#log-28} (2026-03-05)

Expanded the design system with three new concept areas, motivated by the need for inspector panels (color picker, font picker, coordinate inspector) and better control wiring. The expansion was designed around Apple's UIKit target/action pattern, AppKit's KVC/KVO observation model, and the existing three-zone mutation model.

**Concept 19 — Target/Action Control Model** replaces the responder chain's bare-string dispatch with typed `ActionEvent` objects carrying payload, sender, and phase (clean break — no backward compatibility). Five phases (`discrete`, `begin`, `change`, `commit`, `cancel`) support continuous controls like sliders and color pickers. Two dispatch modes: nil-target (chain resolution) and explicit-target via `dispatchTo` (direct to a specific responder, throws on missing target). `nodeCanHandle` provides per-node capability queries. TugButton never hides (disabled instead). DeckCanvas is the last-resort responder (`canHandle: () => true`). Formalizes that controls emit actions but never register as responders (D63), generalizing the existing TugButton design. *(Note: the original design called for backward-compatible string dispatch alongside ActionEvent; the implementation plan chose clean break instead. See Entry 29.)*

**Concept 20 — Mutation Transactions** provides snapshot/preview/commit/cancel semantics for live-preview editing. During a transaction, all mutations are appearance-zone (CSS/DOM, zero re-renders). On commit, the final state persists; on cancel, the snapshot restores. Integrates with action phases: `begin` opens a transaction, `change` previews, `commit`/`cancel` finalize. A `StyleCascadeReader` utility provides read-only introspection into CSS source layers (token, class, inline, preview) for inspector display.

**Concept 21 — Observable Properties** introduces a typed key-path `PropertyStore` per card — a scoped KVC/KVO-inspired store. Cards register inspectable properties with schemas. Inspectors discover properties via `getSchema()`, read via `get()`, write via responder chain actions, and observe via `useSyncExternalStore`-compatible subscriptions. Change records include source attribution to prevent circular updates.

New design decisions: D61–D69. New Rules of Tugways: #9 (live preview is appearance-zone only), #10 (controls emit, responders handle).

Phase 5d restructured into 5d1 (default button, unchanged), 5d2 (control action foundation), 5d3 (mutation transactions), 5d4 (observable properties). New Phase 8e (Inspector Panels) added downstream.

### Entry 29: Phase 5d2 Implemented — Control Action Foundation {#log-29} (2026-03-05)

Implemented Concept 19 (Target/Action Control Model) as Phase 5d2. The plan underwent a major revision during planning: the original design called for backward-compatible string dispatch alongside `ActionEvent`, but the plan chose a **clean break** — `dispatch()` accepts only `ActionEvent`, no string overload, no union type. All existing dispatch call sites and handler signatures were migrated in a single step.

**Key deviations from the original Concept 19 design:**

- **No backward compatibility.** D61 originally said `dispatch('copy')` shorthand continues to work. The plan chose clean break: bare strings are a TypeScript compile error. All ~40 dispatch call sites migrated to `ActionEvent` form. All handler signatures changed from `() => void` to `(event: ActionEvent) => void`.
- **Never-hide TugButton.** Not in the original Concept 19 design. TugButton previously returned `null` (hidden) when `canHandle` returned false. Now renders with `aria-disabled="true"` instead — buttons are always visible, disabled when unhandled. This is standard UI behavior.
- **`nodeCanHandle(nodeId, action)`** — new public method on `ResponderChainManager` for per-node capability queries without chain walk. Used by TugButton's `target` prop for the enabled/disabled check.
- **DeckCanvas last-resort responder** — `canHandle: () => true` added to DeckCanvas's `useResponder` registration, making it a catch-all so chain-action buttons are almost never disabled in practice.
- **Validation queries remain string-based** — `canHandle(action: string)` and `validateAction(action: string)` were not changed to accept `ActionEvent`. They are queries about capability by action name, not about specific event instances.

**Scope:** 19 files modified (8 production, 11 test), 655 tests passing, zero TypeScript errors. Five implementation steps: (1) ActionEvent type + dispatch migration + never-hide TugButton, (2) dispatchTo + nodeCanHandle methods, (3) TugButton target prop + DeckCanvas last-resort test, (4) gallery ActionEvent demo, (5) integration checkpoint verification.

Design doc D61 and D62 sections updated to match implementation. Concept 19 status changed from DESIGNED to IMPLEMENTED.

### Entry 30: Theme Token Overhaul — Concept 22 {#log-30} (2026-03-06)

Added Concept 22: Theme Token Overhaul. This is a comprehensive redesign of the token system based on an offline research and design study documented in `dash/theme-overhaul-proposal.md`.

**Key design decisions:**

- **[D70] TugColor (Hue · Intensity · Tone · Alpha) OKLCH palette.** 24 named hue families with a continuous color space: Hue (color family), Intensity (chroma 0–100), Tone (lightness 0–100). Five convenience presets per hue (canonical, light, dark, intense, muted) with fixed i/t values. Arbitrary colors via the inline `calc()`+`clamp()` formula with literal i/t numbers — themes write chromatic semantic tokens this way. ~200 CSS variables defined as pure CSS `oklch()` + `calc()` + `clamp()` formulas — no JS injection required. P3 wide-gamut support via `@media (color-gamut: p3)` block overriding `peak-c` constants. The JS function `tugColor()` provides programmatic color computation for inline styles and data viz. Per-hue canonical lightness values are tuned via an interactive gallery editor.
- **[D71] Three-layer token naming.** TugColor palette variables (`--tug-{hue}[-preset]`), `--tug-base-*` (canonical semantics), `--tug-<component>-*` (component bindings) replace the current `--tways-*` / `--td-*` two-tier system. The `--tug-comp-*` prefix is banned (confusingly similar to CSS "computed"). All legacy aliases (`--background`, `--foreground`, `--primary`, etc.) are removed after migration.
- **[D72] Global scale.** `--tug-zoom` (default: `1`) drives CSS `zoom` on `<body>`, scaling the entire UI uniformly — all dimensions, text, spacing, radii, icons. Per-component `--tug-<component>-zoom` (default: `1`) allows fine-tuning via zoom on the component root.
- **[D73] Global timing.** `--tug-timing` (default: `1`) multiplies all animation durations. `--tug-motion` (default: `1`, set to `0` by `prefers-reduced-motion`) toggles motion on/off. `data-tug-motion="off"` on body provides CSS hook. Two controls because "slow motion for debugging" and "no motion for accessibility" are categorically different.
- **[D74] Dev cascade inspector.** `Ctrl+Option + hover` shows token resolution chain for any component: `--tug-<component>-*` → `--tug-base-*` → `--tug-{hue}[-preset]`, including hue/intensity/tone provenance for computed colors and scale/timing effects.

Implementation planned across six sub-phases (5d5a–5d5f) in the implementation strategy. External research surveyed Primer, Spectrum, Open Props, Carbon, and Chakra for naming patterns; OKLCH guidance for perceptual uniformity; Adobe color naming guidance for hue family names.

**Implementation history:** Phase 5d5a (Palette Engine) shipped first with the smoothstep/anchor-based system. After extensive curve tuning via the interactive gallery editor, the TugColor (Hue · Intensity · Tone · Alpha) system was designed as a replacement. The TugColor Runtime plan promoted `tugColor()` and canonical constants to `palette-engine.ts`, added P3 support, moved palette generation to pure CSS, and removed all legacy anchor/smoothstep code. A post-merge fix corrected chroma cap derivation — caps are now derived at canonical L only (not the extreme L_DARK/L_LIGHT values which bottlenecked chroma to near-zero). The old `--tug-palette-hue-*` variable names and `tugPaletteColor()` function are gone; replaced by `--tug-{hue}[-preset]` naming and `tugColor()`.

### Entry 31: Palette Engine Integration — Pure CSS, Neutrals, Phase 5d5e {#log-31} (2026-03-07)

Post-mortem on Phases 5d5c and 5d5d revealed a critical gap: the `--tug-base-*` semantic tokens in `tug-tokens.css` contained ~328 hardcoded hex color values instead of resolving from the TugColor palette engine's `--tug-{hue}[-preset]` variables. The consumer migration (5d5d) mechanically renamed all CSS consumers to point at these still-hardcoded tokens. The palette engine was live and generating 242 CSS variables — but nothing consumed them.

**Three key decisions:**

- **[D70] revised — Continuous TugColor color space with convenience presets.** The palette engine exposes 24 hues × 100 i × 100 t as a continuous space. Five convenience presets per hue (canonical, light, dark, intense, muted) with fixed i/t values provide stable reference colors. Themes define chromatic semantic tokens using the inline `calc()`+`clamp()` formula with theme-specific i/t choices — this is where design intent lives. ~200 palette CSS vars (120 convenience presets + 74 per-hue constants + neutrals). P3 support: `@media (color-gamut: p3)` overrides `peak-c` constants. Runtime CSS injection is eliminated — `tugColor()` is retained for programmatic JS use only.

- **[D75] Neutral ramp and opacity.** The TugColor system extends to achromatic colors via `--tug-neutral-*` (the tone axis with C=0) plus `--tug-black`/`--tug-white` anchors. For semi-transparent variants, CSS relative color syntax (`oklch(from var(--tug-orange) l c h / 0.5)`) and `color-mix()` provide composable alpha at the point of use — no precomputed alpha variants needed.

- **Phase restructure.** Renamed Phase 5d5e (Cascade Inspector) to Phase 5d5f. Added new Phase 5d5e (Palette Engine Integration) as the missing link between the implemented TugColor palette engine (5d5a) and the consumer-facing semantic tokens (5d5c/5d5d). This phase wires `--tug-base-*` chromatic tokens to `var(--tug-{hue}[-preset])` references, converts the palette to pure CSS, adds the neutral ramp, and makes theme differentiation about "which hues map to which roles" rather than "which hex values."

### Entry 32: TugAnimator and Phase 7 Expansion — Concept 8 Revised {#log-32} (2026-03-07)

Concept 8 (Motion and Visual Continuity) originally specified CSS `@keyframes` for enter/exit, skeleton shimmer, and startup continuity. Investigation revealed that CSS animations lack three capabilities critical for a professional motion system: completion handlers (CSS `transitionend`/`animationend` are unreliable), cancellation with hold-at-current-value semantics, and additive composition for fluid interruption.

The Web Animations API (WAAPI) fills all three gaps with full browser support: `Animation.finished` returns a real promise, `.cancel()` stops cleanly, and `composite: 'add'` enables additive layering. WAAPI is a playback engine, not a physics engine — spring, gravity, bounce, and friction curves are pre-computed in JS and delivered as WAAPI keyframes.

**Key decisions:**

- **[D76] TugAnimator as the single programmatic animation engine.** CSS `transition` declarations stay for declarative hover/focus states (compositor-accelerated, zero-JS, auto-reversible). Everything else — enter/exit, skeleton shimmer, springs, physics, coordinated multi-element animations, drag release, flash overlays — consolidates into TugAnimator. This replaces the three competing approaches currently in the codebase: CSS `@keyframes`, `requestAnimationFrame` loops, and manual `animationend` event listeners.

- **Animation groups with coordinated completion.** Inspired by UIView.animate: create a group, add animations to multiple elements, await a single `.finished` promise. Under the hood: multiple WAAPI animations with `Promise.all` on their `.finished` promises.

- **Physics solvers.** Spring (damped harmonic oscillator with velocity matching on interruption), gravity + bounce (coefficient of restitution), friction/deceleration (exponential decay). All pre-computed into WAAPI keyframes.

- **Phase 7 split into three sub-phases.** 7a: TugAnimator engine (foundation). 7b: Managed animations + skeleton loading (migrate programmatic @keyframes to TugAnimator; CSS-only animations and rAF loops stay — see Entry 33). 7c: Startup continuity (three-layer flash elimination).

### Entry 33: Animation Boundary Rules — Rules 13–14 Added {#log-33} (2026-03-10)

Pre-planning review for Phase 7a revealed that Entry 32's scope for TugAnimator was over-broad. The original framing ("everything else consolidates into TugAnimator") would have migrated continuous CSS animations (gallery petals, skeleton shimmer), Radix-managed enter/exit, and gesture-driven rAF loops — none of which benefit from WAAPI.

**Key decisions:**

- **Added Rule 13 to Rules of Tugways.** Establishes three lanes: CSS for declarative/continuous motion, TugAnimator for programmatic motion (completion, cancellation, coordination, physics), `requestAnimationFrame` for gesture-driven frame loops. No overlap.

- **Added Rule 14 to Rules of Tugways.** Radix Presence owns enter/exit DOM lifecycle via `animationend`. WAAPI doesn't fire `animationend`. Therefore TugAnimator never drives Radix-managed enter/exit. TugAnimator is for code-controlled DOM insertion/removal only (flash overlays, skeleton crossfades, startup overlay).

- **Added decision rule cheat sheet** to the TugAnimator section of Concept 8 — an 8-row table that resolves CSS vs TugAnimator vs rAF for any animation scenario.

- **Narrowed Phase 7b scope** in the strategy document. Removed: gallery petals/pole migration, rAF loop migration, skeleton shimmer via TugAnimator. Kept: flash overlay, dropdown blink, button spinner migrations (all need completion/cancellation). Added explicit "keep as CSS" and "keep as rAF" sections for clarity.

### Entry 34: Semantic Text Types and Contrast Role Vocabulary — Phase 3.5B {#log-34} (2026-03-19)

Added design decisions D82 (Semantic Text Types) and D83 (Contrast Role Vocabulary) to Concept 22 as part of Phase 3.5B, which establishes the design vocabulary for the element plane.

**Key decisions:**

- **[D82] Four semantic text types.** All text tokens are classified into `content`, `control`, `display`, or `informational`. The classification determines both the element hue slot used in token generation and the contrast role in the pairing map. This replaces the current single-`text` hue that drives all text tokens regardless of purpose. Default conventions for hue selection are baked into `EXAMPLE_RECIPES` as authoring guidelines, not engine constraints: `control` matches `content` (same typographic family), `display` is +10° warmer (closest clean base hue to the +15° convention), `informational` matches `surface.canvas` (recedes into background), `decorative` is near-neutral.

- **[D83] Five contrast roles replace the legacy four.** `content` (75), `control` (60), `display` (60), `informational` (60), `decorative` (15). All readable text roles maintain thresholds >= 60. The key changes: `body-text` → `content` (same threshold, renamed); `large-text` → `control` (same threshold, semantic rename); `subdued-text` → `informational` (threshold raised from 45 to 60); `ui-component` split into `control` (interactive elements, from 30 to 60) and `informational` (structural/metadata elements, from 30 to 60). The `ui-component` split is the largest change — 181 pairings reclassified at double their prior threshold. Risk R02 in the Phase 3.5B plan addresses this explicitly.

- **`ThemeRecipe` restructured.** The flat recipe fields are replaced with nested `surface`/`element`/`role` groups. `cardFrame` and `link` are removed as recipe inputs; `cardFrame` is derived from `element.border` and `link`/`interactive` from `role.action`. New element hue inputs: `element.control`, `element.display`, `element.informational`, `element.decorative`.

- **Card title token.** `element-cardTitle-text-normal-plain-rest` is a new derivation rule using the `display` element hue. `tug-card.css` uses this token for `.tugcard-title`, giving card titles independent color control separate from body prose.

Implementation is in the Phase 3.5B plan (`tugplan-design-vocabulary.md`) with 10 execution steps. The documentation update (this entry) is step 9.
