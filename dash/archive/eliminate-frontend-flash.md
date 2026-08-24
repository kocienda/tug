# Eliminate Frontend Flash on Reload

## Problem

Tugdeck flashes the entire UI during three scenarios:

1. **CSS edit in dev mode** — Editing a single color in `tokens.css` causes the
   entire display to flash, even though only one CSS variable changed.
2. **Frontend reload** — `location.reload()` (from dock menu, `reload_frontend`
   control frame, or browser refresh) shows a brief white/blank screen before the
   UI reappears.
3. **Backend restart** — The WebSocket drops, reconnection kicks in, and if a
   `reload_frontend` control frame is sent afterward, the same full-reload flash
   occurs.

The goal is to **never** flash the entire UI during any of these transitions.

## Root Cause Analysis

### Why CSS edits trigger a full page reload

The import chain is:

```
main.tsx
  ├── import "./globals.css"        ← CSS side-effect import
  │     ├── @import "tailwindcss"   ← Tailwind v4 virtual module
  │     └── @import "../styles/tokens.css"
  ├── import "../styles/chrome.css" ← CSS side-effect import
  └── import "@xterm/xterm/css/xterm.css"
```

Normally, Vite treats CSS imports as self-accepting HMR boundaries — a CSS change
replaces the `<style>` tag in-place without touching the JS module graph. However,
the `@tailwindcss/vite` plugin (Tailwind v4) recompiles `globals.css` whenever any
of its `@import` dependencies change. In some plugin versions and dependency
configurations, this recompilation triggers a module-graph invalidation that
propagates to `main.tsx`.

`main.tsx` has **no** `import.meta.hot.accept()` handler. It's the app entry point
with heavy side effects (creates `TugConnection`, `DeckManager`, registers cards,
creates the React root). When an HMR invalidation reaches a module without an
accept handler, Vite falls back to a **full page reload**.

**Evidence:** The `developer-card.tsx` component has a `vite:afterUpdate` listener
(line 225) that fires during HMR. If CSS edits were truly CSS-only HMR, this
listener would fire without any visual disruption. The fact that the entire display
flashes suggests the update reaches the module graph and triggers
`location.reload()` instead.

### Why full page reloads flash

`index.html` has a bare `<body>` with no inline styles:

```html
<body>
  <script src="/diagnostic.js"></script>
  <div id="deck-container"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
```

During a full page reload:

| Phase | What's visible | Duration |
|-------|---------------|----------|
| Old page teardown | Previous UI disappears | ~0ms (instant) |
| HTML parse | White/transparent body (no background) | ~5-20ms |
| CSS load + parse | Body gets `background-color: var(--td-canvas)` from `globals.css` | ~20-50ms |
| Settings fetch | `fetchSettingsWithRetry("/api/settings")` blocks React mount | ~50-200ms |
| Theme applied | Body class set (e.g., `td-theme-bluenote`) | ~0ms |
| React mount | DeckCanvas renders all cards | ~50-100ms |

The white flash occurs between "HTML parse" and "CSS load" — a window of 20-50ms
where the body has its default white background. Then there's a second flash
between "CSS load" and "React mount" where the background is correct but the
deck-container is empty.

### What does NOT cause a flash

- **Backend restart alone**: The WebSocket reconnection logic in `connection.ts`
  handles disconnect/reconnect gracefully. Feed data is cached in
  `DeckManager.lastPayload` and the React tree stays mounted. The `DisconnectBanner`
  component renders a yellow banner at the top, but card content remains visible.
  No flash — unless a `reload_frontend` control frame follows.

## Proposed Fix: Three Layers

### Layer A: Inline Body Styles (eliminates white flash)

**Impact: High. Effort: Minimal.**

Add inline styles to `<body>` in `index.html` that match the default Brio theme's
canvas appearance. These are applied immediately during HTML parse, before any CSS
files load.

**File:** `tugdeck/index.html`

```html
<body style="margin:0;padding:0;overflow:hidden;background-color:#1c1e22">
```

The value `#1c1e22` is Brio's `--tl-bg` (and `--td-canvas`). Once `globals.css`
loads, the CSS rule `body { background-color: var(--td-canvas); }` takes over,
but since it resolves to the same `#1c1e22`, there's no visible change.

For the grid pattern, we could also inline the background-image, but the
background-color alone eliminates the worst of the flash (white → dark is the
most jarring part). The grid appearing 20ms later is barely perceptible.

**Theme consideration:** The inline color matches Brio (default). If the user
has selected Bluenote (`#2a3136`) or Harmony (`#b0ab9f`), there will be a brief
transition from Brio's color to the actual theme color once CSS loads and the
theme class is applied. This is far less jarring than white → dark, but for
perfection, we could read the theme from the settings API and set the color
dynamically. However, that requires JS execution, which defeats the purpose of
inline styles. The Brio default is the right pragmatic choice.

### Layer B: Startup Overlay (hides mount transition)

**Impact: Medium. Effort: Small.**

Add a full-screen overlay div in `index.html` that covers the viewport with the
background color. This overlay hides the empty `deck-container` during the
settings-fetch and React-mount phases. Once the app is ready, remove it with a
short fade-out.

**File:** `tugdeck/index.html`

```html
<body style="margin:0;padding:0;overflow:hidden;background-color:#1c1e22">
  <div id="deck-startup-overlay"
       style="position:fixed;inset:0;background:#1c1e22;z-index:99999;
              pointer-events:none"></div>
  <script src="/diagnostic.js"></script>
  <div id="deck-container"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
```

**File:** `tugdeck/src/components/chrome/deck-canvas.tsx` (root component, first mount)

```tsx
// In DeckCanvas — deterministic overlay removal on first mount.
// useLayoutEffect fires after React commits DOM, before browser paints.
// This is the onContentReady pattern (Rules 11–12, D79) at viewport scope.
useLayoutEffect(() => {
  const overlay = document.getElementById("deck-startup-overlay");
  if (!overlay) return;
  const anim = animate(overlay, { opacity: [1, 0] }, {
    duration: "--tug-base-motion-duration-glacial",
    easing: "ease-out",
  });
  anim.finished.then(() => overlay.remove());
}, []);
```

`useLayoutEffect` with empty deps fires deterministically after React commits
the first render's DOM mutations, before the browser paints. The browser
composites both the React content and the first frame of the fade animation in
a single paint — the user never sees a frame where the overlay is gone but
content isn't rendered. TugAnimator's `.finished` promise handles cleanup.

**Why this works:** During a full page reload, the overlay covers the entire
viewport from the moment HTML is parsed. The user sees a continuous dark
background throughout the settings-fetch and React-mount phases. When the UI is
ready, the overlay fades away and the fully-rendered deck is revealed. No
`requestAnimationFrame`, no timing bets — a React contract (D79).

### Layer C: CSS HMR Boundary (prevents full reloads for CSS changes)

**Impact: High. Effort: Small.**

Create a dedicated CSS import module that acts as an HMR boundary. This prevents
CSS invalidations from propagating to `main.tsx` and triggering full page reloads.

**New file:** `tugdeck/src/css-imports.ts`

```ts
/**
 * CSS import module — isolates CSS from the main entry point.
 *
 * All CSS side-effect imports live here. This module explicitly accepts
 * HMR updates so CSS changes never propagate to main.tsx (which would
 * trigger a full page reload since main.tsx has no HMR accept handler).
 */
import "./globals.css";
import "../styles/chrome.css";
import "@xterm/xterm/css/xterm.css";

if (import.meta.hot) {
  // Accept self — CSS changes re-execute this module (which re-injects
  // the updated <style> tags) without touching anything upstream.
  import.meta.hot.accept();
}
```

**File:** `tugdeck/src/main.tsx` (replace the three CSS imports at the top)

```ts
// CSS imports isolated in their own HMR boundary module.
// Changes to globals.css, tokens.css, or chrome.css will hot-swap
// the <style> tags without triggering a full page reload.
import "./css-imports";
```

**How it works:** When `tokens.css` changes:
1. `@tailwindcss/vite` recompiles `globals.css`
2. Vite detects the CSS module changed
3. Vite walks the module graph: `globals.css` → `css-imports.ts`
4. `css-imports.ts` has `import.meta.hot.accept()` — the update stops here
5. `css-imports.ts` is re-executed, which re-injects the updated `<style>` tags
6. `main.tsx` is NOT touched — no full page reload

**Risk:** `css-imports.ts` re-executing means the CSS import side effects run
again. In Vite, this is safe — the old `<style>` tags are replaced, not
duplicated. But we should verify with manual testing that no style tags leak.

### Layer C Alternative: Self-accepting main.tsx (more invasive)

If Layer C doesn't work (e.g., the Tailwind plugin invalidates at a different
level), the alternative is to make `main.tsx` itself accept HMR updates for the
CSS dependency:

```ts
// At the bottom of main.tsx
if (import.meta.hot) {
  // Accept CSS module changes without re-executing the entire entry point.
  // The accept callback receives the updated module but we don't need it —
  // Vite's CSS pipeline handles <style> tag replacement automatically.
  import.meta.hot.accept("./globals.css", () => {});
  import.meta.hot.accept("../styles/chrome.css", () => {});
}
```

This is more surgical but also more fragile — it assumes Vite's HMR API
recognizes CSS modules as valid dependency arguments for `accept()`.

## Implementation Plan

### Step 1: Layer A — Inline body styles

1. Edit `tugdeck/index.html`:
   - Add `style="margin:0;padding:0;overflow:hidden;background-color:#1c1e22"`
     to the `<body>` tag.
2. Verify: full page reload no longer shows a white flash (body is dark from
   the first paint).

### Step 2: Layer B — Startup overlay

1. Add the `deck-startup-overlay` div to `index.html` (before `deck-container`).
2. Add `useLayoutEffect` to DeckCanvas that triggers TugAnimator fade-out on the overlay (see code above).
3. Verify: full page reload shows a continuous dark background, then the deck
   fades in smoothly.

### Step 3: Layer C — CSS HMR boundary

1. Create `tugdeck/src/css-imports.ts` with CSS imports and HMR accept.
2. Replace CSS imports in `main.tsx` with `import "./css-imports"`.
3. Verify: editing a color in `tokens.css` updates the UI without a full page
   reload. Check the browser console for `[vite] css hot updated` (good) vs
   `[vite] page reload` (bad).

### Step 4: Verify all three scenarios

- [ ] Edit a CSS color in `tokens.css` → no flash, color updates in-place
- [ ] Click "Reload Frontend" in dock menu → dark background throughout, smooth
      fade-in of the deck
- [ ] Restart the backend → disconnect banner appears, cards stay visible, no
      flash on reconnection
- [ ] Full browser refresh (Cmd+R) → same as "Reload Frontend" behavior

## Testing Notes

### Browser console markers

The codebase already has debug logging for HMR:

- `[dev-flash] main.tsx module executed` — logged when `main.tsx` runs. If this
  appears after a CSS edit, Vite is doing a full page reload.
- `[dev-flash] vite:afterUpdate received` — logged when HMR completes
  successfully. If this appears WITHOUT the main.tsx log, CSS HMR is working
  correctly.

After implementing Layer C, editing `tokens.css` should produce only the
`vite:afterUpdate` log, not the `main.tsx module executed` log.

### Vite HMR console messages

Vite logs its own HMR decisions to the browser console:

- `[vite] css hot updated: /src/globals.css` — CSS-only HMR (desired)
- `[vite] page reload` — full page reload (undesired for CSS changes)

## Files Touched

| File | Change |
|------|--------|
| `tugdeck/index.html` | Add inline body styles, add startup overlay div |
| `tugdeck/src/main.tsx` | Replace CSS imports with `./css-imports` |
| `tugdeck/src/components/chrome/deck-canvas.tsx` | `useLayoutEffect` triggers TugAnimator overlay fade-out on first mount |
| `tugdeck/src/css-imports.ts` | **New file** — CSS imports with HMR boundary |

## Open Questions

1. **Grid background in inline style?** Including the grid pattern
   (`background-image`) in the inline body style would be more faithful to the
   final appearance but makes the HTML noisier. The grid appearing ~20ms after
   the solid background is likely imperceptible. Worth testing.

2. **Theme-aware inline color?** The inline `#1c1e22` matches Brio (default).
   For Bluenote/Harmony users, there's a brief color shift when CSS loads. An
   alternative is a tiny inline `<script>` that reads a cookie or
   `localStorage` value and sets the background color accordingly — but this
   adds complexity and the current settings model uses server-side storage
   (no localStorage fallback per D03).

3. **Tailwind v4 HMR behavior:** The `@tailwindcss/vite` plugin's HMR behavior
   may vary across versions. Layer C should be tested against the currently
   pinned version (Tailwind 4.2.1). If the plugin is updated later, re-verify
   that CSS edits don't trigger full reloads.

4. **Production builds:** Layers A and B apply to both dev and production.
   Layer C (HMR boundary) only affects dev mode (`import.meta.hot` is
   tree-shaken in production builds). No production impact.
