# Keyboard Command Cleanup — Brief

Decisions locked 2026-08-06. This brief captures the modifier-key design philosophy, the resolved shortcut outliers, and the concrete changes to make before the systematic menu-by-menu command audit begins. Grounded in [L30] (every user-invocable command is a registry entry; every emitter goes through the two funnels) and [tuglaws/commands.md](../tuglaws/commands.md).

## Part 1 — The design: modifier algebra

Chord assignment is governed by an algebra, not an enumerated tier list: **two base tiers and two operators**. Every modifier set in use is a composition of these, so every chord's shape is explainable in one sentence.

### Base tiers

- **⌘ — the universal tier.** Verbs any Mac user already knows (Save, Find, Copy, Close, Quit) plus the highest-frequency Tug verbs (Focus Prompt ⌘K, Cycle Stack ⌘R). Digits are places: ⌘1–9 = slots, ⌘0 = actual size.
- **⌃⌘ — the Tug tier.** Tug's own machinery: surfaces, shades, modes, themes, app-specific features. This is where Tug gets to be Tug without colliding with thirty years of ⌘ conventions. (⌃⌘F Full Screen is the macOS-conventional resident that anchors the tier.)

### Operators (each adds one modifier; the key stays the same)

- **⇧ = the counterpart.** Reverse, widen, or undo the base command: ⌘Z → ⇧⌘Z Redo, ⌘G → ⇧⌘G Find Previous, ⌘S → ⇧⌘S Save As, ⌃⌘A Claim All → ⌃⇧⌘A Disclaim All.
- **⌥ = the variant.** Same verb, altered object or form: ⌘W Close → ⌥⌘W Close All, ⌘V Paste → ⌥⌘V Paste as Quote, ⌘N New Session → ⌥⌘N New Text File, ⌘H Hide → ⌥⌘H Hide Others.
- **⌥⇧ = both twists.** Composed, never assigned fresh: "…as Plain Text" is always ⌥⇧⌘ (⌥⇧⌘C, ⌥⇧⌘V — the latter matching the macOS "Paste and Match Style" convention exactly). First/Last Turn (⌥⇧⌘↑/↓) are the ⇧-extremes of Previous/Next Turn (⌥⌘↑/↓).
- **⌃⌥⌘ = the variant/advanced form of a Tug-tier command** — the "super-advanced" tier. Debut resident: Cycle Permission Mode ⌃⌥⌘P (permission modes govern agent autonomy — the quintessential expert feature). ⌃⇧⌘ likewise exists by composition, not decree.

### Rules

1. **The pairing rule.** A ⇧/⌥-composed chord must share its key with the base command it twists. If a proposed chord has no base to vary, it is either a plain-⌘ candidate or a ⌃⌘ Tug-tier command — the modifier stack is never used just because plain ⌘ was taken.
2. **The arrows exemption.** Arrow-key chords are exempt from the pairing rule (⌘↑/↓ is text/history currency in the composer, so ⌥⌘↑/↓ turn navigation has no ⌘ base). ⇧ still means "to the extreme" on arrows.
3. **The scarcity rule.** Plain ⌘'s remaining free slots are granted only to commands a user hits many times an hour; everything else enters through its semantic tier.
4. **Closed sets.** Plain ⌥ letters type glyphs (⌥e → é); plain ⌃ letters belong to the text caret (the emacs set — ⌃U/⌃W are declared substrate currency in `ACTIONS_OUTSIDE_THE_TABLE`). Both are closed forever. Non-printing exceptions grandfathered: ⌥⇥ Cycle Focus Mode, ⌃` Cycle Panes.
5. **⌘. parity.** Wherever ⎋ cancels — dialogs, sheets, alerts, popovers, menus — ⌘. cancels identically. This is a law of the app, not a per-component choice.
6. **Menu placement is a chord decision.** Menu-eligible chords resolve at the native menu layer before any scoped binding (commands.md, four-layer resolution), so every chord grant records both its tier justification and its menuEligible/scope choice — one decision, not two.

### The free pool (plain ⌘, for future grants)

- **Safest:** ⌘D, ⌘Y (weak conventions).
- **Claimable with honest use:** ⌘J (jump/go-to), ⌘E (Find-adjacent).
- **Hold in reserve:** ⌘B, ⌘U (bold/underline — Tug renders markdown), ⌘P (print reflex; only accepted repurposing is a command palette).
- **Punctuation:** ⌘' ⌘; ⌘\ free; ⌘[ / ⌘] reserved for any future back/forward navigation concept.
- **Freed by this cleanup:** ⇧⌘P, ⇧⌘C, ⇧⌘H, ⇧⌘M, ⌥⌘T, ⌘I.

### macOS reserved (never bind)

⌘Space, ⌘⇥, ⌘` · ⌃↑/↓/←/→, ⌃Space · ⌃⌘Q (lock screen), ⌃⌘D (dictionary), ⌃⌘Space (emoji) · ⇧⌘3/4/5 (screenshots), ⇧⌘Q (log out), ⇧⌘/ (Help search) · ⌥⌘⎋ (force quit).

## Part 2 — The shortcut changes

| Command | Now | Becomes | Rationale |
|---|---|---|---|
| Prompt Route (`select-composer-route:prompt`) | ⇧⌘P | **⌃⌘P** | Route selection is Tug machinery |
| Cycle Permission Mode (`cycle-permission-mode`) | ⌃⌘P | **⌃⌥⌘P** | Vacates ⌃⌘P; debuts the advanced tier |
| Show/Hide Changes (`toggle-changes-view`) | ⇧⌘C | **⌃⌘C** | Shade toggles are Tug machinery |
| Show/Hide History (`toggle-history-view`) | ⇧⌘H | **⌃⌘H** | Twin of Changes; moves with it |
| Generate a Commit Message (`commit-auto-message`) | ⇧⌘M (composer-scoped) | **⌃⌘M** (still composer-scoped) | Joins the Changes cluster: ⌃⌘C changes, ⌃⌘M message, ⌃⌘A claim |
| Claim All | none (button only) | **⌃⌘A** (new registry entry, Changes-shade scope) | One mnemonic neighborhood with ⌃⌘C/⌃⌘M |
| Disclaim All | none (button only) | **⌃⇧⌘A** (new registry entry, Changes-shade scope) | The ⇧-counterpart of Claim All; one finger from its pair |
| Next Theme (`next-theme`) | ⌥⌘T | **⌃⌘T** | Themes are Tug machinery |
| Insert File (`insert-file`) | ⌘I | **⌃⌘I** | Frees ⌘I (italic baggage) back to the pool |

**Unchanged, ratified as-is:** ⌥⌘/ Show DevTools vs ⌘/ Command Picker; ⌥⌘↑/↓ turn navigation + ⌥⇧⌘↑/↓ first/last (covered by the arrows exemption).

**⌘. parity sweep.** Five components hand-match ⌘./⎋ today even though `cancel-dialog` owns both chords in the registry: `tug-alert.tsx`, `tug-confirm-popover.tsx`, `tug-sheet.tsx`, `tug-placard.tsx`, `tug-editor-context-menu.tsx`. They convert to one shared matcher that consumes the `cancel-dialog` chords from `keymapRegistry` (the sanctioned pattern — cf. `tug-prompt-entry.tsx` reading `bindingsOf(COMMIT_AUTO_MESSAGE)`). Then a sweep for ⎋-handling surfaces that lack ⌘. parity, adding it everywhere per rule 5.

## Part 3 — Deliverables

1. **New doctrine doc `tuglaws/chord-tiers.md`** — Part 1 of this brief in full: the algebra, the rules, the free-pool ledger, the reserved list. Cross-linked from `tuglaws/commands.md` and the [L30] entry in `tuglaws/tuglaws.md`; one new row in `tuglaws/design-decisions.md` recording the adoption.
2. **Registry edits in `command-registry.ts`** — the nine chord moves/additions above, including new `claim-all` / `disclaim-all` entries (title, routing, scope, bindings) wired to the existing Changes-shade actions.
3. **The ⌘. parity sweep** — shared cancel-chord matcher, five components converted, ⎋-surface audit and parity additions.
4. **Verification** — keymap pane rows and native menu mirror pick up every move via the existing registry sweep (no Swift chord edits expected; construction-time literals for moved chords should be updated or dropped to registry-supplied, matching the `session.previousTurn` precedent); `bunx vite build`; `just app-test-changed`; registry lints (`lintCommandTable`, `lintChordCollisions`) green.

## Loose ends (deferred to the menu-by-menu pass)

- **Cascade ⌃⌥C / Tile ⌃⌥T** sit in a set the algebra doesn't generate (⌃⌥ with no ⌘). Candidate homes exist (⌃⌥⌘ as window-arrangement advanced commands); decide with the whole Window menu on the table.
- The systematic menu-by-menu audit itself: score every menu item against the tiers, fix names per [action-naming.md](../tuglaws/action-naming.md), record menuEligible/scope per chord, and grant from the free pool where frequency earns it.
