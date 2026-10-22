/**
 * tugdeck/src/hmr-bridge.ts
 *
 * Bridge Vite's HMR pre-update / pre-full-reload events into the
 * deck-manager save pipeline so user-visible state survives the
 * React Fast Refresh remounts that follow a hot-replaced module.
 *
 * # Why this exists
 *
 * The Component State Preservation Protocol
 * (`tuglaws/state-preservation.md`) captures bag.content /
 * bag.components / bag.scroll / bag.formControls / bag.regionScroll /
 * bag.domSelection / bag.focus at a small, deliberate set of "known
 * transitions": tab deactivation, `saveState` RPC, `beforeunload`,
 * close-before-destroy. Outside those moments, the framework writes
 * nothing — DOM stays mounted across in-app transitions, so there is
 * nothing to preserve.
 *
 * Vite's HMR breaks that assumption. When an upstream module change
 * (e.g. a CSS-token tweak in `tug-text-editor/theme.ts`) invalidates a
 * downstream React component (`tug-text-editor.tsx`), Fast Refresh remounts
 * the component. The DOM is torn down — but none of the four
 * known-transition triggers fire, because HMR is not a user-visible
 * event the framework knows about. CM6's internal text state, scroll
 * position, selection, and any other state owned by a non-React
 * authority is silently lost.
 *
 * This module makes HMR a fifth (and sixth, counting full-reload)
 * known transition. Vite's HMR API exposes synchronous events
 * (`vite:beforeUpdate`, `vite:beforeFullReload`) that fire before
 * any module replacement applies. We register handlers that fire the
 * same iterate-and-save pass `beforeunload` already runs; the bag
 * lands in deck-manager's in-memory cache before Fast Refresh
 * remounts anything. The matching restore-side change (in
 * `card-host.tsx`) detects the no-op-pair → real-callbacks
 * transition that signals a content-factory remount and replays the
 * bag through the existing `onRestore` path.
 *
 * # Theme-only update fast path
 *
 * Theme switches (the user clicks a theme, or edits a token value in
 * `styles/themes/*.css`) only mutate CSS — no React-side state
 * depends on the outgoing theme. Running `captureAllForTeardown` for
 * those HMR passes is wasted work that scales with per-card bag size
 * (e.g. the prompt-entry's bytes-store of inline image attachments).
 *
 * The dev server's `themeSaveLoadPlugin` and `controlTokenHotReload`
 * broadcast a `tug:theme-changed` custom HMR event immediately before
 * re-rendering the `virtual:tug-active-theme.css` module. WebSocket
 * order is TCP-preserved, and the resulting `vite:beforeUpdate` is
 * processed milliseconds later — so the client always sees the
 * custom event first. We use that as a reliable discriminator
 * because the path-suffix approach doesn't work (Vite reports the
 * JS-graph accept boundary, not the file that actually changed).
 *
 * The arming is time-bounded so a stale arming (the rare case where
 * a theme event fires but the matching `vite:beforeUpdate` never
 * does) can't suppress capture on a later unrelated HMR pass.
 *
 * # Why a bridge module rather than inline in main.tsx
 *
 * Keeping the Vite-specific surface (`import.meta.hot.*`) in a
 * named module makes the dev-only contract greppable, lets the
 * docstring explain the design once, and gives the file a
 * deterministic identity for the self-HMR pattern below.
 *
 * # Production safety
 *
 * `import.meta.hot` is `undefined` in production builds — Vite
 * strips it during the production bundle pass. The function body
 * therefore compiles to dead code in shipped bundles; the module
 * itself is tree-shakeable to nothing if the lone `installHmrBridge`
 * import is removed by the bundler. In practice the call site in
 * `main.tsx` survives, but the early-return ensures zero runtime
 * cost.
 *
 * # Self-HMR safety
 *
 * If THIS module is itself hot-replaced (someone edits this file),
 * Vite will re-evaluate the body. Without `accept`, the new body's
 * `on(...)` calls add fresh listeners while the old listeners may
 * remain alive — every subsequent HMR would then fire the save pass
 * twice (or N times after N edits to this file). The bridge changes
 * rarely; we forfeit the marginal benefit of incremental update
 * here and ask Vite to do a full page reload instead by calling
 * `import.meta.hot.invalidate()` from inside `accept`. One
 * registration, ever.
 *
 * # Laws
 *
 * [L23] (preserve user-visible state across known transitions —
 * adds HMR to the recognized set);
 * [L03] (`import.meta.hot.on` registration runs at module init,
 * before any React render, before any keyboard / pointer event);
 * [L07] (handler closes over `deck` — a stable singleton
 * constructed once in `main.tsx` — and reads through it at call
 * time, not via stale closure capture of any deck-internal state);
 * [L10] (the bridge sits at the deck level; it calls a public
 * method on the deck-manager and does not reach into card or pane
 * internals);
 * [L19] (file follows tugways file-conventions: module docstring,
 * single named export);
 * [L21] (`import.meta.hot.*` is Vite's own runtime API, not
 * third-party code we are copying — no `THIRD_PARTY_NOTICES.md`
 * entry needed).
 */

import type { DeckManager } from "./deck-manager";
import {
  readHostCanvasColorFromAppliedCss,
  sendCanvasColor,
} from "./contexts/theme-provider";
import { notifyThemeStyleEdit } from "./theme-tokens";
import { reportHmrLanded } from "./lib/hmr-landed";
import { installScopedReload } from "./lib/scoped-reload";

/**
 * One-shot arming window for the `tug:theme-changed` HMR signal.
 * See module docstring for the handshake rationale.
 */
const THEME_ARMED_WINDOW_MS = 2_000;
let _themeArmedAt: number | null = null;
/**
 * Companion arm — flipped by `tug:theme-changed` and consumed by
 * the next `vite:afterUpdate` so the Swift bridge can be re-fired
 * with the new `--tugx-host-canvas-color` after the CSS update has
 * actually landed (reading on `beforeUpdate` would see stale value).
 */
let _canvasRebridgeArmed = false;

function armThemeSkip(): void {
  _themeArmedAt = performance.now();
  _canvasRebridgeArmed = true;
}

function consumeThemeSkip(): boolean {
  if (_themeArmedAt === null) return false;
  const age = performance.now() - _themeArmedAt;
  _themeArmedAt = null;
  return age <= THEME_ARMED_WINDOW_MS;
}

function consumeCanvasRebridge(): boolean {
  const armed = _canvasRebridgeArmed;
  _canvasRebridgeArmed = false;
  return armed;
}

/**
 * Wire HMR pre-update events into the deck-manager save pipeline.
 *
 * Called once at app startup, immediately after the `DeckManager`
 * is constructed in `main.tsx`. The bridge stays installed for the
 * lifetime of the page (no teardown helper); the `import.meta.hot`
 * guard makes it a no-op in production.
 */
export function installHmrBridge(deck: DeckManager): void {
  // Capture once at function scope. TypeScript narrows
  // `import.meta.hot` from `ImportMetaHot | undefined` to
  // `ImportMetaHot` after the early-return, but capturing to a
  // local makes the closure semantics in the listener bodies
  // explicit — there is one HMR API instance, and every handler
  // reads through it.
  const hot = import.meta.hot;
  if (!hot) return;

  // Theme-only updates are pre-signalled by the dev server's plugins
  // (POST `/__themes/activate` and `controlTokenHotReload`) via a
  // `tug:theme-changed` custom HMR event. Arm the one-shot skip so
  // the subsequent `vite:beforeUpdate` bypasses
  // `captureAllForTeardown` — theme switches only mutate CSS and
  // don't need React-side state preservation to fire.
  hot.on("tug:theme-changed", () => {
    armThemeSkip();
  });

  // `vite:beforeUpdate` fires synchronously before any HMR module
  // update applies. Triggering the save pass here means the bag is
  // in deck-manager's cache by the time React Fast Refresh starts
  // remounting components. The handler matches the body of
  // `handleBeforeUnload` because `captureAllForTeardown` is the
  // shared implementation; the only difference is the trace tag.
  hot.on("vite:beforeUpdate", () => {
    if (consumeThemeSkip()) return;
    deck.captureAllForTeardown("hmr");
  });

  // `vite:beforeFullReload` fires when Vite gives up on incremental
  // HMR and decides to do a full page reload (e.g., a change Vite
  // can't apply incrementally). Acts as a defensive sibling of
  // `beforeunload`: if both fire, the second one's call to
  // `captureAllForTeardown` is a no-op via the
  // `reloadPending` / `stateFlushed` guard.
  hot.on("vite:beforeFullReload", () => {
    deck.captureAllForTeardown("hmr-full-reload");
  });

  // A reload the dev server scoped to the shell (`lib/scoped-reload.ts`):
  // the same capture a full reload runs, then the reload the host
  // intercepts. One naming only the bodies or the overlay passes the shell by.
  installScopedReload(hot, "shell", () => deck.captureAllForTeardown("hmr-full-reload"));

  // `vite:afterUpdate` fires after an incremental HMR update has been
  // applied. Notify the native host so the dev-info overlay's "load"
  // timestamp reflects when fresh modules came online. Full reloads go
  // through the WebView's didFinish navigation path on the native side
  // and are not reported here.
  hot.on("vite:afterUpdate", (payload) => {
    // If a theme-css edit just landed, re-read the active host canvas
    // color from the updated stylesheet and re-fire the Swift bridge
    // so the native window backdrop tracks the edit live. Reading on
    // `beforeUpdate` would see the pre-edit value — the CSS swap has
    // to land first.
    if (consumeCanvasRebridge()) {
      const hex = readHostCanvasColorFromAppliedCss();
      if (hex) sendCanvasColor(hex);
      // The token edit has landed in the stylesheet. React-side chips
      // repaint via CSS cascade, but the editor's atom-chip widgets bake
      // their colors into an isolated `<img>` data-URI at construction —
      // re-bake them so an atom-token tweak (e.g. tuning chip colors)
      // shows up live in the editor too, not just the transcript.
      notifyThemeStyleEdit();
    }

    reportHmrLanded(payload);
  });

  // Self-HMR: ask Vite to do a full page reload if THIS module is
  // hot-replaced, rather than re-evaluating the body and stacking
  // a duplicate set of listeners on top of the old ones.
  hot.accept(() => {
    hot.invalidate();
  });
}
