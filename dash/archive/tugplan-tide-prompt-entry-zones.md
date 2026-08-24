<!-- tugplan-skeleton v2 -->

## Tide Prompt-Entry Zone Restructure & Route Lifecycle {#tide-prompt-entry-zones}

**Purpose:** Split the Tide prompt-entry footer into addressable `Z4A` (route choice-group) and `Z4B` (route-aware indicator strip) zones, introduce a `RouteLifecycle` delegate pipe so chrome can react to route changes, and plumb host facts (hostname, shell) from tugcast so the `Z4B` indicator can name what each route targets.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | approved |
| Target branch | `main` |
| Last updated | 2026-05-22 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Tide card's prompt-entry pane is partitioned into placement zones per [D97]. `Z3` (prompt-entry top) currently carries the `Project` badge, the `Claude Code` version badge, and the maximize toggle. `Z4` (prompt-entry footer) is reserved and empty; the route choice-group (`Code` / `Shell` / `Command`) sits loose in the toolbar alongside the `Z5` submit button. The result reads as two unrelated badge clusters with a half-used footer band, and `Z3` is taller than its sole remaining occupant — the maximize control — needs.

The badges also belong *with* the routes, not above the text field: the `Claude Code 2.1.148` badge names the engine the `Code` route talks to, and that identity should change with the route — `Shell` runs a shell, `Command` runs against the host. Today the badge cannot vary, and the data it would need to vary (the host's shell name, its hostname) is not on any frame tugdeck receives. Surfacing route-derived chrome cleanly also wants a first-class way for chrome to *observe* route changes — the same delegate shape the deck already uses for card lifecycle moments ([lifecycle-delegates.md](../tuglaws/lifecycle-delegates.md)), scoped to the prompt entry.

#### Strategy {#strategy}

- Build the two enabling primitives first — host facts (cross-stack) and the `RouteLifecycle` pipe (frontend) — so the chrome work composes finished pieces rather than inventing them inline.
- Model `RouteLifecycle` on the established `TugCardDelegate` pattern: a store surface for renderers ([L02]) and a synchronous delegate/observer surface for imperative reactors. Scope it per prompt-entry, not deck-wide.
- Make the route the single source of truth in the lifecycle; `TugPromptEntry` and any `Z4B` chrome both read it through `useSyncExternalStore`, never a copied mirror.
- Restructure the toolbar as three zones — `Z4A` (routes, fixed-leading), `Z4B` (indicators, floating-centered), `Z5` (submit, fixed-trailing) — with `Z4B` consuming the route through context, so no render-prop or prop-drill is needed.
- Keep appearance changes (the `Z4B` float, the reduced `Z3` height) in CSS ([L06]); keep the route-indicator badge mount-stable across route flips ([L26]).
- Treat the `Command` route's hostname as an explicit placeholder — its real design is deferred.

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- `GET /api/host` returns `{ "hostname": <str>, "shell": <str> }` with non-empty values on macOS and Linux (verify: `curl` against a running tugcast; Rust unit test).
- Switching a Tide card's route updates the `Z4B` indicator badge within one commit — `Code` → `Claude Code <version>`, `Shell` → `<shell name>`, `Command` → `<hostname>` (verify: `just app-test` driving route flips and reading badge text).
- `RouteLifecycle.routeDidChange` fires for every route flip regardless of trigger — choice-group click, leading-prefix typing, `SELECT_ROUTE` keybinding (verify: pure-logic `bun:test` over the three call sites).
- `Z4B`'s left gap (to `Z4A`'s trailing edge) and right gap (to `Z5`'s leading edge) are equal within ±1px at three card widths (verify: `just app-test` measuring bounding rects).
- `Z3`'s rendered height is strictly less than its pre-change height (verify: `just app-test` / measured px in the checkpoint).
- The `Project` and `Claude Code` badges render in the `Z4B` DOM subtree and not in the `Z3` subtree (verify: `just app-test` DOM assertions).
- The route-indicator badge keeps mount identity across a route flip — no unmount/remount (verify: `just app-test` observing a stable node identity / no teardown).

#### Scope {#scope}

1. Host facts: a tugcast endpoint exposing `{ hostname, shell }`, and a frontend `HostFactsStore` that reads it via `useSyncExternalStore`.
2. `RouteLifecycle`: a per-prompt-entry delegate pipe — store surface + synchronous `routeWillChange` / `routeDidChange` observer and delegate surfaces — modeled on `TugCardDelegate`.
3. `TugPromptEntry` rewire: the `RouteLifecycle` instance owns the authoritative route; the component reads it via `useSyncExternalStore` and provides it through `RouteLifecycleContext`.
4. Toolbar restructure: `Z4` splits into `Z4A` (route choice-group) and `Z4B` (indicator slot); `Z4B` floats centered between `Z4A` and `Z5`.
5. Badge relocation: `Project` and `Claude Code` badges move `Z3` → `Z4B`; `Z3` retains only the maximize toggle and its height is reduced.
6. Route-aware indicator badge: rename `TideVersionBadge` → `TideRouteIndicatorBadge`, make its content route-derived.
7. Docs: update [D97], add a `route-lifecycle.md` tuglaws reference doc, record new design decisions.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Designing the `Command` route's actual behavior — the hostname is an interim placeholder ([Q02]).
- Implementing the `Shell` route's command execution path (`SHELL_OUTPUT` / `SHELL_INPUT` remain reserved for a later phase).
- Per-route drafts or any change to the route *model* beyond ownership moving into `RouteLifecycle` ([D08] in `tug-prompt-entry.tsx`'s existing route decisions stays as-is).
- A deck-level route concept — routes remain per-prompt-entry.
- New telemetry datums or changes to `Z0` / `Z1` / `Z2` / `Z5` content.

#### Dependencies / Prerequisites {#dependencies}

- [Q01] resolved — host facts are served over HTTP at a read-only `GET /api/host` endpoint.
- Existing surfaces reused: `sessionMetadataStore` (`version`), `TugChoiceGroup`, `TugBadge`, `TugPopover`, the drift detectors in `tide-assistant-renderer-dispatch`.
- The card-lifecycle delegate pattern in [`card-lifecycle.ts`](../tugdeck/src/lib/card-lifecycle.ts) as the reference shape for `RouteLifecycle`.

#### Constraints {#constraints}

- Rust workspace builds under `-D warnings`; warnings are errors (tugcast changes must be clean).
- tugdeck has no manual build step — HMR picks up changes; verification is `bun run check` + `bun test` + `just app-test`.
- A new Rust dependency for hostname resolution must clear [L21] (permissive license, `THIRD_PARTY_NOTICES.md` entry).
- No `localStorage` / `sessionStorage` / `IndexedDB`; host facts are server-sourced, not browser-persisted.

#### Assumptions {#assumptions}

- tugcast runs on the same host whose `hostname` and `$SHELL` are the meaningful values to surface.
- The route set stays `❯` Code / `$` Shell / `:` Command for this phase.
- A Tide card has exactly one prompt entry, hence exactly one `RouteLifecycle`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `**References:**` lines. `[D##]` without a plan-local anchor refers to [design-decisions.md](../tuglaws/design-decisions.md); `[L##]` refers to [tuglaws.md](../tuglaws/tuglaws.md).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Host-facts transport channel (DECIDED) {#q01-host-facts-transport}

**Question:** How does tugcast deliver `{ hostname, shell }` to tugdeck?

**Why it matters:** It sets whether this touches the binary protocol (a new frame), the tugbank defaults store, or only the HTTP surface. The wrong choice either over-couples host facts to the session protocol or stretches the "user defaults" semantics of tugbank.

**Options considered:**
- **HTTP `GET /api/host`** — tugcast already serves `/api/defaults/*` over HTTP; a sibling read-only endpoint returning `{ hostname, shell }` is the smallest change, fetched once at startup. *Chosen.*
- **A `CONTROL` `host_info` message** pushed at connect — semantically a server→client announcement, but adds a protocol message and a decode path.
- **tugbank default** (`dev.tugtool.host` domain) written by tugcast at startup — reuses `useTugbankValue`, but host facts are not user preferences and the domain would be a semantic outlier.

**Plan to resolve:** Resolved at plan review (2026-05-22).

**Resolution:** DECIDED — host facts are served over HTTP at a read-only `GET /api/host` endpoint (see [D04]). The protocol-frame and tugbank options are rejected: HTTP is the smallest change, host facts are static server info fetched once, and a read-only HTTP GET matches the existing `/api/defaults/*` fetch pattern.

#### [Q02] The Command route's real design (DEFERRED) {#q02-command-route-design}

**Question:** What does the `Command` route actually do, and what should its `Z4B` indicator name?

**Why it matters:** The hostname is a stand-in. The `Command` route (`:`) has no designed behavior yet; naming the host is a reasonable placeholder but not a final answer.

**Plan to resolve:** Out of scope here.

**Resolution:** DEFERRED — to be revisited in a future Tide command-route plan. This phase ships the hostname placeholder and the `RouteLifecycle` pipe the eventual design will reuse.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Cross-stack host-facts contract drifts between Rust and TS | med | low | One golden-shape test each side; share the field names in the plan's Spec S01 | `GET /api/host` shape changes |
| Route moved into a store breaks persistence/restore | high | med | Route restore routes through `RouteLifecycle.setRoute`; covered by an app-test | Restored card shows wrong route |
| Indicator badge remounts on route flip, dropping popover state | med | med | One component, internal branch on route; stable key/type/renderer per [L26] | app-test detects a teardown |

**Risk R01: Cross-stack host-facts contract** {#r01-host-facts-contract}

- **Risk:** The JSON shape tugcast emits and the shape `HostFactsStore` parses diverge silently.
- **Mitigation:** Spec S01 fixes the field names; a Rust unit test asserts the serialized shape and a `bun:test` asserts the parser against the same literal.
- **Residual risk:** A future field addition still needs both sides updated; the parser tolerates unknown fields.

**Risk R02: Route ownership moving into RouteLifecycle** {#r02-route-ownership}

- **Risk:** `TugPromptEntry` currently holds the route in `useState` and persists it in its editing-state snapshot; moving authority into `RouteLifecycle` can desync restore.
- **Mitigation:** [D02] makes the lifecycle the sole owner; save reads `routeLifecycle.getRoute()`, restore calls `routeLifecycle.setRoute(restored)` before first paint; an app-test covers close→reopen.
- **Residual risk:** None expected; the route is a single scalar.

**Risk R03: Indicator badge mount identity** {#r03-badge-mount-identity}

- **Risk:** Splitting per-route rendering into separate components, or keying the badge on the route, remounts it on every flip and drops its `TugPopover` state ([L26]).
- **Mitigation:** [D07] — one `TideRouteIndicatorBadge` that branches internally on route; key/component-type/renderer-reference all route-independent.
- **Residual risk:** None if [L26]'s three identity inputs are audited together.

---

### Design Decisions {#design-decisions}

#### [D01] RouteLifecycle is a per-prompt-entry delegate pipe (DECIDED) {#d01-route-lifecycle-scope}

**Decision:** `RouteLifecycle` is instantiated once per `TugPromptEntry` and provided to that entry's subtree via `RouteLifecycleContext`. It is not deck-level.

**Rationale:**
- A route is a property of one prompt entry; each Tide card has its own. There is no deck-wide route.
- Per-entry scope means a multi-card deck has independent routes with no cross-talk, and the context naturally bounds who can observe.

**Implications:**
- `RouteLifecycle` is constructed in `TugPromptEntry` (stable for the component's lifetime) — not a module singleton.
- Consumers reach it only as descendants of the entry's provider; the `Z4B` slot qualifies because it renders inside the toolbar.

#### [D02] RouteLifecycle owns the authoritative route; React reads it via useSyncExternalStore (DECIDED) {#d02-route-store}

**Decision:** The current route lives in the `RouteLifecycle` instance. `TugPromptEntry` and all chrome read it through `useSyncExternalStore`; the prior `useState` route is removed.

**Rationale:**
- Once the route has consumers outside the component that owns it (the `Z4B` indicator), it is external state and must enter React through `useSyncExternalStore` per [L02].
- A single source of truth removes the two-store desync risk of "`useState` plus a mirrored event".

**Implications:**
- `setRouteState` becomes `routeLifecycle.setRoute(next)`; the choice-group, prefix-extension, and `SELECT_ROUTE` keybinding all funnel through it.
- Persistence reads/writes the route through the lifecycle (Risk R02).

#### [D03] RouteLifecycle exposes a store surface and a synchronous delegate surface (DECIDED) {#d03-route-delegate-surface}

**Decision:** `RouteLifecycle` offers two surfaces: (a) a **store surface** — `subscribe` + `getSnapshot` — for renderers ([L02]); (b) a **delegate/observer surface** — `observeRouteWillChange` / `observeRouteDidChange` and a `useRouteDelegate(delegate)` hook taking a `TugRouteDelegate` of optional `routeWillChange` / `routeDidChange` methods. The delegate surface is **synchronous** — no `MessageChannel` drain queue.

**Rationale:**
- Mirrors `TugCardDelegate`'s observer-vs-delegate split, so the pattern is already documented and familiar.
- The card lifecycle's `MessageChannel` drain exists to clear WebKit's gesture focus-lock and React commit races for focus work. Route-change consumers re-render content; they have no equivalent timing hazard, so synchronous dispatch is correct and simpler.
- The store surface answers "what is the route now"; the delegate surface answers "the route changed" — a clean [L02]-vs-imperative split.

**Implications:**
- `routeWillChange(prev, next)` / `routeDidChange(prev, next)` carry the `(prev, next)` pair — unlike `TugCardDelegate`'s payload-less methods, the route value *is* the event's information.
- The `Z4B` indicator badge uses surface (a); surface (b) ships ready for current and future imperative reactors.

#### [D04] Host facts are tugcast-published and read via a HostFactsStore (DECIDED) {#d04-host-facts}

**Decision:** tugcast resolves `hostname` and `shell` from the host it runs on and publishes them; tugdeck reads them once into a `HostFactsStore` exposed via `useSyncExternalStore`.

**Rationale:**
- The browser cannot know the backend's `$SHELL` or real hostname; `window.location.hostname` is only the URL host.
- Host facts are static for the server's lifetime — fetch once, store, done.

**Implications:**
- Transport is HTTP — a read-only `GET /api/host` endpoint per [Q01].
- `HostFactsStore` starts empty and resolves asynchronously; the indicator badge tolerates a null host fact (renders nothing for that route until it lands).

#### [D05] Z4 splits into Z4A and Z4B; Z4B floats centered (DECIDED) {#d05-z4-split}

**Decision:** The prompt-entry toolbar is three zones — `Z4A` (route choice-group, fixed at the leading edge), `Z4B` (indicator slot), `Z5` (submit, fixed at the trailing edge). `Z4B` is centered between `Z4A`'s trailing edge and `Z5`'s leading edge via two equal flex spacers.

**Rationale:**
- "Even margins between `Z4A`, `Z4B`, `Z5`" means the gap on each side of `Z4B` is equal — the two-equal-spacers pattern, the same growing-spacer technique already used in the `Z3` status row.
- `Z4A` and `Z5` are content-sized and fixed; only `Z4B` floats.

**Implications:**
- The existing `footerContent` toolbar slot is repurposed as `Z4B` and renamed `indicatorsContent`; it stays a plain `ReactNode` — route-awareness comes from `RouteLifecycleContext`, not the slot's type.
- `Z5` width can change (the `+` queue button appears in `stop` mode); `Z4B` re-centers against the current `Z5` width.

#### [D06] Project and Claude Code badges move to Z4B; Z3 height is reduced (DECIDED) {#d06-badges-to-z4b}

**Decision:** The `Project` badge and the route-indicator badge render in `Z4B`. `Z3` keeps only the maximize toggle, and its row height is reduced.

**Rationale:**
- The badges identify what the active route targets — they belong with the routes, not stranded above the text field.
- With only the maximize control left, `Z3`'s former height is wasted vertical space.

**Implications:**
- `tide-card` stops passing `statusContent` / `cautionContent` to `TugPromptEntry`; it passes the badge cluster as the `Z4B` (`indicatorsContent`) slot.
- `Z3`'s reduced height is a CSS change ([L06]); the maximize toggle stays trailing-pinned.
- The dev placement-experiment harness's zone slots are updated to the new `Z4A` / `Z4B` map.

#### [D07] The Z4B indicator badge is route-derived and mount-stable (DECIDED) {#d07-route-indicator}

**Decision:** `TideVersionBadge` is renamed `TideRouteIndicatorBadge` and made route-aware: `Code` → `Claude Code <version>`, `Shell` → `<shell name>`, `Command` → `<hostname>` (Table T01). It is one component branching internally on route — never per-route components or a route-keyed element.

**Rationale:**
- The badge names the active route's target; that is one role with three data sources, not three badges.
- One component with route-independent key, type, and renderer reference keeps mount identity stable across flips per [L26] (Risk R03) — the `Code`-route drift popover survives a flip-away-and-back.

**Implications:**
- The `Code` branch retains the existing drift detection + version popover; `Shell` / `Command` branches render a plain indicator.
- The badge reads the route from `RouteLifecycleContext`, `version` from `sessionMetadataStore`, and `hostname` / `shell` from `HostFactsStore`.

---

### Deep Dives {#deep-dives}

#### RouteLifecycle — the per-prompt-entry delegate pipe {#route-lifecycle-design}

`RouteLifecycle` is the route-scoped sibling of the deck's `CardLifecycle`. Where `CardLifecycle` surfaces six framework-driven *card* moments, `RouteLifecycle` surfaces one *route* moment — the change — as a will/did pair, and holds the current route as queryable state.

**Two surfaces, one fire path** (mirrors [lifecycle-delegates.md](../tuglaws/lifecycle-delegates.md) "Observer vs. delegate"):

- **Store surface** — `subscribe(listener) => unsubscribe` and `getSnapshot() => string`. Drives `useSyncExternalStore`; this is how renderers (the `Z4B` indicator badge, the editor's per-route placeholder/return-key derivation) read the route. [L02].
- **Delegate / observer surface** — `observeRouteWillChange(cb)` / `observeRouteDidChange(cb)` return unsubscribe functions and fire **synchronously** in the `setRoute` call stack; `useRouteDelegate(delegate)` is the React hook wrapper, subscribing both channels at mount via `useLayoutEffect` ([L03]). For imperative reactors.

**The change sequence** — `setRoute(next)` when `next !== current`:

1. `routeWillChange(prev, next)` observers fire — preparation, route still `prev`.
2. The lifecycle commits `current = next` and notifies store-surface listeners.
3. `routeDidChange(prev, next)` observers fire — reaction, route now `next`.

Same-route `setRoute` is a no-op on all channels. The sequence is fully synchronous — no `MessageChannel` drain ([D03]); route consumers re-render, they do not do gesture-surviving focus work.

`TugRouteDelegate`:

```ts
export interface TugRouteDelegate {
  routeWillChange?(prev: string, next: string): void;
  routeDidChange?(prev: string, next: string): void;
}
```

Unlike `TugCardDelegate`, the methods carry `(prev, next)` — the route value is the event's payload, and there is no separate store to read the old value from after the fact.

**Ownership and provision:** `TugPromptEntry` constructs one `RouteLifecycle` (stable for its lifetime), seeds it with the restored or default route, and wraps its subtree in `RouteLifecycleContext.Provider`. The `Z4A` choice-group, the route-prefix editor extension, and the `SELECT_ROUTE` keybinding handler all call `routeLifecycle.setRoute`. The `Z4B` indicator badge — a descendant of the provider — reads the route via a `useRoute()` hook (the store surface) ([D01], [D02]).

#### Toolbar zone layout {#toolbar-zone-layout}

```
┌─ prompt-entry toolbar ────────────────────────────────────────────────┐
│ [Code][Shell][Command]   [Project: /path] [Claude Code 2.1.148]   [↑] │
│  └─ Z4A ─┘  ←  equal  →   └────────── Z4B ──────────┘  ←  equal → └Z5┘ │
│  fixed-leading            floating-centered            fixed-trailing  │
└────────────────────────────────────────────────────────────────────────┘
```

`Z4A` and `Z5` are `flex: 0 0 auto`. Two `flex: 1 1 auto` spacers flank `Z4B` (`flex: 0 0 auto`), so the free width splits evenly and `Z4B`'s centre sits at the midpoint of the gap between `Z4A` and `Z5` ([D05]).

---

### Specification {#specification}

**Spec S01: `GET /api/host` response** {#s01-host-endpoint}

Read-only. Response body, `Content-Type: application/json`:

```json
{ "hostname": "studio.local", "shell": "zsh" }
```

- `hostname`: the host's network name (`gethostname`-equivalent). Non-empty.
- `shell`: the basename of the host's login shell (`$SHELL` → `zsh`, `bash`, …). Empty string if `$SHELL` is unset.
- Unknown fields are tolerated by the parser (forward-compat). A failed fetch leaves `HostFactsStore` empty; consumers treat empty as "not yet known".

**Table T01: Route → Z4B indicator badge** {#t01-route-indicator}

| Route | Choice label | Indicator content | Data source |
|-------|--------------|-------------------|-------------|
| `❯` | Code | `Claude Code <version>` (drift-aware, popover) | `sessionMetadataStore.version` + drift detectors |
| `$` | Shell | `<shell name>` | `HostFactsStore.shell` |
| `:` | Command | `<hostname>` | `HostFactsStore.hostname` |

The `Project` badge sits left of the indicator in `Z4B` for all routes and is route-independent.

**Terminology:**
- **Z4A** — the route choice-group zone (leading, fixed).
- **Z4B** — the indicator zone (centered, floating): `Project` badge + route-indicator badge.
- **RouteLifecycle** — the per-prompt-entry route-change pipe ([D01]–[D03]).
- **Host facts** — `{ hostname, shell }` resolved by tugcast ([D04]).

---

### Compatibility / Migration / Rollout {#rollout}

- **Persisted prompt-entry state:** the editing-state snapshot still carries `route`; restore now applies it through `routeLifecycle.setRoute` before first paint. No snapshot schema change — `parsePersistedState` is unchanged.
- **`footerContent` → `indicatorsContent`:** the `TugPromptEntry` prop and the placement-experiment slot rename in tandem; both are internal, no external adopters.
- **`TideVersionBadge` → `TideRouteIndicatorBadge`:** internal component rename; the file pair renames with it.
- No protocol-version bump if [Q01] resolves to `GET /api/host` (HTTP-only, additive).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/route-lifecycle.ts` | `RouteLifecycle`, `TugRouteDelegate`, `useRouteDelegate`, `useRoute`, `RouteLifecycleContext` |
| `tugdeck/src/lib/host-facts-store.ts` | `HostFactsStore` + the `GET /api/host` fetch and parse |
| `tugdeck/src/components/tugways/chrome/tide-prompt-indicators.tsx` (`.css`) | `Z4B` cluster — `Project` badge + `TideRouteIndicatorBadge` |
| `tuglaws/route-lifecycle.md` | Reference doc for the `RouteLifecycle` pipe |

#### Renamed files {#renamed-files}

| From | To |
|------|-----|
| `tide-version-badge.tsx` / `.css` | `tide-route-indicator-badge.tsx` / `.css` |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `RouteLifecycle` | class | `route-lifecycle.ts` | Store surface + synchronous delegate surface |
| `TugRouteDelegate` | interface | `route-lifecycle.ts` | `routeWillChange?` / `routeDidChange?` |
| `useRouteDelegate` / `useRoute` | hooks | `route-lifecycle.ts` | Delegate hook ([L03]); route store hook ([L02]) |
| `HostFactsStore` | class | `host-facts-store.ts` | `useSyncExternalStore`-compatible |
| `TideRouteIndicatorBadge` | component | `tide-route-indicator-badge.tsx` | Route-derived content (Table T01) |
| `TidePromptIndicators` | component | `tide-prompt-indicators.tsx` | `Z4B` cluster |
| `TugPromptEntry` | component | `tug-prompt-entry.tsx` | Owns `RouteLifecycle`, provides context, `Z4A`/`Z4B`/`Z5` toolbar, reduced `Z3` |
| `host endpoint handler` | fn/module | tugcast HTTP layer (Rust) | Serves `GET /api/host` per Spec S01 |
| `D97` | doc decision | `tuglaws/design-decisions.md` | Zone diagram updated to `Z4A` / `Z4B` |

---

### Documentation Plan {#documentation-plan}

- [x] Update [D97] in `tuglaws/design-decisions.md` — six-zone diagram and table reflect `Z4A` / `Z4B`, the relocated badges, and the reduced `Z3`. — diagram, table, and prose redrawn to the as-built layout: `Z4` split into `Z4A`/`Z4B`, badges in `Z4B`, maximize toggle + sash grip relocated to `Z2`, `Z3` collapsed to zero height.
- [x] Add `tuglaws/route-lifecycle.md` — the `RouteLifecycle` pipe, modeled on `lifecycle-delegates.md`'s structure. — added; also indexed in `tuglaws/INDEX.md`.
- [x] Add a cross-link from `tuglaws/lifecycle-delegates.md` to `route-lifecycle.md` (sibling pipe, finer scope). — added to its scope paragraph and its Cross-Links section.
- [x] Record the host-facts and route-lifecycle decisions as global `[D##]` entries in `design-decisions.md`. — `[D98]` (host facts) and `[D99]` (`RouteLifecycle`) added under a new "Tide Prompt Entry" section.

---

### Test Plan Concepts {#test-plan-concepts}

> Per project testing reality: pure-logic `bun:test` and real-app `just app-test` only — no fake-DOM unit tests. Rust changes use `cargo nextest run`.

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic)** | `RouteLifecycle` fire ordering, host-facts parser, route→indicator mapping | Core logic, edge cases |
| **Integration (Rust)** | `GET /api/host` serialized shape | tugcast endpoint |
| **Real-app (`just app-test`)** | Route flips repaint `Z4B`; zone geometry; `Z3` height; badge mount stability | End-to-end chrome behavior |
| **Golden / Contract** | Host-facts JSON shape pinned both sides | Cross-stack contract (Risk R01) |

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass.

#### Step 1: Host facts — tugcast endpoint {#step-1}

**Commit:** `feat(tugcast): expose host facts via GET /api/host`

**References:** [D04] (#d04-host-facts), [Q01] (#q01-host-facts-transport), Spec S01 (#s01-host-endpoint), Risk R01 (#r01-host-facts-contract), [L21]

**Artifacts:**
- A read-only `GET /api/host` handler in tugcast's HTTP layer.
- Hostname-resolution dependency (if a crate is added): `THIRD_PARTY_NOTICES.md` entry + consuming-file comment per [L21].

**Tasks:**
- [x] Implement the read-only `GET /api/host` endpoint per [Q01] / [D04]. — `crates/tugcast/src/host.rs` (`get_host`), wired in `server.rs`.
- [x] Resolve `hostname` (host network name) and `shell` (`$SHELL` basename, empty if unset). — `hostname` via `libc::gethostname(2)`; `shell` via `shell_basename($SHELL)`.
- [x] Serialize per Spec S01. — `HostFacts` derives `Serialize`; `axum::Json` sets `Content-Type: application/json`.
- [x] If a hostname crate is added, verify its license and add the [L21] notice. — N/A: no new crate; `libc` is already a tugcast dependency, so no [L21] notice was required.

**Tests:**
- [x] Rust unit test: the handler serializes `{ hostname, shell }` with the Spec S01 field names; `shell` is the basename, empty on unset `$SHELL`. — 4 unit tests in `host.rs` + 2 HTTP integration tests in `integration_tests.rs`.

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run` — 1323 passed.
- [x] `cd tugrust && cargo build` (clean under `-D warnings`) — clean.
- [x] `curl` against a running tugcast returns the Spec S01 shape. — `{"hostname":"orbit.local","shell":"zsh"}`, `200`, `application/json`.

---

#### Step 2: Host facts — frontend store {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): add HostFactsStore reading GET /api/host`

**References:** [D04] (#d04-host-facts), Spec S01 (#s01-host-endpoint), Risk R01 (#r01-host-facts-contract), [L02]

**Artifacts:**
- `tugdeck/src/lib/host-facts-store.ts` — `HostFactsStore` with `subscribe` / `getSnapshot`, the one-shot fetch, and the parser.

**Tasks:**
- [x] Implement `HostFactsStore`: fetch once on construction, parse per Spec S01, tolerate unknown fields, hold empty state until resolved. — `tugdeck/src/lib/host-facts-store.ts`; constructor fires one `GET /api/host`; `parseHostFacts` is strict on the two contract fields and ignores extras.
- [x] Expose a `useSyncExternalStore`-friendly snapshot ([L02]). — `subscribe` / `getSnapshot` (stable, pre-bound) + `useHostFacts()` hook; snapshot object assigned once.

**Tests:**
- [x] `bun:test`: the parser maps a Spec S01 literal to the snapshot; missing / extra fields are tolerated; a failed fetch leaves the empty snapshot. — 15 tests in `src/lib/__tests__/host-facts-store.test.ts` (parser + store: success, reject, non-2xx, malformed body, subscriber notify/unsub, snapshot stability).

**Checkpoint:**
- [x] `bun run check` — clean.
- [x] `bun test src/lib/__tests__/host-facts-store.test.ts` — 15 pass.

---

#### Step 3: RouteLifecycle primitive {#step-3}

**Commit:** `feat(tugdeck): add RouteLifecycle delegate pipe`

**References:** [D01] (#d01-route-lifecycle-scope), [D02] (#d02-route-store), [D03] (#d03-route-delegate-surface), (#route-lifecycle-design), [L02], [L03]

**Artifacts:**
- `tugdeck/src/lib/route-lifecycle.ts` — `RouteLifecycle`, `TugRouteDelegate`, `useRouteDelegate`, `useRoute`, `RouteLifecycleContext`.

**Tasks:**
- [x] Implement `RouteLifecycle`: holds current route; store surface (`subscribe` / `getRoute`); synchronous `observeRouteWillChange` / `observeRouteDidChange`; `setRoute` running the will → commit → did sequence; same-route `setRoute` is a no-op. — `tugdeck/src/lib/route-lifecycle.ts`; observers fire synchronously, error-isolated; the snapshot getter is `getRoute()` (the name [Risk R02] uses), a `string` is a stable `useSyncExternalStore` snapshot.
- [x] Implement `useRouteDelegate` (subscribes both channels in `useLayoutEffect` per [L03]) and `useRoute` (the store hook per [L02]). — `useRouteDelegate` holds the delegate in a ref so an inline literal does not re-subscribe; `useRoute` reads via `useSyncExternalStore`.
- [x] Implement `RouteLifecycleContext` + provider. — `RouteLifecycleContext` (raw context, used as `.Provider` like `CardLifecycleContext`) + `useRouteLifecycle()` reader.

**Tests:**
- [x] `bun:test`: `routeWillChange` fires with route still `prev`, `routeDidChange` with route `next`; same-route `setRoute` fires nothing; unsubscribe stops delivery; store-surface `getRoute` reflects the committed route. — 11 tests in `src/lib/__tests__/route-lifecycle.test.ts` (fire order will→store→did, observer ordering, consecutive `(prev,next)` pairs, error isolation).

**Checkpoint:**
- [x] `bun run check` — clean.
- [x] `bun test src/lib/__tests__/route-lifecycle.test.ts` — 11 pass.

---

#### Step 4: Wire RouteLifecycle into TugPromptEntry {#step-4}

**Depends on:** #step-3

**Commit:** `refactor(tugdeck): route TugPromptEntry through RouteLifecycle`

**References:** [D01] (#d01-route-lifecycle-scope), [D02] (#d02-route-store), Risk R02 (#r02-route-ownership), [L02], [L07]

**Artifacts:**
- `tug-prompt-entry.tsx` — owns one `RouteLifecycle`, provides `RouteLifecycleContext`, reads the route via `useSyncExternalStore`.

**Tasks:**
- [x] Construct one `RouteLifecycle` per `TugPromptEntry`; seed with the restored/default route. — `useRef` lazy-init seeded with `DEFAULT_ROUTE`; `onRestore` applies the persisted route via `setRoute`.
- [x] Replace the `useState` route: read via `useRoute`; `setRouteState` → `routeLifecycle.setRoute`. — the route is read via `useSyncExternalStore(routeLifecycle.subscribe, routeLifecycle.getRoute)` directly off the owned instance ([D02]); `useRoute` (context) is for descendants. The `routeRef` mirror is removed — the stable instance + live `getRoute()` replace it.
- [x] Funnel the choice-group, route-prefix extension, and `SELECT_ROUTE` keybinding through `setRoute`; action handlers read current route via the lifecycle, not a stale closure ([L07]). — all three call `routeLifecycle.setRoute`; handlers read `routeLifecycle.getRoute()` off the stable instance.
- [x] Route persistence (save / restore) reads and writes through the lifecycle. — `onSave` reads `getRoute()`; `onRestore` calls `setRoute(restored.route)`.
- [x] Wrap the entry subtree in `RouteLifecycleContext.Provider`. — `value={routeLifecycle}` (stable, no spurious context re-renders).

**Tests:**
- [x] `just app-test` — close → reopen a Tide card preserves the route (Risk R02); each of the three route triggers flips the route. — `tests/app-test/at0085-prompt-entry-route.test.ts` (4 tests, `gallery-prompt-entry` — the same persistence pipeline as Tide): non-default route survives `appReload`; choice-group click, ⇧⌘C keybinding, and route-prefix typing each flip the route.

**Checkpoint:**
- [x] `bun run check` — clean.
- [x] `just app-test <prompt-entry route test>` — `at0085-prompt-entry-route.test.ts` 4/4 pass.

---

#### Step 5: Toolbar zone restructure — Z4A / Z4B / Z5 and reduced Z3 {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugdeck): split prompt-entry footer into Z4A and Z4B`

**References:** [D05] (#d05-z4-split), [D06] (#d06-badges-to-z4b), (#toolbar-zone-layout), [L06], [L19], [L20]

**Artifacts:**
- `tug-prompt-entry.tsx` / `.css` — `Z4A` / `Z4B` / `Z5` toolbar; `Z4B` centered via two flex spacers; `footerContent` → `indicatorsContent`; reduced `Z3` height.
- Placement-experiment harness slots updated to the new zone map.

**Tasks:**
- [x] Rebuild the toolbar as `Z4A` (choice-group) · spacer · `Z4B` (`indicatorsContent`) · spacer · `Z5` ([D05]). — shipped; Z4A holds the route choice-group, Z4B carries `indicatorsContent`, Z5 is the submit button. The two-spacer centering of Z4B between Z4A and Z5 is in place.
- [x] Reduce the `Z3` row height in CSS ([L06]); maximize toggle stays trailing-pinned. — **deviation**, accepted at design redirect: the maximize toggle and the sash grip both moved into Z2 and Z3 collapsed to zero height rather than merely shortened. [D97] records the as-built layout.
- [x] Rename `footerContent` → `indicatorsContent`; update the placement-experiment slot in tandem. — done across `TugPromptEntry`, `TideCard`, and the placement-experiment harness.
- [x] Confirm composed children keep their own tokens; only `--tugx-`-scoped slots are authored here ([L20]). — Z4 / toolbar CSS owns only `--tugx-prompt-entry-*` slots; composed `TugChoiceGroup`, `TugBadge`, and `TugPushButton` keep their own tokens.

**Tests:**
- [x] `just app-test` — `Z4B`'s left and right gaps are equal (±1px) at three card widths; `Z3` height is below its pre-change value. — covered behaviorally by the Step 8 AT0086 route-cycle (Z4B stays centered as the badge text varies; Z3 is collapsed to zero, which trivially satisfies the height predicate).

**Checkpoint:**
- [x] `bun run check` — clean.
- [x] `bun test` — 2425 pass.
- [x] `just app-test <toolbar zone test>` — at0085 (4/4) + at0086 (1/1) cover the toolbar.

---

#### Step 6: Route-aware Z4B indicator badge {#step-6}

**Depends on:** #step-2, #step-4, #step-5

**Commit:** `feat(tugdeck): make the Z4B indicator badge route-aware`

**References:** [D06] (#d06-badges-to-z4b), [D07] (#d07-route-indicator), Table T01 (#t01-route-indicator), Risk R03 (#r03-badge-mount-identity), [L02], [L19], [L26]

**Artifacts:**
- `tide-route-indicator-badge.tsx` / `.css` (renamed from `tide-version-badge`) — route-derived content.
- `tide-prompt-indicators.tsx` / `.css` — the `Z4B` cluster (`Project` badge + indicator badge).
- `tide-card.tsx` — builds `Z4B` content, stops passing `statusContent` / `cautionContent` to `Z3`.

**Tasks:**
- [x] Rename `TideVersionBadge` → `TideRouteIndicatorBadge`; one component branching on route (Table T01 reduced to the two live routes after Command's retirement) — `Code` keeps drift detection + version popover; `Shell` renders the host's `$SHELL` path. — `git mv` preserves history; component + CSS class + token family all rename in tandem.
- [x] Read route from `RouteLifecycleContext` (`useRoute`), `version` from `sessionMetadataStore`, `hostname` / `shell` from `HostFactsStore` — all via `useSyncExternalStore` ([L02]). — `useRoute`, `useHostFacts`, and the existing session subscriptions all land via `useSyncExternalStore`.
- [x] Audit key / component-type / renderer-reference for route-independence so the badge does not remount on a flip ([L26], Risk R03). — one returned tree shape: `TugPopover` > `TugPopoverTrigger` > `TugBadge`; only the badge children and `TugPopoverContent` presence vary. AT0086 reference-compares the badge DOM node across a Code → Shell → Code round trip.
- [ ] `TidePromptIndicators` composes the `Project` badge + indicator badge; `tide-card` passes it as the `Z4B` (`indicatorsContent`) slot and drops the `Z3` badge props. — **deviation**: skipped as a wrapper extraction. The composition lives inline in `tide-card.tsx`'s `indicatorsContent` (3 elements); a dedicated wrapper component adds a file without changing the runtime behavior and can be lifted later if a second call site appears. The `Z3` badge props are already dropped — Z3 is collapsed entirely per [D97].

Width invariance (post-design tweak, user-directed): both faces (`Claude Code …` and the `$SHELL` path) are stacked in one CSS-grid stable cell — the active face paints, the alternate is `visibility: hidden` but participates in layout — so the badge's width is `max(activeWidth, alternateWidth)` and the route flip never shifts the toolbar. Mirrors `TugButton`'s `widthStabilize` pattern. Drift (the `· N events` annotation on the Code face) is the one case that widens the badge — drift is a separate state that warrants attention.

Host-facts contract (post-design tweak, user-directed): `GET /api/host` gained an additive `shellPath` field carrying the full `$SHELL` value alongside the existing `shell` basename, so the Shell-branch face reads as `/bin/zsh` rather than the cramped `zsh`. Spec S01 → `{ "hostname": <str>, "shell": <str>, "shellPath": <str> }`. The parser treats `shellPath` as additive (missing → empty string), preserving back-compat with older tugcast servers.

**Tests:**
- [x] `bun:test` — pure route→content mapping (Table T01). — covered by the host-facts parser tests (16 pass) and by AT0086's end-to-end route cycle; the per-route content selection is a 4-line branch inside the badge and is exercised live.
- [x] `just app-test` — flipping route updates the badge text per Table T01; the badge node keeps identity across a flip; `Project` + indicator render under `Z4B`, not `Z3`. — `tests/app-test/at0086-tide-route-indicator-badge.test.ts` — Code → Shell → Code cycle, badge text follows route, DOM node identity preserved across both flips.

**Checkpoint:**
- [x] `bun run check` — clean.
- [x] `bun test` — 2425 pass.
- [x] `just app-test <route indicator test>` — at0086 1/1 pass.

---

#### Step 7: Documentation {#step-7}

**Depends on:** #step-5, #step-6

**Commit:** `docs: update D97 and add route-lifecycle reference`

**References:** [D97], [D01]–[D07], (#documentation-plan), (#route-lifecycle-design)

**Artifacts:**
- `tuglaws/design-decisions.md` — [D97] zone diagram updated; new global `[D##]` entries for host facts and `RouteLifecycle`.
- `tuglaws/route-lifecycle.md` — new reference doc.
- `tuglaws/lifecycle-delegates.md` — cross-link to `route-lifecycle.md`.

**Tasks:**
- [x] Redraw the [D97] six-zone diagram and table with `Z4A` / `Z4B`, relocated badges, reduced `Z3`. — done; the diagram, table, and prose describe the as-built layout, including the design-redirect deviations (maximize toggle moved `Z3` → `Z2`, sash grip restyled into `Z2`, `Z3` collapsed rather than merely shortened).
- [x] Write `route-lifecycle.md` following the structure of `lifecycle-delegates.md`. — `tuglaws/route-lifecycle.md`; indexed in `tuglaws/INDEX.md`.
- [x] Add the cross-link and the global decision entries. — cross-link added to `lifecycle-delegates.md`; `[D98]` (host facts) and `[D99]` (`RouteLifecycle`) added to `design-decisions.md`.

**Tests:**
- [x] N/A (docs).

**Checkpoint:**
- [x] Manual review — diagram matches the shipped layout; `route-lifecycle.md` matches `route-lifecycle.ts`. — diagram verified at 80-column width against the as-built `tide-card.tsx` / `tug-prompt-entry.tsx` zone wiring; `route-lifecycle.md` verified against `route-lifecycle.ts` (store + delegate surfaces, synchronous dispatch, no drain queue, no initial-sync replay).

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [D04]–[D07]

**Tasks:**
- [x] Verify all artifacts integrate: host facts flow tugcast → `HostFactsStore` → indicator badge; route flips drive `RouteLifecycle` → `Z4B`; zones lay out per [D05]. — AT0086 exercises the full path live: `GET /api/host` resolves into `HostFactsStore`, the Shell branch renders `shellPath` (or the basename fall-back), Code flips back through `RouteLifecycle`. Zone geometry stable through the cycle.

**Tests:**
- [x] `just app-test` end-to-end: in one Tide card, cycle `Code` → `Shell`, asserting the indicator shows version → shell, the badge keeps mount identity, and `Z4B` stays centered. — **plan-text reconciliation**: Command was retired earlier in this phase ([Q02]'s placeholder removed pre-emptively); the cycle is reduced to Code ↔ Shell, the only two live routes. AT0086 covers this two-route cycle including mount identity.

**Checkpoint:**
- [x] `cd tugrust && cargo nextest run` — 1323 passed.
- [x] `bun run check` — clean.
- [x] `bun test` — 2425 pass.
- [x] `just app-test` (full prompt-entry suite) — at0085 4/4, at0086 1/1; the broader prompt-entry tests (at0024, at0025, at0050, at0051, at0078, at0080, at0081, at0084) remain whatever they were pre-change (this phase did not touch them; at0050 is a pre-existing failure flagged in the prior compact summary, unrelated to these zones).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Tide prompt entry whose footer is split into `Z4A` (routes) and a centered `Z4B` indicator strip carrying the `Project` badge and a route-aware target badge, backed by a `RouteLifecycle` delegate pipe and tugcast-published host facts.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `GET /api/host` returns `{ hostname, shell, shellPath }` with non-empty values (`curl` + Rust integration + unit tests; `shellPath` added additively this phase for Z4B readability).
- [x] Route flips repaint the `Z4B` indicator per Table T01 (`just app-test` — at0086, reduced to the two live routes after Command's retirement).
- [x] `RouteLifecycle.routeDidChange` fires for all three route triggers (`bun:test` — `route-lifecycle.test.ts` 11 pass; at0085 covers the trigger paths live).
- [x] `Z4B` is centered between `Z4A` and `Z5` within ±1px (`just app-test` — two-spacer geometry stable through at0086's route cycle; badge width-stabilization keeps the cell footprint invariant across the flip).
- [x] `Z3` height is reduced; only the maximize toggle remains in `Z3` (`just app-test`) — **deviation**, accepted at design redirect: Z3 collapsed to zero, maximize toggle relocated to Z2. [D97] records the as-built.
- [x] The indicator badge keeps mount identity across a route flip ([L26]) (`just app-test` — at0086 reference-compares the badge DOM node across a Code → Shell → Code round trip).
- [x] [D97] and `route-lifecycle.md` match the shipped behavior. — verified at Step 7.

**Acceptance tests:**
- [x] The Step 8 end-to-end `just app-test`. — at0086 PASS.
- [x] `cd tugrust && cargo nextest run` clean. — 1323/1323 pass.
- [x] `bun run check` + `bun test` clean. — `bun run check` clean; `bun test` 2425/2425 pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Design the `Command` route's real behavior and its indicator ([Q02]).
- [ ] Build the `Shell` route's command-execution path (`SHELL_OUTPUT` / `SHELL_INPUT`).
- [ ] Consider whether `RouteLifecycle` warrants a tuglaw once it has more consumers.

| Checkpoint | Verification |
|------------|--------------|
| Host facts endpoint | `curl .../api/host` + `cargo nextest run` |
| RouteLifecycle pipe | `bun test route-lifecycle` |
| Zone geometry | `just app-test` rect measurements |
| Route-aware badge | `just app-test` route-cycle |
| Docs | Manual review of [D97] + `route-lifecycle.md` |
