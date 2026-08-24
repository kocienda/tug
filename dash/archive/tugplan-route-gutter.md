# Tugplan: Route Indicator as Gutter Element

**Status:** Proposed
**Scope:** `tugdeck/src/components/tugways/tug-prompt-entry.{tsx,css}`, one prop removal on `<TugPromptInput>`, persistence migration helper.
**Non-goal:** removing `setRoute` / `routePrefixes` / `detectRoutePrefix` from `TugPromptInput` and the engine — they stay as a general capability for future consumers.

## Motivation

The current route indicator is an inline `<img>` atom at position 0 of the prompt-input's text flow. It was a cheap first cut — reusing the atom pipeline — but it has repeatedly proven to be the wrong model:

- **Special cases leak into the input.** `isEffectivelyEmpty` has to treat a bare route atom as empty. `handleInputChange` has to auto-insert the atom when the user types into an empty input. `setRoute` has to clear and re-insert to swap the atom.
- **Caret placement is semantically broken.** The caret can land at position 0, *before* the route atom — as if the route were part of the user's text, which it isn't.
- **Bulk edit is broken.** Select-all + Delete empties the input, and the first keystroke after pops the route atom back in. The user never asked for that.
- **Visual alignment is fiddly.** Extra right margin on the atom, caret inset at position 1, baseline offsets — none of it quite lines up.

The route is **not** part of the user's text. It's a property of the input itself — a mode, a header. The right primitive is a **gutter**: a static element rendered next to the text area, outside the text flow.

## Design

### Layout

Extend `.tug-prompt-entry-input-area` into a two-column flex row:

```
┌──────────────────────────┐
│ status row              │
│ [gutter] [   editor   ] │
│ toolbar                 │
└──────────────────────────┘
```

The gutter is a fixed-width column that renders the current route's lucide icon, vertically aligned with the first visual line of the editor. The editor fills the remaining space as today.

### Icons

| Route   | Prefix | Lucide          |
|---------|--------|-----------------|
| Prompt  | `>`    | `ChevronRight`  |
| Shell   | `$`    | `DollarSign`    |
| Command | `:`    | `Puzzle`        |

The same icons replace the current `<span aria-hidden>…</span>` children in `ROUTE_ITEMS` so the choice-group segments read consistently with the gutter.

### What gets removed from TugPromptEntry

- The `routePrefixes` prop on `<TugPromptInput>`.
- The `onRouteChange={handleRouteChange}` prop and the `handleRouteChange` callback.
- The `input.setRoute(...)` call in the SELECT_VALUE handler.
- The route-atom auto-insert branch in `handleInputChange` (everything after the `data-empty` write).
- The bare-route-atom special case in `isEffectivelyEmpty` — it collapses to `input?.isEmpty() ?? true`.

### What stays

- Per-route draft persistence (`savedContentByRouteRef` + Tugcard payload) — still keyed by route.
- Per-route history (`currentHistoryProvider`, `RouteHistoryProvider`) — still scoped by route.
- Sticky route state across submit.
- Per-route `returnAction` mapping.

### Persistence migration

Tugbank may hold pre-change drafts that contain `type: "route"` atoms in their `text` / `atoms` pair. On `useTugcardPersistence.onRestore`, sanitize each `perRoute` entry before applying: strip atoms where `type === "route"` and remove their `\uFFFC` placeholders from `text`, shifting subsequent atom positions and selection offsets. One-pass helper; no version bump needed.

## Tuglaws Check

- **[L06]** Gutter appearance via CSS; icon selection is driven by route state (React state, low-frequency, discrete events — not keystroke-rate). ✓
- **[L22]** No direct DOM writes; React renders the icon when route state changes. ✓
- **[L11]** Route changes still flow through the responder chain via SELECT_VALUE. ✓

## Steps

1. **Swap choice-group icons.** Replace the three `<span>…</span>` nodes in `ROUTE_ITEMS` with the corresponding lucide components at `size={12}`.
2. **Add the gutter to the entry layout.** New `.tug-prompt-entry-gutter` element inside `.tug-prompt-entry-input-area`, flexed alongside `TugPromptInput`. Renders the lucide icon for the active route. Width + padding tuned so the editor's text baseline doesn't shift versus today.
3. **Unwire atom-based route handling.** Remove `routePrefixes`, `onRouteChange`, and `setRoute`/auto-insert sites as listed above. Delete `handleRouteChange`. Simplify `isEffectivelyEmpty`.
4. **Migrate persisted state on restore.** Add a `stripRouteAtoms(state)` helper and call it inside `onRestore` before `restoreState` / `savedContentByRouteRef` assignment.
5. **Visual tuning.** Gutter color (muted by default, accent on focus?), icon size vs. editor font, vertical centering on the first line. Eyeball against the current route-atom and confirm the baseline is unchanged.

## Acceptance

- ⌘A + Delete empties the input cleanly; nothing pops back in.
- Caret never lands to the left of the route indicator (it can't — the indicator isn't in the text flow).
- Typing the literal character `>`, `$`, or `:` at position 0 leaves it as text, not an atom.
- The choice-group and the gutter show the same icon for the current route.
- Reload from a pre-change draft renders without an orphan `>`/`$`/`:` atom.
