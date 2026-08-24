# Move TugPopupMenu to internal/

## Rationale

TugPopupMenu is infrastructure composed by multiple public components — app code should never import it directly. This mirrors TugButton, which is already in `internal/`.

**Current importers:**
- `tug-popup-button.tsx` — convenience wrapper (public)
- `tug-tab-bar.tsx` — overflow + add menus (public)
- `gallery-popup-button.tsx` — gallery demo (educational, not production)

App code always uses TugPopupButton (for standard popup buttons) or TugTabBar (for tab menus). There is no scenario where app code should import TugPopupMenu directly.

Per component-authoring.md:
> - It provides infrastructure that multiple public components compose
> - App code should never import it directly — there's always a more appropriate public component
> - Moving it to `internal/` reduces confusion about which component to choose

## Work Items

1. **Move files:**
   - `tugways/tug-popup-menu.tsx` → `tugways/internal/tug-popup-menu.tsx`
   - `tugways/tug-menu.css` stays where it is (shared menu/popover/tooltip infrastructure, already imported by relative path from the component)

2. **Update imports (3 files):**
   - `tug-popup-button.tsx`: `"./tug-popup-menu"` → `"./internal/tug-popup-menu"`
   - `tug-tab-bar.tsx`: `"./tug-popup-menu"` → `"./internal/tug-popup-menu"`
   - `gallery-popup-button.tsx`: `"@/components/tugways/tug-popup-menu"` → `"@/components/tugways/internal/tug-popup-menu"`

3. **Re-export types from public components:**
   - `tug-popup-button.tsx` already re-exports `TugPopupMenuItem` — good
   - Verify `tug-tab-bar.tsx` doesn't need to re-export anything (it doesn't — tab bar callers pass `TabItem[]`, not `TugPopupMenuItem[]`)

4. **Update module docstring:**
   - Add "Internal building block — app code should use TugPopupButton instead." per authoring guide rule

5. **Update audit-tokens.ts:**
   - If the file list references `tug-popup-menu`, update path

## Checkpoints

- `bun run build` exits 0
- `bun run test` exits 0
- `bun run audit:tokens lint` exits 0
- No direct imports of `tug-popup-menu` from outside `tugways/` or `tugways/internal/` (except gallery)
