# tug-popup-menu Phase 2 Audit

Component: `tugdeck/src/components/tugways/tug-popup-menu.tsx` + `tugdeck/src/components/tugways/tug-menu.css`

Core logic (Radix integration, selection blink animation, trigger inversion) is solid. Surface-level compliance needs work — Spec refs, alias chain violation, hardcoded values, stale docs.

---

## Findings

### Critical

1. **Two-hop alias chain [L17 violation]** — `tug-menu.css:59-72`: all `--tugx-dropdown-*` aliases chain through `--tugx-menu-*` (e.g., `--tugx-dropdown-bg: var(--tugx-menu-bg)` where `--tugx-menu-bg: var(--tug7-...)`). Must resolve to `--tug7-*` in one hop. Fix: point `--tugx-dropdown-*` directly at `--tug7-*` tokens, or collapse the two alias tiers into one.

2. **Hardcoded values instead of tokens** — `tug-menu.css` uses raw rem values where design tokens exist:
   - Line 216: `border-radius: 0.5rem` → `var(--tug-radius-md)`
   - Line 230: `border-radius: 0.375rem` → `var(--tug-radius-sm)`
   - Line 218: `padding: 0.25rem` → `var(--tug-space-xs)`
   - Lines 235-236: `gap: 0.5rem; padding: 0.375rem 0.5rem` → `var(--tug-space-sm)`, `var(--tug-space-xs) var(--tug-space-sm)`
   - Line 237: `font-size: 0.8125rem` → `var(--tug-font-size-sm)`

3. **Missing compact `@tug-pairings` block** — Only has expanded table.

### Moderate

4. **Spec references (4 occurrences)** — Lines 23, 24, 32, 40, 60: "Spec S02", "Spec S03". Prohibited.

5. **"Rule 4" instead of [L06]** — Line 99: `"Rule 4 compliant"` should be `[L06]`.

6. **Missing law citations** — Docstring needs [L06], [L11], [L19]. Currently only has [D01]-[D05].

7. **CSS import not first** — Line 30 after React and Radix imports. Should be first.

8. **Stale TugDropdown paragraph** — Lines 16-18 describe TugDropdown's behavior ("TugDropdown owns its trigger button internally..."), not TugPopupMenu's. Dead documentation from migration.

9. **Pairings table has parenthetical noise** — Every cell has `(short-name)` clutter.

### Not Issues

- Selection blink animation: well-implemented (WAAPI, completion sequencing, .catch() error recovery).
- Radix portal rendering: avoids z-index conflicts.
- `asChild` trigger inversion: clean separation of trigger presentation from menu logic.
- Blinking guard (blinkingRef): prevents re-entrant selection calls.
- CSS file name `tug-menu.css`: shared infrastructure file covering menu/popover/tooltip — name is appropriate.

---

## Dash Plan (Single Dash)

### Work Items

**TSX (`tug-popup-menu.tsx`):**
- Rewrite module docstring: purge Spec refs, remove stale TugDropdown paragraph, add [L06], [L11], [L19]
- Move CSS import to first position
- Replace "Rule 4 compliant" with [L06] (line 99)
- Purge remaining Spec refs from type comments and interface docstrings

**CSS (`tug-menu.css`):**
- Fix two-hop alias chain: collapse `--tugx-dropdown-*` aliases to resolve directly to `--tug7-*` tokens
- Replace hardcoded rem values with design tokens (border-radius, padding, gap, font-size)
- Add compact `@tug-pairings` block
- Clean expanded pairings table: remove parenthetical short names

### Checkpoints

- `bun run build` exits 0
- `bun run test` exits 0
- `bun run audit:tokens lint` exits 0
- No two-hop alias chains in body{}
- No hardcoded rem values in .tug-dropdown-content or .tug-dropdown-item
- No Spec/Rule refs in either file
