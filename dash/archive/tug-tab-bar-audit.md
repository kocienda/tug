# tug-tab-bar Phase 2 Audit

Component: `tugdeck/src/components/tugways/tug-tab-bar.tsx` + `tugdeck/src/components/tugways/tug-tab.css`

Core logic (overflow system, drag threshold) is well-engineered. Surface-level authoring compliance is poor — the most technical debt of any Phase 2 component so far.

---

## Findings

### Critical

1. **Raw `--tug-color()` in component CSS** — 4 aliases in `body{}` use `--tug-color()`, which is a build-time theme transform allowed only in theme files. All 4 are also dead aliases (see #2), so the fix is deletion.

2. **14 dead aliases in `body{}`** — 27 aliases defined, only 11 referenced by any `var()` call. Dead: `--tugx-tab-bg-rest`, `--tugx-tab-bg-compact`, `--tugx-tab-fg-compact`, `--tugx-tab-badge-fg`, `--tugx-tab-ghost-bg`, `--tugx-tab-ghost-border`, `--tugx-tab-dropTarget-bg`, `--tugx-tab-dropTarget-border`, `--tugx-tab-overflow-trigger-bg`, `--tugx-tab-overflow-trigger-fg`, `--tugx-tab-add-bg-hover`, `--tugx-tab-add-fg`, `--tugx-tab-typePicker-bg`, `--tugx-tab-typePicker-fg`.

3. **No `data-slot`** — Root div has `data-testid="tug-tab-bar"` but not `data-slot="tug-tab-bar"`.

4. **No `forwardRef`, closed props interface, no `...rest` spread** — Component is a plain function. `TugTabBarProps` doesn't extend `React.ComponentPropsWithoutRef<"div">`. Root div can't receive caller className, style, data-*, aria-*, or event handlers.

5. **CSS file name mismatch** — Component is TugTabBar but CSS file is `tug-tab.css`. Should be `tug-tab-bar.css` per naming convention.

6. **Missing compact `@tug-pairings` block** — Only has expanded table. Compact machine-readable block required alongside it.

### Moderate

7. **Plan spec references everywhere** — TSX docstring: "Spec S01", "Spec S03", "Spec S08", "Table T01", anchor tags. CSS: "Phase 5b4", "Phase 5b2", "Phase 5b5", "Spec S03/S05/S06/S07", "[Rule 4]". All prohibited.

8. **Missing minimum law citations** — Docstring needs [L06], [L16], [L19]. Currently has [D01]-[D04] (fine) but zero law citations.

9. **CSS import not first** — Line 36, after 5 other imports. Should be the first import.

10. **Pairings table noise** — Parenthetical short names like `(element-global-border-normal-default-rest)` clutter every cell.

### Not Issues

- Overflow system design: appearance-zone/structural-zone split is clean and correct.
- Drag threshold pattern: well-documented, correct.
- Keyboard accessibility: `role="tab"`, `aria-selected`, `tabIndex`, Enter/Space.
- Uses TugButton + TugPopupMenu for overflow and add buttons (not raw buttons).
- ResizeObserver cleanup: disconnect + RAF cancel.

---

## Dash Plan (Single Dash)

All 4 `--tug-color()` usages are dead aliases — no theme token migration needed, just deletion. Everything fits in one dash.

### Work Items

**TSX (`tug-tab-bar.tsx`):**
- Rewrite module docstring: purge Spec/Table/anchor refs, add [L06], [L16], [L19] + [D01]-[D04]
- Move CSS import to first position
- Convert to `React.forwardRef`, extend props with `Omit<React.ComponentPropsWithoutRef<"div">, "role">` (since root has `role="tablist"`)
- Add `data-slot="tug-tab-bar"` to root div
- Spread `...rest` on root div
- Purge remaining Spec/Table/Rule refs from code comments (useTabOverflow docstring, inline comments)

**CSS (`tug-tab.css` → `tug-tab-bar.css`):**
- Rename file from `tug-tab.css` to `tug-tab-bar.css`
- Update import in `tug-tab-bar.tsx`
- Delete 14 dead aliases from `body{}`
- Add compact `@tug-pairings` block
- Clean expanded pairings table: remove parenthetical short names
- Purge all Phase/Spec/Rule refs from CSS section comments
- Replace "[Rule 4]" with "[L06]"

### Checkpoints

- `bun run build` exits 0
- `bun run test` exits 0
- `bun run audit:tokens lint` exits 0
- No `--tug-color()` in component CSS
- No Spec/Phase/Table/Rule refs in either file
- `data-slot="tug-tab-bar"` present on root
- 11 aliases in `body{}` (25 total − 14 dead)

### Surviving Aliases (11)

```
--tugx-tab-bar-bg           → line 64  (.tug-tab-bar background)
--tugx-tab-bg-hover         → line 111 (.tug-tab hover bg)
--tugx-tab-bg-active        → line 104 (.tug-tab active bg)
--tugx-tab-fg-rest          → line 89  (.tug-tab color)
--tugx-tab-fg-hover         → line 112 (.tug-tab hover color)
--tugx-tab-fg-active        → line 105 (.tug-tab active color)
--tugx-tab-close-bg-hover   → line 199 (.tug-tab-close hover bg)
--tugx-tab-close-fg-hover   → line 200 (.tug-tab-close hover color)
--tugx-tab-underline-active → line 106 (.tug-tab active underline)
--tugx-tab-badge-bg         → line 278 (.tug-tab-overflow-badge bg)
--tugx-tab-insertIndicator  → line 321 (.tug-tab-insert-indicator bg)
```
