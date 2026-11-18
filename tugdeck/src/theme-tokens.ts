/**
 * theme-tokens.ts — Runtime API for reading theme token values and
 * observing theme changes.
 *
 * getTokenValue reads the current resolved value of a CSS custom property.
 * subscribeThemeChange lets non-React code observe theme changes without
 * pulling state into React [L22]; it returns the unsubscribe.
 *
 * The theme provider calls notifyThemeChange when the theme switches.
 * In production, CSS is guaranteed to be applied at that point (stylesheet
 * load event). In dev mode (HMR), CSS may not be applied yet — the
 * notification defers until the sentinel token value actually changes.
 */

import { createSubscribable } from "@/lib/subscribable";

// Sentinel token — used to detect when CSS has been applied after a theme change.
// Must differ between themes. --tugx-host-canvas-color is designed for this.
const SENTINEL_TOKEN = "--tugx-host-canvas-color";

const _subscribers = createSubscribable();
let _cachedSentinel = "";
let _pendingObserver: MutationObserver | null = null;

/** Read the current resolved value of a CSS custom property. */
export function getTokenValue(tokenName: string): string {
  return getComputedStyle(document.body).getPropertyValue(tokenName).trim();
}

/** Subscribe to theme change notifications. Returns the unsubscribe. */
export function subscribeThemeChange(callback: () => void): () => void {
  return _subscribers.subscribe(callback);
}

/**
 * Reflect the active theme's light/dark appearance onto
 * `<html data-theme-mode>` so component CSS can branch on it (e.g. thicker
 * accent rings on the pale light-theme fields). The value comes from each
 * theme's own `--tugx-theme-appearance` metadata token, read from applied CSS
 * — same mechanism as `--tugx-host-canvas-color`. Defaults to `dark` when the
 * token is absent (the base theme is dark).
 */
function reflectThemeAppearance(): void {
  const mode = getTokenValue("--tugx-theme-appearance") === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme-mode", mode);
}

/** Fire all theme change subscribers. */
function fireSubscribers(): void {
  reflectThemeAppearance();
  _subscribers.notify();
}

/**
 * Called by the theme provider when the theme changes.
 *
 * Checks if CSS has already been applied by comparing a sentinel token
 * against the cached value. If applied, fires subscribers immediately.
 * If not yet applied (dev mode HMR race), sets up a MutationObserver
 * on document.head and fires when the sentinel actually changes.
 */
export function notifyThemeChange(): void {
  // Disconnect any pending observer from a previous call
  if (_pendingObserver) {
    _pendingObserver.disconnect();
    _pendingObserver = null;
  }

  const current = getTokenValue(SENTINEL_TOKEN);
  if (current !== _cachedSentinel && _cachedSentinel !== "") {
    // CSS already applied — fire immediately
    _cachedSentinel = current;
    fireSubscribers();
    return;
  }

  // CSS not yet applied — observe document.head for stylesheet changes
  _pendingObserver = new MutationObserver(() => {
    const now = getTokenValue(SENTINEL_TOKEN);
    if (now !== _cachedSentinel) {
      _cachedSentinel = now;
      _pendingObserver!.disconnect();
      _pendingObserver = null;
      fireSubscribers();
    }
  });
  _pendingObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/**
 * Fire theme-change subscribers immediately, without the sentinel
 * comparison {@link notifyThemeChange} uses.
 *
 * A theme *switch* changes the sentinel token, so `notifyThemeChange`
 * can wait for it to flip. A token-value *edit* within the active theme
 * (the dev/HMR iterate-on-look-and-feel loop) does NOT change the
 * sentinel — the same theme, different values — so the sentinel-gated
 * path would wait forever. Subscribers that bake token values at
 * construction (the editor's atom-chip widgets, which resolve colors via
 * `getTokenValue` into an isolated `<img>` data-URI) must re-bake to
 * reflect the edit; React-side chips repaint for free via CSS cascade.
 * The HMR bridge calls this after a `styles/themes/*.css` edit lands.
 */
export function notifyThemeStyleEdit(): void {
  fireSubscribers();
}

/**
 * Initialize the sentinel cache. Called once at startup so the first
 * notifyThemeChange has a baseline to compare against.
 */
export function initThemeTokens(): void {
  _cachedSentinel = getTokenValue(SENTINEL_TOKEN);
  reflectThemeAppearance();
}
