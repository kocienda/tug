/**
 * scale-timing.ts -- JS helpers for the global scale/timing/motion multipliers.
 *
 * Provides runtime access to the three global CSS custom properties defined on
 * :root in tug.css:
 *   --tug-zoom   continuous dimension multiplier (default 1)
 *   --tug-timing  continuous animation-duration multiplier (default 1)
 *   --tug-motion  binary motion toggle: 1 = on, 0 = off (default 1)
 *
 * Also provides initMotionObserver() which wires up the prefers-reduced-motion
 * media query and manages the data-tug-motion attribute on <body>. Call this
 * once during app boot (before DeckManager construction) so the attribute is
 * set from first paint.
 */

/** Read the current --tug-zoom value from :root computed style. Returns 1 if unset or unparseable. */
export function getTugZoom(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--tug-zoom").trim();
  const value = parseFloat(raw);
  return isNaN(value) ? 1 : value;
}

/** Read the current --tug-timing value from :root computed style. Returns 1 if unset or unparseable. */
export function getTugTiming(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--tug-timing").trim();
  const value = parseFloat(raw);
  return isNaN(value) ? 1 : value;
}

/**
 * The observer's cached answer, or `null` before anything has read one.
 *
 * `--tug-motion` is 0 in exactly one place — the `prefers-reduced-motion`
 * block in `tug.css` — and {@link initMotionObserver} already watches that
 * media query. So the value is knowable without asking the style system, and
 * asking is what mattered: {@link isTugMotionEnabled} is read by the deck's
 * `notify`, by every settle arm and by the sheet host, which put a
 * `getComputedStyle` on `<html>` inside the commit path ([B07]).
 */
let cachedMotionEnabled: boolean | null = null;

/** Read `--tug-motion` off computed style. The slow path, taken once. */
function readMotionFromStyle(): boolean {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--tug-motion").trim();
  const value = parseFloat(raw);
  return isNaN(value) ? true : value !== 0;
}

/**
 * Check whether motion is enabled. Returns false when --tug-motion is 0, true
 * otherwise.
 *
 * An INLINE `--tug-motion` on `<html>` wins, and is the one thing this cannot
 * cache: it is how a test turns motion off mid-run, and no media query fires
 * for it. Reading the inline style attribute is a property lookup on a
 * `CSSStyleDeclaration` the element already holds — it resolves nothing and
 * forces no recalc — so the fast path stays fast and the override stays live.
 */
export function isTugMotionEnabled(): boolean {
  const inline = document.documentElement.style.getPropertyValue("--tug-motion").trim();
  if (inline !== "") return parseFloat(inline) !== 0;
  if (cachedMotionEnabled === null) cachedMotionEnabled = readMotionFromStyle();
  return cachedMotionEnabled;
}

/**
 * Initialize motion attribute management.
 *
 * - Reads the prefers-reduced-motion media query on call
 * - Sets data-tug-motion="off" on <body> when motion is disabled
 * - Removes the attribute when motion is enabled
 * - Listens for media query changes and updates the attribute accordingly
 * - Returns a cleanup function that removes the listener
 *
 * Call once during app boot before DeckManager construction.
 */
export function initMotionObserver(): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");

  function applyMotionAttribute(reduced: boolean): void {
    // The cache and the attribute are one decision, written together: the
    // media query is the only thing that moves `--tug-motion`, so this is the
    // only place the cached answer can go stale ([B07]).
    cachedMotionEnabled = !reduced;
    if (reduced) {
      document.body.setAttribute("data-tug-motion", "off");
    } else {
      document.body.removeAttribute("data-tug-motion");
    }
  }

  // Apply immediately based on current media query state
  applyMotionAttribute(mq.matches);

  // Listen for changes (e.g., user changes system accessibility setting)
  function handleChange(event: MediaQueryListEvent): void {
    applyMotionAttribute(event.matches);
  }

  mq.addEventListener("change", handleChange);

  // Return cleanup function to remove the listener
  return () => {
    mq.removeEventListener("change", handleChange);
  };
}
