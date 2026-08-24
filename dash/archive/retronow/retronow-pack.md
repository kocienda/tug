# Retronow shadcn + Tailwind Pack

This workspace now includes a Retronow starter pack for modern app UIs and card-based canvas layouts.

## Files

- `styles/retronow-tailwind.css`
  - Tailwind v4 theme bridge (`@theme`) + Retronow component utility classes.
  - Includes shadcn variable mappings (`--background`, `--primary`, `--border`, etc).
- `styles/retronow-shadcn.css`
  - Additional shadcn token override layer and slot polish.
- `styles/retronow-deck.css`
  - Card/canvas system styles with visible grid, snap affordances, and resize handles.
- `components/retronow/retronow-classes.ts`
  - Central class recipes for Retronow-styled controls and cards.
- `components/retronow/RetronowControlPack.tsx`
  - Control showcase pack covering input, textarea, combo, button, slider, radio, checkbox, and address bar pattern.
- `components/retronow/RetronowDeckCanvas.tsx`
  - React card deck canvas with drag, resize, and 24px snap behavior.
- `components/retronow/RetronowComponentPackPage.tsx`
  - Full React page mockup showing wrapper-style component interactions end-to-end.
- `mockups/retronow-deck-canvas-mockup.html`
  - Browser-openable deck/canvas mockup with draggable, snap-aligned cards.

## Quick Integration (shadcn + Tailwind)

1. Import your base shadcn globals first.
2. Then import:
   - `styles/retronow-tailwind.css`
   - optionally `styles/retronow-shadcn.css`
3. Add `className="retronow"` to your app shell root.
4. Style shadcn components by applying class recipes from `retronow-classes.ts`.
5. Optional: render `<RetronowComponentPackPage />` in a route to preview everything quickly.

## Suggested Next Step

Create app-level wrappers so teams consume Retronow consistently:

- `AppButton` -> wraps shadcn `Button` + `retronow.button`
- `AppInput` -> wraps shadcn `Input` + `retronow.input`
- `AppCardWindow` -> wraps shadcn `Card` + `retronow.shell`

Use Lucide icons (`lucide-react`) in title bars, controls, and card toolbars for a coherent visual language.
