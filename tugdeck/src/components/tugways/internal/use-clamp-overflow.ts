/**
 * Internal building block — app code should use `Clamp` instead.
 *
 * Measures whether a content element's natural height exceeds an N-line
 * cap and returns the overflow verdict, so a clamp container can decide
 * whether a "Show more" reveal is even warranted. The cap is computed from
 * the element's own resolved line-height (`lines × lineHeightPx`) and
 * written back onto the element as the `--tug-clamp-cap` custom property —
 * the CSS clamp rule consumes that variable for its `max-height`, so the
 * window tracks a real visual line count rather than a guessed height.
 *
 * The cap is re-measured on size / content changes via a `ResizeObserver`.
 * `scrollHeight` reports the full content height regardless of the clamp's
 * own `max-height`, so the verdict holds in both the collapsed and
 * expanded states.
 *
 * @module components/tugways/internal/use-clamp-overflow
 */

import React from "react";

/** Resolve an element's line-height to pixels, approximating `normal`. */
export function resolveLineHeightPx(el: HTMLElement): number {
  const cs = window.getComputedStyle(el);
  const lineHeight = parseFloat(cs.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  // `line-height: normal` does not parse to a number — approximate it
  // from the font size (the usual ~1.2 ratio) so the cap stays sane.
  const fontSize = parseFloat(cs.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 0;
}

/**
 * Watch `ref` and report whether its content exceeds `lines` visual lines.
 * Writes the measured pixel cap onto the element as `--tug-clamp-cap`.
 */
export function useClampOverflow(
  ref: React.RefObject<HTMLElement | null>,
  lines: number,
): boolean {
  const [overflows, setOverflows] = React.useState(false);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;

    const measure = (): void => {
      // Resolve the cap from the content's own line-height. The clamp
      // wrapper inherits a surface default that may differ from the real
      // content (e.g. a `<code>` child with its own line-height), so prefer
      // the first element child when there is one.
      const target = (el.firstElementChild as HTMLElement | null) ?? el;
      const capPx = resolveLineHeightPx(target) * lines;
      el.style.setProperty("--tug-clamp-cap", `${capPx}px`);
      // +1 absorbs sub-pixel rounding so a content that fits exactly does
      // not flicker the reveal control in and out across re-measures.
      const next = capPx > 0 && el.scrollHeight > capPx + 1;
      setOverflows((prev) => (prev === next ? prev : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, lines]);

  return overflows;
}
