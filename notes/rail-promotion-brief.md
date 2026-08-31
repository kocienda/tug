# Rail Promotion: the sidebar rails become the keyboard entities

**Purpose:** Promote the left and right sidebar rails to first-class keyboard entities, retire the per-card sidebar toggle chords, and make the rail arrangement ready to hold more than two members — clearing the ground for the Lens breakout that follows.

---

## Purpose {#purpose}

The sidebar is about to grow from three cards to six (the Lens dissolves into Cards, Dashes, Layout, and Tripwires — see `notes/lens-breakout-brief.md`). Today's keyboard grammar gives each sidebar card its own ⌃⌘⟨letter⟩ toggle, and that grammar cannot scale: the letters the new cards would want are already spent or forbidden. The user reports not using the per-card toggles in actual work. The move is to give the chords to the rails themselves — one gesture per side — and demote the per-card toggles to chord-less, rebindable menu rows.

---

## Evidence {#evidence}

**[F01] The sidebar chords today.** `toggle-lens` ⌃⌘L, `toggle-jots` ⌃⌘J, `toggle-overview` ⌃⌘O — all `routing: "registry"`, `menuEligible`, with empty Swift key equivalents so `applyCommandChords` writes them and they stay rebindable. Plus `focus-lens` ⌘L (`first-responder` routing, not menu-eligible) and `new-jot` ⌘J. All in `tugdeck/src/components/tugways/command-registry.ts` (~lines 1608–1800); handlers in `tugdeck/src/components/chrome/deck-canvas.tsx` (~1543–1576) and `tugdeck/src/action-dispatch.ts` (~518–540); Swift items `maker.lens` / `maker.jots` / `maker.overview` in `tugapp/Sources/AppDelegate.swift` (~1331). **(verified)**

**[F02] No rail-addressed chord exists.** Nothing binds "the left rail" or "the right rail" as such; a rail exists only as a consequence of a sidebar card being visible. The nearest machinery is `toggleSidebarCard` in `tugdeck/src/sidebar-toggle.ts:33` — a three-state ladder per card: hidden → show + activate (keyboard-modality focus transfer); showing but not first responder → activate; showing and first responder → hide. **(verified)**

**[F03] The letter grammar dies of collisions at six cards.** Cards wants ⌃⌘C (taken — `toggle-changes-view`); Tripwires wants ⌃⌘T (taken — `next-theme`); Dashes wants ⌃⌘D (macOS Dictionary, on the never-bind list in `tuglaws/chord-tiers.md`). The tier's occupancy line lists A, B, C, F, G, H, I, J, K, L, M, P, T, U in use. **(verified)**

**[F04] ⌃⌘← and ⌃⌘→ are free.** The macOS never-bind list reserves *plain* ⌃-arrows (Spaces / Mission Control), not the ⌘ composition — the exact argument the split family already made for ⌃⌘↑/↓ (`move-in-column`), which is pinned by the routing-drift guard. Nothing in `command-registry.ts` claims the ⌃⌘ horizontal arrows. **(verified against the registry; the pressed-chord check on a running app remains to be done in the dash, per the probe warning in `chord-tiers.md`.)**

**[F05] Rails hold N members in the data model but have only ever held two on screen.** `imposition.rails[side]` is `{ mode?, order?, shares? }` keyed by componentId (`tugdeck/src/lib/layout-imposer.ts:200`), with stack/split modes, seam drags, the stack badge/picker, and drag-to-zone all live. The *columns* record (`imposition.columns`) is documented in `tuglaws/pane-model.md` as "the exact shape `imposition.rails` holds per side" and columns carry the 3+-member overflow geometry (past ~2.5 members, stop dividing and scroll the strip on a per-slot offset). Rails have no such overflow rule — a split rail with four members would produce slivers. **(verified in doctrine; the rail split path read but not exercised at >2.)**

---

## Decisions {#decisions}

**[B01] ⌃⌘← toggles the left rail; ⌃⌘→ toggles the right rail.** Tug tier — a rail is layout vocabulary, alongside ⌃⌘↑/↓ `move-in-column`, whose axis these complete horizontally. Arrows are R1-exempt under R2; the mnemonic is the geometry itself. The semantics are `toggleSidebarCard`'s three-state ladder lifted from card to rail: rail hidden → show it and focus its frontmost member; shown but focus elsewhere → focus its frontmost member; focus inside the rail → hide the rail. Showing a rail shows the members that were open when it was hidden (membership churn never destroys the arrangement — the [L23] rule the rails already keep). Both chords are `menuEligible` with empty Swift key equivalents, per the discipline every sidebar toggle already follows.

**[B02] The per-card toggles retire to chord-less menu rows.** `toggle-lens`, `toggle-jots`, `toggle-overview`, and `focus-lens` lose their default chords; Show ⟨card⟩ rows remain in the menu with `bindings: []` — a command with no *default* chord, not one that refuses a chord — so the keymap pane can still bind them. This is the demotion shape the card widths already took (`chord-tiers.md`, "The card widths gave the digits up"), and it rests on the same rate argument: the user does not reach for these. ⌃⌘L, ⌃⌘J, ⌃⌘O, and ⌘L return to their pools. (`toggle-lens` and `focus-lens` themselves are deleted outright when the Lens card dies in the breakout dash; until then they stand chord-less.)

**[B03] ⌘J New Jot survives untouched.** It is a capture verb, not a toggle, and its R3 frequency claim is unchanged.

**[B04] The rail split takes the column overflow geometry.** Port the 3+-member rule from columns to rails — equal heights at run/2.5, a per-side offset property, activate-reveals — so a split rail past two members scrolls instead of slivering. `pane-model.md` already frames rails and columns as one implementation over two kinds of place; this closes the one asymmetry. Stack mode needs nothing: the badge/picker handles any depth today.

**[B05] `chord-tiers.md`'s sidebar-toggle family section is rewritten in the same change.** The family's own text anticipated a third card arriving "already knowing its chord"; the honest update is that the per-card letter grammar retires and the rail pair replaces it, recorded with this derivation so the next reader inherits the reasoning. `menus.md`'s generated chord table regenerates via `menus-doc.test.ts`.

---

## Open Questions {#open-questions}

- **Which member takes focus on a split rail?** The ladder says "frontmost", which is well-defined for a stack (z-front) but a split rail shows every member. Likely answer: the `selected` member the stack-badge menu already tracks, else the top of the rail order — but settle it in the dash by reading how `railFrontmostPaneId` (`deck-canvas.tsx:480`) resolves today.

---

## Non-goals {#non-goals}

- **The Lens breakout itself.** This dash only makes the rails ready; the four new cards arrive in the next dash (`notes/lens-breakout-brief.md`).
- **New ⇧/⌥ compositions on the rail chords.** No "move card to other side" chord, no "focus rail without toggling" chord. The three-state ladder covers focus; anything more waits for demonstrated need.
- **Keeping any per-card sidebar chord as a default.** Considered and rejected: retaining even one (say ⌘J-adjacent) re-opens the letter-scaling problem the rail promotion exists to close. Rebinding in the keymap pane remains available to anyone who misses one.

---

## Exit {#exit}

A direct **`/dash`** — not a plan. The decisions are made above; the shape is clear; the parts (registry entries, handlers, Swift menu rows, the rail overflow port, the doctrine rewrite, tests) order themselves. The dash's task list is written from this brief. This dash joins before the breakout dash begins, so the rail machinery lands under test against the existing three sidebar cards.
