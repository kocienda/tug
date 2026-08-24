# Tugways Component Library Roadmap

*Complete inventory of existing components, planned builds, and implementation order.*

## Archived Documents

The following documents are superseded by this roadmap:

- `.tugtool/tugplan-tugways-phase-8-radix-redesign.md` — Original Phase 8 plan. Component inventory and design decisions are incorporated here. Infrastructure decisions (D01-D07) remain valid as historical reference.
- `dash/step-4-interactive-build-guide.md` — Original Step 4 build guide. Build-order and token patterns are incorporated here.
- `dash/archive/tugways-implementation-strategy.md` — Original implementation strategy. Already archived.

---

## Completed Components

Components that exist today, audited to compliance with `tuglaws/component-authoring.md` in the Phase 2 quality audit.

### Public Components

| Component | Kind | Description | Gallery Card |
|-----------|------|-------------|:------------:|
| tug-push-button | Compositional | Primary push button (composes internal TugButton) | ✅ |
| tug-popup-button | Compositional | macOS-style popup button (composes TugPopupMenu + TugButton) | ✅ |
| tug-checkbox | Wrapper (Radix) | Checkbox with label, mixed state, roles | ✅ |
| tug-switch | Wrapper (Radix) | Toggle switch with label | ✅ |
| tug-input | Wrapper (native) | Text input with validation, focus ring | ✅ |
| tug-label | Wrapper (Radix) | Text label with ellipsis, max-lines | ✅ |
| tug-badge | Original | Tone variants, tinted/pill, count mode | ✅ |
| tug-skeleton | Original | Shimmer placeholder with pulse animation | ✅ |
| tug-marquee | Original | Scrolling overflow text | ✅ |
| tug-card | Structural | Multi-tab card with title bar, accessory slot, effects | ✅ |
| tug-tab-bar | Structural | Tab strip with overflow, drag, type picker | ✅ |
| tug-value-input | Original | Compact editable value display with imperative DOM management [L06]. Formatted display, select-all on focus, type-to-replace, arrow key increment, validate on commit. | ✅ |

### Internal Components

| Component | Kind | Description | Composed By |
|-----------|------|-------------|-------------|
| tug-button | Wrapper (Radix) | Core button with emphasis/role/size matrix | TugPushButton, TugPopupButton, TugTabBar |
| tug-popup-menu | Wrapper (Radix) | Headless dropdown menu with blink animation | TugPopupButton, TugTabBar |

### Theme Internals (Not Audited)

| Component | Description |
|-----------|-------------|
| tug-hue-strip | Theme generator hue picker |
| tug-color-strip | Theme generator color strip |

---

## Radix Primitives Coverage

*Cross-reference of all 30 [Radix UI Primitives](https://www.radix-ui.com/primitives/docs/overview/introduction) against tugways components. Policy: wrap Radix for ARIA, keyboard, and state management; layer tug styling and behaviors on top. Roll our own only when tug requirements compel it.*

### Wrapping Radix — Completed

| Tug Component | Radix Primitive | Notes |
|---|---|---|
| tug-checkbox | `react-checkbox` | Three states, role-based color injection |
| tug-label | `react-label` | Click-to-focus, ellipsis truncation |
| tug-radio-group | `react-radio-group` | Composes with TugButton via `asChild` |
| tug-switch | `react-switch` | Track/thumb, inline label |
| tug-slider | `react-slider` | Track/range/thumb, editable value input |
| tug-button (internal) | `react-slot` | `asChild` polymorphism for Radix composition |
| tug-popup-menu (internal) | `react-dropdown-menu` | Architectural inversion, blink animation |

### Wrapping Radix — Planned

| Tug Component | Radix Primitive | Group | Notes |
|---|---|---|---|
| tug-tooltip | `react-tooltip` | B | Package installed |
| tug-context-menu | `react-context-menu` | B | Package not yet installed |
| tug-accordion | `react-accordion` | B | Expand/collapse ARIA, keyboard nav, single/multiple mode |
| tug-alert | `react-alert-dialog` | C | Package not yet installed |
| tug-confirm-popover | `react-popover` | C | Package installed |
| tug-bulletin | Sonner (not Radix Toast) | C | Package not yet installed |
| tug-avatar | `react-avatar` | E | Package not yet installed |
| tug-toolbar | `react-toolbar` | F | Package not yet installed |

### Custom — Justified Deviations

| Tug Component | Radix Alternative | Why Custom |
|---|---|---|
| tug-tab-bar | `react-tabs` | Overflow via ResizeObserver, drag initiation, type-picker menus — beyond Radix Tabs scope |
| tug-choice-group | `react-toggle-group` | Sliding indicator pill animation + connected segments require imperative DOM |
| tug-option-group | `react-toggle-group` | Multi-toggle with pipe dividers and per-item backgrounds — beyond Radix ToggleGroup |
| tug-separator | `react-separator` | Labels, ornaments, capped ends — Radix Separator is just `<div role="separator">` |
| tug-progress | `react-progress` | Unified spinner/bar/ring/pie with compound composition — far beyond Radix's simple bar |

### Custom — No Radix Equivalent

| Tug Component | Why Custom |
|---|---|
| tug-input | No Radix input primitive; native `<input>` is correct |
| tug-textarea | No Radix primitive; auto-resize requires imperative DOM |
| tug-badge | Display-only, no interaction |
| tug-card | Domain-specific composition |
| tug-push-button | Thin styling wrapper on tug-button |
| tug-popup-button | Composition of tug-button + tug-popup-menu (Radix underneath) |
| tug-value-input | Imperative DOM management for formatted display, type-to-replace |
| tug-marquee | Scrolling animation, no Radix equivalent |
| tug-skeleton | Shimmer animation, no Radix equivalent |
| tug-box | Recursive disable propagation via React context |
| tug-banner | State-driven app-modal barrier with scrim + inert. No Radix equivalent. |
| tug-sheet | Card-scoped modality requires portal into card, card-scoped inert — Radix Dialog is document-level. Uses Radix FocusScope (standalone). |

### Radix Primitives — Skipped

| Radix Primitive | Why Skip |
|---|---|
| `react-select` | Covered by tug-popup-button. Remove installed package. |
| `react-scroll-area` | Native scrollbars sufficient. Remove installed package. |
| `react-tabs` | tug-tab-bar correctly exceeds its scope. Remove installed package. |
| `react-hover-card` | Tooltip + popover cover this space |
| `react-menubar` | Desktop menubar — not relevant to card-based UI |
| `react-navigation-menu` | Site navigation — not relevant |
| `react-aspect-ratio` | Trivial CSS (`aspect-ratio` property) |
| `react-collapsible` | Accordion covers this; standalone collapsible not needed |
| `react-otp-field` | Auth-specific, not relevant |
| `react-password-toggle` | Auth-specific, not relevant |
| `react-form` | Not needed now; reconsider if client-side form validation becomes a requirement |

### Package Cleanup

Installed but unused — remove from `package.json`:
- `@radix-ui/react-select`
- `@radix-ui/react-scroll-area`
- `@radix-ui/react-tabs`

Installed but unused — can also be removed (tug-sheet is now original, not a Radix Dialog wrapper):
- `@radix-ui/react-dialog`

---

## Planned Components — Form Controls

Controls that handle user input. Each wraps a Radix primitive or native element.

| # | Component | Kind | Wraps | Key Features | Priority |
|---|-----------|------|-------|--------------|----------|
| 1 | tug-slider | Wrapper | `@radix-ui/react-slider` | Track/thumb, value display, range labels | High |
| 2 | tug-radio-group | Wrapper | `@radix-ui/react-radio-group` | Group label, horizontal/vertical layout | High |
| 3 | tug-textarea | Wrapper (native) | `<textarea>` | Auto-resize, char count, field tokens | High |

**Removed:** tug-select (covered by tug-popup-button), tug-toggle (covered by tug-checkbox/tug-switch), tug-toggle-group (row of toggles — unnecessary given existing controls).

## Planned Components — Display & Feedback

Components that present information or feedback. No user input.

| # | Component | Kind | Key Features | Priority |
|---|-----------|------|--------------|----------|
| 7 | tug-separator | Original | Horizontal/vertical, label, ornament, capped ends. Custom — Radix Separator too minimal. | High |
| 9 | tug-progress | Original | Unified progress: spinner, bar, ring, pie variants. Indeterminate + determinate modes. Custom — far beyond Radix Progress. | High |
| 10 | tug-keyboard | Original | Keycap chip for shortcut display | Medium |
| 11 | tug-avatar | Wrapper (Radix) | Wraps `@radix-ui/react-avatar`. Image + fallback initials, size variants | Medium |
| 12 | tug-status-indicator | Original | Tone-colored dot + text label | Medium |

## Planned Components — Navigation & Overlay

Components that manage layered UI, menus, and scrolling.

| # | Component | Kind | Wraps | Key Features | Priority |
|---|-----------|------|-------|--------------|----------|
| 13 | tug-tooltip | Wrapper (Radix) | `@radix-ui/react-tooltip` | Hover labels, keyboard shortcut display | High |
| 14 | tug-context-menu | Wrapper (Radix) | `@radix-ui/react-context-menu` | Right-click menus for cards | Medium |
| 15 | tug-popover | Wrapper (Radix) | `@radix-ui/react-popover` | General anchored overlay | Medium |

**Removed:** tug-scroll-area (native browser scrollbars are sufficient; Windows polish is not a priority).

## Planned Components — Alerts & Modals

Five-tier modal system modeled on AppKit. See [tug-alert-system.md](tug-alert-system.md) for consolidated proposal.

| # | Component | Kind | Scope | Key Features | Priority |
|---|-----------|------|-------|--------------|----------|
| 16 | tug-banner | Original | App-modal (state) | State-driven barrier with scrim + inert. Status/error variants. Replaces disconnect-banner + error-boundary. | High |
| 17 | tug-alert | Wrapper (Radix) | App-modal (action) | Wraps `@radix-ui/react-alert-dialog`. Promise-based API, button roles, scrim | High |
| 18 | tug-sheet | Original + FocusScope | Card-modal | Window-shade from title bar, card-scoped inert, TugcardPortalContext | High |
| 19 | tug-confirm-popover | Wrapper (Radix) | Button-local | Wraps `@radix-ui/react-popover`. Destructive action confirmation | High |
| 20 | tug-bulletin | Wrapper (Sonner) | Non-blocking | Wraps Sonner. Fire-and-forget, tone variants, auto-dismiss, top-right default | High |

## Planned Components — Data Display

Components for structured data presentation.

| # | Component | Kind | Key Features | Priority |
|---|-----------|------|--------------|----------|
| 21 | tug-table | Original | Header/row/cell, sortable, stripe option | Medium |
| 22 | tug-stat-card | Original | Key-value metric (label + number + trend) | Low |
| 24 | tug-accordion | Wrapper (Radix) | Wraps `@radix-ui/react-accordion`. Expand/collapse ARIA, keyboard nav, single/multiple mode | Low |

## Planned Components — Data Visualization

Custom SVG/Canvas components for charts and gauges.

| # | Component | Kind | Key Features | Priority |
|---|-----------|------|--------------|----------|
| 25 | tug-sparkline | Original | SVG inline chart: area, line, column, bar | Low |
| 26 | tug-linear-gauge | Original | Horizontal gauge with needle, thresholds | Low |
| 27 | tug-arc-gauge | Original | Radial gauge with arc fill, center readout | Low |

## Planned Components — Compositions

Higher-level components assembled from multiple primitives.

| # | Component | Kind | Composes | Key Features | Priority |
|---|-----------|------|----------|--------------|----------|
| 30 | tug-search-bar | Composition | TugInput + TugButton | Search field with action button. Deferred from Group D. | Low |
| 31 | tug-toolbar | Wrapper (Radix) | Wraps `@radix-ui/react-toolbar`. Grouped controls with arrow key nav | Low |

## New Component Ideas

*Components not in the original Phase 8 plan.*

| # | Component | Kind | Description | Priority |
|---|-----------|------|-------------|----------|
| 32 | tug-choice-group | Original | Mutually exclusive segment picker (renamed from tug-segmented-choice). Horizontal row of connected segments with sliding indicator pill. Icon + label support, optional animation. Part of the group family with tug-radio-group and tug-option-group. | High |
| 39 | tug-option-group | Original | Multi-toggle group where each item toggles independently (like B/I/U in a text editor). Connected row with per-item on-state backgrounds, pipe dividers between off-state neighbors. Part of the group family. | High |
| 33 | tug-box | Original | Container providing visual grouping (optional border, optional label) and functional grouping (enable/disable all contained controls with one prop). Nestable — disabled outer box cascades to all inner boxes and controls. Modeled on HTML `<fieldset>` semantics with recursive disable propagation via React context. | High |
| 34 | tug-rich-text | Wrapper (Monaco) | Monaco editor in a tugways component. Token-driven theming, standard props interface, integration with card content system. Deferred from Group D — not needed for conversation experience. | Medium |
| 35 | tug-banner | Original | State-driven app-modal barrier. Scrim + inert for modality. Status variant (connection lost) and error variant (render errors with stack traces). Replaces hand-built disconnect-banner.tsx and error-boundary.tsx rendering. | High |
| 36 | tug-markdown | Original | High-performance markdown/MDX renderer for LLM and agent responses. Three layers: (1) standard CommonMark/GFM rendering with token-driven typography, (2) full MDX support for embedded React components, (3) "MDX+" custom parsing extensions for tugways-specific formatting (agent output, code diffs, plan steps, tool results, etc.). Must handle streaming content (incremental rendering as tokens arrive), large documents without jank, and syntax-highlighted code blocks via tug-rich-text integration. The primary display surface for all AI-generated content in the app. | High |
| 37 | tug-prompt-input | Original | Rich input field for composing prompts and conversational text. History navigation, typeahead/suggestions, completions, multi-line expansion. Distinct from tug-input (basic field) and tug-textarea (plain multi-line) — prompt-input is the full interactive authoring field. | High |
| 38 | tug-prompt-entry | Composition | Integrated prompt composition surface. Composes tug-prompt-input + submit button + progress indicator + utility buttons. The complete "enter a prompt" experience. Pairs with tug-markdown on the output side: prompt-entry is where text goes in, markdown is where responses come out. | High |
| 40 | tug-cue | Original | **Implemented.** Banner-shaped inline click target — a soft, full-width affordance that doubles as a passive descriptive hint and an action surface. Use case: collapsed-hint banners in body-kinds ("1,234 lines folded — click to expand"), disclosure triggers, soft prompts. Fills a gap between tug-push-button (uppercase CTA), tug-icon-button (icon-only trailing action), and tug-banner (app-modal status strip). API mirrors tug-button: `onClick` xor `action`, optional `target`, `role` (one of `active` / `accent` / `agent` / `caution` / `danger` / `data` / `success`), `density`, `icon`. Lives at `tugdeck/src/components/tugways/tug-cue.tsx`; designed in [#step-10-6](../dash/tide-assistant-rendering.md#step-10-6) of the Tide rendering plan. | High |

---

## Implementation Groups

*Ordered by dependency and downstream need. Each group is built one component at a time, interactively tuned in the Component Gallery.*

### Group A: Form Controls & Actions

Settings card and card content need these. Slider, radio, textarea, choice-group, box, and option-group cover all form control and grouping patterns needed across card UIs. **Group A is complete.**

- ~~tug-slider~~ ✅
- ~~tug-radio-group~~ ✅
- ~~tug-choice-group~~ ✅ *(renamed from tug-segmented-choice)*
- ~~tug-box~~ ✅
- ~~tug-textarea~~ ✅
- ~~tug-option-group~~ ✅

### Group B: Display & Popup Essentials

Separators, progress indicators, collapsible sections, tooltips, context menus, popovers, and confirmation guards. **Group B is complete.**

- ~~tug-separator~~ ✅
- ~~tug-progress~~ ✅ *(unified component replacing tug-spinner + tug-progress; spinner/bar/ring/pie variants)*
- ~~tug-accordion~~ ✅
- ~~tug-tooltip~~ ✅ *(truncation-aware mode, keyboard shortcut badges)*
- ~~tug-context-menu~~ ✅ *(reuses tug-menu.css tokens [L20], blink animation)*
- ~~tug-popover~~ ✅ *(compound API: Root/Trigger/Content/Close)*
- ~~tug-confirm-popover~~ ✅ *(composes tug-popover [L20], imperative Promise API + declarative callbacks)*

### Group C: Alert System

Four modality tiers: state barriers, app-modal alerts, card-modal sheets, and notifications. See [tug-alert-system.md](tug-alert-system.md) for the consolidated proposal. **Group C is complete.**

- ~~tug-banner~~ ✅ *(state-driven app-modal barrier, replaces disconnect-banner + error-boundary)*
- ~~tug-alert~~ ✅ *(app-modal, Radix AlertDialog, Promise API, useTugAlert hook)*
- ~~tug-sheet~~ ✅ *(card-modal, original + FocusScope, window-shade, TugcardPortalContext, useTugSheet hook)*
- ~~tug-bulletin~~ ✅ *(modeless notifications, Sonner, useTugBulletin hook)*
- ~~tug-dialog~~ — Skipped. Card system handles dialog use cases natively.

### Group D: The Conversation Experience

The core AI interaction: prompt input, streamed markdown rendering, and agent progress. Ten phases from hook capture to custom block renderers, each scoped as a `/plan` → `/implement` cycle. See [tug-conversation.md](tug-conversation.md) for the full roadmap.

- tug-markdown
- tug-prompt-input
- tug-prompt-entry

**Deferred from Group D:**
- tug-rich-text — Monaco editor wrapper. Moved to a future group. Not needed for the conversation experience.
- tug-search-bar — TugInput + TugButton composition. Moved to a future group. Trivial, no urgency.

### Group E: Data Display & Feedback

Table, avatars, and indicators needed for card content.

- tug-table
- tug-keyboard
- tug-avatar
- tug-status-indicator
- tug-stat-card

### Group F: Data Visualization

Specialized components for analytics cards. No downstream dependencies.

- tug-sparkline
- tug-linear-gauge
- tug-arc-gauge
- tug-toolbar

